$c = Get-Content 'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\materials\report-template-extracted\word\document.xml' -Raw -Encoding UTF8
$m = [regex]::Matches($c, '【([^】]+)】')
$m | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
Write-Host "---COUNT---"
$m.Count