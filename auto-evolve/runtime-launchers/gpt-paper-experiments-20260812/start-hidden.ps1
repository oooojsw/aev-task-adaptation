$ErrorActionPreference = "Stop"
$root = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$script = Join-Path $root "auto-evolve\runtime-launchers\gpt-paper-experiments-20260812\run-sequence.ps1"
$sequence = Join-Path $root "auto-evolve\runtime-state\experiment-sequences\20260812-gpt-paper-experiments-1-to-4"
New-Item -ItemType Directory -Force -Path $sequence | Out-Null
$stdout = Join-Path $sequence "wrapper-stdout.log"
$stderr = Join-Path $sequence "wrapper-stderr.log"
$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"'
$process = Start-Process -FilePath "powershell.exe" -ArgumentList $argLine -WorkingDirectory "C:\Users\ZhuanZ\Desktop\SkillOpt" -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
[IO.File]::WriteAllText((Join-Path $sequence "wrapper.pid"), [string]$process.Id, [Text.UTF8Encoding]::new($false))
Write-Output $process.Id
