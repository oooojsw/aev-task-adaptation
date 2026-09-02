param(
  [ValidateRange(1, 4)][int]$Workers = 2,
  [int]$ExecTimeout = 600
)

$ErrorActionPreference = "Stop"
$project = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$skillOpt = "C:\Users\ZhuanZ\Desktop\SkillOpt"
$authPath = Join-Path $project "auto-evolve\.opencode-private\data\opencode\auth.json"
$sequence = Join-Path $project "auto-evolve\runtime-state\experiment-sequences\20260814-spreadsheetbench-three-repeat-minimax-test280"
$outputRoot = Join-Path $skillOpt "outputs\spreadsheetbench-three-repeat-minimax27-test280-20260814"
$statusPath = Join-Path $sequence "status.json"

$auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
$credential = [string]$auth.'minimax-cn-coding-plan'.key
if ([string]::IsNullOrWhiteSpace($credential)) {
  throw "MiniMax Coding Plan credential is missing from the isolated snapshot."
}

$env:MINIMAX_API_KEY = $credential
$env:MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic/v1"
$env:MINIMAX_MODEL = "MiniMax-M2.7"
$env:MINIMAX_ENABLE_THINKING = "false"

$runs = foreach ($repeat in 1..3) {
  $label = $repeat.ToString("00")
  @{
    id = "repeat-$label"
    skill = Join-Path $project "auto-evolve\runtime-state\benchmark-runs\20260811-spreadsheetbench69-merge-as-opt-minimax27-repeat-$label\merge-and-validate\phase2-skillopt\native-train\best_skill.md"
    out = Join-Path $outputRoot "repeat-$label"
  }
}

New-Item -ItemType Directory -Force -Path $sequence, $outputRoot | Out-Null

function Get-ResultCount([string]$OutRoot) {
  $resultPath = Join-Path $OutRoot "results.jsonl"
  if (-not (Test-Path -LiteralPath $resultPath)) { return 0 }
  return @(Get-Content -LiteralPath $resultPath -Encoding UTF8 | Where-Object { $_.Trim() }).Count
}

function Write-Status([string]$State, [string]$ActiveRun, [string]$Message = "") {
  $conditions = foreach ($run in $runs) {
    [ordered]@{
      id = $run.id
      skill = $run.skill
      out = $run.out
      resultCount = Get-ResultCount $run.out
      summaryExists = Test-Path -LiteralPath (Join-Path $run.out "eval_summary.json")
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
  } | ConvertTo-Json -Depth 6
  [IO.File]::WriteAllText($statusPath, $payload, [Text.UTF8Encoding]::new($false))
}

try {
  Set-Location -LiteralPath $skillOpt
  Write-Status "starting" ""
  foreach ($run in $runs) {
    if (-not (Test-Path -LiteralPath $run.skill)) {
      throw "Skill file not found: $($run.skill)"
    }
    $summaryPath = Join-Path $run.out "eval_summary.json"
    if (Test-Path -LiteralPath $summaryPath) {
      try {
        $summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$summary.n_items -eq 280) {
          Write-Status "running" $run.id "Already complete; skipped."
          continue
        }
      } catch {}
    }

    New-Item -ItemType Directory -Force -Path $run.out | Out-Null
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
      "--out_root", $run.out,
      "--mode", "multi",
      "--max_turns", "30",
      "--workers", [string]$Workers,
      "--cfg-options", "env.exec_timeout=$ExecTimeout"
    )
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & python.exe @args 1>> (Join-Path $run.out "stdout.log") 2>> (Join-Path $run.out "stderr.log")
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    [IO.File]::WriteAllText((Join-Path $run.out "exit-code.txt"), [string]$exitCode, [Text.UTF8Encoding]::new($false))
    if ($exitCode -ne 0) {
      throw "Evaluator $($run.id) exited with code $exitCode."
    }
  }
  Write-Status "complete" "" "All three MiniMax M2.7 test280 evaluations completed."
} catch {
  Write-Status "failed" "" $_.Exception.Message
  throw
} finally {
  Remove-Item Env:MINIMAX_API_KEY -ErrorAction SilentlyContinue
}
