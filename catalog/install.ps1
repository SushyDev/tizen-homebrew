# One command from a bare machine to Tizen Homebrew on the television:
#
#   irm https://sushydev.github.io/tizen-homebrew/install.ps1 | iex
#
# It downloads the installer and runs it. The installer carries its own runtime, so nothing has to
# be installed first and nothing is left behind.

$ErrorActionPreference = 'Stop'

$repo = 'SushyDev/tizen-homebrew'

# Only an x64 build is published; Windows on ARM runs it under emulation.
$asset = 'tizen-homebrew-installer-windows-x64.exe'
$url = "https://github.com/$repo/releases/latest/download/$asset"

$directory = Join-Path ([System.IO.Path]::GetTempPath()) ("tizen-homebrew-" + [System.Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $directory

$installer = Join-Path $directory $asset

try {
    Write-Host 'Downloading the installer...'

    $previous = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $installer
    $ProgressPreference = $previous

    # Start-Process would hand it a console of its own; this keeps it in the one the person is using.
    & $installer
} finally {
    Remove-Item -Recurse -Force $directory -ErrorAction SilentlyContinue
}
