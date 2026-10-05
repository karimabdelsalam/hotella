# Builds the hotel agent's MSI (WiX v5, ADR-0020). Windows only:
#   pwsh packaging/windows/build-msi.ps1 -Version 0.10.2 [-Out dist]
# → <Out>/hotella-agent-<version>-win-x64.msi (+ .sha256), from the same self-contained win-x64 publish as the zip.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Out = (Join-Path (Get-Location) 'dist')
)
$ErrorActionPreference = 'Stop'
$agent = Resolve-Path (Join-Path $PSScriptRoot '../..')
$stage = Join-Path ([IO.Path]::GetTempPath()) "hotella-msi-$([guid]::NewGuid())"
try {
  dotnet publish "$agent/src/Hotella.Agent/Hotella.Agent.csproj" -c Release -r win-x64 --self-contained `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none `
    -p:Version=$Version -o $stage --nologo -v quiet
  if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }
  Copy-Item "$agent/src/Hotella.Agent/agent.example.json" $stage
  # Forward slashes: a trailing backslash would escape the closing quote of the argument.
  $publishDir = $stage.Replace('\', '/') + '/'
  dotnet build "$PSScriptRoot/msi/HotellaAgent.wixproj" -c Release -p:Version=$Version "-p:AgentPublishDir=$publishDir" --nologo
  if ($LASTEXITCODE -ne 0) { throw 'MSI build failed' }
  $msi = Get-ChildItem "$PSScriptRoot/msi/bin" -Recurse -Filter "hotella-agent-$Version-win-x64.msi" | Select-Object -First 1
  if (-not $msi) { throw 'MSI not found after the build' }
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  $target = Join-Path $Out $msi.Name
  Copy-Item $msi.FullName $target -Force
  (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant() | Set-Content -NoNewline "$target.sha256"
  Write-Output $target
} finally {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
