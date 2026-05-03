param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path,
  [string]$TaskPackRelativePath = "auto-evolve\\task-packs\\real-long-tasks\\try4-expert-bootstrap",
  [string[]]$RuntimeKeywords = @("try4", "expert-bootstrap", "blank-agent-deployment"),
  [string[]]$AcceptanceIndexKeywords = @("try4", "expert-bootstrap", "blank-agent-deployment", "FL-14", "fl-14"),
  [switch]$SkipProcessStop,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

function Contains-AnyKeyword {
  param(
    [string]$Text,
    [string[]]$Keywords
  )
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  foreach ($keyword in $Keywords) {
    if ($Text.IndexOf($keyword, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }
  return $false
}

function Assert-UnderRoot {
  param(
    [string]$RootPath,
    [string]$TargetPath,
    [string]$Label
  )
  $rootFull = [System.IO.Path]::GetFullPath($RootPath).TrimEnd("\")
  $targetFull = [System.IO.Path]::GetFullPath($TargetPath)
  if (-not $targetFull.StartsWith($rootFull + "\", [System.StringComparison]::OrdinalIgnoreCase) -and $targetFull -ne $rootFull) {
    throw "$Label points outside repo root: $targetFull"
  }
  return $targetFull
}

function Remove-MatchingDirectories {
  param(
    [string]$ParentPath,
    [string]$RootPath,
    [string[]]$Keywords
  )
  if (-not (Test-Path -LiteralPath $ParentPath)) {
    return @()
  }
  $removed = @()
  $dirs = Get-ChildItem -LiteralPath $ParentPath -Directory -ErrorAction SilentlyContinue
  foreach ($dir in $dirs) {
    if (-not (Contains-AnyKeyword -Text $dir.Name -Keywords $Keywords)) {
      continue
    }
    $safePath = Assert-UnderRoot -RootPath $RootPath -TargetPath $dir.FullName -Label "Remove-MatchingDirectories"
    Remove-Item -LiteralPath $safePath -Recurse -Force -ErrorAction SilentlyContinue
    $removed += $safePath
  }
  return $removed
}

function Remove-MatchingRuntimeItems {
  param(
    [string]$RuntimeRoot,
    [string]$RootPath,
    [string[]]$Keywords
  )
  if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
    return @()
  }
  $removed = @()
  $items = Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { Contains-AnyKeyword -Text $_.FullName -Keywords $Keywords } |
    Sort-Object FullName -Descending
  foreach ($item in $items) {
    $safePath = Assert-UnderRoot -RootPath $RootPath -TargetPath $item.FullName -Label "Remove-MatchingRuntimeItems"
    if (-not (Test-Path -LiteralPath $safePath)) {
      continue
    }
    Remove-Item -LiteralPath $safePath -Recurse -Force -ErrorAction SilentlyContinue
    $removed += $safePath
  }
  return $removed
}

function Ensure-EmptyDirectory {
  param(
    [string]$Path,
    [string]$RootPath
  )
  $safePath = Assert-UnderRoot -RootPath $RootPath -TargetPath $Path -Label "Ensure-EmptyDirectory"
  if (-not (Test-Path -LiteralPath $safePath)) {
    New-Item -ItemType Directory -Path $safePath -Force | Out-Null
    return
  }
  $children = Get-ChildItem -LiteralPath $safePath -Force -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Remove-Item -LiteralPath $child.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Remove-DirectoryIfExists {
  param(
    [string]$Path,
    [string]$RootPath
  )
  $safePath = Assert-UnderRoot -RootPath $RootPath -TargetPath $Path -Label "Remove-DirectoryIfExists"
  if (Test-Path -LiteralPath $safePath) {
    Remove-Item -LiteralPath $safePath -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Remove-ChildrenExcept {
  param(
    [string]$ParentPath,
    [string]$RootPath,
    [string[]]$KeepFiles = @(),
    [string[]]$KeepDirectories = @()
  )
  $safeParent = Assert-UnderRoot -RootPath $RootPath -TargetPath $ParentPath -Label "Remove-ChildrenExcept"
  if (-not (Test-Path -LiteralPath $safeParent)) {
    return
  }

  $keepFileSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($item in $KeepFiles) { [void]$keepFileSet.Add($item) }
  $keepDirSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($item in $KeepDirectories) { [void]$keepDirSet.Add($item) }

  $children = Get-ChildItem -LiteralPath $safeParent -Force -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    if ($child.PSIsContainer) {
      if ($keepDirSet.Contains($child.Name)) { continue }
      Remove-Item -LiteralPath $child.FullName -Recurse -Force -ErrorAction SilentlyContinue
      continue
    }
    if ($keepFileSet.Contains($child.Name)) { continue }
    Remove-Item -LiteralPath $child.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Remove-RootTransientItems {
  param([string]$RootPath)
  if (-not (Test-Path -LiteralPath $RootPath)) {
    return @()
  }
  $removed = @()
  $filePattern = "^(?:&1|null|dummy\.json|context\d*\.txt|debug_|check_|temp_|tmp_|extract_|generate_|validate_|verify_|placeholder|placeholders|remaining|report_|exp_|scan_|search_|inspect_|list_|parse_)"
  $files = Get-ChildItem -LiteralPath $RootPath -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match $filePattern -or $_.Extension -in @(".log")
  }
  foreach ($file in $files) {
    $safePath = Assert-UnderRoot -RootPath $RootPath -TargetPath $file.FullName -Label "Remove-RootTransientItems:file"
    Remove-Item -LiteralPath $safePath -Force -ErrorAction SilentlyContinue
    $removed += $safePath
  }

  $dirPattern = "^(?:temp_|tmp_|workspace$|task-packs$)"
  $dirs = Get-ChildItem -LiteralPath $RootPath -Directory -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match $dirPattern
  }
  foreach ($dir in $dirs) {
    $safePath = Assert-UnderRoot -RootPath $RootPath -TargetPath $dir.FullName -Label "Remove-RootTransientItems:dir"
    Remove-Item -LiteralPath $safePath -Recurse -Force -ErrorAction SilentlyContinue
    $removed += $safePath
  }
  return $removed
}

function Remove-AutoEvolveRuntimeCache {
  param(
    [string]$AutoEvolveRuntimeRoot,
    [string]$RootPath
  )
  if (-not (Test-Path -LiteralPath $AutoEvolveRuntimeRoot)) {
    return @()
  }
  $removed = @()
  $children = Get-ChildItem -LiteralPath $AutoEvolveRuntimeRoot -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @("opencode-config", "opencode-isolated-env", "probe-config", "probe-iso-env") -or
    $_.Name -like "probe-*.txt"
  }
  foreach ($child in $children) {
    $safePath = Assert-UnderRoot -RootPath $RootPath -TargetPath $child.FullName -Label "Remove-AutoEvolveRuntimeCache"
    Remove-Item -LiteralPath $safePath -Recurse -Force -ErrorAction SilentlyContinue
    $removed += $safePath
  }
  return $removed
}

function Stop-ResidualRuntimeProcesses {
  param([string[]]$Keywords)
  $selfPid = $PID
  $stopped = @()
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $selfPid -and
    ($_.Name -match "bun.exe|node.exe|powershell.exe|opencode-cli.exe") -and
    (Contains-AnyKeyword -Text $_.CommandLine -Keywords @(
      "run-long-task-campaign",
      "run-long-task",
      "Long Task Execute",
      "try4-expert-bootstrap",
      "blank-agent-deployment"
    ))
  }

  foreach ($proc in $procs) {
    try {
      Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction Stop
      $stopped += ("PID={0}; Name={1}" -f $proc.ProcessId, $proc.Name)
    } catch {}
  }
  return $stopped
}

$repoRootFull = [System.IO.Path]::GetFullPath($RepoRoot)
$repoRootFull = Assert-UnderRoot -RootPath $repoRootFull -TargetPath $repoRootFull -Label "RepoRoot"

$runtimeRoot = Join-Path $repoRootFull "auto-evolve\\runtime-state"
$autoEvolveRuntimeRoot = Join-Path $repoRootFull "auto-evolve\\.runtime"
$taskRoot = Join-Path $repoRootFull $TaskPackRelativePath
$seedRoot = Join-Path $taskRoot "seed-expert-workspace"
$liveRoot = Join-Path $taskRoot "expert-workspace"
$workspaceRoot = Join-Path $taskRoot "workspace"
$outputsRoot = Join-Path $taskRoot "outputs"
$deployWorkRoot = Join-Path $taskRoot "deployment\\work"
$deployOutputsRoot = Join-Path $taskRoot "deployment\\outputs"
$materialsRoot = Join-Path $taskRoot "materials"
$deploymentRoot = Join-Path $taskRoot "deployment"
$verifyScript = Join-Path $repoRootFull "auto-evolve\\scripts\\verify-try4-clean-state.ps1"

$taskRootKeepFiles = @(
  "00-task-entry.md",
  "campaign.json",
  "spec.json",
  "spec-round2.json"
)
$taskRootKeepDirectories = @(
  "capabilities",
  "configs",
  "deployment",
  "experience-workspace",
  "expert-workspace",
  "goal",
  "materials",
  "outputs",
  "preview",
  "seed-campaign-evidence",
  "seed-expert-workspace",
  "seed-expert-workspace-round2",
  "seed-round2-evidence",
  "workspace"
)
$deploymentKeepFiles = @(
  "deployment-spec.json"
)
$deploymentKeepDirectories = @(
  "configs"
)

Assert-UnderRoot -RootPath $repoRootFull -TargetPath $runtimeRoot -Label "runtimeRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $taskRoot -Label "taskRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $seedRoot -Label "seedRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $liveRoot -Label "liveRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $workspaceRoot -Label "workspaceRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $outputsRoot -Label "outputsRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $deployWorkRoot -Label "deployWorkRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $deployOutputsRoot -Label "deployOutputsRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $materialsRoot -Label "materialsRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $deploymentRoot -Label "deploymentRoot" | Out-Null
Assert-UnderRoot -RootPath $repoRootFull -TargetPath $verifyScript -Label "verifyScript" | Out-Null

if (-not (Test-Path -LiteralPath $taskRoot)) {
  throw "Task root not found: $taskRoot"
}
if (-not (Test-Path -LiteralPath $seedRoot)) {
  throw "seed-expert-workspace not found: $seedRoot"
}

$stoppedProcesses = @()
if (-not $SkipProcessStop) {
  $stoppedProcesses = Stop-ResidualRuntimeProcesses -Keywords $RuntimeKeywords
}

$removedRuntimeDirs = @()
$removedRuntimeDirs += Remove-MatchingDirectories -ParentPath (Join-Path $runtimeRoot "long-task-campaigns") -RootPath $repoRootFull -Keywords $RuntimeKeywords
$removedRuntimeDirs += Remove-MatchingDirectories -ParentPath (Join-Path $runtimeRoot "long-task\\runs") -RootPath $repoRootFull -Keywords $RuntimeKeywords
$removedRuntimeDirs += Remove-MatchingDirectories -ParentPath (Join-Path $runtimeRoot "acceptance-framework\\deployment-runs") -RootPath $repoRootFull -Keywords $RuntimeKeywords
$removedRuntimeDirs += Remove-MatchingDirectories -ParentPath (Join-Path $runtimeRoot "acceptance-framework\\records") -RootPath $repoRootFull -Keywords $RuntimeKeywords

$pendingSmoke = Join-Path $runtimeRoot "campaign-pending-smoke"
if (Test-Path -LiteralPath $pendingSmoke) {
  $safePendingSmoke = Assert-UnderRoot -RootPath $repoRootFull -TargetPath $pendingSmoke -Label "pendingSmoke"
  Remove-Item -LiteralPath $safePendingSmoke -Recurse -Force -ErrorAction SilentlyContinue
  $removedRuntimeDirs += $safePendingSmoke
}

$removedRuntimeItems = Remove-MatchingRuntimeItems -RuntimeRoot $runtimeRoot -RootPath $repoRootFull -Keywords $RuntimeKeywords
$removedAutoRuntimeItems = Remove-AutoEvolveRuntimeCache -AutoEvolveRuntimeRoot $autoEvolveRuntimeRoot -RootPath $repoRootFull
$removedRootTransientItems = Remove-RootTransientItems -RootPath $repoRootFull

$acceptanceIndex = Join-Path $runtimeRoot "acceptance-framework\\index.jsonl"
$acceptanceLinesRemoved = 0
if (Test-Path -LiteralPath $acceptanceIndex) {
  $allLines = Get-Content -LiteralPath $acceptanceIndex -ErrorAction SilentlyContinue
  $kept = @()
  foreach ($line in $allLines) {
    if (Contains-AnyKeyword -Text $line -Keywords $AcceptanceIndexKeywords) {
      $acceptanceLinesRemoved += 1
      continue
    }
    $kept += $line
  }
  Set-Content -LiteralPath $acceptanceIndex -Value $kept -Encoding UTF8
}

if (Test-Path -LiteralPath $liveRoot) {
  $safeLiveRoot = Assert-UnderRoot -RootPath $repoRootFull -TargetPath $liveRoot -Label "liveRoot-remove"
  Remove-Item -LiteralPath $safeLiveRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Copy-Item -LiteralPath $seedRoot -Destination $liveRoot -Recurse -Force

# task-pack root strict cleanup: remove all sibling debris outside the canonical surface.
Remove-ChildrenExcept -ParentPath $taskRoot -RootPath $repoRootFull -KeepFiles $taskRootKeepFiles -KeepDirectories $taskRootKeepDirectories

Ensure-EmptyDirectory -Path $workspaceRoot -RootPath $repoRootFull
Ensure-EmptyDirectory -Path $outputsRoot -RootPath $repoRootFull
Ensure-EmptyDirectory -Path $deployWorkRoot -RootPath $repoRootFull
Ensure-EmptyDirectory -Path $deployOutputsRoot -RootPath $repoRootFull

$taskGeneratedDirs = @(
  "explanation_template_unpacked",
  "report_template_unpacked",
  "xlsx_unpacked",
  "probe-test"
)
foreach ($dirName in $taskGeneratedDirs) {
  Remove-DirectoryIfExists -Path (Join-Path $taskRoot $dirName) -RootPath $repoRootFull
}

Remove-ChildrenExcept -ParentPath $materialsRoot -RootPath $repoRootFull -KeepFiles @(
  "source.xlsx",
  "report-reference.doc",
  "explanation-reference.doc",
  "report-template.docx",
  "explanation-template.docx",
  "human-guidance.md"
)

$deploymentGeneratedDirs = @(
  "__pycache__",
  "outputs",
  "validate_input_temp",
  "xlsx_work",
  "template_explain_xml",
  "template_report_xml",
  "deployment"
)
foreach ($dirName in $deploymentGeneratedDirs) {
  Remove-DirectoryIfExists -Path (Join-Path $deploymentRoot $dirName) -RootPath $repoRootFull
}

# deployment root strict cleanup: keep only official spec/config surface.
Remove-ChildrenExcept -ParentPath $deploymentRoot -RootPath $repoRootFull -KeepFiles $deploymentKeepFiles -KeepDirectories $deploymentKeepDirectories
Ensure-EmptyDirectory -Path $deployWorkRoot -RootPath $repoRootFull
Ensure-EmptyDirectory -Path $deployOutputsRoot -RootPath $repoRootFull

if (-not $SkipVerify) {
  & $verifyScript -RepoRoot $repoRootFull -TaskPackRelativePath $TaskPackRelativePath -ExpertWorkspaceMode "seed"
  if ($LASTEXITCODE -ne 0) {
    throw "Environment initialization finished, but verify-try4-clean-state failed."
  }
}

$result = [ordered]@{
  passed = $true
  summary = "try4 clean initialization completed (including shadow-memory cleanup)."
  repoRoot = $repoRootFull
  taskRoot = $taskRoot
  stoppedProcessCount = @($stoppedProcesses).Count
  removedRuntimeDirCount = @($removedRuntimeDirs).Count
  removedRuntimeItemCount = @($removedRuntimeItems).Count
  removedAutoRuntimeItemCount = @($removedAutoRuntimeItems).Count
  removedRootTransientItemCount = @($removedRootTransientItems).Count
  acceptanceLinesRemoved = $acceptanceLinesRemoved
  verifyRan = (-not $SkipVerify)
  checkedAt = (Get-Date).ToString("o")
}

$result | ConvertTo-Json -Depth 6
exit 0
