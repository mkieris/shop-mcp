# Baut das MCP-Bundle (shopware-admin-mcp.mcpb) fuer die Team-Verteilung.
# Aufruf:  powershell -ExecutionPolicy Bypass -File build-bundle.ps1
# Output:  shopware-admin-mcp.mcpb (per Doppelklick in der Claude-App installierbar)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$stage = Join-Path $root "bundle-build"

Write-Host "[1/4] TypeScript bauen (tsc -> dist/)"
Push-Location $root
npm run prepare
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "tsc build failed" }
Pop-Location

Write-Host "[2/4] Staging-Verzeichnis aufsetzen"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item (Join-Path $root "package.json") $stage
Copy-Item (Join-Path $root "package-lock.json") $stage
Copy-Item (Join-Path $root "manifest.json") $stage
Copy-Item (Join-Path $root "dist") (Join-Path $stage "dist") -Recurse

Write-Host "[3/4] Produktions-Abhaengigkeiten installieren"
Push-Location $stage
# --ignore-scripts: das prepare-Script (tsc) wuerde ohne devDependencies fehlschlagen
npm ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm ci failed" }

Write-Host "[4/4] Bundle packen"
npx --yes @anthropic-ai/mcpb pack . (Join-Path $root "shopware-admin-mcp.mcpb")
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "mcpb pack failed" }
Pop-Location

Write-Host ""
Write-Host "Fertig: $root\shopware-admin-mcp.mcpb"
Write-Host "Diese Datei auf SharePoint legen - sie enthaelt KEINE Zugangsdaten."
