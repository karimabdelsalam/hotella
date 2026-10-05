# CI smoke for the MSI (a Windows runner, as Administrator): installs, checks what `setup` laid out, proves an
# enrollment code given to the installer reaches neither the MSI log nor the disk, and uninstalls cleanly.
#   pwsh packaging/windows/smoke-msi.ps1 -Msi dist/hotella-agent-<v>-win-x64.msi
param([Parameter(Mandatory = $true)][string]$Msi)
$ErrorActionPreference = 'Stop'
$Msi = (Resolve-Path $Msi).Path
$root = Join-Path $env:ProgramFiles 'Hotella\Agent'
$data = Join-Path $env:ProgramData 'Hotella\Agent'
$logs = Join-Path ([IO.Path]::GetTempPath()) "hotella-msi-logs-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Invoke-Msi([string[]]$Arguments, [string]$Log) {
  $p = Start-Process msiexec.exe -ArgumentList ($Arguments + @('/qn', '/l*v', "`"$Log`"")) -Wait -PassThru
  if ($p.ExitCode -ne 0) { Get-Content $Log -Tail 80; throw "msiexec $($Arguments[0]) exited $($p.ExitCode)" }
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "smoke failed: $Message" } }

# 1. Without codes: the single-instance layout, the service registered (not started: nothing enrolled yet).
Invoke-Msi @('/i', "`"$Msi`"") "$logs\install.log"
Assert (Test-Path "$root\current\hotella-agent.exe") 'current\hotella-agent.exe'
Assert ((Get-Item "$root\current").LinkType -eq 'SymbolicLink') 'current is a link'
Assert (Test-Path "$data\agent.json") 'default settings'
$service = Get-Service HotellaAgent -ErrorAction SilentlyContinue
Assert ($null -ne $service) 'service HotellaAgent'
Assert ($service.StartType -eq 'Automatic') 'automatic start'
$acl = (Get-Acl $data).Access | ForEach-Object { $_.IdentityReference.Value }
Assert (-not ($acl -match 'Users')) 'data directory not readable by Users'
Invoke-Msi @('/x', "`"$Msi`"") "$logs\uninstall.log"
Assert ($null -eq (Get-Service HotellaAgent -ErrorAction SilentlyContinue)) 'service removed'
Assert (-not (Test-Path "$root\current")) 'current removed'
Assert (Test-Path "$data\agent.json") 'data kept without REMOVE_DATA'

# 2. With an enrollment code (refused: nothing listens there): never in the log, never left on disk.
$token = 'hagt_smoke' + [guid]::NewGuid().ToString('N')
$json = '{"g":"https://127.0.0.1:9","t":"' + $token + '","c":"' + ('ab' * 32) + '"}'
$code = 'hotella1.' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
Invoke-Msi @('/i', "`"$Msi`"", "ENROLLMENT_CODE_1=$code") "$logs\install-code.log"
$log = Get-Content -Raw "$logs\install-code.log"
Assert (-not $log.Contains($token)) 'token not in the MSI log'
Assert (-not $log.Contains($code)) 'code not in the MSI log'
Assert ($log.Contains('enrollment code(s) handed to setup')) 'codes handed to setup'
Assert ($log.Contains('an enrollment code was refused')) 'setup reported the refused code'
Assert (-not (Test-Path "$data\enroll.codes")) 'codes file deleted'
Invoke-Msi @('/x', "`"$Msi`"", 'REMOVE_DATA=1') "$logs\uninstall-data.log"
Assert (-not (Test-Path $data)) 'data removed with REMOVE_DATA=1'
Assert (-not (Test-Path "$root\versions")) 'versions removed'
Write-Output 'MSI smoke passed'
