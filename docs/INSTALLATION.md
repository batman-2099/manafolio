# Installation and server configuration

[Back to Manafolio](../README.md) · [User guide](USER_GUIDE.md)

## Docker

Clone [the Manafolio repository](https://github.com/batman-2099/manafolio) and build the checked-in Compose service:

```bash
git clone https://github.com/batman-2099/manafolio.git
cd manafolio
docker compose up -d --build
```

Open `http://localhost:3001`. Without `DEFAULT_ADMIN_PASSWORD`, the first browser visit creates the owner account; protect access until setup is complete. With it set, startup creates the `admin` account when no users exist, and the first visit is a regular login. Registration is invite-only unless explicitly enabled.

The `manafolio-data` volume contains the SQLite database, automatic backups, TLS material, scan models, and catalogs. To configure optional variables in Compose, uncomment the `environment:` header and the desired entries below it; [`.env.example`](../.env.example) documents available settings. Builds use local source, not an assumed published image or binary. After updating your checkout, run `docker compose up -d --build` again. Existing installations must follow the [migration instructions](#migrate-an-existing-installation) first.

Finish imports and saves before updating or stopping the container. Compose allows two minutes for graceful shutdown; after that deadline Docker can forcibly terminate unfinished work. The server warns after 30 seconds if it is still draining. A longer grace period is not a substitute for completing active operations and taking a backup.

## Windows installer

Tagged releases also build `Manafolio-Setup-windows-x64.exe` for **64-bit Windows 10 or later**. Download it from [GitHub Releases](https://github.com/batman-2099/manafolio/releases), run Setup, and open **Manafolio** from the Start Menu. Setup installs for the current user without requesting administrator privileges, defaults to `%LOCALAPPDATA%\Programs\Manafolio`, and offers an optional desktop shortcut. Node, Electron, Chromium, and application dependencies are included; the server-only `.zip` remains available.

Windows packages include ONNX Runtime's required Microsoft Visual C++ DLLs beside its native addon, so they do not rely on a separately installed Visual C++ Redistributable or require an elevation prompt to install it. These private runtime DLLs are serviced through Manafolio package updates. If an older installer fails loading `onnxruntime_binding.node` with “The specified module could not be found,” install the corrected package over the existing app; do not delete the data directory. Installing the [Microsoft x64 Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) is also a workaround for older packages.

Manafolio opens in its own sandboxed window and starts the bundled server without a console. Closing the window or choosing **Quit** asks for confirmation, then waits for active server requests and database writes before exiting. Finish imports and saves first. Setup and uninstall refuse to overwrite a running installed app/server; quit it and wait for shutdown before proceeding. Stop any older console-launched server too, since a port conflict is reported rather than connecting to another process.

If shutdown is still waiting after 30 seconds, choose **Keep waiting** to allow active work to finish. **Force quit** is an explicit last resort and can lose in-flight work; there is no automatic forced termination.

Persistent files live separately in `%LOCALAPPDATA%\Manafolio`: `manafolio.db`, backups, artwork, TLS material, and `models/`. Optional configuration goes in that directory's `.env`, using [`.env.example`](../.env.example) as a reference. Environment variables take precedence; `DB_PATH` and `CV_MODEL_DIR` override the defaults, and relative paths resolve from the data directory. The private Chromium profile lives in `desktop/`; server/startup diagnostics go to `desktop.log` (current launch, capped at 4 MiB). Startup errors offer **Show log**.

The app uses native file dialogs, clipboard shortcuts, Back/Forward, reload, zoom, printing, and text prompts with Cancel/Escape. Camera access requires permission. External links open in your browser; sign-in redirects stay in the app session, although some identity providers reject embedded browsers. Browser sessions are not shared with Edge or Chrome.

Before updating, quit Manafolio and back up the entire data directory, then run the new installer. **Settings → Apps → Installed apps → Manafolio → Uninstall** removes the program and shortcuts but deliberately retains collection data, configuration, and the desktop profile. Existing server-archive/Docker data is **not imported automatically**; follow the [offline migration procedure](#migrate-an-existing-installation). If an existing collection unexpectedly shows owner setup, stop and check paths.

The installer is **unsigned**; Windows SmartScreen may warn about an unknown publisher. Only run a download from a source you trust; do not disable SmartScreen globally. The server retains normal LAN access, so protect access until first-owner setup is complete and use HTTPS remotely. Native scanning/OCR and ChatGPT/Codex still require the supported Unix runtime; use Docker for those features on Windows. Camera permission alone does not install those prerequisites.

## Linux AppImage

Tagged releases also build `Manafolio-linux-x64.AppImage` for x86-64 Linux. Download it from [GitHub Releases](https://github.com/batman-2099/manafolio/releases), then run:

```bash
chmod +x Manafolio-linux-x64.AppImage
./Manafolio-linux-x64.AppImage
```

The image opens Manafolio in its own desktop window and runs its bundled server in the background. No Terminal or browser is needed after launch. Closing the window or choosing **Quit** asks for confirmation, then drains active server requests and database writes. After 30 seconds, **Keep waiting** remains the safe default; **Force quit** requires explicit consent and can lose in-flight work. Finish imports and saves first. Stop the previous browser-based AppImage server before launching this version. Node, Electron, Chromium, and application dependencies are included; the existing server-only `.tar.gz` remains available.

The x86-64 image targets Ubuntu 22.04 or newer compatible desktop distributions with GTK 3, NSS, ALSA, and GBM runtime libraries. Chromium's sandbox requires unprivileged user namespaces; run as a normal user and **do not use `--no-sandbox` or run as root**. If a distro's AppArmor policy blocks user namespaces, configure a narrowly scoped policy for the installed app rather than disabling sandbox protections globally. If FUSE is unavailable, use `./Manafolio-linux-x64.AppImage --appimage-extract-and-run`. Wayland and X11 are supported; if your compositor has rendering problems, launch with `--ozone-platform=x11` on an X11/XWayland session.

By default, persistent files live in `~/.local/share/manafolio/` (`$XDG_DATA_HOME/manafolio/` when set): `manafolio.db`, backups, artwork, TLS material, and `models/` for scan models/catalogs. Optional configuration goes in that directory's `.env`; use [`.env.example`](../.env.example) as a reference. Environment variables take precedence over `.env`; `DB_PATH` and `CV_MODEL_DIR` can override the defaults. Relative configuration paths resolve from this data directory. The private Chromium profile lives in `desktop/`; sign in again when switching from the old browser UI. Current-launch server diagnostics go to `desktop.log` (capped at 4 MiB), and startup errors offer **Show log**.

Imports/exports use native file dialogs; Edit/View provide clipboard shortcuts, Back/Forward, reload, zoom, and printing. Text prompts support Enter, Cancel, and Escape. Camera access requires an explicit grant and is restricted to the local app; microphones and unrelated permissions are denied. External links open in your browser, while SSO redirects remain in the app session (some providers may reject embedded browsers). The app does not share Safari/Chrome/Firefox sessions.

Stop the server and back up this entire directory before updating; replace only the AppImage, not its data directory. Existing archive/Docker installations are **not imported automatically**: follow the [offline migration procedure](#migrate-an-existing-installation) and point configuration at the intended data before starting. An unexpected owner-creation screen means stop and check paths.

The server retains its normal network behavior, including LAN access. Protect access until owner setup is complete and use HTTPS for remote access. Scanning still requires native Tesseract with English data and downloaded models/catalogs; these are not bundled. See [Card scanning](#card-scanning).

## macOS DMG

macOS desktop packages require **macOS 14.4 or later**. Choose the package for your processor:

- **Apple Silicon:** [`Manafolio-macos-arm64.dmg`](https://github.com/batman-2099/manafolio/releases/latest/download/Manafolio-macos-arm64.dmg).
- **Intel x86-64:** [`Manafolio-macos-x64.dmg`](https://github.com/batman-2099/manafolio/releases/latest/download/Manafolio-macos-x64.dmg).

Open the disk image, drag **Manafolio.app** into **Applications**, and eject the image. Matching `Manafolio-macos-arm64.tar.gz` and `Manafolio-macos-x64.tar.gz` server archives are available from [GitHub Releases](https://github.com/batman-2099/manafolio/releases). Intel packages build the locked ONNX Runtime version from source because its npm package does not include an Intel macOS binary.

Open **Manafolio** from Applications. The app starts its bundled server in the background and displays Manafolio inside a native WebKit window; no Terminal or browser is required. Closing the window or pressing **Command+Q** asks for confirmation, then drains active server requests and database writes. After 30 seconds, choose **Keep waiting** unless you explicitly accept the risk of losing in-flight work with **Force quit**. Finish saves/imports before quitting. Stop an older Terminal-launched server before opening the new app; a port conflict is reported instead of silently connecting to another process.

File imports and exports use macOS Open/Save dialogs. The Edit menu supports clipboard shortcuts; View offers Back, Forward, Reload, zoom, and Print. Camera access requires permission. External links open in your default browser; HTTP(S) sign-in redirects remain in the app's web session, although identity providers may disallow embedded browsers. The app has its own persistent WebKit session, separate from Safari/Chrome; sign in again after switching from the old browser launcher.

The bundle is ad-hoc signed, **not Developer ID signed or notarized**. Gatekeeper may block a downloaded copy. Only if you trust the release, use macOS **System Settings → Privacy & Security → Open Anyway** after the first launch attempt. Do not disable Gatekeeper globally.

Persistent files live in `~/Library/Application Support/Manafolio/`: `manafolio.db`, backups, artwork, TLS material, and `models/` for downloaded scan assets. Put optional configuration in that directory's `.env`, using [`.env.example`](../.env.example) as a reference. Environment variables take precedence; `DB_PATH` and `CV_MODEL_DIR` override the defaults. Relative configuration paths resolve from this data directory. Startup/server output goes to `desktop.log` there, replaced on each launch and capped at 4 MiB; startup failures offer **Show log**.

Before updating, stop the server and back up the entire data directory, then replace the app in Applications. Existing archive/Docker data is **not imported automatically**; follow the [offline migration procedure](#migrate-an-existing-installation). The normal LAN access and first-owner setup rules still apply: protect access until setup is complete and use HTTPS for remote access. The DMG does not bundle native Tesseract or scan models/catalogs; packaging does not remove the existing [scanning prerequisites](#card-scanning).

## Migrate an existing installation

Manafolio uses its own database, deployment, browser, and backup names. Startup does not rename previous database files or migrate deployment volumes, browser state, or backup formats. Follow the offline procedure before starting the new service. **Do not start the new service against an empty replacement volume.**

1. Record the current `DB_PATH`, Compose project/volume names, and persistent-data location. Stop every service that can write to the database, then make an offline backup of the entire data directory outside the deployment. Keep the original volume until migration is verified.
2. With all writers stopped, rename the collection database to `manafolio.db` and any matching `-wal` and `-shm` sidecars to `manafolio.db-wal` and `manafolio.db-shm`. Keep them together; never discard a WAL that may contain committed data or overwrite an existing destination.
3. Rename `<previous-DB_PATH>.scryfall-bulk.sqlite` to `manafolio.db.scryfall-bulk.sqlite` in the same directory, including matching sidecars. This rebuildable catalog is not the collection database.
4. Update `.env`, service definitions, external scripts, and mounts. Docker uses `/app/database/manafolio.db`; source defaults to `backend/database/manafolio.db`. Copy the stopped persistent volume's complete contents into the new `manafolio-data` volume, preserving ownership, permissions, backups, TLS material, models, catalogs, and account credentials. Compose project names affect actual volume names: inspect the resolved mount rather than assuming it.
5. Rebuild and restart. Verify accounts, collection quantities, storage, decks, and backups before retiring the old deployment. If a populated installation shows owner creation, stop and correct the mount or `DB_PATH`; do not initialize a replacement collection.

Very old databases containing `collection.sub_location_1` are rejected at startup without dropping collection or location tables. Preserve a verified offline copy and arrange an explicit migration to the compartment schema before retrying. Earlier versions could destructively reset these tables; do not downgrade and launch against the original database as a workaround.

Browser keys use `manafolio_*`: sign in again and reselect browser-only preferences; old keys are not migrated. Older compatible JSON exports need the explicit [backup format conversion](USER_GUIDE.md#restore-a-backup-into-the-signed-in-account) before restore.

For server recovery, preserve the persistent volume and keep protected backups outside it; snapshots in the same volume do not protect against losing that volume. Stop database writers before an offline whole-volume copy, retaining the database and any WAL/SHM files together. Whole-volume backups may include account credentials and TLS private keys. See [Take a server backup](USER_GUIDE.md#take-a-server-backup) for the administrator's backup controls.

## HTTP, HTTPS, and reverse proxies

| Port | Use |
| --- | --- |
| `3001` | Localhost or a reverse proxy that terminates TLS. |
| `3443` | Direct HTTPS, including camera use from a phone. |

Use HTTPS for remote access. The built-in self-signed certificate is generated in the persistent volume; browsers require explicit acceptance per device. Set `SSL_CERT_PATH` and `SSL_KEY_PATH` to use a trusted certificate. Behind a TLS-terminating reverse proxy, set `TRUST_PROXY=1` and usually publish only port `3001`.

## Configuration

The canonical list is [`.env.example`](../.env.example).

For source or downloaded-server installations, copy `.env.example` to `backend/.env` (the release's `app/backend/.env`). The server and maintenance scripts in `backend/scripts/` keep existing process variables first, then load `.env` from the working directory, then `backend/.env` as a fallback. Leave `DB_PATH` unset to retain the source default regardless of working directory. Use an absolute path for an override; existing relative overrides are still resolved from the process's working directory. In Docker, set variables in Compose rather than copying the source example over the image's defaults.

| Variable | Purpose |
| --- | --- |
| `DB_PATH` | SQLite database path; unset defaults to `backend/database/manafolio.db`, while Docker supplies `/app/database/manafolio.db`. |
| `DEFAULT_ADMIN_PASSWORD` | Bootstrap `admin` password only when no users exist. |
| `PUBLIC_BASE_URL` | External URL for share links and an allowed CORS origin. |
| `TRUST_PROXY` | Reverse-proxy hop count, commonly `1`. |
| `HTTPS_PORT` | Built-in HTTPS port; empty for HTTP-only operation. |
| `SSL_CERT_PATH` / `SSL_KEY_PATH` | Trusted TLS certificate and key. |
| `ALLOW_REGISTRATION` | `true` enables public self-registration. |
| `CV_MODEL_DIR` | Persistent scan models and catalogs. |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP_LAST` | Automatic SQLite snapshot schedule and retention. |
| `OLLAMA_BASE_URL` | Default Ollama service address; users may choose their own. |

## Phone browsers

Open your server's HTTPS address in your phone's browser and sign in with your server account. The responsive web interface includes collection, storage, decks, and [camera scanning](USER_GUIDE.md#scan-physical-cards-with-a-camera); scanning requires browser camera permission and the [server-side assets](#card-scanning) described below.

## Native SSO handoff

The server also supports Android sign-in through an external browser/Custom Tab when the existing OIDC integration is enabled. `GET /api/auth/config` advertises `nativeOidcEnabled`; older servers without that marker do not support this handoff. Keep the identity provider's registered redirect at your server's existing `/api/auth/oidc/callback`, **not** the Android custom URI. No additional IdP client secret belongs in the app, and existing browser sign-in and account provisioning/linking policies are unchanged.

The app supplies its own S256 PKCE challenge and random state to `/api/auth/native/login`, with the only allowed return URI `app.manafolio.app://auth/callback`. After browser sign-in, that callback receives a single-use opaque code, never a reusable session. The app exchanges the code, state, and verifier over your server's trusted HTTPS connection at `/api/auth/native/exchange`. Codes expire after 90 seconds; a server restart or a lost exchange response requires a fresh sign-in. Pending attempts are process-local: run a single backend process, or provide sticky routing for every step before deploying multiple workers. See [the API/security contract](../PROJECT.md#native-sso-contract) for payloads, errors, limits, and regression checks.

## Card scanning

**Add Cards → Scan Cards** uses local ONNX artwork matching, informational title OCR, and footer OCR to verify set code and collector number. It requires a server installation, models, a catalog, and native Tesseract with English data.

1. Fetch models after deployment:

   ```bash
   docker exec manafolio node scripts/fetch-models.mjs
   ```

   From source, run `node scripts/fetch-models.mjs` in `backend/`.
2. Build the relevant language catalog under **Admin → Catalogs**. Downloading data and fingerprinting artwork can take hours. Stopped or failed builds keep the working catalog and cached card data; uncommitted embeddings are discarded. The next build reuses unchanged vectors from the last successful publication.
   Rebuild existing local catalogs to include native double-faced cards' reverse artwork; unchanged front artwork is reused.
3. Linux source installations need Tesseract at `/usr/bin/tesseract` with `eng` trained data (`/usr/bin/tesseract --list-langs`). On Debian/Ubuntu, install `tesseract-ocr tesseract-ocr-eng`. Source-built Docker images include both. On macOS, install Tesseract through Homebrew (`brew install tesseract`) and verify `eng` with `/opt/homebrew/bin/tesseract --list-langs`. The app checks `/opt/homebrew/bin/tesseract`, then `/usr/local/bin/tesseract`, directly so Finder does not need your shell's PATH. The DMG does not include Tesseract or its language data.

Phones require HTTPS. See [the image-identification pipeline](../PROJECT.md#image-identification-pipeline) for details and limitations, and [Scan physical cards with a camera](USER_GUIDE.md#scan-physical-cards-with-a-camera) for capture, verification, Scan review, and accuracy warnings.

## Optional AI server configuration

AI is optional. See [Optional AI deck help](USER_GUIDE.md#optional-ai-deck-help) for provider setup, recommendations, saved-deck improvements, and user controls.

### Ollama deployment

Run [Ollama](https://docs.ollama.com/) and install a structured-output model, for example `ollama pull granite4.1:8b`. In **Settings → AI preferences**, enter the service's HTTP(S) address, check the connection, and choose an installed model. A blank address uses `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`). Models are not downloaded automatically, and failures never fall back to ChatGPT.

**Ollama deployment security.** Requests originate from the server, not the browser. Signed-in users can contact server-accessible HTTP(S) addresses, including localhost and private/LAN services. Invite only trusted users and enforce outbound network restrictions with your firewall; URL validation is not an access allowlist. Manafolio does not add Ollama authentication. Do not expose its port publicly.

In Docker, `127.0.0.1` is the container. To reach host Ollama, use `OLLAMA_BASE_URL=http://host.docker.internal:11434` and, on Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the Compose service. Configure Ollama's `OLLAMA_HOST` to listen on an interface reachable from the container, with firewall restrictions. Alternatively use an Ollama service name on a shared Docker network.

### AI data sharing and credentials

Requests send eligible card metadata/counts, the session conversation, and the current draft—including manually edited draft descriptions and strategies—to the chosen provider. They do not send storage locations, container names/IDs, saved private notes, or other users' collections. Source-deck context excludes its saved description and private notes. ChatGPT sends data to OpenAI and uses your Codex limits; an Ollama service may process data locally or remotely depending on its configuration.

Connect only to a trusted Manafolio server. The official [Codex app-server](https://developers.openai.com/codex/app-server/) integration requires a Unix server, including Docker, and disables model access to host files, commands, and external tools. Credentials are separated per user under `<database-directory>/codex/<user-id>/`, but administrators can access them. **Disconnect** removes that user's local Codex data. Collection JSON backups exclude credentials; whole-volume backups include them and must be protected. AI endpoints require browser sessions rather than API keys.

Deleting an account also stops its local Codex work and removes its credential directory without contacting OpenAI or revoking provider-side authorization. A cleanup failure leaves the account undeleted and reports an error; retry deletion after correcting the filesystem problem. Existing backups are not erased.

Gemini and OpenRouter keys are stored separately per user and provider in the server database, not returned to the browser. **Remove API key** deletes that provider's stored key without affecting other providers; revoke it at the provider to invalidate it externally. Administrators and database/volume backups can access these keys; account JSON exports exclude them. Gemini receives requests at Google's API, while OpenRouter forwards them to the selected model's upstream provider. Review both the gateway's and upstream provider's policies before sending data. Adding providers does not change existing saved provider choices.
