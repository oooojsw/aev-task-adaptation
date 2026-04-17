#!/usr/bin/env python3
import zipfile, re

# Inspect the remaining placeholder in detail
template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'

with zipfile.ZipFile(template_path) as z:
    raw = z.read('word/document.xml')

text = raw.decode('utf-8', errors='replace')

# Find the context around the split placeholder
# The remaining pattern starts with </w:t> so find where 【 appears before it
idx = text.find('\u3010')
print("First U+3010 at index:", idx)

# Look at the surrounding text
start_context = max(0, idx - 200)
end_context = min(len(text), idx + 500)
context = text[start_context:end_context]

print("\nContext around first U+3010:")
print("Start part (last 100 chars before U+3010):")
print(repr(context[context.find('\u3010')-100:context.find('\u3010')]))

print("\nFull context (first 400 chars from U+3010):")
# Show up to first </w:t> after U+3010
end_marker = context.find('\u3010')
segment = context[end_marker:end_marker+400]
print(repr(segment))

# Find where this bracket pair ends (looking for U+3011)
remaining = text[idx:]
right_idx = remaining.find('\u3011')
if right_idx >= 0:
    print("\nRight bracket (U+3011) found at offset:", idx + right_idx)
    print("Content between brackets:")
    between = text[idx+1:idx+right_idx]
    print(repr(between))
    
# Also check - is the </w:t> before U+3010 inside or outside the placeholder?
# Find the <w:t> that precedes U+3010
before = text[:idx]
last_wt_close = before.rfind('</w:t>')
last_wt_open = before.rfind('<w:t')
print("\nLast <w:t> before U+3010 at:", last_wt_open)
print("Last </w:t> before U+3010 at:", last_wt_close)
print("Text between last </w:t> and U+3010:", repr(before[last_wt_close+7:idx]))