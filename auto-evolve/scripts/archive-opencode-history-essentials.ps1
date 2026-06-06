param(
  [string]$SourceRoot = "E:\opencode-auto-evolve-history",
  [string]$ArchiveParent = "C:\Users\ZhuanZ\Desktop\experiment",
  [switch]$ClearSource
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingPath([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Path does not exist: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).ProviderPath
}

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Copy-IfExists([string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $From)) {
    return $false
  }
  Ensure-Directory (Split-Path -Parent $To)
  Copy-Item -LiteralPath $From -Destination $To -Force
  return $true
}

function Copy-DirectoryIfExists([string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $From)) {
    return $false
  }
  if (Test-Path -LiteralPath $To) {
    Remove-Item -LiteralPath $To -Recurse -Force
  }
  Ensure-Directory (Split-Path -Parent $To)
  Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
  return $true
}

function Relative-To([string]$Root, [string]$Path) {
  $rootUri = [System.Uri]::new(($Root.TrimEnd('\') + '\'))
  $pathUri = [System.Uri]::new($Path)
  return [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace('/', '\')
}

function Add-CopiedFile([System.Collections.Generic.List[object]]$Manifest, [string]$Source, [string]$Dest, [string]$Kind) {
  if (Copy-IfExists $Source $Dest) {
    $info = Get-Item -LiteralPath $Dest
    $Manifest.Add([pscustomobject]@{
      kind = $Kind
      source = $Source
      archived = $Dest
      bytes = $info.Length
    })
  }
}

function Add-CopiedDirectory([System.Collections.Generic.List[object]]$Manifest, [string]$Source, [string]$Dest, [string]$Kind) {
  if (Copy-DirectoryIfExists $Source $Dest) {
    $bytes = (Get-ChildItem -LiteralPath $Dest -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) {
      $bytes = 0
    }
    $Manifest.Add([pscustomobject]@{
      kind = $Kind
      source = $Source
      archived = $Dest
      bytes = [int64]$bytes
    })
  }
}

$resolvedSource = Resolve-ExistingPath $SourceRoot
$resolvedParent = Resolve-ExistingPath $ArchiveParent

$expectedSource = [System.IO.Path]::GetFullPath("E:\opencode-auto-evolve-history").TrimEnd('\')
if ($resolvedSource.TrimEnd('\') -ne $expectedSource) {
  throw "Refusing to archive/clear unexpected source root: $resolvedSource"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveRoot = Join-Path $resolvedParent "opencode-history-essentials-$stamp"
Ensure-Directory $archiveRoot

$copied = [System.Collections.Generic.List[object]]::new()
$runtimeState = Join-Path $resolvedSource "runtime-state"
$archiveRuntime = Join-Path $archiveRoot "runtime-state"

# Campaign-level evidence: current skill packages and compact state files.
$campaignRoot = Join-Path $runtimeState "long-task-campaigns"
if (Test-Path -LiteralPath $campaignRoot) {
  Get-ChildItem -LiteralPath $campaignRoot -Directory -Force | ForEach-Object {
    $campaign = $_
    $rel = Relative-To $runtimeState $campaign.FullName
    foreach ($name in @(
      "campaign.json",
      "exploration-tree.json",
      "campaign-working-memory.json",
      "routing-control.json",
      "dispatch-tickets.json",
      "final-report.json"
    )) {
      Add-CopiedFile $copied (Join-Path $campaign.FullName $name) (Join-Path $archiveRuntime (Join-Path $rel $name)) "campaign-state"
    }
    Add-CopiedDirectory $copied (Join-Path $campaign.FullName "pending-expert-package\current") (Join-Path $archiveRuntime (Join-Path $rel "pending-expert-package\current")) "pending-expert-package"
    Add-CopiedDirectory $copied (Join-Path $campaign.FullName "final-expert-package") (Join-Path $archiveRuntime (Join-Path $rel "final-expert-package")) "final-expert-package"
  }
}

# Round final-acceptance evidence: keep compact validator outputs, not bulky event streams.
foreach ($patternRoot in @(
  (Join-Path $runtimeState "long-task-campaigns"),
  (Join-Path $runtimeState "acceptance-framework\deployment-runs"),
  (Join-Path $runtimeState "multi-instance-runs")
)) {
  if (-not (Test-Path -LiteralPath $patternRoot)) {
    continue
  }
  Get-ChildItem -LiteralPath $patternRoot -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @(
        "result.json",
        "evaluation.json",
        "validator_input.json",
        "run.json",
        "summary.json",
        "scorecard.json",
        "state.json",
        "verified-training.json",
        "final-report.json",
        "stdout.log",
        "stderr.log"
      )
    } |
    ForEach-Object {
      $rel = Relative-To $runtimeState $_.FullName
      Add-CopiedFile $copied $_.FullName (Join-Path $archiveRuntime $rel) "compact-evidence"
    }
}

# Long-task run state: progress files are enough to reconstruct old run status.
$longTaskRuns = Join-Path $runtimeState "long-task\runs"
if (Test-Path -LiteralPath $longTaskRuns) {
  Get-ChildItem -LiteralPath $longTaskRuns -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @(
        "progress_state.json",
        "graph.json",
        "result.json",
        "evaluation.json",
        "run.json",
        "response.txt",
        "failure_packets.jsonl",
        "retry_lessons.jsonl",
        "learning_units.jsonl"
      )
    } |
    ForEach-Object {
      $rel = Relative-To $runtimeState $_.FullName
      Add-CopiedFile $copied $_.FullName (Join-Path $archiveRuntime $rel) "long-task-run-state"
    }
}

# Logs are usually small and useful for postmortems.
Add-CopiedDirectory $copied (Join-Path $resolvedSource "runtime-logs") (Join-Path $archiveRoot "runtime-logs") "runtime-logs"

$topLevel = Get-ChildItem -LiteralPath $resolvedSource -Force | Select-Object Name, Mode, LastWriteTime
$copiedBytes = ($copied | Measure-Object -Property bytes -Sum).Sum
if ($null -eq $copiedBytes) {
  $copiedBytes = 0
}

$manifest = [pscustomobject]@{
  createdAt = (Get-Date).ToString("o")
  sourceRoot = $resolvedSource
  archiveRoot = $archiveRoot
  clearSourceRequested = [bool]$ClearSource
  topLevel = $topLevel
  copiedCount = $copied.Count
  copiedBytes = [int64]$copiedBytes
  copied = $copied
  notes = @(
    "This archive keeps compact evidence only.",
    "Excluded by design: opencode-config session caches, node_modules, isolated HOME/XDG caches, bulky event streams, and keep-stash transfer remnants.",
    "Original source can be cleared after verifying this manifest and archive folder."
  )
}

$manifestPath = Join-Path $archiveRoot "manifest.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

if ($ClearSource) {
  # Safety rail: only clear children under the exact historical root. Keep the empty root folder as a tombstone.
  $children = @(Get-ChildItem -LiteralPath $resolvedSource -Force)
  foreach ($child in $children) {
    $childPath = [System.IO.Path]::GetFullPath($child.FullName)
    if (-not $childPath.StartsWith($expectedSource + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove path outside expected source root: $childPath"
    }
  }
  foreach ($child in $children) {
    Remove-Item -LiteralPath $child.FullName -Recurse -Force
  }
  $tombstone = Join-Path $resolvedSource "CLEARED_BY_ARCHIVE.txt"
  @(
    "E:\opencode-auto-evolve-history was cleared after compact archive.",
    "Archive: $archiveRoot",
    "Manifest: $manifestPath",
    "ClearedAt: $((Get-Date).ToString("o"))"
  ) | Set-Content -LiteralPath $tombstone -Encoding UTF8
}

Write-Output "archiveRoot=$archiveRoot"
Write-Output "manifestPath=$manifestPath"
Write-Output "copiedCount=$($manifest.copiedCount)"
Write-Output "copiedBytes=$($manifest.copiedBytes)"
Write-Output "clearSource=$([bool]$ClearSource)"
