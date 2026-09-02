param(
  [ValidateRange(1, 8)][int]$Workers = 2,
  [int]$ExecTimeout = 600
)

$ErrorActionPreference = "Stop"
$skillOpt = "C:\Users\ZhuanZ\Desktop\SkillOpt"
$authPath = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\.opencode-private\data\opencode\auth.json"
$mergeOptSkill = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\runtime-state\benchmark-runs\20260804-spreadsheetbench69-merge-as-opt-minimax27\merge-and-validate\phase2-skillopt\native-train\best_skill.md"
$sequenceRoot = Join-Path $skillOpt "outputs\spreadsheetbench-minimax27-five-condition-20260809"
$statusPath = Join-Path $sequenceRoot "sequence-status.json"

if (-not (Test-Path -LiteralPath $authPath)) {
  throw "Isolated Auto-Evolve auth snapshot is missing."
}
$auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
$credential = [string]$auth.'minimax-cn-coding-plan'.key
if ([string]::IsNullOrWhiteSpace($credential)) {
  throw "MiniMax Coding Plan credential is missing from the isolated snapshot."
}

$env:MINIMAX_API_KEY = $credential
$env:MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic/v1"
$env:MINIMAX_MODEL = "MiniMax-M2.7"
$env:MINIMAX_ENABLE_THINKING = "false"

$runs = @(
  @{ id = "no-skill"; skill = Join-Path $skillOpt "empty-no-skill.md" },
  @{ id = "aev-merge-as-old"; skill = Join-Path $skillOpt "outputs\spreadsheetbench-aev-merged-skill-20260720.md" },
  @{ id = "optminimax-m27"; skill = Join-Path $skillOpt "outputs\spreadsheetbench-optminimax-m27-training-20260719-140245\best_skill.md" },
  @{ id = "aev-merge-as-opt"; skill = $mergeOptSkill },
  @{ id = "skillopt-official"; skill = Join-Path $skillOpt "ckpt\spreadsheetbench\gpt5.5_skill.md" }
)

New-Item -ItemType Directory -Force -Path $sequenceRoot | Out-Null

function Get-ResultCount([string]$OutRoot) {
  $resultPath = Join-Path $OutRoot "results.jsonl"
  if (-not (Test-Path -LiteralPath $resultPath)) { return 0 }
  return @(Get-Content -LiteralPath $resultPath -Encoding UTF8 | Where-Object { $_.Trim() }).Count
}

function Write-Status([string]$State, [string]$ActiveRun, [string]$Message = "") {
  $conditions = @()
  foreach ($run in $runs) {
    $outRoot = Join-Path $sequenceRoot $run.id
    $conditions += [ordered]@{
      id = $run.id
      resultCount = Get-ResultCount $outRoot
      summaryExists = Test-Path -LiteralPath (Join-Path $outRoot "eval_summary.json")
    }
  }
  [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    state = $State
    activeRun = $ActiveRun
    message = $Message
    model = "MiniMax-M2.7"
    mode = "SkillOpt native multi"
    split = "official test280"
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
    $outRoot = Join-Path $sequenceRoot $run.id
    $summaryPath = Join-Path $outRoot "eval_summary.json"
    if (Test-Path -LiteralPath $summaryPath) {
      try {
        $summary = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$summary.n_items -eq 280) {
          Write-Status "running" $run.id "Already complete; skipped."
          continue
        }
      } catch {
        # An incomplete summary resumes from the existing results.jsonl ledger.
      }
    }

    New-Item -ItemType Directory -Force -Path $outRoot | Out-Null
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
      "--out_root", $outRoot,
      "--mode", "multi",
      "--max_turns", "30",
      "--workers", [string]$Workers,
      "--cfg-options", "env.exec_timeout=$ExecTimeout"
    )

    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & python.exe @args 1>> (Join-Path $outRoot "stdout.log") 2>> (Join-Path $outRoot "stderr.log")
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    Set-Content -LiteralPath (Join-Path $outRoot "exit-code.txt") -Value $exitCode -Encoding ascii
    if ($exitCode -ne 0) {
      throw "Evaluator $($run.id) exited with code $exitCode."
    }
  }
  Write-Status "complete" "" "All five MiniMax M2.7 conditions completed."
} catch {
  Write-Status "failed" "" $_.Exception.Message
  throw
} finally {
  Remove-Item Env:MINIMAX_API_KEY -ErrorAction SilentlyContinue
}
