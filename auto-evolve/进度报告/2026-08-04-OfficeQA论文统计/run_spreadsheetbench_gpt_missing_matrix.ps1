param(
  [string]$BaseUrl = "http://localhost:63384/v1",
  [ValidateRange(1, 8)][int]$Workers = 2,
  [int]$ExecTimeout = 600
)

$ErrorActionPreference = "Stop"
$skillOpt = "C:\Users\ZhuanZ\Desktop\SkillOpt"
$mergeOptSkill = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\runtime-state\benchmark-runs\20260804-spreadsheetbench69-merge-as-opt-minimax27\merge-and-validate\phase2-skillopt\native-train\best_skill.md"
$sequenceRoot = Join-Path $skillOpt "outputs\spreadsheetbench-gpt-missing-matrix-20260809"
$statusPath = Join-Path $sequenceRoot "sequence-status.json"

if ([string]::IsNullOrWhiteSpace($env:QWEN_CHAT_API_KEY)) {
  $sidecarConfigPath = "C:\Users\ZhuanZ\.antigravity_cockpit\codex_local_access_sidecar\config.json"
  if (-not (Test-Path -LiteralPath $sidecarConfigPath)) {
    throw "QWEN_CHAT_API_KEY is missing and the local 63384 sidecar config was not found."
  }
  $sidecarConfig = Get-Content -LiteralPath $sidecarConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $sidecarKeys = @($sidecarConfig.'api-keys')
  if ($sidecarKeys.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$sidecarKeys[0])) {
    throw "The local 63384 sidecar config contains no usable API key."
  }
  $env:QWEN_CHAT_API_KEY = [string]$sidecarKeys[0]
}
$env:QWEN_CHAT_BASE_URL = $BaseUrl
$env:QWEN_CHAT_ENABLE_THINKING = "false"

$runs = @(
  @{
    id = "gpt54mini-merge-as-opt"
    model = "gpt-5.4-mini"
    skill = $mergeOptSkill
    out = Join-Path $skillOpt "outputs\spreadsheetbench-gpt54mini-mergeopt-63384-20260809"
  },
  @{
    id = "gpt54-merge-as-opt"
    model = "gpt-5.4"
    skill = $mergeOptSkill
    out = Join-Path $skillOpt "outputs\spreadsheetbench-gpt54-mergeopt-63384-20260809"
  },
  @{
    id = "gpt55-merge-as-old"
    model = "gpt-5.5"
    skill = Join-Path $skillOpt "outputs\spreadsheetbench-aev-merged-skill-20260720.md"
    out = Join-Path $skillOpt "outputs\spreadsheetbench-gpt55-aev-minimax-m27-skill-63384-20260722"
  },
  @{
    id = "gpt55-optminimax-m27"
    model = "gpt-5.5"
    skill = Join-Path $skillOpt "outputs\spreadsheetbench-optminimax-m27-training-20260719-140245\best_skill.md"
    out = Join-Path $skillOpt "outputs\spreadsheetbench-gpt55-optminimax-m27-skill-63384-20260722"
  },
  @{
    id = "gpt55-merge-as-opt"
    model = "gpt-5.5"
    skill = $mergeOptSkill
    out = Join-Path $skillOpt "outputs\spreadsheetbench-gpt55-mergeopt-63384-20260809"
  },
  @{
    id = "gpt55-skillopt-official"
    model = "gpt-5.5"
    skill = Join-Path $skillOpt "ckpt\spreadsheetbench\gpt5.5_skill.md"
    out = Join-Path $skillOpt "outputs\spreadsheetbench-gpt55-skillopt-official-gpt55-skill-63384-20260722"
  }
)

New-Item -ItemType Directory -Force -Path $sequenceRoot | Out-Null

function Get-ResultCount([string]$OutRoot) {
  $path = Join-Path $OutRoot "results.jsonl"
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  return @(Get-Content -LiteralPath $path -Encoding UTF8 | Where-Object { $_.Trim() }).Count
}

function Write-Status([string]$State, [string]$ActiveRun, [string]$Message = "") {
  $conditions = foreach ($run in $runs) {
    [ordered]@{
      id = $run.id
      model = $run.model
      resultCount = Get-ResultCount $run.out
      summaryExists = Test-Path -LiteralPath (Join-Path $run.out "eval_summary.json")
    }
  }
  [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    state = $State
    activeRun = $ActiveRun
    message = $Message
    baseUrl = $BaseUrl
    mode = "SkillOpt native multi"
    split = "official test280"
    maxTurns = 30
    workers = $Workers
    conditions = $conditions
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

try {
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
      } catch {
        # Resume from the existing results ledger when the summary is incomplete.
      }
    }

    New-Item -ItemType Directory -Force -Path $run.out | Out-Null
    Write-Status "running" $run.id
    $args = @(
      "-u", "scripts/eval_only.py",
      "--config", "configs/spreadsheetbench/default.yaml",
      "--skill", $run.skill,
      "--split", "test",
      "--backend", "qwen_chat",
      "--target_model", $run.model,
      "--target_backend", "qwen_chat",
      "--qwen_chat_base_url", $BaseUrl,
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
    Set-Content -LiteralPath (Join-Path $run.out "exit-code.txt") -Value $exitCode -Encoding ascii
    if ($exitCode -ne 0) {
      throw "Evaluator $($run.id) exited with code $exitCode."
    }
  }
  Write-Status "complete" "" "All missing GPT SpreadsheetBench matrix conditions completed."
} catch {
  Write-Status "failed" "" $_.Exception.Message
  throw
}
