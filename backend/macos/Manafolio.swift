import AppKit
import WebKit

final class Manafolio: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var web: WKWebView!
    private var server: Process?
    private var output: Pipe?
    private var log: FileHandle?
    private var pendingOutput = ""
    private var origin: URL?
    private var stopping = false
    private var failed = false
    private var deadline = Date()
    private let dataDirectory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory())
        .appendingPathComponent("Library/Application Support/Manafolio", isDirectory: true)

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "print")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.print = () => window.webkit.messageHandlers.print.postMessage(null)", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if SMOKE_TEST
        configuration.websiteDataStore = .nonPersistent()
        #endif
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Manafolio — Starting server…"
        window.minSize = NSSize(width: 390, height: 480)
        window.contentView = web
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        installMenus()
        NSApp.activate(ignoringOtherApps: true)
        startServer()
    }

    private func installMenus() {
        let menu = NSMenu()
        for (title, items) in [
            ("Manafolio", [("Quit Manafolio", #selector(NSApplication.terminate(_:)), "q")]),
            ("Edit", [("Undo", Selector(("undo:")), "z"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")]),
            ("View", [("Back", #selector(goBack), "["), ("Forward", #selector(goForward), "]"), ("Reload", #selector(reload), "r"), ("Zoom In", #selector(zoomIn), "+"), ("Zoom Out", #selector(zoomOut), "-"), ("Actual Size", #selector(actualSize), "0"), ("Print…", #selector(printPage), "p")])
        ] {
            let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: title)
            for (label, action, key) in items {
                let item = NSMenuItem(title: label, action: action, keyEquivalent: key)
                if title == "View" { item.target = self }
                submenu.addItem(item)
            }
            parent.submenu = submenu
            menu.addItem(parent)
        }
        NSApp.mainMenu = menu
    }

    private func startServer() {
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let logURL = dataDirectory.appendingPathComponent("desktop.log")
            // Keep only the current launch's diagnostics, not an unbounded log archive.
            _ = FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            log = try FileHandle(forWritingTo: logURL)
            let child = Process()
            child.executableURL = Bundle.main.resourceURL!.appendingPathComponent("server/manafolio-server")
            child.currentDirectoryURL = dataDirectory
            var environment = ProcessInfo.processInfo.environment
            environment["MANAFOLIO_MAC_APP"] = "1"
            child.environment = environment
            child.standardInput = FileHandle.nullDevice
            let pipe = Pipe()
            output = pipe
            child.standardOutput = pipe
            child.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async { self?.receive(data) }
            }
            child.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if !self.stopping { self.fail("The local server stopped. Check desktop.log for details, then quit and reopen Manafolio.") }
                }
            }
            server = child
            deadline = Date().addingTimeInterval(90)
            try child.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in
                guard let self = self, self.origin == nil, !self.stopping else { return }
                self.fail("The local server did not start within 90 seconds. Check desktop.log, including whether another server is using the configured port.")
            }
        } catch { fail("Could not start the local server: \(error.localizedDescription)") }
    }

    private func receive(_ data: Data) {
        try? log?.write(contentsOf: data)
        pendingOutput += String(decoding: data, as: UTF8.self)
        while let newline = pendingOutput.firstIndex(of: "\n") {
            let line = String(pendingOutput[..<newline])
            pendingOutput.removeSubrange(...newline)
            if line.hasPrefix("MANAFOLIO_READY:"), let port = Int(line.dropFirst("MANAFOLIO_READY:".count)), (1...65535).contains(port) {
                origin = URL(string: "http://localhost:\(port)")!
                waitForDatabase()
            }
        }
    }

    private func waitForDatabase() {
        guard let origin = origin, !stopping, !failed else { return }
        var request = URLRequest(url: origin.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.stopping, !self.failed else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.window.title = "Manafolio"
                    self.web.load(URLRequest(url: origin))
                } else if Date() < self.deadline {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForDatabase() }
                } else { self.fail("The database did not become ready. Check desktop.log, then quit and reopen Manafolio.") }
            }
        }.resume()
    }

    private func fail(_ message: String) {
        guard !failed, !stopping else { return }
        failed = true
        #if SMOKE_TEST
        fputs("FAIL: \(message)\n", stderr)
        server?.terminate()
        exit(1)
        #else
        let alert = NSAlert()
        alert.messageText = "Manafolio could not continue"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Show log")
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.activateFileViewerSelecting([dataDirectory.appendingPathComponent("desktop.log")])
        }
        NSApp.terminate(nil)
        #endif
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { NSApp.terminate(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if stopping { return .terminateCancel }
        #if !SMOKE_TEST
        if !failed && origin != nil {
            let alert = NSAlert()
            alert.messageText = "Quit Manafolio?"
            alert.informativeText = "The local server will stop. Finish any imports or saves first; unsaved changes will be lost."
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Quit")
            if alert.runModal() != .alertSecondButtonReturn { return .terminateCancel }
        }
        #endif
        stopping = true
        guard let server = server, server.isRunning else { return .terminateNow }
        server.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            if server.isRunning { kill(server.processIdentifier, SIGKILL) }
        }
        server.waitUntilExit()
        return .terminateNow
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url = url, let origin = origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }
    @objc private func goBack() { web.goBack() }
    @objc private func goForward() { web.goForward() }
    @objc private func reload() { web.reload() }
    @objc private func zoomIn() { web.pageZoom = min(4, web.pageZoom + 0.25) }
    @objc private func zoomOut() { web.pageZoom = max(0.5, web.pageZoom - 0.25) }
    @objc private func actualSize() { web.pageZoom = 1 }
    @objc private func printPage() {
        guard isLocal(web.url) else { return }
        web.printOperation(with: NSPrintInfo.shared).run()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.frameInfo.isMainFrame && isLocal(message.frameInfo.request.url) { printPage() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if action.navigationType == .linkActivated && !isLocal(url) && ["https", "http", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            // Keep HTTP(S) redirects in this session for OIDC; never permit local-file navigation.
            decisionHandler(["http", "https", "blob", "about"].contains(url.scheme ?? "") ? .allow : .cancel)
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isLocal(url) { webView.load(action.request) }
            else if ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        #if SMOKE_TEST
        completionHandler(dataDirectory.appendingPathComponent("smoke-export.txt"))
        #else
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.url : nil) }
        #endif
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        #if SMOKE_TEST
        fail("Download failed: \(error.localizedDescription)")
        #else
        if (error as NSError).code != NSURLErrorCancelled { showError("Download failed", error.localizedDescription) }
        #endif
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(isLocal(frame.request.url) && type == .camera ? .prompt : .deny)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.stringValue = defaultText ?? ""; input.setAccessibilityLabel(prompt)
        alert.accessoryView = input
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? input.stringValue : nil) }
    }
    private func showError(_ title: String, _ detail: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.beginSheetModal(for: window)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        let alert = NSAlert(); alert.messageText = "Could not load Manafolio"; alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "Retry"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { if $0 == .alertFirstButtonReturn, let origin = self.origin { self.web.load(URLRequest(url: origin)) } }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    #if SMOKE_TEST
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { smoke(attempt: 0) }
    private func smoke(attempt: Int) {
        web.evaluateJavaScript("document.querySelector('input[type=password]') !== null") { value, error in
            guard error == nil, value as? Bool == true else {
                if attempt >= 60 { self.fail("Login form did not render in WKWebView"); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.smoke(attempt: attempt + 1) }
                return
            }
            self.web.callAsyncJavaScript("""
                const health = await fetch('/api/health');
                if (!health.ok) throw new Error('API unavailable inside WebKit');
                const config = await (await fetch('/api/auth/config')).json();
                if (config.setupRequired) throw new Error('Bootstrap owner missing');
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob(['Manafolio export smoke'], {type:'text/plain'}));
                link.download = 'smoke-export.txt'; document.body.append(link); link.click(); link.remove();
                return true;
                """, arguments: [:], in: nil, in: .page) { result in
                    if case .failure(let error) = result { self.fail(error.localizedDescription); return }
                    self.web.takeSnapshot(with: nil) { image, error in
                        guard let image = image, let tiff = image.tiffRepresentation,
                              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { self.fail("Snapshot failed"); return }
                        try? png.write(to: self.dataDirectory.appendingPathComponent("wrapper.png"))
                    }
                }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        do {
            let content = try String(contentsOf: dataDirectory.appendingPathComponent("smoke-export.txt"), encoding: .utf8)
            guard content == "Manafolio export smoke" else { fail("Blob export content changed"); return }
            fputs("PASS: Native WKWebView renders login, serves API, and saves blob exports.\n", stderr)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { NSApp.terminate(nil) }
        } catch { fail(error.localizedDescription) }
    }
    #endif
}

let application = NSApplication.shared
let delegate = Manafolio()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
