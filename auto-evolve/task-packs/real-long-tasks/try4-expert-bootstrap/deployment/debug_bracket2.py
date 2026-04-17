#!/usr/bin/env python3
import zipfile, re

template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'

with zipfile.ZipFile(template_path) as z:
    raw = z.read('word/document.xml')

text = raw.decode('utf-8', errors='replace')

# Count all bracket variants
for code in [0x300A, 0x300B, 0x3010, 0x3011, 0x5B, 0x5D]:  # 【 】 【 】 [ ]
    char = chr(code)
    count = text.count(char)
    print(f'U+{code:04X} ({char}) count: {count}')

# Check if U+3010 is present (another common bracket)
count_3010 = text.count('\u3010')
count_3011 = text.count('\u3011')
print(f'\nU+3010: {count_3010}, U+3011: {count_3011}')

# Now try replacing with U+3010
LEFT = '\u3010'
RIGHT = '\u3011'
REPORT_VALUES = {
    "\u3010\u4ea7\u6743\u6301\u6709\u5355\u4f4d\u3011": "南京恩瑞特实业有限公司",
}
pattern = "\u3010\u4ea7\u6743\u6301\u6709\u5355\u4f4d\u3011"
print(f'\nPattern {pattern!r} in text: {pattern in text}')

# Try different bracket combinations
for left_char in ['\u300a', '\u3010', '[']:
    for right_char in ['\u300b', '\u3011', ']']:
        test_pattern = left_char + '\u4ea7\u6743\u6301\u6709\u5355\u4f4d' + right_char
        found = test_pattern in text
        if found:
            print(f'Found with {hex(ord(left_char))}/{hex(ord(right_char))}')"