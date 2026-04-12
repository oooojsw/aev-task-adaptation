param(
  [Parameter(Mandatory = $true)]
  [string]$InputJsonPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedToken
)

$ErrorActionPreference = "Stop"

$payload = Get-Content -LiteralPath $InputJsonPath -Raw | ConvertFrom-Json
$targetPaths = @($payload.targetPaths)

if ($targetPaths.Count -eq 0) {
  $result = @{
    passed = $false
    summary = "No target path was provided to the validator."
    details = @("validator_input.targetPaths was empty.")
    blocking = $true
  }
  $result | ConvertTo-Json -Depth 8
  exit 1
}

$targetPath = $targetPaths[0].path
if (-not (Test-Path -LiteralPath $targetPath)) {
  $result = @{
    passed = $false
    summary = "Target file does not exist."
    details = @("missing target: $targetPath")
    blocking = $true
  }
  $result | ConvertTo-Json -Depth 8
  exit 1
}

$content = Get-Content -LiteralPath $targetPath -Raw
$passed = $content -like "*$ExpectedToken*"

$result = @{
  passed = $passed
  summary = if ($passed) { "Target file contains expected token." } else { "Target file is missing expected token." }
  details = if ($passed) { @("token found: $ExpectedToken", "target: $targetPath") } else { @("token missing: $ExpectedToken", "target: $targetPath") }
  blocking = $true
}

$result | ConvertTo-Json -Depth 8
if ($passed) {
  exit 0
}
exit 1
