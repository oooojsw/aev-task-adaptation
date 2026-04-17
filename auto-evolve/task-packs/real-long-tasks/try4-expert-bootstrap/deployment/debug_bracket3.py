#!/usr/bin/env python3
import zipfile, re

template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'

with zipfile.ZipFile(template_path) as z:
    raw = z.read('word/document.xml')

text = raw.decode('utf-8', errors='replace')

# Count all bracket variants
for code in [0x300A, 0x300B, 0x3010, 0x3011]:
    char = chr(code)
    count = text.count(char)
    code_hex = hex(code)
    print(code_hex + ' count: ' + str(count))

# Check U+3010
print('U+3010: ' + str(text.count('\u3010')))
print('U+3011: ' + str(text.count('\u3011')))

# Try replacing with U+3010
REPORT_VALUES = {}
REPORT_VALUES['\u3010\u4ea7\u6743\u6301\u6709\u5355\u4f4d\u3011'] = '南京恩瑞特实业有限公司'

pattern = '\u3010\u4ea7\u6743\u6301\u6709\u5355\u4f4d\u3011'
print('Pattern with 3010 in text: ' + str(pattern in text))

# Try different bracket combinations
for left_code in [0x300A, 0x3010]:
    for right_code in [0x300B, 0x3011]:
        left_char = chr(left_code)
        right_char = chr(right_code)
        test_pattern = left_char + '\u4ea7\u6743\u6301\u6709\u5355\u4f4d' + right_char
        found = test_pattern in text
        if found:
            print('Found with left=' + hex(left_code) + ' right=' + hex(right_code))