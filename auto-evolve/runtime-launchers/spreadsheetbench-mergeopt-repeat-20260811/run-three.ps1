$ErrorActionPreference = "Continue"
$project = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest"
$launcher = Join-Path $project "auto-evolve\runtime-launchers\spreadsheetbench-mergeopt-repeat-20260811\run-repeat.ts"
$sequenceRoot = Join-Path $project "auto-evolve\runtime-state\experiment-sequences\20260811-spreadsheetbench-mergeopt-three-repeats"

New-Item -ItemType Directory -Force -Path $sequenceRoot | Out-Null
Set-Location -LiteralPath $project

foreach ($repeat in 1..3) {
    $label = $repeat.ToString("00")
    $out = Join-Path $project "auto-evolve\runtime-state\benchmark-runs\20260811-spreadsheetbench69-merge-as-opt-minimax27-repeat-$label"
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    $attempt = 0
    $exitCode = 1
    while ($attempt -lt 3 -and $exitCode -ne 0) {
        $attempt += 1
        [ordered]@{
            updatedAt = (Get-Date).ToString("o")
            state = "training"
            activeRepeat = $repeat
            repeatAttempt = $attempt
            completedRepeats = $repeat - 1
            totalRepeats = 3
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sequenceRoot "status.json") -Encoding UTF8

        & bun run $launcher "--repeat=$repeat" 1>> (Join-Path $out "wrapper-stdout.log") 2>> (Join-Path $out "wrapper-stderr.log")
        $exitCode = $LASTEXITCODE
        [IO.File]::WriteAllText((Join-Path $out "exit-code.txt"), [string]$exitCode, [Text.UTF8Encoding]::new($false))
        if ($exitCode -ne 0 -and $attempt -lt 3) { Start-Sleep -Seconds 30 }
    }
    if ($exitCode -ne 0) {
        [ordered]@{
            updatedAt = (Get-Date).ToString("o")
            state = "failed"
            activeRepeat = $repeat
            repeatAttempt = $attempt
            completedRepeats = $repeat - 1
            totalRepeats = 3
            exitCode = $exitCode
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sequenceRoot "status.json") -Encoding UTF8
        exit $exitCode
    }
}

[ordered]@{
    updatedAt = (Get-Date).ToString("o")
    state = "training_complete"
    activeRepeat = 0
    repeatAttempt = 0
    completedRepeats = 3
    totalRepeats = 3
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sequenceRoot "status.json") -Encoding UTF8
exit 0
