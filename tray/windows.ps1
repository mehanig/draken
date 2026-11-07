# Native notification-area helper. Executed as fixed packaged PowerShell code;
# never evaluates presentation data or changes execution/application-control policy.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) { throw 'An interactive Windows desktop is required' }
$statePath = $env:DRAKEN_TRAY_STATE
$assets = $env:DRAKEN_TRAY_ASSETS
$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$items = @{}
$icons = @{}
$timer = New-Object System.Windows.Forms.Timer

function Emit($value) {
    [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}
function Add-Item($id, $text, $actionable) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Text = $text
    $item.Tag = $id
    $item.Enabled = $actionable
    if ($actionable) {
        $item.add_Click({ param($sender, $eventArgs) Emit @{type='action'; action=[string]$sender.Tag} })
    }
    $items[$id] = $item
    [void]$menu.Items.Add($item)
}
function Update-State {
    # Allow atomic replacement while the parent publishes the next heartbeat.
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = New-Object System.IO.FileStream($statePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    $reader = $null
    try {
        if ($stream.Length -gt 16384) { throw 'Invalid tray state' }
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $state = $reader.ReadToEnd() | ConvertFrom-Json
    } finally {
        if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($state.quit -or [Math]::Abs($now - [double]$state.updated) -gt 15000) {
        $timer.Stop()
        [System.Windows.Forms.Application]::ExitThread()
        return
    }
    if ($state.version -ne 1 -or -not $icons.ContainsKey([string]$state.phase)) { throw 'Invalid tray state' }
    $tray.Icon = $icons[[string]$state.phase]
    $title = [string]$state.title
    $tray.Text = $title.Substring(0, [Math]::Min(63, $title.Length))
    $items.status.Text = $title
    $items.detail.Text = if ($state.detail) { [string]$state.detail } else { 'Server connectivity only - not model readiness' }
    $items.open.Enabled = [bool]$state.canOpen
    $items.start.Enabled = [bool]$state.canStart
    $items.stop.Enabled = [bool]$state.canStop
    $items.quit.Text = if ($state.owned) { 'Quit tray and stop Draken' } else { 'Quit tray (leave server running)' }
}
try {
    foreach ($phase in @('running','stopped','starting','stopping','error')) {
        $icons[$phase] = New-Object System.Drawing.Icon((Join-Path $assets ($phase + '.ico')))
    }
    Add-Item 'status' 'Draken - Starting' $false
    Add-Item 'detail' 'Checking server' $false
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    Add-Item 'open' 'Open Draken' $true
    Add-Item 'start' 'Start Draken (current settings)' $true
    Add-Item 'stop' 'Stop Draken (ends active calls)' $true
    [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    Add-Item 'quit' 'Quit tray' $true
    $tray.ContextMenuStrip = $menu
    $tray.add_DoubleClick({ if ($items.open.Enabled) { Emit @{type='action'; action='open'} } })
    Update-State
    $tray.Visible = $true
    $timer.Interval = 500
    $timer.add_Tick({
        try { Update-State } catch {
            $timer.Stop()
            [System.Windows.Forms.Application]::ExitThread()
        }
    })
    $timer.Start()
    Emit @{type='ready'}
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $timer.Dispose()
    $tray.Visible = $false
    $tray.Dispose()
    $menu.Dispose()
    foreach ($icon in $icons.Values) { $icon.Dispose() }
}
