$ErrorActionPreference = "Stop"
$project = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$script = Join-Path $project "auto-evolve\runtime-launchers\spreadsheetbench-mergeopt-repeat-20260811\run-minimax-test280.ps1"
$sequence = Join-Path $project "auto-evolve\runtime-state\experiment-sequences\20260814-spreadsheetbench-three-repeat-minimax-test280"

New-Item -ItemType Directory -Force -Path $sequence | Out-Null
$stdout = Join-Path $sequence "wrapper-stdout.log"
$stderr = Join-Path $sequence "wrapper-stderr.log"
$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -Workers 2 -ExecTimeout 600'
$process = Start-Process -FilePath "powershell.exe" -ArgumentList $argLine -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
[IO.File]::WriteAllText((Join-Path $sequence "wrapper.pid"), [string]$process.Id, [Text.UTF8Encoding]::new($false))
Write-Output $process.Id
