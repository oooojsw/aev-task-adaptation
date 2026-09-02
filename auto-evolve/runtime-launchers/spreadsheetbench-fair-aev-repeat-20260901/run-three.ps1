$ErrorActionPreference = "Stop"
$project = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$launcher = Join-Path $project "auto-evolve\runtime-launchers\spreadsheetbench-fair-aev-repeat-20260901\run-repeat.ts"
$sequenceRoot = Join-Path $project "auto-evolve\runtime-state\experiment-sequences\20260901-spreadsheetbench-fair-aev-mergeopt-repeats"

New-Item -ItemType Directory -Force -Path $sequenceRoot | Out-Null
Set-Location -LiteralPath $project

function Write-SequenceStatus([string]$State, [int]$ActiveRepeat, [int]$CompletedRepeats, [int]$ExitCode = 0) {
  $payload = [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    state = $State
    activeRepeat = $ActiveRepeat
    completedRepeats = $CompletedRepeats
    totalRepeats = 3
    exitCode = $ExitCode
    reportingPolicy = "Report all repeats, mean, standard deviation, and minimum. Do not select the best repeat."
  } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $sequenceRoot "status.json"), $payload, [Text.UTF8Encoding]::new($false))
}

for ($repeat = 1; $repeat -le 3; $repeat++) {
  $label = $repeat.ToString("00")
  $out = Join-Path $project "auto-evolve\runtime-state\benchmark-runs\20260901-spreadsheetbench-fair-aev-mergeopt-repeats-repeat-$label"
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  Write-SequenceStatus "training" $repeat ($repeat - 1)
  & bun run $launcher "--repeat=$repeat" 1>> (Join-Path $out "wrapper-stdout.log") 2>> (Join-Path $out "wrapper-stderr.log")
  $exitCode = $LASTEXITCODE
  [IO.File]::WriteAllText((Join-Path $out "exit-code.txt"), [string]$exitCode, [Text.UTF8Encoding]::new($false))
  if ($exitCode -ne 0) {
    Write-SequenceStatus "failed" $repeat ($repeat - 1) $exitCode
    exit $exitCode
  }
  Write-SequenceStatus "between_repeats" 0 $repeat
}
Write-SequenceStatus "training_complete" 0 3
