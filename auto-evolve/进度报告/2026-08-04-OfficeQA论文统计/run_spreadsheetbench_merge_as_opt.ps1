$ErrorActionPreference = "Continue"
$project = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$launcher = Join-Path $project "auto-evolve\runtime-launchers\spreadsheetbench-matrix-20260804\launch.ts"
$out = Join-Path $project "auto-evolve\runtime-state\benchmark-runs\20260804-spreadsheetbench69-merge-as-opt-minimax27"

Set-Location -LiteralPath $project
& bun run $launcher
$code = $LASTEXITCODE
[IO.File]::WriteAllText(
    (Join-Path $out "exit-code.txt"),
    [string]$code,
    [Text.UTF8Encoding]::new($false)
)
exit $code
