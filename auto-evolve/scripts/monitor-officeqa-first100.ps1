param(
  [int]$IntervalSeconds = 1800,
  [int]$MaxChecks = 10,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$SplitFile = Join-Path $ProjectRoot "auto-evolve\task-packs\real-long-tasks\officeqa-pro-learnbench\splits\first-100.json"
$ResultFile = Join-Path $ProjectRoot "runtime-state\officeqa-pro-runs\officeqa-pro-first-100-concurrency-5-result.json"
$LogFile = Join-Path $ProjectRoot "runtime-state\officeqa-pro-runs\officeqa-pro-first-100-monitor.log"
$OutLog = Join-Path $ProjectRoot "runtime-state\officeqa-pro-runs\officeqa-pro-first-100-run.out.log"
$ErrLog = Join-Path $ProjectRoot "runtime-state\officeqa-pro-runs\officeqa-pro-first-100-run.err.log"

New-Item -ItemType Directory -Force -Path (Split-Path $ResultFile) | Out-Null

function Write-HeartbeatLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  Write-Output $line
}

function Get-OfficeQaRunnerProcess {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -match "run-officeqa-pro-experiment\.ts" -and
      $_.CommandLine -match [regex]::Escape($ResultFile)
    }
}

function Get-ResultSummary {
  if (!(Test-Path $ResultFile)) {
    return [PSCustomObject]@{ Total = 0; Complete = 0; Running = 0; Failed = 0; Incomplete = 100; Statuses = "no-result-file" }
  }
  $parsed = Get-Content -Raw $ResultFile | ConvertFrom-Json
  $items = if ($parsed -is [array]) { $parsed } else { @($parsed) }
  $completeStatuses = @("verified_success", "exhausted_failure")
  $complete = @($items | Where-Object { $completeStatuses -contains $_.status }).Count
  $running = @($items | Where-Object { $_.status -eq "running" }).Count
  $failed = @($items | Where-Object { $_.status -eq "failed" }).Count
  $groups = $items | Group-Object status | ForEach-Object { "$($_.Name)=$($_.Count)" }
  [PSCustomObject]@{
    Total = $items.Count
    Complete = $complete
    Running = $running
    Failed = $failed
    Incomplete = 100 - $complete
    Statuses = ($groups -join ",")
  }
}

function Start-OfficeQaRunner {
  $command = @"
`$env:OFFICEQA_PRO_CONCURRENCY='5'
`$env:OFFICEQA_PRO_RUN_LIMIT='100'
`$env:OFFICEQA_PRO_SPLIT_FILE='$SplitFile'
`$env:OFFICEQA_PRO_RESULT_FILE='$ResultFile'
Set-Location '$ProjectRoot'
bun run auto-evolve\scripts\run-officeqa-pro-experiment.ts
"@
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog
}

for ($i = 1; $i -le $MaxChecks; $i += 1) {
  $summary = Get-ResultSummary
  $runner = @(Get-OfficeQaRunnerProcess)
  Write-HeartbeatLog "check=$i total=$($summary.Total) complete=$($summary.Complete) running=$($summary.Running) failed=$($summary.Failed) incomplete=$($summary.Incomplete) statuses=$($summary.Statuses) runnerCount=$($runner.Count)"

  if ($summary.Complete -ge 100) {
    Write-HeartbeatLog "stop=complete"
    break
  }

  if ($runner.Count -eq 0 -and !$NoStart) {
    Write-HeartbeatLog "action=start-runner"
    Start-OfficeQaRunner
  }

  if ($i -lt $MaxChecks) {
    Start-Sleep -Seconds $IntervalSeconds
  }
}

Write-HeartbeatLog "stop=max-checks-or-loop-ended"
