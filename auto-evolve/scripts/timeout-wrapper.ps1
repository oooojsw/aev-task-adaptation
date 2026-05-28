param(
    [string]$ValidatorScript,
    [string]$PayloadPath,
    [string]$WorkspacePath,
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = "Continue"
$scratchDir = Join-Path $env:TEMP "vw-timeout-$(Get-Random)"
New-Item -ItemType Directory -Path $scratchDir -Force | Out-Null
$resultFile = Join-Path $scratchDir "result.json"
$stdoutFile = Join-Path $scratchDir "stdout.log"
$stderrFile = Join-Path $scratchDir "stderr.log"

$validatorArgs = @($ValidatorScript, $PayloadPath)
if ($WorkspacePath) { $validatorArgs += $WorkspacePath }

$proc = Start-Process -FilePath "bun" -ArgumentList $validatorArgs -NoNewWindow -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile

try {
    $null = Wait-Process -InputObject $proc -Timeout $TimeoutSeconds -ErrorAction Stop
} catch {
    Stop-Process -InputObject $proc -Force -ErrorAction SilentlyContinue
    @{
        passed = $false
        summary = "Validator timed out after ${TimeoutSeconds} seconds"
        details = @("Timeout enforced by timeout-wrapper.ps1", "Validator: $ValidatorScript")
        blocking = $false
        timedOut = $true
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $resultFile -Encoding UTF8
    Write-Output $resultFile
    exit 0
}

if (Test-Path $stdoutFile) {
    $content = Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue
    if ($content) {
        try {
            $json = $content | ConvertFrom-Json
            if ($json) { $json | ConvertTo-Json -Depth 5 | Set-Content -Path $resultFile -Encoding UTF8 }
        } catch { }
    }
}

if (-not (Test-Path $resultFile)) {
    @{
        passed = $false
        summary = "Validator produced no parseable output"
        blocking = $false
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $resultFile -Encoding UTF8
}

Write-Output $resultFile
exit 0
