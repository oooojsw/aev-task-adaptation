Add-Type -AssemblyName System.IO.Compression.FileSystem

$docxPath = "C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
$tempDir = [System.IO.Path]::GetTempPath() + "docx_extract"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

$archive = [System.IO.Compression.ZipFile]::OpenRead($docxPath)
foreach ($entry in $archive.Entries) {
    $destPath = Join-Path $tempDir $entry.FullName
    $destDir = Split-Path $destPath -Parent
    if (!(Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    $entry.ExtractToFile($destPath, $true)
}
$archive.Dispose()

$docXmlPath = Join-Path $tempDir "word\document.xml"
$content = Get-Content $docXmlPath -Raw -Encoding UTF8

Write-Host "=== Checking for 22893.8 ==="
Write-Host "Contains '22893.8': $($content.Contains('22893.8'))"
Write-Host "Contains '22,893.8': $($content.Contains('22,893.8'))"
Write-Host "Contains '20260': $($content.Contains('20260'))"
Write-Host "Contains '20,260': $($content.Contains('20,260'))"

Remove-Item $tempDir -Recurse -Force
