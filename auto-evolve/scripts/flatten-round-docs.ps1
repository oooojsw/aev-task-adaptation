param(
  [string]$SourceRoot = "C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-rounds-001-040",
  [string]$DestinationRoot = "C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-flat-docs"
)

$ErrorActionPreference = "Stop"

function Sanitize-Token([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "unknown" }
  $value = $value -replace '[<>:"/\\|?*\x00-\x1F]', '_'
  $value = $value -replace '\s+', '_'
  $value = $value -replace '_+', '_'
  return $value.Trim('_')
}

function Get-LeafBaseName([string]$name) {
  return [System.Text.RegularExpressions.Regex]::Replace($name, '\.[^.]+$', '')
}

function Get-RoundLabel([string]$relativePath) {
  if ($relativePath.StartsWith("campaign\rounds\round-") -and $relativePath -match 'round-(\d{3})') {
    return $Matches[1]
  }
  if ($relativePath.StartsWith("runs\") -and $relativePath -match 'round-(\d{3})') {
    return $Matches[1]
  }
  return "000"
}

function Get-SourceScope([string]$relativePath) {
  if ($relativePath.StartsWith("campaign\rounds\")) { return "campaign-round" }
  if ($relativePath.StartsWith("campaign\")) { return "campaign-root" }
  if ($relativePath.StartsWith("runs\")) { return "run-round" }
  return "other"
}

function Get-ContextParts([string]$relativePath) {
  $parts = @{
    Unit = $null
    Attempt = $null
    Stage = $null
  }

  $segments = $relativePath -split '[\\/]'
  if ($segments.Count -ge 2 -and $segments[0] -eq "campaign" -and $segments[1] -eq "rounds") {
    if ($segments.Count -ge 4) {
      $parts.Unit = $segments[3]
      if ($segments.Count -ge 5) {
        if ($segments[4] -match '^attempt-(\d+)$') {
          $parts.Attempt = $Matches[1]
          if ($segments.Count -ge 6) { $parts.Stage = $segments[5] }
        } else {
          $parts.Stage = $segments[4]
        }
      }
    }
    return $parts
  }

  if ($segments.Count -ge 2 -and $segments[0] -eq "runs") {
    if ($relativePath -match '^runs\\[^\\]+\\units\\([^\\]+)\\attempt-(\d+)\\([^\\]+)\\') {
      $parts.Unit = $Matches[1]
      $parts.Attempt = $Matches[2]
      $parts.Stage = Get-LeafBaseName $Matches[3]
      return $parts
    }
    if ($relativePath -match '^runs\\[^\\]+\\([^\\]+)\\') {
      $parts.Unit = "run"
      $parts.Stage = Get-LeafBaseName $Matches[1]
      return $parts
    }
  }

  if ($segments.Count -ge 2 -and $segments[0] -eq "campaign") {
    $parts.Unit = "campaign"
    $parts.Stage = Get-LeafBaseName $segments[-1]
    return $parts
  }

  $parts.Unit = "misc"
  $parts.Stage = Get-LeafBaseName $segments[-1]
  return $parts
}

function Get-OrderedTextFiles([string]$root) {
  $allowedExtensions = @(".md", ".json", ".jsonl", ".txt", ".log")
  Get-ChildItem -LiteralPath $root -Recurse -File |
    Where-Object { $allowedExtensions -contains $_.Extension.ToLowerInvariant() } |
    Sort-Object FullName
}

function Get-RelativePathCompat([string]$basePath, [string]$fullPath) {
  $base = [System.IO.Path]::GetFullPath($basePath)
  if (-not $base.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $base += [System.IO.Path]::DirectorySeparatorChar
  }
  $baseUri = [Uri]::new($base)
  $fullUri = [Uri]::new([System.IO.Path]::GetFullPath($fullPath))
  $relative = [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fullUri).ToString())
  return $relative -replace '/', '\'
}

if (-not (Test-Path -LiteralPath $SourceRoot)) {
  throw "Source root not found: $SourceRoot"
}

if (Test-Path -LiteralPath $DestinationRoot) {
  Remove-Item -LiteralPath $DestinationRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $DestinationRoot | Out-Null

$files = Get-OrderedTextFiles $SourceRoot
$roundCounters = @{}

foreach ($file in $files) {
  $relativePath = Get-RelativePathCompat $SourceRoot $file.FullName
  $roundLabel = Get-RoundLabel $relativePath
  $scope = Get-SourceScope $relativePath
  $context = Get-ContextParts $relativePath

  if (-not $roundCounters.ContainsKey($roundLabel)) {
    $roundCounters[$roundLabel] = 0
  }
  $roundCounters[$roundLabel]++
  $sequence = $roundCounters[$roundLabel]

  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
  $extension = $file.Extension.ToLowerInvariant()

  $unitPart = if ($context.Unit) { Sanitize-Token $context.Unit } else { "no-unit" }
  $attemptPart = if ($context.Attempt) { "a$($context.Attempt)" } else { "na" }
  $stagePart = if ($context.Stage) { Sanitize-Token $context.Stage } else { "file" }
  $namePart = Sanitize-Token (Get-LeafBaseName $file.Name)
  $outputName = ("r{0}_{1:D4}__{2}__{3}__{4}{5}" -f $roundLabel, $sequence, $unitPart, $attemptPart, $namePart, $extension)

  $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
  $header = @(
    "Round: $roundLabel"
    "Scope: $scope"
    "Unit: $unitPart"
    "Attempt: $attemptPart"
    "Stage: $stagePart"
    "Source file: $($file.Name)"
    ""
  ) -join "`r`n"

  $outputPath = Join-Path $DestinationRoot $outputName
  [System.IO.File]::WriteAllText($outputPath, $header + $content, [System.Text.UTF8Encoding]::new($false))
}

$readme = @"
# Try4 Expert Bootstrap Flat Docs

This folder contains a flattened copy of the text documents from rounds 001 to 040.

## Naming

- Each file starts with `rNNN_` for the round number.
- The file body begins with a small header that records the round, scope, unit, attempt, and stage.
- No source paths are included in the filenames or headers.

## Reading order

1. Start with `r000_` files for the campaign-level overview.
2. Then read `r001_` through `r040_` in order.
3. For a single round, look for `run-trace`, `round-summary`, `campaign-lead`, and `response` files first.
"@

[System.IO.File]::WriteAllText((Join-Path $DestinationRoot "README.md"), $readme, [System.Text.UTF8Encoding]::new($false))

Write-Output "Flattened $($files.Count) documents into $DestinationRoot"
