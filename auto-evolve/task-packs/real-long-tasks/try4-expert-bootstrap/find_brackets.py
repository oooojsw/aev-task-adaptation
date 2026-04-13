# -*- coding: utf-8 -*-
import zipfile

# Read the template - get raw bytes
template_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\materials\report-template.docx'

with zipfile.ZipFile(template_path) as z:
    content = z.read('word/document.xml')
    
# U+3010 = \xe3\x80\x90, U+3011 = \xe3\x80\x91
bracket_open = b'\xe3\x80\x90'
bracket_close = b'\xe3\x80\x91'

# Find all placeholders with their byte positions
placeholders = []
i = 0
while i < len(content):
    idx = content.find(bracket_open, i)
    if idx < 0:
        break
    end_idx = content.find(bracket_close, idx)
    if end_idx < 0:
        break
    # Get raw bytes of the placeholder text
    raw_bytes = content[idx+3:end_idx]
    # Decode as UTF-8
    try:
        text_str = raw_bytes.decode('utf-8')
    except:
        text_str = raw_bytes.decode('latin-1')
    placeholders.append((idx, text_str))
    i = end_idx + 1

# Deduplicate
seen = set()
unique = []
for idx, text in placeholders:
    if text not in seen:
        seen.add(text)
        unique.append(text)

print(f'Found {len(unique)} unique placeholders:')
for p in unique:
    print(f'  【{p}】')