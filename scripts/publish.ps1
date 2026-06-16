<#
.SYNOPSIS
  Publish durable-copilot-sessions to GitHub under your personal account.

.DESCRIPTION
  Creates the remote repository (if needed) and pushes `main` plus the current
  feature branch. Run this from an INTERACTIVE terminal so Git Credential
  Manager can prompt for your namra98 credentials if they are not cached.

.EXAMPLE
  # Fully automated (creates the repo via API and pushes):
  $env:GH_TOKEN = "<namra98 PAT with 'repo' scope>"
  .\scripts\publish.ps1

.EXAMPLE
  # If you created the empty repo yourself on github.com first:
  .\scripts\publish.ps1
#>
param(
  [string]$Owner = "namra98",
  [string]$Name = "durable-copilot-sessions",
  [switch]$Public
)

$ErrorActionPreference = "Stop"
$repo = "$Owner/$Name"
$visibility = if ($Public) { "public" } else { "private" }
$remoteUrl = "https://github.com/$repo.git"

function Test-RepoExists {
  git ls-remote $remoteUrl HEAD *> $null
  return ($LASTEXITCODE -eq 0)
}

# 1) Ensure the remote repository exists.
if (-not (Test-RepoExists)) {
  if ($env:GH_TOKEN) {
    $body = @{ name = $Name; private = (-not $Public) } | ConvertTo-Json
    Invoke-RestMethod -Method POST -Uri "https://api.github.com/user/repos" `
      -Headers @{
        Authorization = "token $($env:GH_TOKEN)"
        "User-Agent"  = "dcs-publish"
        Accept        = "application/vnd.github+json"
      } -Body $body | Out-Null
    Write-Host "Created $visibility repo $repo via API."
  }
  elseif (Get-Command gh -ErrorAction SilentlyContinue) {
    Write-Host "Creating $repo via gh (ensure gh is authenticated as $Owner)..."
    gh repo create $repo "--$visibility" --disable-wiki 2>$null
  }
  else {
    throw "Repo $repo does not exist. Create it (private) at https://github.com/new, or set `$env:GH_TOKEN and re-run."
  }
}

# 2) Wire the remote.
$hasOrigin = (git remote) -contains "origin"
if ($hasOrigin) { git remote set-url origin $remoteUrl } else { git remote add origin $remoteUrl }

# 3) Push main + the current branch.
git push -u origin main
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { git push -u origin $branch }

Write-Host ""
Write-Host "Done. Open a pull request:"
Write-Host "  https://github.com/$repo/compare/main...$branch?expand=1"
