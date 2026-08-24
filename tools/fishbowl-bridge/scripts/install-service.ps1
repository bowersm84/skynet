# install-service.ps1 — installs the bridge as a Windows service with NSSM. Run as Administrator on the Fishbowl server.
# Prereqs: Node.js >= 18 on PATH, nssm.exe on PATH (https://nssm.cc), `npm install` done, .env filled in.
param(
  [string]$ServiceName = 'SkyNetFishbowlBridge',
  [string]$Nssm = 'nssm'
)
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot          # tools\fishbowl-bridge
$node  = (Get-Command node).Source
$entry = Join-Path $root 'src\index.mjs'
$logs  = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
if (-not (Test-Path (Join-Path $root '.env'))) { throw ".env not found in $root - copy .env.example to .env and fill it in first" }
if (-not (Test-Path (Join-Path $root 'node_modules'))) { throw "node_modules not found in $root - run npm install first" }

& $Nssm install $ServiceName $node $entry
& $Nssm set $ServiceName AppDirectory $root
& $Nssm set $ServiceName DisplayName 'SkyNet Fishbowl Bridge'
& $Nssm set $ServiceName Description 'Mirrors Fishbowl sales orders into SkyNet MES (read-only against Fishbowl).'
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName AppStdout (Join-Path $logs 'service-stdout.log')
& $Nssm set $ServiceName AppStderr (Join-Path $logs 'service-stderr.log')
& $Nssm set $ServiceName AppRotateFiles 1
& $Nssm set $ServiceName AppRotateBytes 10485760
& $Nssm set $ServiceName AppExit Default Restart
& $Nssm set $ServiceName AppRestartDelay 10000
& $Nssm set $ServiceName AppStopMethodConsole 15000
& $Nssm start $ServiceName
Write-Host "Installed and started $ServiceName. Logs: $logs"
Write-Host "Manage with: nssm status|stop|start|restart $ServiceName"
