<#
.SYNOPSIS
  Build durable-copilot-sessions and make the `dcs` command available globally.

.DESCRIPTION
  Installs dependencies, builds, and runs `npm link` so `dcs` is on your PATH.
  Run from anywhere; it operates on the repo this script lives in.

.EXAMPLE
  .\scripts\install.ps1
  .\scripts\install.ps1 -WithTasks    # also register auto-snapshot + logon restore
#>
param(
  [switch]$WithTasks
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Installing dependencies..." -ForegroundColor Cyan
npm install | Out-Null

Write-Host "==> Building..." -ForegroundColor Cyan
npm run build | Out-Null

Write-Host "==> Linking Rust-backed 'dcs' globally (npm link)..." -ForegroundColor Cyan
npm link | Out-Null

if ($WithTasks) {
  Write-Host "==> Registering Scheduled Tasks (auto-snapshot + logon restore)..." -ForegroundColor Cyan
  dcs install-tasks
}

Write-Host ""
Write-Host "Done. The Rust-backed 'dcs' command is now available." -ForegroundColor Green
Write-Host "  dcs doctor          # verify your environment"
Write-Host "  dcs ui              # open the dashboard"
Write-Host "  dcs list            # list open sessions"
Write-Host "  dcs install-tasks   # auto-snapshot + restore-on-login (if not already)"
Write-Host "  .\scripts\tray.ps1  # optional always-on system tray"
