param(
  [string]$Out,
  [string]$Campaign,
  [ValidateSet("pause", "drain", "kill-only", "abort", "snapshot-only")]
  [string]$Mode = "pause",
  [string]$Reason = "",
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

$ArgsList = @("run", "auto-evolve/scripts/stop-auto-evolve.ts", "--mode", $Mode)
if ($Out) {
  $ArgsList += @("--out", $Out)
}
if ($Campaign) {
  $ArgsList += @("--campaign", $Campaign)
}
if ($Reason) {
  $ArgsList += @("--reason", $Reason)
}
if ($DryRun) {
  $ArgsList += "--dry-run"
}
if ($Force) {
  $ArgsList += "--force"
}

if (-not $Out -and -not $Campaign) {
  throw "Provide -Out <benchmark/direct-chat out dir> or -Campaign <campaign id/dir>."
}

& bun @ArgsList
