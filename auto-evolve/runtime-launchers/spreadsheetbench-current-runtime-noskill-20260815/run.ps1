param(
  [ValidateRange(1, 4)][int]$Workers = 2,
  [int]$ExecTimeout = 600
)

$ErrorActionPreference = "Stop"
$project = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$skillOpt = "C:\Users\ZhuanZ\Desktop\SkillOpt"
$authPath = Join-Path $project "auto-evolve\.opencode-private\data\opencode\auth.json"
$sequence = Join-Path $project "auto-evolve\runtime-state\experiment-sequences\20260815-spreadsheetbench-current-runtime-noskill-minimax27"
$out = Join-Path $skillOpt "outputs\spreadsheetbench-minimax27-current-runtime-noskill-20260815"
$statusPath = Join-Path $sequence "status.json"
$skill = Join-Path $skillOpt "empty-no-skill.md"

New-Item -ItemType Directory -Force -Path $sequence, $out | Out-Null

function Get-ResultCount {
  $resultPath = Join-Path $out "results.jsonl"
  if (-not (Test-Path -LiteralPath $resultPath)) { return 0 }
  return @(Get-Content -LiteralPath $resultPath -Encoding UTF8 | Where-Object { $_.Trim() }).Count
}

function Write-Status([string]$State, [string]$Message = "") {
  $payload = [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    state = $State
    message = $Message
    model = "MiniMax-M2.7"
    condition = "no-skill"
    mode = "SkillOpt native multi"
    split = "official test280"
    workers = $Workers
    resultCount = Get-ResultCount
    out = $out
  } | ConvertTo-Json -Depth 4
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

  Write-Status "running"
  Set-Location -LiteralPath $skillOpt
  $args = @(
    "-u", "scripts/eval_only.py",
    "--config", "configs/spreadsheetbench/default.yaml",
    "--skill", $skill,
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
  if ($exitCode -ne 0) {
    throw "Evaluator exited with code $exitCode."
  }
  Write-Status "complete"
} catch {
  Write-Status "failed" $_.Exception.Message
  throw
} finally {
  Remove-Item Env:MINIMAX_API_KEY -ErrorAction SilentlyContinue
}
