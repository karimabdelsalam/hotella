# Installs (or adds a version of) the hotel agent as a Windows service:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Package hotella-agent-<version>-win-x64.zip
# Layout: %ProgramFiles%\Hotella\Agent\versions\<version>\, ...\current -> the running version (the updater switches
# it), %ProgramData%\Hotella\Agent (settings agent.json, identity and queue; DPAPI-protected, Administrators/SYSTEM only).
# Then: hotella-agent enroll --token-file - --ca planova-agent-ca.pem  (the token from the platform, on stdin).
# An MSI wrapping this (WiX) waits on the owner's decision on the installer toolset (BUILD_PLAN 10.4 notes).
param([Parameter(Mandatory = $true)][string]$Package)
$ErrorActionPreference = 'Stop'
$name = Split-Path $Package -Leaf
if ($name -notmatch '^hotella-agent-(\d+(\.\d+){1,3})-win-x64\.zip$') { throw "not an agent package: $Package" }
$version = $Matches[1]
$root = Join-Path $env:ProgramFiles 'Hotella\Agent'
$data = Join-Path $env:ProgramData 'Hotella\Agent'
$target = Join-Path $root "versions\$version"
New-Item -ItemType Directory -Force -Path (Join-Path $root 'versions'), $data | Out-Null
if (-not (Test-Path $target)) {
  $tmp = Join-Path $root "versions\.install-$([guid]::NewGuid())"
  Expand-Archive -Path $Package -DestinationPath $tmp
  Move-Item $tmp $target
}
$current = Join-Path $root 'current'
if (Test-Path $current) { (Get-Item $current).Delete() }
New-Item -ItemType SymbolicLink -Path $current -Target $target | Out-Null
if (-not (Test-Path (Join-Path $data 'agent.json'))) { Copy-Item (Join-Path $target 'agent.example.json') (Join-Path $data 'agent.json') }
# The data directory holds the device identity: SYSTEM and Administrators only.
icacls $data /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
$exe = Join-Path $current 'hotella-agent.exe'
if (-not (Get-Service HotellaAgent -ErrorAction SilentlyContinue)) {
  New-Service -Name HotellaAgent -DisplayName 'Hotella hotel agent' -BinaryPathName "`"$exe`" run" -StartupType Automatic | Out-Null
}
# Exit 10 (restart into an update) and 11 (rolled back) are restarts, as is any crash.
sc.exe failure HotellaAgent reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
sc.exe failureflag HotellaAgent 1 | Out-Null
Write-Output "installed $version; edit $data\agent.json, enroll, then: Start-Service HotellaAgent"
