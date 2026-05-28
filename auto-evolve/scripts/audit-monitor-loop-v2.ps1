param(
  [int]$Runs = 20,
  [int]$SleepSeconds = 1800
)

$ErrorActionPreference = "Continue"

$root = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve"
$log = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\runtime-logs\audit-monitor-loop-v2.log"

"[$(Get-Date -Format o)] START audit-monitor-loop-v2" | Add-Content -LiteralPath $log

for ($i = 1; $i -le $Runs; $i++) {
  try {
    $dir = Join-Path $root "runtime-state\long-task-campaigns"
    $rows = @()
    if (Test-Path $dir) {
      $rows = Get-ChildItem -LiteralPath $dir -Directory | ForEach-Object {
        $f = Join-Path $_.FullName "campaign.json"
        if (Test-Path $f) {
          try { $j = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { $j = $null }
          if ($j) { [PSCustomObject]@{ status = [string]$j.status } }
        }
      }
    }

    $grp = $rows | Group-Object status | ForEach-Object { "$($_.Name)=$($_.Count)" }
    $runner = Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq "bun.exe" -and $_.CommandLine -match "run-audit-point-batches.ts"
    }

    if (-not $runner) {
      "[$(Get-Date -Format o)] tick=$i RESTART queue-runner stats=$($grp -join ',')" | Add-Content -LiteralPath $log
      Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile",
        "-Command",
        "$env:AUDIT_POINT_QUEUE_CONCURRENCY='5'; $env:AUDIT_POINT_TRAIN_BACKTEST_ROUNDS='1'; $env:AUDIT_POINT_REPAIR_ATTEMPTS='3'; bun run scripts/run-audit-point-batches.ts"
      ) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    } else {
      "[$(Get-Date -Format o)] tick=$i OK stats=$($grp -join ',')" | Add-Content -LiteralPath $log
    }
  } catch {
    "[$(Get-Date -Format o)] tick=$i ERROR $($_.Exception.Message)" | Add-Content -LiteralPath $log
  }

  if ($i -lt $Runs) {
    Start-Sleep -Seconds $SleepSeconds
  }
}

"[$(Get-Date -Format o)] END audit-monitor-loop-v2" | Add-Content -LiteralPath $log
