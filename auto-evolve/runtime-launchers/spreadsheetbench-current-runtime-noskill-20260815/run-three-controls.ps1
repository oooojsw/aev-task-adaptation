param(
  [ValidateRange(1, 4)][int]$Workers = 2,
  [int]$ExecTimeout = 600
)

$ErrorActionPreference = "Stop"
$project = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$skillOpt = "C:\Users\ZhuanZ\Desktop\SkillOpt"
$authPath = Join-Path $project "auto-evolve\.opencode-private\data\opencode\auth.json"
$sequence = Join-Path $project "auto-evolve\runtime-state\experiment-sequences\20260815-spreadsheetbench-minimax27-corrected-controls"
$outputRoot = Join-Path $skillOpt "outputs\spreadsheetbench-minimax27-corrected-controls-20260815"
$statusPath = Join-Path $sequence "status.json"

$runs = @(
  @{ id = "aev-merge-as-old"; skill = Join-Path $skillOpt "outputs\spreadsheetbench-aev-merged-skill-20260720.md" },
  @{ id = "optminimax-m27"; skill = Join-Path $skillOpt "outputs\spreadsheetbench-optminimax-m27-training-20260719-140245\best_skill.md" },
  @{ id = "skillopt-official"; skill = Join-Path $skillOpt "ckpt\spreadsheetbench\gpt5.5_skill.md" }
)

New-Item -ItemType Directory -Force -Path $sequence, $outputRoot | Out-Null

function Get-ResultCount([string]$OutRoot) {
  $resultPath = Join-Path $OutRoot "results.jsonl"
  if (-not (Test-Path -LiteralPath $resultPath)) { return 0 }
  return @(Get-Content -LiteralPath $resultPath -Encoding UTF8 | Where-Object { $_.Trim() }).Count
}

function Write-Status([string]$State, [string]$ActiveRun = "", [string]$Message = "") {
  $conditions = foreach ($run in $runs) {
    $out = Join-Path $outputRoot $run.id
    [ordered]@{
      id = $run.id
      resultCount = Get-ResultCount $out
      summaryExists = Test-Path -LiteralPath (Join-Path $out "eval_summary.json")
    }
  }
  $payload = [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    state = $State
    activeRun = $ActiveRun
    message = $Message
    model = "MiniMax-M2.7"
    mode = "SkillOpt native multi"
    split = "official test280"
    workers = $Workers
    conditions = $conditions
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($statusPath, $payload, [Text.UTF8Encoding]::new($false))
}

try {
  $auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $credential = [string]$auth.'minimax-cn-coding-plan'.key
  if ([string]::IsNullOrWhiteSpace($credential)) {
    throw "MiniMax Coding Plan credential is missing from the isolated snapshot."
  }
  $env:MINIMAX_API_KEY = $credential
  $env:MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic/v1"
  $env:MINIMAX_MODEL = "MiniMax-M2.7"
  $env:MINIMAX_ENABLE_THINKING = "false"

  Set-Location -LiteralPath $skillOpt
  Write-Status "starting"
  foreach ($run in $runs) {
    if (-not (Test-Path -LiteralPath $run.skill)) {
      throw "Skill file not found: $($run.skill)"
    }
    $out = Join-Path $outputRoot $run.id
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    $summaryPath = Join-Path $out "eval_summary.json"
    if (Test-Path -LiteralPath $summaryPath) {
      $summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ([int]$summary.n_items -eq 280) { continue }
    }
    Write-Status "running" $run.id
    $args = @(
      "-u", "scripts/eval_only.py",
      "--config", "configs/spreadsheetbench/default.yaml",
      "--skill", $run.skill,
      "--split", "test",
      "--backend", "minimax_chat",
      "--target_model", "MiniMax-M2.7",
      "--target_backend", "minimax_chat",
      "--minimax_base_url", "https://api.minimaxi.com/anthropic/v1",
      "--split_dir", "data/spreadsheetbench_split",
      "--data_root", "E:/project/experiment/SpreadsheetBench/all_data_912_v0.1",
      "--out_root", $out,
      "--mode", "multi",
      "--max_turns", "30",
      "--workers", [string]$Workers,
      "--cfg-options", "env.exec_timeout=$ExecTimeout"
    )
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & python.exe @args 1>> (Join-Path $out "stdout.log") 2>> (Join-Path $out "stderr.log")
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    [IO.File]::WriteAllText((Join-Path $out "exit-code.txt"), [string]$exitCode, [Text.UTF8Encoding]::new($false))
    if ($exitCode -ne 0) { throw "Evaluator $($run.id) exited with code $exitCode." }
  }
  Write-Status "complete" "" "All corrected controls completed."
} catch {
  Write-Status "failed" "" $_.Exception.Message
  throw
} finally {
  Remove-Item Env:MINIMAX_API_KEY -ErrorAction SilentlyContinue
}
