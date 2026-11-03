# package.ps1 — builds the skyserver bundle SkyNetBridge-<version>.zip on the Desktop and prints its SHA256.
# Run from anywhere on Matt's PC after the bridge change is committed:
#   powershell -ExecutionPolicy Bypass -File tools\fishbowl-bridge\scripts\package.ps1
# The zip holds package.json, package-lock.json, README.md, .env.example, src\ and scripts\ (the
# FB1_Cutover_Runbook.md bundle): never node_modules, .env or logs, which stay on skyserver.
param(
  [string]$OutDir = [Environment]::GetFolderPath('Desktop')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # tools\fishbowl-bridge
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $OutDir "SkyNetBridge-$version.zip"
$paths = 'package.json', 'package-lock.json', 'README.md', '.env.example', 'src', 'scripts' | ForEach-Object { Join-Path $root $_ }
Compress-Archive -Force -DestinationPath $zip -Path $paths
$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash
Write-Host "Built $zip"
Write-Host "SHA256 $hash"
