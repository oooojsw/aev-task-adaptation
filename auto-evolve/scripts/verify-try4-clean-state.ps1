param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path,
  [string]$TaskPackRelativePath = "auto-evolve\\task-packs\\real-long-tasks\\try4-expert-bootstrap",
  [string[]]$RuntimeKeywords = @("try4", "expert-bootstrap", "blank-agent-deployment"),
  [string[]]$AcceptanceIndexKeywords = @("try4", "expert-bootstrap", "blank-agent-deployment", "FL-14", "fl-14"),
  [ValidateSet("seed", "empty", "either")]
  [string]$ExpertWorkspaceMode = "seed"
)

$ErrorActionPreference = "Stop"

function New-Finding {
  param(
    [string]$Code,
    [string]$Message,
    [string]$Path = "",
    [string]$Level = "error"
  )
  [PSCustomObject]@{
    code = $Code
    level = $Level
    message = $Message
    path = $Path
  }
}

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

function Get-RelativeMap {
  param(
    [string]$RootPath
  )
  $map = @{}
  if (-not (Test-Path -LiteralPath $RootPath)) {
    return $map
  }
  $rootFull = [System.IO.Path]::GetFullPath($RootPath)
  $prefix = $rootFull.TrimEnd("\") + "\"
  $files = Get-ChildItem -LiteralPath $RootPath -Recurse -File -ErrorAction SilentlyContinue
  foreach ($file in $files) {
    $full = [System.IO.Path]::GetFullPath($file.FullName)
    $relative = if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $full.Substring($prefix.Length)
    } else {
      $file.Name
    }
    $map[$relative] = $file.FullName
  }
  return $map
}

function Hash-File {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Short-Text {
  param(
    [string]$Text,
    [int]$Limit = 260
  )
  if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
  $normalized = ($Text -replace "\s+", " ").Trim()
  if ($normalized.Length -le $Limit) { return $normalized }
  return $normalized.Substring(0, $Limit - 3) + "..."
}

$findings = @()
$metrics = [ordered]@{}
$checkedAt = (Get-Date).ToString("o")

$repoRootFull = [System.IO.Path]::GetFullPath($RepoRoot)
$runtimeRoot = Join-Path $repoRootFull "auto-evolve\\runtime-state"
$autoEvolveRuntimeRoot = Join-Path $repoRootFull "auto-evolve\\.runtime"
$taskRoot = Join-Path $repoRootFull $TaskPackRelativePath
$seedRoot = Join-Path $taskRoot "seed-expert-workspace"
$liveRoot = Join-Path $taskRoot "expert-workspace"
$workspaceRoot = Join-Path $taskRoot "workspace"
$outputsRoot = Join-Path $taskRoot "outputs"
$deployWorkRoot = Join-Path $taskRoot "deployment\\work"
$deploymentRoot = Join-Path $taskRoot "deployment"
$deployOutputsRoot = Join-Path $deploymentRoot "outputs"

$taskRootAllowedFiles = @(
  "00-task-entry.md",
  "campaign.json",
  "spec.json",
  "spec-round2.json"
)
$taskRootAllowedDirs = @(
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
$deploymentAllowedFiles = @(
  "deployment-spec.json"
)
$deploymentAllowedDirs = @(
  "configs",
  "outputs",
  "work"
)

$metrics.repoRoot = $repoRootFull
$metrics.runtimeRoot = $runtimeRoot
$metrics.taskRoot = $taskRoot
$metrics.expertWorkspaceMode = $ExpertWorkspaceMode

if (-not (Test-Path -LiteralPath $runtimeRoot)) {
  $findings += New-Finding -Code "runtime_root_missing" -Message "runtime-state directory is missing." -Path $runtimeRoot
}
if (-not (Test-Path -LiteralPath $taskRoot)) {
  $findings += New-Finding -Code "task_root_missing" -Message "try4 task root is missing." -Path $taskRoot
}

$rootTransientFilePattern = "^(?:&1|null|dummy\.json|context\d*\.txt|debug_|check_|temp_|tmp_|extract_|generate_|validate_|verify_|placeholder|placeholders|remaining|report_|exp_|scan_|search_|inspect_|list_|parse_)"
$rootTransientDirPattern = "^(?:temp_|tmp_|workspace$|task-packs$)"
$rootTransientItems = @()
if (Test-Path -LiteralPath $repoRootFull) {
  $rootTransientItems += @(Get-ChildItem -LiteralPath $repoRootFull -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match $rootTransientFilePattern -or $_.Extension -in @(".log")
  })
  $rootTransientItems += @(Get-ChildItem -LiteralPath $repoRootFull -Directory -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match $rootTransientDirPattern
  })
}
$metrics.rootTransientItemCount = $rootTransientItems.Count
if ($rootTransientItems.Count -gt 0) {
  foreach ($item in ($rootTransientItems | Select-Object -First 30)) {
    $findings += New-Finding -Code "repo_root_transient_item" -Message "Project root still contains a temporary/debug artifact that can pollute agent search." -Path $item.FullName
  }
}

$autoRuntimeResidue = @()
if (Test-Path -LiteralPath $autoEvolveRuntimeRoot) {
  $autoRuntimeResidue = @(Get-ChildItem -LiteralPath $autoEvolveRuntimeRoot -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -in @("opencode-config", "opencode-isolated-env", "probe-config", "probe-iso-env") -or
    $_.Name -like "probe-*.txt"
  })
}
$metrics.autoRuntimeResidueCount = $autoRuntimeResidue.Count
if ($autoRuntimeResidue.Count -gt 0) {
  foreach ($item in ($autoRuntimeResidue | Select-Object -First 20)) {
    $findings += New-Finding -Code "auto_runtime_cache_residue" -Message "auto-evolve .runtime still contains old OpenCode/probe cache." -Path $item.FullName
  }
}

# 0) strict surface checks for root/deployment (block hidden pollution)
if (Test-Path -LiteralPath $taskRoot) {
  $allowedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $taskRootAllowedFiles) { [void]$allowedFiles.Add($name) }
  $allowedDirs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $taskRootAllowedDirs) { [void]$allowedDirs.Add($name) }

  $rootChildren = Get-ChildItem -LiteralPath $taskRoot -Force -ErrorAction SilentlyContinue
  foreach ($child in $rootChildren) {
    if ($child.PSIsContainer) {
      if (-not $allowedDirs.Contains($child.Name)) {
        $findings += New-Finding -Code "task_root_unexpected_dir" -Message "Unexpected directory exists under task root." -Path $child.FullName
      }
      continue
    }
    if (-not $allowedFiles.Contains($child.Name)) {
      $findings += New-Finding -Code "task_root_unexpected_file" -Message "Unexpected file exists under task root." -Path $child.FullName
    }
  }
}

if (Test-Path -LiteralPath $deploymentRoot) {
  $allowedFiles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $deploymentAllowedFiles) { [void]$allowedFiles.Add($name) }
  $allowedDirs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $deploymentAllowedDirs) { [void]$allowedDirs.Add($name) }

  $deploymentChildren = Get-ChildItem -LiteralPath $deploymentRoot -Force -ErrorAction SilentlyContinue
  foreach ($child in $deploymentChildren) {
    if ($child.PSIsContainer) {
      if (-not $allowedDirs.Contains($child.Name)) {
        $findings += New-Finding -Code "deployment_unexpected_dir" -Message "Unexpected directory exists under deployment root." -Path $child.FullName
      }
      continue
    }
    if (-not $allowedFiles.Contains($child.Name)) {
      $findings += New-Finding -Code "deployment_unexpected_file" -Message "Unexpected file exists under deployment root." -Path $child.FullName
    }
  }
}

# 1) Residual runtime processes
$selfPid = $PID
$processMatches = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $cmd = ""
  if ($null -ne $_.CommandLine) { $cmd = [string]$_.CommandLine }
  $_.ProcessId -ne $selfPid -and
  -not (Contains-AnyKeyword -Text $cmd -Keywords @(
    "verify-try4-clean-state.ps1",
    "Get-CimInstance Win32_Process"
  )) -and
  ($_.Name -match "bun.exe|node.exe|powershell.exe|opencode-cli.exe") -and
  (
    Contains-AnyKeyword -Text $cmd -Keywords @(
      "run-long-task-campaign",
      "run-long-task",
      "Long Task Execute",
      "try4-expert-bootstrap",
      "blank-agent-deployment"
    )
  )
}
$metrics.residualProcessCount = @($processMatches).Count
if ($metrics.residualProcessCount -gt 0) {
  foreach ($proc in $processMatches) {
    $cmd = ""
    if ($null -ne $proc.CommandLine) { $cmd = [string]$proc.CommandLine }
    $findings += New-Finding -Code "residual_process" -Message "Residual runtime process is still running." -Path ("PID={0}; Name={1}; Cmd={2}" -f $proc.ProcessId, $proc.Name, (Short-Text -Text $cmd))
  }
}

# 2) Runtime directory residue checks
$dirChecks = @(
  @{ id = "long_task_campaigns"; path = Join-Path $runtimeRoot "long-task-campaigns" },
  @{ id = "long_task_runs"; path = Join-Path $runtimeRoot "long-task\\runs" },
  @{ id = "deployment_runs"; path = Join-Path $runtimeRoot "acceptance-framework\\deployment-runs" },
  @{ id = "acceptance_records"; path = Join-Path $runtimeRoot "acceptance-framework\\records" }
)

foreach ($check in $dirChecks) {
  $matchCount = 0
  if (Test-Path -LiteralPath $check.path) {
    $dirs = Get-ChildItem -LiteralPath $check.path -Directory -ErrorAction SilentlyContinue
    $matchedDirs = @($dirs | Where-Object { Contains-AnyKeyword -Text $_.Name -Keywords $RuntimeKeywords })
    $matchCount = $matchedDirs.Count
    if ($matchCount -gt 0) {
      foreach ($dir in $matchedDirs) {
        $findings += New-Finding -Code "runtime_residue_$($check.id)" -Message "Residual runtime directory exists." -Path $dir.FullName
      }
    }
  }
  $metrics["residue_$($check.id)"] = $matchCount
}

$runtimeResidueItems = @()
if (Test-Path -LiteralPath $runtimeRoot) {
  $runtimeResidueItems = @(Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
    Contains-AnyKeyword -Text $_.FullName -Keywords $RuntimeKeywords
  })
}
$metrics.residue_runtime_items = $runtimeResidueItems.Count
if ($runtimeResidueItems.Count -gt 0) {
  foreach ($item in ($runtimeResidueItems | Select-Object -First 30)) {
    $findings += New-Finding -Code "runtime_keyword_residue" -Message "Runtime-state still contains a task/deployment keyword residue." -Path $item.FullName
  }
}

$pendingSmokePath = Join-Path $runtimeRoot "campaign-pending-smoke"
$metrics.campaignPendingSmokeExists = Test-Path -LiteralPath $pendingSmokePath
if ($metrics.campaignPendingSmokeExists) {
  $findings += New-Finding -Code "pending_smoke_exists" -Message "campaign-pending-smoke should be removed before zero-start." -Path $pendingSmokePath
}

# 3) acceptance-framework index pollution
$acceptanceIndex = Join-Path $runtimeRoot "acceptance-framework\\index.jsonl"
$indexHits = @()
if (Test-Path -LiteralPath $acceptanceIndex) {
  foreach ($keyword in $AcceptanceIndexKeywords) {
    $indexHits += @(Select-String -Path $acceptanceIndex -Pattern $keyword -SimpleMatch -ErrorAction SilentlyContinue)
  }
}
$indexHits = @($indexHits | Sort-Object Path, LineNumber -Unique)
$metrics.acceptanceIndexHitCount = $indexHits.Count
if ($indexHits.Count -gt 0) {
  $sample = $indexHits | Select-Object -First 12
  foreach ($hit in $sample) {
    $findings += New-Finding -Code "acceptance_index_polluted" -Message ("acceptance index still contains blocked keyword data at line {0}" -f $hit.LineNumber) -Path $hit.Path
  }
}

# 4) required materials intact
$materialsRoot = Join-Path $taskRoot "materials"
$requiredMaterials = @(
  "source.xlsx",
  "report-reference.doc",
  "explanation-reference.doc",
  "report-template.docx",
  "explanation-template.docx"
)
$missingMaterials = @()
foreach ($item in $requiredMaterials) {
  $materialPath = Join-Path $materialsRoot $item
  if (-not (Test-Path -LiteralPath $materialPath)) {
    $missingMaterials += $materialPath
    $findings += New-Finding -Code "missing_material" -Message "Required material is missing." -Path $materialPath
  }
}
$metrics.missingMaterialCount = $missingMaterials.Count

# 5) working directories must be empty
$workingDirs = @($workspaceRoot, $outputsRoot, $deployWorkRoot, $deployOutputsRoot)
foreach ($dir in $workingDirs) {
  if (-not (Test-Path -LiteralPath $dir)) {
    $findings += New-Finding -Code "working_dir_missing" -Message "Working directory should exist and be empty." -Path $dir
    continue
  }
  $items = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
  $metricsKey = "itemsIn_" + ((Split-Path $dir -Leaf) -replace "[^a-zA-Z0-9_]", "_")
  $metrics[$metricsKey] = $items.Count
  if ($items.Count -gt 0) {
    $findings += New-Finding -Code "working_dir_not_empty" -Message ("Working directory is not empty ({0} item(s))." -f $items.Count) -Path $dir
  }
}

# 6) expert-workspace state check
if (-not (Test-Path -LiteralPath $seedRoot)) {
  $findings += New-Finding -Code "seed_missing" -Message "seed-expert-workspace is missing." -Path $seedRoot
} elseif (-not (Test-Path -LiteralPath $liveRoot)) {
  $findings += New-Finding -Code "live_expert_missing" -Message "expert-workspace is missing." -Path $liveRoot
} else {
  $seedMap = Get-RelativeMap -RootPath $seedRoot
  $liveMap = Get-RelativeMap -RootPath $liveRoot
  $metrics.seedFileCount = $seedMap.Count
  $metrics.liveFileCount = $liveMap.Count

  if ($ExpertWorkspaceMode -eq "empty") {
    if ($liveMap.Count -ne 0) {
      $findings += New-Finding -Code "live_expert_not_empty" -Message "expert-workspace should be empty in empty mode." -Path $liveRoot
    }
  } elseif ($ExpertWorkspaceMode -eq "seed") {
    $missingInLive = @($seedMap.Keys | Where-Object { -not $liveMap.ContainsKey($_) })
    $extraInLive = @($liveMap.Keys | Where-Object { -not $seedMap.ContainsKey($_) })
    if ($missingInLive.Count -gt 0) {
      foreach ($key in ($missingInLive | Select-Object -First 20)) {
        $findings += New-Finding -Code "live_expert_missing_file" -Message "expert-workspace is missing seeded file." -Path (Join-Path $liveRoot $key)
      }
    }
    if ($extraInLive.Count -gt 0) {
      foreach ($key in ($extraInLive | Select-Object -First 20)) {
        $findings += New-Finding -Code "live_expert_extra_file" -Message "expert-workspace contains extra file (not in seed)." -Path (Join-Path $liveRoot $key)
      }
    }
    $common = @($seedMap.Keys | Where-Object { $liveMap.ContainsKey($_) })
    $hashMismatchCount = 0
    foreach ($key in $common) {
      $seedHash = Hash-File -Path $seedMap[$key]
      $liveHash = Hash-File -Path $liveMap[$key]
      if ($seedHash -ne $liveHash) {
        $hashMismatchCount += 1
        if ($hashMismatchCount -le 20) {
          $findings += New-Finding -Code "live_expert_hash_mismatch" -Message "expert-workspace file content differs from seed." -Path (Join-Path $liveRoot $key)
        }
      }
    }
    $metrics.liveExpertHashMismatchCount = $hashMismatchCount
  } else {
    # either mode: pass if live is empty OR identical to seed
    $isEmpty = ($liveMap.Count -eq 0)
    $sameSet = ($seedMap.Count -eq $liveMap.Count) -and (@($seedMap.Keys | Where-Object { -not $liveMap.ContainsKey($_) }).Count -eq 0)
    $hashDiff = 0
    if ($sameSet -and -not $isEmpty) {
      foreach ($key in $seedMap.Keys) {
        if ((Hash-File -Path $seedMap[$key]) -ne (Hash-File -Path $liveMap[$key])) {
          $hashDiff += 1
          break
        }
      }
    }
    if (-not $isEmpty -and (-not $sameSet -or $hashDiff -gt 0)) {
      $findings += New-Finding -Code "live_expert_invalid_state" -Message "expert-workspace is neither empty nor seed-equivalent." -Path $liveRoot
    }
  }
}

# 7) stale running marker check (status says running but ownerPID dead)
$staleStatusCount = 0
if (Test-Path -LiteralPath (Join-Path $runtimeRoot "long-task-campaigns")) {
  $campaignStateFiles = Get-ChildItem -LiteralPath (Join-Path $runtimeRoot "long-task-campaigns") -Recurse -File -Filter "campaign.json" -ErrorAction SilentlyContinue
  foreach ($file in $campaignStateFiles) {
    try {
      $state = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      if ($state.status -eq "running" -and $state.ownerPID) {
        $ownerAlive = Get-Process -Id ([int]$state.ownerPID) -ErrorAction SilentlyContinue
        if (-not $ownerAlive) {
          $staleStatusCount += 1
          $findings += New-Finding -Code "stale_campaign_running" -Message ("campaign.json says running but owner PID {0} is not alive." -f $state.ownerPID) -Path $file.FullName
        }
      }
    } catch {}
  }
}
if (Test-Path -LiteralPath (Join-Path $runtimeRoot "long-task\\runs")) {
  $progressFiles = Get-ChildItem -LiteralPath (Join-Path $runtimeRoot "long-task\\runs") -Recurse -File -Filter "progress_state.json" -ErrorAction SilentlyContinue
  foreach ($file in $progressFiles) {
    try {
      $progress = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      if ($progress.status -eq "running" -and $progress.ownerPID) {
        $ownerAlive = Get-Process -Id ([int]$progress.ownerPID) -ErrorAction SilentlyContinue
        if (-not $ownerAlive) {
          $staleStatusCount += 1
          $findings += New-Finding -Code "stale_run_running" -Message ("progress_state.json says running but owner PID {0} is not alive." -f $progress.ownerPID) -Path $file.FullName
        }
      }
    } catch {}
  }
}
$metrics.staleRunningMarkerCount = $staleStatusCount

$passed = ($findings.Count -eq 0)
$result = [ordered]@{
  passed = $passed
  checkedAt = $checkedAt
  summary = if ($passed) { "Cleanup verification passed. Environment is clean for zero-start." } else { "Cleanup verification failed. Residual state exists." }
  metrics = $metrics
  findings = $findings
}

$result | ConvertTo-Json -Depth 8
if ($passed) {
  exit 0
}
exit 1
