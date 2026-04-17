#!/usr/bin/env python3
import zipfile, re

# Check explanation template
exp_template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估说明-空数据模板.docx'

with zipfile.ZipFile(exp_template_path) as z:
    raw = z.read('word/document.xml')

text = raw.decode('utf-8', errors='replace')

# Extract all text between U+3010/U+3011 brackets
def extract_between_3011(text):
    results = []
    idx = 0
    while True:
        start = text.find('\u3010', idx)
        if start < 0:
            break
        end = text.find('\u3011', start + 1)
        if end < 0:
            break
        content = text[start+1:end]
        results.append(content)
        idx = end + 1
    return results

print('=== Explanation template placeholders (U+3010/U+3011) ===')
placeholders = extract_between_3011(text)
print('Count: ' + str(len(placeholders)))
unique = sorted(set(placeholders))
print('Unique count: ' + str(len(unique)))
for p in unique:
    print('  ' + repr(p))

# Check generated explanation
gen_exp_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx'

with zipfile.ZipFile(gen_exp_path) as z:
    gen_raw = z.read('word/document.xml')

gen_text = gen_raw.decode('utf-8', errors='replace')

print('')
print('=== Generated explanation placeholders (U+3010/U+3011) ===')
gen_placeholders = extract_between_3011(gen_text)
print('Count: ' + str(len(gen_placeholders)))
gen_unique = sorted(set(gen_placeholders))
print('Unique count: ' + str(len(gen_unique)))
for p in gen_unique:
    print('  ' + repr(p))