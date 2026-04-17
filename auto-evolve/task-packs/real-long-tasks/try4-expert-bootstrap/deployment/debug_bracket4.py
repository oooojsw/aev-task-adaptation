#!/usr/bin/env python3
import zipfile, re

# Check template
template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'

with zipfile.ZipFile(template_path) as z:
    raw = z.read('word/document.xml')

text = raw.decode('utf-8', errors='replace')

# Extract all text between brackets
def extract_between(text, left, right):
    results = []
    idx = 0
    while True:
        start = text.find(left, idx)
        if start < 0:
            break
        end = text.find(right, start + 1)
        if end < 0:
            break
        content = text[start+1:end]
        results.append(content)
        idx = end + 1
    return results

print('=== Template placeholders (U+300A/U+300B) ===')
placeholders_300a = extract_between(text, '\u300a', '\u300b')
print('Count: ' + str(len(placeholders_300a)))
print('Unique: ' + str(set(placeholders_300a)))

print('')
print('=== Template placeholders (U+3010/U+3011) ===')
placeholders_3010 = extract_between(text, '\u3010', '\u3011')
print('Count: ' + str(len(placeholders_3010)))
print('Unique: ' + str(sorted(set(placeholders_3010))))

# Check generate_final.py output
generated_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx'

with zipfile.ZipFile(generated_path) as z:
    gen_raw = z.read('word/document.xml')

gen_text = gen_raw.decode('utf-8', errors='replace')

print('')
print('=== Generated doc placeholders (U+300A/U+300B) ===')
gen_300a = extract_between(gen_text, '\u300a', '\u300b')
print('Count: ' + str(len(gen_300a)))
print('Unique: ' + str(sorted(set(gen_300a))))

print('')
print('=== Generated doc placeholders (U+3010/U+3011) ===')
gen_3010 = extract_between(gen_text, '\u3010', '\u3011')
print('Count: ' + str(len(gen_3010)))
unique_gen = sorted(set(gen_3010))
print('Unique count: ' + str(len(unique_gen)))
for p in unique_gen:
    print('  ' + repr(p))