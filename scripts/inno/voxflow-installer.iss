; VoxFlow — InnoSetup 安装版
;
; 第二遍打包：以第一遍 electron-builder --dir 的产物（release\win-unpacked\）为输入。
; 由 scripts\bundle-inno.ps1 调用：
;   ISCC /DAppVersion=0.4.0 /DOutputBase=VoxFlow-Setup-0.4.0 voxflow-installer.iss
;
; 安装后的目录结构（与便携版一致）：
;   <root>\
;     VoxFlow.exe     ← 根目录启动器（scripts\inno\VoxFlowLauncher.cs 编译产物）
;     bin\            ← Electron 本体
;     data\           ← 预建空目录（安装版不用它，数据根在 %APPDATA%）
;     libs\           ← 推理运行时，按需下载
;
; 为什么 exe 在根、Electron 在 bin：用户要求的目录布局。
; 应用侧靠 src\main\core\data-root.ts 的 appRootDir() 识别 bin\ 布局，
; 把 data\ 与 libs\ 定位回根目录。

#ifndef AppVersion
  #error 用法: ISCC /DAppVersion=<ver> /DOutputBase=<name> voxflow-installer.iss
#endif
#ifndef OutputBase
  #define OutputBase "VoxFlow-Setup"
#endif

#define AppName "VoxFlow"
#define AppPublisher "VoxFlow"
#define AppExeName "VoxFlow.exe"
#define AppId "{{7C4B2E19-8A3D-4F6A-9B2E-1D5C7A3F8E42}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputBaseFilename={#OutputBase}
OutputDir=..\..\dist-inno
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; 图标：与 electron-builder 用同一份 build\icon.ico
SetupIconFile=..\..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}

ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Files]
; ── 根目录启动器 ──────────────────────────────────────────────────────
Source: "..\..\.cache\VoxFlowLauncher.exe"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion

; ── Electron 本体 → bin\ ──────────────────────────────────────────────
Source: "..\..\release\win-unpacked\*"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
; data\ 与 libs\ 预建空目录，让目录结构与便携版一致。
; 安装版的数据根实际在 %APPDATA%\com.voxflow.app（见 data-root.ts 的 isPortable）。
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\data\models"; Flags: uninsneveruninstall
Name: "{app}\libs"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "立即启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 删 bin\ 与根目录 exe，保留 data\（用户的模型与配置在里面，删了要重下几十 GB）
Type: filesandordirs; Name: "{app}\bin"
Type: files; Name: "{app}\{#AppExeName}"
