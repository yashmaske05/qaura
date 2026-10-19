# Installs the packaged app for the current user, adds Desktop + Start Menu shortcuts and "Open with > QAura".
# Your data lives separately in %APPDATA%\QAura and is never touched by this script.
# Usage: npm run package; npm run install-app

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'dist\QAura-win32-x64'
$target = Join-Path $env:LOCALAPPDATA 'Programs\QAura'
$exeName = 'QAura.exe'

if (-not (Test-Path (Join-Path $source $exeName))) {
  throw "Build the app first with 'npm run package' (expected $source\$exeName)."
}
# The old "QA Notepad" must be closed too, so nothing writes to the old data while it is copied.
foreach ($name in 'QAura', 'QA Notepad') {
  if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
    throw "$name is running. Close it, then run this again."
  }
}

# Mirror the build into the install folder (only this folder is touched).
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit code $LASTEXITCODE)." }

$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')

# Remove the old "QA Notepad" shortcuts and program files (never its data folder).
foreach ($old in (Join-Path $desktop 'QA Notepad.lnk'), (Join-Path $programs 'QA Notepad.lnk')) {
  if (Test-Path $old) { Remove-Item $old -Force; Write-Host "Removed old shortcut: $old" }
}
$oldInstall = Join-Path $env:LOCALAPPDATA 'Programs\QA Notepad'
if (Test-Path (Join-Path $oldInstall 'QA Notepad.exe')) {
  Remove-Item $oldInstall -Recurse -Force
  Write-Host "Removed old program files: $oldInstall"
}

$exe = Join-Path $target $exeName
$shell = New-Object -ComObject WScript.Shell
foreach ($link in (Join-Path $desktop 'QAura.lnk'), (Join-Path $programs 'QAura.lnk')) {
  $s = $shell.CreateShortcut($link)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $target
  $s.IconLocation = "$exe,0"
  $s.Description = 'QAura, the QA workspace'
  $s.Save()
  Write-Host "Shortcut created: $link"
}
# "Open with > QAura" in File Explorer (adds an option; your default apps stay as they are).
& (Join-Path $PSScriptRoot 'open-with.ps1') -Exe $exe

Write-Host "Installed to: $target"
Write-Host "Your data folder: $(Join-Path $env:APPDATA 'QAura')"
