param(
  [string]$ConfigDir = "$env:USERPROFILE\.config\opencode-source-isolated",
  [string]$WorkDir = "$env:USERPROFILE\Desktop\opencode re\opencode latest",
  [switch]$Pure,
  [string[]]$CommandArgs = @("--help")
)

$ErrorActionPreference = "Stop"

$pkg = Join-Path $WorkDir "packages\opencode"
$src = Join-Path $pkg "src\index.ts"
if (-not (Test-Path $src)) {
  throw "Missing source entry: $src"
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

$env:OPENCODE_CONFIG_DIR = $ConfigDir
$env:OPENCODE_CLIENT = "cli"
if ($Pure) {
  $env:OPENCODE_PURE = "1"
} else {
  Remove-Item Env:OPENCODE_PURE -ErrorAction SilentlyContinue
}
$run = if ($CommandArgs.Count -eq 1 -and $CommandArgs[0].Contains(",")) {
  $CommandArgs[0] -split ","
} else {
  $CommandArgs
}

Write-Host "[opencode-source] OPENCODE_CONFIG_DIR=$env:OPENCODE_CONFIG_DIR"
Write-Host "[opencode-source] OPENCODE_PURE=$env:OPENCODE_PURE"
Write-Host "[opencode-source] WorkDir=$WorkDir"

Push-Location $pkg
$code = 1
try {
  & bun run --conditions=browser src/index.ts @run
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $code
