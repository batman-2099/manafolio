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
var
  PreviousPath, Directory: String;
  PayloadDirs: array[0..4] of String;
  Index: Integer;
begin
  Result := RunningAppMessage();
  if Result <> '' then
    Exit;

  (* Only clean an installation registered by this installer at this path.
     Never delete app/backend wholesale: archive users can keep .env, database,
     models and backups there. Desktop user data lives outside {app}. *)
  if not RegQueryStringValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{8B26A6D8-3DD2-4B60-91D2-1A823E1E2390}_is1',
    'InstallLocation', PreviousPath) then
    Exit;
  if CompareText(AddBackslash(PreviousPath), AddBackslash(ExpandConstant('{app}'))) <> 0 then
    Exit;

  PayloadDirs[0] := 'desktop';
  PayloadDirs[1] := 'app\backend\src';
  PayloadDirs[2] := 'app\backend\node_modules';
  PayloadDirs[3] := 'app\frontend\dist';
  PayloadDirs[4] := 'app\shared';
  for Index := 0 to GetArrayLength(PayloadDirs) - 1 do
  begin
    Directory := ExpandConstant('{app}\') + PayloadDirs[Index];
    if DirExists(Directory) and not DelTree(Directory, True, True, True) then
    begin
      Result := 'Setup could not replace the old application payload. Close Manafolio and any programs using its installation files, then retry. Configuration and user data have not been removed.';
      Exit;
    end;
  end;
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
