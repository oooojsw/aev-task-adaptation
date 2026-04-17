#!/usr/bin/env python3
import zipfile, re

report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"

with zipfile.ZipFile(report_path) as z:
    xml = z.read('word/document.xml').decode('utf-8', errors='replace')

# Find index of residual 【 and then find its closing 】
idx = xml.find('\u3010')
print("U+3010 at XML index:", idx)

# Find the closing U+3011
search_from = xml.find('\u3010')
right = xml.find('\u3011', search_from + 1)
print("U+3011 at XML index:", right)

# Show content between them
between = xml[idx+1:right]
print("\nBetween brackets (", len(between), "chars):")
print(repr(between))

# Find which runs these fall into
runs = list(re.finditer(r'<w:t[^>]*>([^<]*)</w:t>', xml))
for i, m in enumerate(runs):
    start = m.start()
    end = m.end()
    if start <= idx <= end:
        print(f"\nU+3010 falls in run {i} (start={start}, end={end})")
        print(f"Run content: {repr(m.group(1))}")
    if start <= right <= end:
        print(f"U+3011 falls in run {i} (start={start}, end={end})")
        print(f"Run content: {repr(m.group(1))}")

# Check what the two runs contain
print("\n--- Runs around the residual ---")
for i in range(383, 387):
    if i < len(runs):
        m = runs[i]
        print(f"Run {i}: start={m.start()}, end={m.end()}, content={repr(m.group(1))}")
        if '\u3010' in m.group(1) or '\u3011' in m.group(1):
            print("  ** Contains bracket **")