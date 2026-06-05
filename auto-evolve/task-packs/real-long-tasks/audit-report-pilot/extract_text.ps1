
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Open('C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\audit-report-pilot\浙江哈工机器人有限公司股权价值内部审核意见.doc')
$text = $doc.Content.Text
$doc.Close()
$word.Quit()
$text | Out-File -FilePath 'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\audit-report-pilot\human_ref_raw.txt' -Encoding utf8
