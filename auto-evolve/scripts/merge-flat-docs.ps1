param(
  [string]$SourceRoot = "C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-flat-docs",
  [string]$OutputFile = "C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-flat-docs\ALL_MERGED.md"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SourceRoot)) {
  throw "Source root not found: $SourceRoot"
}

$files = Get-ChildItem -LiteralPath $SourceRoot -File |
  Where-Object { $_.Name -match '^r\d{3}_' } |
  Sort-Object Name

if (Test-Path -LiteralPath $OutputFile) {
  Remove-Item -LiteralPath $OutputFile -Force
}

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$writer = [System.IO.StreamWriter]::new($OutputFile, $false, $utf8NoBom)
try {
  $writer.WriteLine("# Try4 Expert Bootstrap Combined Round Docs")
  $writer.WriteLine()
  $writer.WriteLine("This file contains the flattened round docs in order, with the sequence kept in each section title.")
  $writer.WriteLine()

  foreach ($file in $files) {
    $writer.WriteLine("## $($file.Name)")
    $writer.WriteLine()
    $content = [System.IO.File]::ReadAllText($file.FullName, $utf8NoBom)
    $writer.Write($content)
    if (-not $content.EndsWith("`n")) {
      $writer.WriteLine()
    }
    $writer.WriteLine()
  }
}
finally {
  $writer.Dispose()
}

Write-Output "Merged $($files.Count) files into $OutputFile"
