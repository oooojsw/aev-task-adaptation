#!/usr/bin/env python3
import zipfile, re

exp_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"

with zipfile.ZipFile(exp_path) as z:
    content = z.read('word/document.xml').decode('utf-8', errors='replace')

text = re.sub(r'<[^>]+>', '', content)

# Extract all U+300A/U+300B pairs
def extract_pairs(text, left, right):
    results = []
    idx = 0
    while True:
        start = text.find(left, idx)
        if start < 0:
            break
        end = text.find(right, start + 1)
        if end < 0:
            break
        results.append(text[start:end+1])
        idx = end + 1
    return results

exp_300a = extract_pairs(text, '\u300a', '\u300b')
print("Explanation U+300A/U+300B pairs:", len(exp_300a))
print("\nRemaining U+300A pairs:")
for i, p in enumerate(exp_300a):
    print(f"  {i}: {repr(p[:60])}")

# Also check 3010
exp_3010 = extract_pairs(text, '\u3010', '\u3011')
print("\nExplanation U+3010/U+3011 pairs:", len(exp_3010))
for i, p in enumerate(exp_3010):
    print(f"  {i}: {repr(p[:60])}")

# Compare with template
template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估说明-空数据模板.docx'
with zipfile.ZipFile(template_path) as z:
    template_content = z.read('word/document.xml').decode('utf-8', errors='replace')

template_text = re.sub(r'<[^>]+>', '', template_content)
template_300a = extract_pairs(template_text, '\u300a', '\u300b')
template_3010 = extract_pairs(template_text, '\u3010', '\u3011')

print("\nTemplate explanation:")
print("  U+300A/U+300B pairs:", len(template_300a))
print("  U+3010/U+3011 pairs:", len(template_3010))