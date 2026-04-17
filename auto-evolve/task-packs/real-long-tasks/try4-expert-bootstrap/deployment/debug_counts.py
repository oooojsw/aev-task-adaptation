#!/usr/bin/env python3
import zipfile, re

# Debug the generate_fixed.py output - trace what happened to 300A brackets
gen_report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'

# Get original template bracket counts by type
with zipfile.ZipFile(template_path) as z:
    template_xml = z.read('word/document.xml').decode('utf-8', errors='replace')

# Count all brackets in template
template_300a_count = template_xml.count('\u300a')
template_300b_count = template_xml.count('\u300b')
template_3010_count = template_xml.count('\u3010')
template_3011_count = template_xml.count('\u3011')

print("Template brackets:")
print("  U+300A:", template_300a_count)
print("  U+300B:", template_300b_count)
print("  U+3010:", template_3010_count)
print("  U+3011:", template_3011_count)

# Get generated report bracket counts
with zipfile.ZipFile(gen_report_path) as z:
    gen_xml = z.read('word/document.xml').decode('utf-8', errors='replace')

gen_300a_count = gen_xml.count('\u300a')
gen_300b_count = gen_xml.count('\u300b')
gen_3010_count = gen_xml.count('\u3010')
gen_3011_count = gen_xml.count('\u3011')

print("\nGenerated report brackets:")
print("  U+300A:", gen_300a_count)
print("  U+300B:", gen_300b_count)
print("  U+3010:", gen_3010_count)
print("  U+3011:", gen_3011_count)

# Check which bracket type was used for replacements
# Report mappings use U+300A/U+300B for 17 placeholders
# Let's check if 300A/300B were in template
print("\nTemplate has U+300A/U+300B:", template_300a_count > 0)

# Check 3010/3011 content in template
def extract_all_between(text, left, right):
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

# Check what's in the 3010 brackets in template
template_3010_content = extract_all_between(template_xml, '\u3010', '\u3011')
print("\nTemplate U+3010 bracket content (first 5):")
for i, c in enumerate(template_3010_content[:5]):
    print(f"  {i}: len={len(c)}, preview={repr(c[:50])}")

# Check if any of these look like placeholders (short text without XML)
print("\nTemplate 3010 brackets that look like actual placeholders:")
for i, c in enumerate(template_3010_content):
    if len(c) < 50 and '</w:' not in c and '<w:' not in c:
        print(f"  {i}: {repr(c)}")

# Check the residual in generated report
gen_3010_content = extract_all_between(gen_xml, '\u3010', '\u3011')
print("\nGenerated report U+3010 bracket content:")
for i, c in enumerate(gen_3010_content):
    print(f"  {i}: len={len(c)}, preview={repr(c[:80])}")