#!/usr/bin/env python3
import zipfile, re, sys

template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'

with zipfile.ZipFile(template_path) as z:
    raw = z.read('word/document.xml')

# Decode as UTF-8
text = raw.decode('utf-8', errors='replace')

# Count U+300A and U+300B
left_count = text.count('\u300a')
right_count = text.count('\u300b')
print(f'U+300A count: {left_count}')
print(f'U+300B count: {right_count}')

# Find first few U+300A positions
positions = []
idx = 0
while len(positions) < 3:
    idx = text.find('\u300a', idx)
    if idx < 0:
        break
    positions.append(idx)
    idx += 1

print(f'First 3 U+300A at positions: {positions}')

# Check raw bytes at first U+300A position
if positions:
    p = positions[0]
    # Find corresponding byte position
    # Count UTF-8 characters up to character position p
    char_pos = 0
    byte_offset = 0
    while char_pos < p and byte_offset < len(raw):
        b = raw[byte_offset]
        if b < 0x80:
            byte_offset += 1
        elif b < 0xe0:
            byte_offset += 2
        elif b < 0xf0:
            byte_offset += 3
        else:
            byte_offset += 4
        char_pos += 1
    print(f'Char position {p} -> byte offset {byte_offset}')
    snippet = raw[byte_offset:byte_offset+20]
    print(f'Raw bytes at that position: {snippet.hex()}')
    try:
        decoded = snippet.decode('utf-8')
        print(f'Decoded chars: {[hex(ord(c)) for c in decoded]}')
    except Exception as e:
        print(f'Decode error: {e}')

# Find sample text
text_parts = re.findall(r'<w:t[^>]*>([^<]*)</w:t>', text)
print(f'\nTotal text runs: {len(text_parts)}')
print('First 5 text runs:')
for i, t in enumerate(text_parts[:5]):
    print(f'  {i}: {repr(t)}')

# Check if pattern 【产权持有单位】 exists
pattern = '\u300a\u4ea7\u6743\u6301\u6709\u5355\u4f4d\u300b'
print(f'\nPattern {pattern!r} in text: {pattern in text}')

# Find what's between 【 and 】
idx = text.find('\u300a')
if idx >= 0:
    end = text.find('\u300b', idx)
    if end >= 0:
        content_between = text[idx:end+1]
        print(f'First bracket pair content: {repr(content_between)}')