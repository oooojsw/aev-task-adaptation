param(
  [string]$SkillOptRoot = "C:\Users\ZhuanZ\Desktop\SkillOpt",
  [string]$RecordRoot = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\runtime-state\external-experiments"
)

$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $SkillOptRoot "outputs\officeqa-minimax-m27-retrain-$stamp"
$logs = Join-Path $out "launcher-logs"
$recordDir = Join-Path $RecordRoot "skillopt-officeqa-minimax-m27-$stamp"
New-Item -ItemType Directory -Force -Path $logs, $recordDir | Out-Null

$python = (Get-Command python).Source
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:OFFICEQA_DOCS_DIR = "E:\project\experiment\datasets\OfficeQA_corpus\treasury_bulletins_parsed"
$env:MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic/v1"

$arguments = @(
  "scripts/train.py",
  "--config", "configs/officeqa/default.yaml",
  "--backend", "minimax_chat",
  "--optimizer_model", "MiniMax-M2.7",
  "--target_model", "MiniMax-M2.7",
  "--minimax_base_url", "https://api.minimaxi.com/anthropic/v1",
  "--minimax_model", "MiniMax-M2.7",
  "--minimax_temperature", "0.2",
  "--minimax_max_tokens", "8000",
  "--minimax_enable_thinking", "false",
  "--num_epochs", "4",
  "--train_size", "50",
  "--batch_size", "40",
  "--analyst_workers", "2",
  "--workers", "2",
  "--split_mode", "split_dir",
  "--split_dir", "data/officeqa_id_split",
  "--eval_test", "true",
  "--out_root", $out,
  "--cfg-options",
  "model.optimizer_backend=minimax_chat",
  "model.target_backend=minimax_chat",
  "env.data_dirs=E:/project/experiment/datasets/OfficeQA_corpus/treasury_bulletins_parsed",
  "env.max_tool_turns=24"
)

$quoted = $arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
$argLine = $quoted -join " "
$stdout = Join-Path $logs "stdout.log"
$stderr = Join-Path $logs "stderr.log"
$process = Start-Process -FilePath $python -ArgumentList $argLine -WorkingDirectory $SkillOptRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru

$state = [ordered]@{
  version = 1
  task = "SkillOpt OfficeQA MiniMax-M2.7 retrain and evaluate"
  status = "starting"
  schedule = [ordered]@{
    phase1IntervalSeconds = 900
    phase1Rounds = 4
    phase2IntervalSeconds = 3600
    phase2Rounds = "until_complete"
    currentRound = 0
  }
  model = [ordered]@{
    optimizer = "MiniMax-M2.7"
    target = "MiniMax-M2.7"
    backend = "minimax_chat"
    thinking = $false
  }
  dataset = [ordered]@{
    name = "OfficeQA"
    splitDir = "data/officeqa_id_split"
    train = 50
    validation = 24
    test = 172
  }
  process = [ordered]@{
    pid = $process.Id
    startedAt = (Get-Date).ToString("o")
    python = $python
  }
  paths = [ordered]@{
    skilloptOutput = $out
    stdout = $stdout
    stderr = $stderr
    recordDir = $recordDir
  }
  lineage = [ordered]@{
    freshRun = $true
    previousRun = "C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\officeqa-minimax-m27-codingplan-fixed-official-20260629-195923"
    overwritePrevious = $false
  }
}

$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $recordDir "monitor-state.json") -Encoding utf8
$out | Set-Content -LiteralPath (Join-Path $recordDir "skillopt-output-path.txt") -Encoding utf8
$state | ConvertTo-Json -Depth 8
