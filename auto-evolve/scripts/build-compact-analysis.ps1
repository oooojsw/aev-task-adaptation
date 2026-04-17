param(
  [string]$SourceRoot = "C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-flat-docs",
  [string]$OutputFile = "C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-flat-docs\ALL_ANALYSIS_COMPACT.md",
  [int]$ListLimit = 4,
  [int]$WorkingMemoryLimit = 5,
  [int]$TreeHotspotLimit = 8
)

$ErrorActionPreference = "Stop"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Read-FlatPayload {
  param([Parameter(Mandatory = $true)][string]$Path)

  $lines = [System.IO.File]::ReadAllLines($Path, $utf8NoBom)
  if ($lines.Length -le 6) {
    return ""
  }

  return (($lines[6..($lines.Length - 1)] -join "`n").Trim())
}

function Load-FlatJson {
  param([Parameter(Mandatory = $true)][string]$Path)

  $payload = Read-FlatPayload -Path $Path
  if ([string]::IsNullOrWhiteSpace($payload)) {
    return $null
  }

  return $payload | ConvertFrom-Json -Depth 64
}

function Normalize-Text {
  param([AllowNull()][string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return ""
  }

  return ([regex]::Replace($Text, '\s+', ' ')).Trim()
}

function Truncate-Text {
  param(
    [AllowNull()][string]$Text,
    [int]$MaxLen = 180
  )

  $clean = Normalize-Text -Text $Text
  if ($clean.Length -le $MaxLen) {
    return $clean
  }

  if ($MaxLen -le 1) {
    return $clean.Substring(0, 1)
  }

  return ($clean.Substring(0, $MaxLen - 1)).TrimEnd() + "…"
}

function Get-UniqueStrings {
  param([object[]]$Items)

  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $result = New-Object System.Collections.Generic.List[string]

  foreach ($item in @($Items)) {
    $text = Normalize-Text -Text ([string]$item)
    if ([string]::IsNullOrWhiteSpace($text)) {
      continue
    }

    if ($seen.Add($text)) {
      [void]$result.Add($text)
    }
  }

  return $result
}

function Get-LimitedStrings {
  param(
    [object[]]$Items,
    [int]$Limit,
    [int]$MaxLen = 180
  )

  $unique = Get-UniqueStrings -Items $Items
  $output = New-Object System.Collections.Generic.List[string]

  foreach ($item in @($unique)) {
    $text = Truncate-Text -Text $item -MaxLen $MaxLen
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      [void]$output.Add($text)
    }
    if ($output.Count -ge $Limit) {
      break
    }
  }

  if ($output.Count -eq 0) {
    [void]$output.Add("none")
  }

  return $output
}

function Get-FieldFromMarkdown {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$FieldName
  )

  $pattern = "(?m)^\-\s*" + [regex]::Escape($FieldName) + ":\s*(.+)$"
  $match = [regex]::Match($Text, $pattern)
  if ($match.Success) {
    return Normalize-Text -Text $match.Groups[1].Value
  }

  return $null
}

function Get-SectionBody {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Heading
  )

  $pattern = "(?ms)^##\s+" + [regex]::Escape($Heading) + "\s*\r?\n(?<body>.*?)(?=^##\s+|\z)"
  $match = [regex]::Match($Text, $pattern)
  if ($match.Success) {
    return $match.Groups["body"].Value
  }

  return $null
}

function Get-SectionItems {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Heading,
    [int]$Limit = 4,
    [int]$MaxLen = 180
  )

  $body = Get-SectionBody -Text $Text -Heading $Heading
  if ([string]::IsNullOrWhiteSpace($body)) {
    return @()
  }

  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($rawLine in ($body -split "\r?\n")) {
    $line = $rawLine.Trim()
    if ($line.StartsWith("- ")) {
      $text = Truncate-Text -Text $line.Substring(2).Trim() -MaxLen $MaxLen
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        [void]$lines.Add($text)
      }
    }
  }

  if ($lines.Count -eq 0) {
    return @()
  }

  return (Get-UniqueStrings -Items $lines | Select-Object -First $Limit)
}

function Format-CommandOutcome {
  param([Parameter(Mandatory = $true)]$Outcome)

  $unitId = $Outcome.unitID
  if ([string]::IsNullOrWhiteSpace([string]$unitId)) {
    $unitId = $Outcome.unitId
  }
  if ([string]::IsNullOrWhiteSpace([string]$unitId)) {
    $unitId = "unknown"
  }

  $attempt = $Outcome.attempt
  if ($null -eq $attempt -or [string]::IsNullOrWhiteSpace([string]$attempt)) {
    $attempt = "na"
  }

  $successCount = 0
  if ($null -ne $Outcome.successCommands) {
    $successCount = @($Outcome.successCommands).Count
  }

  $failedCount = 0
  if ($null -ne $Outcome.failedCommands) {
    $failedCount = @($Outcome.failedCommands).Count
  }

  return ("{0}#{1} (+{2}/-{3})" -f $unitId, $attempt, $successCount, $failedCount)
}

function Write-Line {
  param(
    [Parameter(Mandatory = $true)][System.IO.StreamWriter]$Writer,
    [AllowNull()][string]$Text = ""
  )

  $Writer.WriteLine($Text)
}

if (-not (Test-Path -LiteralPath $SourceRoot)) {
  throw "Source root not found: $SourceRoot"
}

$allFiles = Get-ChildItem -LiteralPath $SourceRoot -File | Where-Object { $_.Name -match '^r\d{3}_' }

$campaignFile = $allFiles | Where-Object { $_.Name -match '^r000_.*__campaign\.json$' } | Select-Object -First 1
$treeFile = $allFiles | Where-Object { $_.Name -match '^r000_.*__exploration-tree\.json$' } | Select-Object -First 1
$memoryFile = $allFiles | Where-Object { $_.Name -match '^r000_.*__campaign-working-memory\.json$' } | Select-Object -First 1

$roundSummaryFiles = $allFiles |
  Where-Object { $_.Name -match '^r\d{3}_.*__round-summary\.md$' } |
  Sort-Object Name

$runTraceDigestFiles = $allFiles |
  Where-Object { $_.Name -match '^r\d{3}_.*__run-trace-digest\.json$' } |
  Sort-Object Name

if ($null -eq $campaignFile -or $null -eq $treeFile -or $null -eq $memoryFile) {
  throw "Missing one or more root campaign files in $SourceRoot"
}

$campaign = Load-FlatJson -Path $campaignFile.FullName
$tree = Load-FlatJson -Path $treeFile.FullName
$memory = Load-FlatJson -Path $memoryFile.FullName

$roundMap = [ordered]@{}

foreach ($file in $roundSummaryFiles) {
  if ($file.Name -match '^r(\d{3})_') {
    $round = [int]$Matches[1]
    if (-not $roundMap.Contains($round)) {
      $roundMap[$round] = [ordered]@{}
    }
    $roundMap[$round].SummaryFile = $file
    $roundMap[$round].SummaryText = Read-FlatPayload -Path $file.FullName
  }
}

foreach ($file in $runTraceDigestFiles) {
  if ($file.Name -match '^r(\d{3})_') {
    $round = [int]$Matches[1]
    if (-not $roundMap.Contains($round)) {
      $roundMap[$round] = [ordered]@{}
    }
    $roundMap[$round].DigestFile = $file
    $roundMap[$round].Digest = Load-FlatJson -Path $file.FullName
  }
}

$treeStatusCounts = @{}
foreach ($node in @($tree.nodes)) {
  $status = if ([string]::IsNullOrWhiteSpace([string]$node.status)) { "unknown" } else { [string]$node.status }
  if (-not $treeStatusCounts.ContainsKey($status)) {
    $treeStatusCounts[$status] = 0
  }
  $treeStatusCounts[$status]++
}

$memoryKindCounts = @{}
foreach ($item in @($memory.items)) {
  $kind = if ([string]::IsNullOrWhiteSpace([string]$item.kind)) { "unknown" } else { [string]$item.kind }
  if (-not $memoryKindCounts.ContainsKey($kind)) {
    $memoryKindCounts[$kind] = 0
  }
  $memoryKindCounts[$kind]++
}

$topTreeNodes = @($tree.nodes) |
  Sort-Object @{ Expression = { $_.attemptCount }; Descending = $true }, @{ Expression = { $_.lastUpdatedRound }; Descending = $true } |
  Select-Object -First $TreeHotspotLimit

$realBlockers = @($memory.items) | Where-Object { $_.kind -eq 'real_blocker' } | Sort-Object @{ Expression = { $_.evidenceCount }; Descending = $true }, @{ Expression = { $_.lastSeenRound }; Descending = $true }
$stableFacts = @($memory.items) | Where-Object { $_.kind -eq 'stable_fact' } | Sort-Object @{ Expression = { $_.evidenceCount }; Descending = $true }, @{ Expression = { $_.lastSeenRound }; Descending = $true }
$validatedMethods = @($memory.items) | Where-Object { $_.kind -eq 'validated_method' } | Sort-Object @{ Expression = { $_.evidenceCount }; Descending = $true }, @{ Expression = { $_.lastSeenRound }; Descending = $true }
$packageGaps = @($memory.items) | Where-Object { $_.kind -eq 'package_gap' } | Sort-Object @{ Expression = { $_.evidenceCount }; Descending = $true }, @{ Expression = { $_.lastSeenRound }; Descending = $true }
$forbiddenPaths = @($memory.items) | Where-Object { $_.kind -eq 'forbidden_path' } | Sort-Object @{ Expression = { $_.evidenceCount }; Descending = $true }, @{ Expression = { $_.lastSeenRound }; Descending = $true }

if (Test-Path -LiteralPath $OutputFile) {
  Remove-Item -LiteralPath $OutputFile -Force
}

$writer = [System.IO.StreamWriter]::new($OutputFile, $false, $utf8NoBom)
try {
  Write-Line $writer "# Try4 Expert Bootstrap Compact Analysis"
  Write-Line $writer ""
  Write-Line $writer "Source: $SourceRoot"
  Write-Line $writer ("Captured rounds: {0}" -f $roundSummaryFiles.Count)
  Write-Line $writer ("Generated rounds: {0}" -f $roundMap.Count)
  Write-Line $writer ""

  Write-Line $writer "## Campaign Snapshot"
  Write-Line $writer ("id: {0}" -f $campaign.id)
  Write-Line $writer ("title: {0}" -f $campaign.title)
  Write-Line $writer ("status: {0}" -f $campaign.status)
  Write-Line $writer ("mode: {0}" -f $campaign.mode)
  Write-Line $writer ("currentRound: {0}" -f $campaign.currentRound)
  Write-Line $writer ("tree.updatedThroughRound: {0}" -f $tree.updatedThroughRound)
  Write-Line $writer ("tree.currentPhase: {0}" -f $tree.currentPhase)
  Write-Line $writer ("lastSummary: {0}" -f (Truncate-Text -Text $campaign.lastSummary -MaxLen 220))
  Write-Line $writer ("createdAt: {0}" -f $campaign.createdAt)
  Write-Line $writer ("updatedAt: {0}" -f $campaign.updatedAt)
  Write-Line $writer ""

  Write-Line $writer "## Tree Snapshot"
  Write-Line $writer ("nodes: {0}" -f @($tree.nodes).Count)
  Write-Line $writer ("statusCounts: {0}" -f (($treeStatusCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Name, $_.Value }) -join ", "))
  Write-Line $writer ("frontierRegions: {0}" -f ((Get-LimitedStrings -Items $tree.frontierRegions -Limit 5 -MaxLen 140) -join " | "))
  Write-Line $writer ""
  Write-Line $writer "Tree hotspots:"
  foreach ($node in $topTreeNodes) {
    $summary = Truncate-Text -Text $node.summary -MaxLen 180
    $notes = ""
    if ($node.notes -and @($node.notes).Count -gt 0) {
      $notes = " | notes=" + ((Get-LimitedStrings -Items $node.notes -Limit 2 -MaxLen 120) -join "; ")
    }
    Write-Line $writer ("- {0} | status={1} | attempts={2} | success={3} | fail={4} | lastRound={5} | summary={6}{7}" -f `
      $node.region, $node.status, $node.attemptCount, $node.successCount, $node.failCount, $node.lastUpdatedRound, $summary, $notes)
  }
  Write-Line $writer ""

  Write-Line $writer "## Working Memory Snapshot"
  Write-Line $writer ("items: {0}" -f @($memory.items).Count)
  Write-Line $writer ("kinds: {0}" -f (($memoryKindCounts.GetEnumerator() | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Name, $_.Value }) -join ", "))
  Write-Line $writer ""

  Write-Line $writer "Real blockers:"
  foreach ($item in (Get-UniqueStrings -Items ($realBlockers | Select-Object -First $WorkingMemoryLimit | ForEach-Object { $_.statement }))) {
    Write-Line $writer ("- {0}" -f $item)
  }
  if (@($realBlockers).Count -eq 0) {
    Write-Line $writer "- none"
  }
  Write-Line $writer ""

  Write-Line $writer "Stable facts:"
  foreach ($item in @($stableFacts | Select-Object -First $WorkingMemoryLimit)) {
    Write-Line $writer ("- {0} | evidence={1} | rounds={2}-{3}" -f (Truncate-Text -Text $item.statement -MaxLen 180), $item.evidenceCount, $item.firstSeenRound, $item.lastSeenRound)
  }
  if (@($stableFacts).Count -eq 0) {
    Write-Line $writer "- none"
  }
  Write-Line $writer ""

  Write-Line $writer "Validated methods:"
  foreach ($item in @($validatedMethods | Select-Object -First $WorkingMemoryLimit)) {
    Write-Line $writer ("- {0} | evidence={1} | rounds={2}-{3}" -f (Truncate-Text -Text $item.statement -MaxLen 180), $item.evidenceCount, $item.firstSeenRound, $item.lastSeenRound)
  }
  if (@($validatedMethods).Count -eq 0) {
    Write-Line $writer "- none"
  }
  Write-Line $writer ""

  Write-Line $writer "Package gaps:"
  foreach ($item in @($packageGaps | Select-Object -First $WorkingMemoryLimit)) {
    Write-Line $writer ("- {0} | evidence={1} | rounds={2}-{3}" -f (Truncate-Text -Text $item.statement -MaxLen 180), $item.evidenceCount, $item.firstSeenRound, $item.lastSeenRound)
  }
  if (@($packageGaps).Count -eq 0) {
    Write-Line $writer "- none"
  }
  Write-Line $writer ""

  Write-Line $writer "Forbidden paths:"
  foreach ($item in @($forbiddenPaths | Select-Object -First $WorkingMemoryLimit)) {
    Write-Line $writer ("- {0} | evidence={1} | rounds={2}-{3}" -f (Truncate-Text -Text $item.statement -MaxLen 180), $item.evidenceCount, $item.firstSeenRound, $item.lastSeenRound)
  }
  if (@($forbiddenPaths).Count -eq 0) {
    Write-Line $writer "- none"
  }
  Write-Line $writer ""

  Write-Line $writer "## Round Timeline"
  foreach ($round in $roundMap.Keys | Sort-Object) {
    $entry = $roundMap[$round]
    $summaryText = [string]$entry.SummaryText
    $digest = $entry.Digest

    $mode = Get-FieldFromMarkdown -Text $summaryText -FieldName "mode"
    $status = if ($digest -and $digest.finalStatus) { [string]$digest.finalStatus } else { (Get-FieldFromMarkdown -Text $summaryText -FieldName "status") }
    $summary = if ($digest -and $digest.summary) { [string]$digest.summary } else { (Get-FieldFromMarkdown -Text $summaryText -FieldName "summary") }
    $failurePackets = Get-FieldFromMarkdown -Text $summaryText -FieldName "failure_packets"
    $retryLessons = Get-FieldFromMarkdown -Text $summaryText -FieldName "retry_lessons"
    $learningUnits = Get-FieldFromMarkdown -Text $summaryText -FieldName "learning_units"

    Write-Line $writer ""
    Write-Line $writer ("## Round {0:000}" -f $round)
    Write-Line $writer ("status: {0}" -f (if ([string]::IsNullOrWhiteSpace($status)) { "unknown" } else { $status }))
    if (-not [string]::IsNullOrWhiteSpace($mode)) {
      Write-Line $writer ("mode: {0}" -f $mode)
    }
    Write-Line $writer ("summary: {0}" -f (Truncate-Text -Text $summary -MaxLen 220))
    Write-Line $writer ("packets/retries/learning: {0}/{1}/{2}" -f (if ($failurePackets) { $failurePackets } else { "na" }), (if ($retryLessons) { $retryLessons } else { "na" }), (if ($learningUnits) { $learningUnits } else { "na" }))

    $explored = @()
    if ($digest -and $digest.exploredRegions) {
      $explored = Get-LimitedStrings -Items $digest.exploredRegions -Limit $ListLimit -MaxLen 160
    }
    Write-Line $writer ("explored: {0}" -f (($explored) -join " | "))

    $successPaths = @()
    if ($digest -and $digest.keySuccessPaths) {
      $successPaths = Get-LimitedStrings -Items $digest.keySuccessPaths -Limit $ListLimit -MaxLen 180
    }
    Write-Line $writer ("success: {0}" -f (($successPaths) -join " | "))

    $failurePaths = @()
    if ($digest -and $digest.keyFailurePaths) {
      $failurePaths = Get-LimitedStrings -Items $digest.keyFailurePaths -Limit $ListLimit -MaxLen 180
    }
    Write-Line $writer ("failure: {0}" -f (($failurePaths) -join " | "))

    $blockers = @()
    if ($digest -and $digest.blockers) {
      $blockers = Get-LimitedStrings -Items $digest.blockers -Limit $ListLimit -MaxLen 180
    }
    Write-Line $writer ("blockers: {0}" -f (($blockers) -join " | "))

    $carryover = Get-LimitedStrings -Items (Get-SectionItems -Text $summaryText -Heading "Retry Strategy Carryover" -Limit $ListLimit -MaxLen 180) -Limit $ListLimit -MaxLen 180
    Write-Line $writer ("carryover: {0}" -f (($carryover) -join " | "))

    $packageGapsRound = @()
    if ($digest -and $digest.packageGaps) {
      $packageGapsRound = Get-LimitedStrings -Items $digest.packageGaps -Limit $ListLimit -MaxLen 180
    }
    Write-Line $writer ("gaps: {0}" -f (($packageGapsRound) -join " | "))

    $validatedRound = @()
    if ($digest -and $digest.validatedMethods) {
      $validatedRound = Get-LimitedStrings -Items $digest.validatedMethods -Limit 2 -MaxLen 180
    }
    Write-Line $writer ("validated: {0}" -f (($validatedRound) -join " | "))

    $outcomeLines = @()
    if ($digest -and $digest.commandOutcomes) {
      foreach ($outcome in @($digest.commandOutcomes)) {
        $outcomeLines += (Format-CommandOutcome -Outcome $outcome)
      }
    }
    $outcomeLines = @($outcomeLines | Select-Object -Unique)
    Write-Line $writer ("commands: {0}" -f (($outcomeLines | Select-Object -First 6) -join " | "))
  }
}
finally {
  $writer.Dispose()
}

Write-Output "Wrote compact analysis to $OutputFile"
