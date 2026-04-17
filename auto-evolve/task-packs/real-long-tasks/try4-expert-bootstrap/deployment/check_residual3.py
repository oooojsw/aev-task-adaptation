#!/usr/bin/env python3
import zipfile, re

# Deep analysis of the remaining residual in generated report
gen_report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"

with zipfile.ZipFile(gen_report_path) as z:
    gen_xml = z.read('word/document.xml').decode('utf-8', errors='replace')

# Find all U+3010/U+3011 pairs in generated report
def find_all_pairs(text, left_char, right_char):
    pairs = []
    idx = 0
    while True:
        start = text.find(left_char, idx)
        if start < 0:
            break
        end = text.find(right_char, start + 1)
        if end < 0:
            break
        content = text[start+1:end]
        pairs.append((start, end, content))
        idx = end + 1
    return pairs

gen_pairs = find_all_pairs(gen_xml, '\u3010', '\u3011')
print("Generated report U+3010/U+3011 pairs:", len(gen_pairs))

# Show all remaining pairs
print("\nRemaining pairs:")
for i, (start, end, content) in enumerate(gen_pairs):
    print(f"  {i}: index {start}-{end}, {end-start+1} chars, content={repr(content[:80])}")

# Now check original template - what bracket pairs exist near the residual position?
template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'
with zipfile.ZipFile(template_path) as z:
    template_xml = z.read('word/document.xml').decode('utf-8', errors='replace')

# Find all 3010 pairs in template
template_pairs = find_all_pairs(template_xml, '\u3010', '\u3011')
print("\nTemplate U+3010/U+3011 pairs:", len(template_pairs))

# Find the pair that would be near index 94624 in generated doc
# In the generated doc, the residual is at index 94624
# But in template, the same relative position might have different content
# Let's compare the surrounding context

print("\n=== Checking position mapping ===")
print("Generated residual at index 94624")
print("Template corresponding position should have same structure")

# Check if the template has a U+3010 pair spanning multiple runs at that position
for i, (start, end, content) in enumerate(template_pairs):
    if end - start > 100:  # large content means spanning multiple runs
        print(f"\nLarge template pair {i}: {start}-{end}, {end-start} chars")
        print(f"Content preview: {repr(content[:100])}")

# Check run structure for the problematic pair in template
# The residual in generated spans runs 384-385
# Find corresponding position in template
template_idx = 7976  # This is where U+3010 appears in template
print(f"\nTemplate U+3010 at index {template_idx}")
template_right = template_xml.find('\u3011', template_idx + 1)
print(f"Template U+3011 at index {template_right}")

# Check run structure in template around this position
runs = list(re.finditer(r'<w:t[^>]*>([^<]*)</w:t>', template_xml))
for i, m in enumerate(runs):
    start_pos = m.start()
    end_pos = m.end()
    if abs(start_pos - template_idx) < 50 or abs(end_pos - template_idx) < 50:
        print(f"Template run {i} near index {template_idx}: start={start_pos}, content={repr(m.group(1)[:50])}")
        if '\u3010' in m.group(1) or '\u3011' in m.group(1):
            print(f"  ** Contains bracket **")