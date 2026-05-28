#!/usr/bin/env pwsh
# Launch script for auto-evolve long-task on Windows
# Uses CreateProcess directly to avoid MSYS2/Git Bash shell issues
$ErrorActionPreference = "Stop"

$autoEvolveDir = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve"
$specPath = $args[0]

if (-not $specPath) {
    Write-Error "Usage: launch-long-task.ps1 <spec-path>"
    exit 1
}

$bunExe = "C:\Users\ZhuanZ\AppData\Roaming\npm\node_modules\bun\bin\bun.exe"
if (-not (Test-Path $bunExe)) {
    Write-Error "bun.exe not found at: $bunExe"
    exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $bunExe
$psi.Arguments = "run cli.ts run-long-task --spec `"$specPath`""
$psi.WorkingDirectory = $autoEvolveDir
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::Start($psi)
Write-Output "Started long-task, PID: $($proc.Id)"