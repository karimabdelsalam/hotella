# Development, diagnostics and emergency install of the hotel agent (hotels get the MSI — ADR-0020):
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Package hotella-agent-<version>-win-x64.zip [-CodesFile codes.txt]
# Unpacks into %ProgramFiles%\Hotella\Agent\versions\<version>\ and runs the same step the MSI runs,
# `hotella-agent setup install`: the `current` link, the protected data directory, one service per connector enrolled
# from the codes file (one enrollment code per line; deleted once read), recovery actions, start.
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$CodesFile
)
$ErrorActionPreference = 'Stop'
$name = Split-Path $Package -Leaf
if ($name -notmatch '^hotella-agent-(\d+(\.\d+){1,3})-win-x64\.zip$') { throw "not an agent package: $Package" }
$version = $Matches[1]
$root = Join-Path $env:ProgramFiles 'Hotella\Agent'
$target = Join-Path $root "versions\$version"
New-Item -ItemType Directory -Force -Path (Join-Path $root 'versions') | Out-Null
if (-not (Test-Path $target)) {
  $tmp = Join-Path $root "versions\.install-$([guid]::NewGuid())"
  Expand-Archive -Path $Package -DestinationPath $tmp
  Move-Item $tmp $target
}
$setupArgs = @('setup', 'install')
if ($CodesFile) { $setupArgs += @('--codes-file', (Resolve-Path $CodesFile).Path) }
& (Join-Path $target 'hotella-agent.exe') @setupArgs
exit $LASTEXITCODE
