param(
  [ValidateRange(1, 8)][int]$Workers = 5,
  [int]$ExecTimeout = 600
)

$ErrorActionPreference = "Stop"
$skillOpt = "C:\Users\ZhuanZ\Desktop\SkillOpt"
$authPath = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\.opencode-private\data\opencode\auth.json"
$skillPath = Join-Path $skillOpt "ckpt\spreadsheetbench\gpt5.5_skill.md"
$outRoot = Join-Path $skillOpt "outputs\spreadsheetbench-minimax27-skillopt-official-gpt55-skill-retest-20260902"

if (-not (Test-Path -LiteralPath $authPath)) { throw "Isolated MiniMax credential snapshot is missing." }
if (-not (Test-Path -LiteralPath $skillPath)) { throw "SkillOpt official GPT-5.5 Skill is missing." }

$auth = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json
$credential = [string]$auth.'minimax-cn-coding-plan'.key
if ([string]::IsNullOrWhiteSpace($credential)) { throw "MiniMax Coding Plan credential is missing." }

$env:MINIMAX_API_KEY = $credential
$env:MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic/v1"
$env:MINIMAX_MODEL = "MiniMax-M2.7"
$env:MINIMAX_ENABLE_THINKING = "false"
New-Item -ItemType Directory -Force -Path $outRoot | Out-Null

try {
  $evalArgs = @(
    "-u", "scripts/eval_only.py",
    "--config", "configs/spreadsheetbench/default.yaml",
    "--skill", $skillPath,
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
  # Invoke Python as a child process so its non-fatal openpyxl stderr warnings
  # cannot become PowerShell NativeCommandError records.
  $argLine = [string]::Join(" ", $evalArgs)
  $pythonProcess = Start-Process -FilePath "python.exe" -ArgumentList $argLine -WorkingDirectory $skillOpt -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $outRoot "python-stdout.log") -RedirectStandardError (Join-Path $outRoot "python-stderr.log")
  $exitCode = $pythonProcess.ExitCode
  Set-Content -LiteralPath (Join-Path $outRoot "exit-code.txt") -Value $exitCode -Encoding ascii
  if ($exitCode -ne 0) { throw "Evaluator exited with code $exitCode." }
} finally {
  Remove-Item Env:MINIMAX_API_KEY -ErrorAction SilentlyContinue
}
