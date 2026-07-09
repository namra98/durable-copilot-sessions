<#
.SYNOPSIS
  Always-on system-tray launcher for durable-copilot-sessions (zero dependencies).

.DESCRIPTION
  Shows a tray icon with quick actions (Open API, Snapshot now, Restore
  last). Uses Windows Forms NotifyIcon, so it needs an STA message loop.

  Run it with Windows PowerShell (STA by default):
      powershell.exe -STA -File .\scripts\tray.ps1
  or via the CLI convenience command:
      dcs tray

  To start it automatically at logon, drop a shortcut to that command in
  shell:startup, or use `dcs install-tasks` for the snapshot/restore tasks.
#>
param([int]$Port = 4517)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root "dist\cli\rust-bin.js"
if (-not (Test-Path $cli)) {
  Write-Host "Build first: npm run build" -ForegroundColor Yellow
  exit 1
}

function Invoke-Dcs([string]$ArgsLine) {
  Start-Process -FilePath "node" -ArgumentList ('"' + $cli + '" ' + $ArgsLine) -WindowStyle Hidden
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = "Durable Copilot Sessions"
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Open API health", $null, { Invoke-Dcs "serve --port $Port"; Start-Process "http://127.0.0.1:$Port/api/health" })
[void]$menu.Items.Add("Snapshot now", $null, { Invoke-Dcs "snapshot" })
[void]$menu.Items.Add("Restore last", $null, { Invoke-Dcs "restore-last" })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add("Quit tray", $null, {
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  })
$icon.ContextMenuStrip = $menu
$icon.add_MouseDoubleClick({ Start-Process "http://127.0.0.1:$Port/api/health" })

[System.Windows.Forms.Application]::Run()
