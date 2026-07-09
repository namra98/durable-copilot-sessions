<#
.SYNOPSIS
  One-shot bootstrap for durable-copilot-sessions: clone (if needed), install,
  build, link `dcs` globally, and optionally register the durability tasks.

.DESCRIPTION
  Designed to be run from anywhere. If the repo isn't already present it clones
  it into <Dir> (default: the current directory). Then it runs the standard
  setup (npm install + build + npm link) so the `dcs` command is on your PATH.

  Remote one-liner (requires access to the repo + git/gh + Node >= 20):

    irm https://raw.githubusercontent.com/namra98/durable-copilot-sessions/main/scripts/bootstrap.ps1 | iex

  (For a private repo, clone with `gh repo clone` first, or run this script from
  a local checkout.)

.PARAMETER Dir
  Parent directory to clone into. Defaults to the current directory.

.PARAMETER NoTasks
  Skip registering the auto-snapshot + logon-restore Scheduled Tasks.

.EXAMPLE
  irm https://raw.githubusercontent.com/namra98/durable-copilot-sessions/main/scripts/bootstrap.ps1 | iex
  .\scripts\bootstrap.ps1 -NoTasks
#>
param(
  [string]$Dir = (Get-Location).Path,
  [switch]$NoTasks
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/namra98/durable-copilot-sessions.git"
$RepoName = "durable-copilot-sessions"

# Resolve the repo root: either we're already inside it, or we clone it.
if (Test-Path (Join-Path (Get-Location) "package.json")) {
  $root = (Get-Location).Path
} else {
  $target = Join-Path $Dir $RepoName
  if (-not (Test-Path $target)) {
    Write-Host "==> Cloning $RepoUrl ..." -ForegroundColor Cyan
    git clone $RepoUrl $target
  }
  $root = $target
}

Set-Location $root

Write-Host "==> Installing dependencies..." -ForegroundColor Cyan
npm install | Out-Null

Write-Host "==> Building..." -ForegroundColor Cyan
npm run build | Out-Null

Write-Host "==> Linking Rust-backed 'dcs' globally (npm link)..." -ForegroundColor Cyan
npm link | Out-Null

if (-not $NoTasks) {
  Write-Host "==> Registering Scheduled Tasks (auto-snapshot + logon restore)..." -ForegroundColor Cyan
  node (Join-Path $root "dist\cli\rust-bin.js") install-tasks
}

Write-Host ""
Write-Host "Done. The Rust-backed 'dcs' command is now available." -ForegroundColor Green
Write-Host "  dcs doctor          # verify your environment"
Write-Host "  dcs serve           # start the Rust API"
Write-Host "  dcs install-tasks   # auto-snapshot + restore-on-login (if not already)"
