#ifndef AppVersion
  #error AppVersion must be supplied with /DAppVersion=<version>
#endif

[Setup]
AppId={{8B26A6D8-3DD2-4B60-91D2-1A823E1E2390}
AppName=Manafolio
AppVersion={#AppVersion}
AppPublisher=Manafolio
AppPublisherURL=https://github.com/batman-2099/manafolio
DefaultDirName={localappdata}\Programs\Manafolio
DefaultGroupName=Manafolio
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\..\build
OutputBaseFilename=Manafolio-Setup-windows-x64
SetupIconFile=..\..\build\Manafolio-windows\manafolio.ico
UninstallDisplayIcon={app}\manafolio.ico
UninstallDisplayName=Manafolio
LicenseFile=..\..\LICENSE
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "..\..\build\Manafolio-windows\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Manafolio"; Filename: "{app}\desktop\Manafolio.exe"; WorkingDir: "{app}"; IconFilename: "{app}\manafolio.ico"; AppUserModelID: "Manafolio.Desktop"
Name: "{userdesktop}\Manafolio"; Filename: "{app}\desktop\Manafolio.exe"; WorkingDir: "{app}"; IconFilename: "{app}\manafolio.ico"; AppUserModelID: "Manafolio.Desktop"; Tasks: desktopicon

[Run]
Filename: "{app}\desktop\Manafolio.exe"; Description: "Launch Manafolio"; Flags: nowait postinstall skipifsilent

[Code]
function RunningAppMessage(): String;
var
  Locator, Services, Processes, Process: Variant;
  Index: Integer;
  Executable: String;
begin
  Result := '';
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('.', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name = ''Manafolio.exe'' OR Name = ''manafolio-server.exe''');
    for Index := 0 to Processes.Count - 1 do
    begin
      Process := Processes.ItemIndex(Index);
      Executable := '';
      if not VarIsNull(Process.ExecutablePath) then
        Executable := Process.ExecutablePath;
      if (Executable = '') or
         (CompareText(GetShortName(Executable), GetShortName(ExpandConstant('{app}\desktop\Manafolio.exe'))) = 0) or
         (CompareText(GetShortName(Executable), GetShortName(ExpandConstant('{app}\manafolio-server.exe'))) = 0) then
      begin
        Result := 'Manafolio is running or its process could not be inspected. Close Manafolio (including any elevated instance) and wait for it to finish saving, then try again. Setup will not force it to close.';
        Exit;
      end;
    end;
  except
    Result := 'Setup could not check whether Manafolio is running. Close Manafolio, ensure Windows Management Instrumentation is available, and try again.';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := RunningAppMessage();
end;

function InitializeUninstall(): Boolean;
var
  Message: String;
begin
  Message := RunningAppMessage();
  Result := Message = '';
  if not Result then
    SuppressibleMsgBox(Message, mbError, MB_OK, IDOK);
end;
