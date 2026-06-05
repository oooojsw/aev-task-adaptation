param(
  [string]$RepoRoot = "$env:USERPROFILE\Desktop\opencode re\opencode latest",
  [string]$Image = "opencode-local:dev",
  [string]$ConfigDir = "$env:USERPROFILE\.config\opencode-docker-isolated",
  [string]$StateDir = "$env:USERPROFILE\.config\opencode-docker-state",
  [string]$WorkDir = "$env:USERPROFILE\Desktop\opencode re\opencode latest\auto-evolve",
  [switch]$BuildOnly,
  [switch]$Pure,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"

$dockerfile = Join-Path $RepoRoot "packages\opencode\Dockerfile"
if (-not (Test-Path $dockerfile)) {
  throw "Missing Dockerfile: $dockerfile"
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

Push-Location (Join-Path $RepoRoot "packages\opencode")
try {
  docker build -t $Image -f Dockerfile .
  if ($LASTEXITCODE -ne 0) {
    throw "docker build failed for image: $Image"
  }
} finally {
  Pop-Location
}

if ($BuildOnly) {
  Write-Host "[opencode-docker] image built: $Image"
  exit 0
}

$cmd = @(
  "run", "--rm", "-it",
  "-v", "${WorkDir}:/workspace",
  "-v", "${ConfigDir}:/cfg",
  "-v", "${StateDir}:/state",
  "-w", "/workspace",
  "-e", "OPENCODE_CONFIG_DIR=/cfg",
  "-e", "HOME=/state",
  "-e", "XDG_CONFIG_HOME=/state/.config",
  "-e", "XDG_DATA_HOME=/state/.local/share"
)

if ($Pure) {
  $cmd += @("-e", "OPENCODE_PURE=1")
}

$cmd += $Image
$cmd += $Args

Write-Host "[opencode-docker] image=$Image"
Write-Host "[opencode-docker] work=$WorkDir"
Write-Host "[opencode-docker] cfg=$ConfigDir"
Write-Host "[opencode-docker] state=$StateDir"
Write-Host "[opencode-docker] pure=$Pure"

& docker @cmd
