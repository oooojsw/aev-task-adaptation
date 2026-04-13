[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-ChildItem 'C:\Users\ZhuAnZ\Desktop\try4*' -Recurse -Filter 'generate-final.js' | ForEach-Object { Get-Content $_.FullName -Raw }
