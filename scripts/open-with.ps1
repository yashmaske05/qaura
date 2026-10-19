# Adds QAura to File Explorer's "Open with" menu for the file types QAura supports (current user only).
# It never changes which app opens a file by default, and only adds or removes QAura's own entries.
# Opening a file with QAura stores a copy in Files; the original file is never changed.
# Usage: scripts\open-with.ps1            (called by install.ps1)
#        scripts\open-with.ps1 -Remove    (takes QAura out of "Open with" again)
param(
  [string]$Exe = (Join-Path $env:LOCALAPPDATA 'Programs\QAura\QAura.exe'),
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

# Keep in step with FILE_TYPES in main.js (plus .jpeg, which QAura stores as .jpg).
$exts = 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp4', 'webm', 'pdf', 'docx', 'xlsx', 'csv', 'pptx',
  'txt', 'log', 'json', 'xml', 'har', 'yaml', 'yml', 'sql', 'md'
$app = 'QAura.exe'
$cu = [Microsoft.Win32.Registry]::CurrentUser

# CreateSubKey opens an existing key without touching what other apps stored there
# (unlike New-Item -Force, which would recreate the key and drop their entries).
function Set-Reg([string]$sub, [string]$name, $value) {
  $k = $cu.CreateSubKey($sub)
  try { $k.SetValue($name, $value) } finally { $k.Close() }
}

# Remove QAura's previous entries first, so this can run any number of times.
$cu.DeleteSubKeyTree("Software\Classes\Applications\$app", $false)
$cu.DeleteSubKeyTree('Software\Classes\QAura.File', $false) # first version registered a ProgID; it hid other apps
foreach ($e in $exts) {
  $cu.DeleteSubKeyTree("Software\Classes\.$e\OpenWithList\$app", $false)
  $k = $cu.OpenSubKey("Software\Classes\.$e\OpenWithProgids", $true)
  if ($k) { try { $k.DeleteValue('QAura.File', $false) } finally { $k.Close() } }
}

if (-not $Remove) {
  if (-not (Test-Path -LiteralPath $Exe)) { throw "QAura.exe not found at $Exe" }
  # Listed through OpenWithList (not a ProgID), so other apps such as ChatGPT stay in the menu too.
  Set-Reg "Software\Classes\Applications\$app" 'FriendlyAppName' 'QAura'
  Set-Reg "Software\Classes\Applications\$app\DefaultIcon" '' "$Exe,0"
  Set-Reg "Software\Classes\Applications\$app\shell\open\command" '' "`"$Exe`" `"%1`""
  foreach ($e in $exts) {
    Set-Reg "Software\Classes\Applications\$app\SupportedTypes" ".$e" ''
    $cu.CreateSubKey("Software\Classes\.$e\OpenWithList\$app").Close()
  }
}

# Tell Explorer the associations changed so the menu updates without signing out.
Add-Type -Namespace QAuraSetup -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, System.IntPtr item1, System.IntPtr item2);'
[QAuraSetup.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

if ($Remove) { Write-Host 'QAura removed from "Open with".' }
else { Write-Host "QAura added to ""Open with"" for: $($exts -join ', ')" }
