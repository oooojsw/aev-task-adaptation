#!/usr/bin/env python3
import zipfile

report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
exp_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"

# Check the residual in report
with zipfile.ZipFile(report_path) as z:
    xml = z.read('word/document.xml').decode('utf-8', errors='replace')

# The residual is at index 94624. Let's get the text content around it.
# Strip XML tags to find text
import re
text = re.sub(r'<[^>]+>', '', xml)

# Find index 94624 in XML, then find the corresponding position in stripped text
# Actually, let's just search for the specific residual text
search = '\u3010'
idx = xml.find(search)
print("XML index of residual:", idx)

# Get surrounding context
print("\nXML context (200 chars around U+3010):")
print(xml[idx-100:idx+200])

# Check if the residual is inside a drawing/textbox element
print("\nIs it inside w:pict/v:shape?", '<w:pict>' in xml[max(0,idx-500):idx+100] or '<v:shape' in xml[max(0,idx-500):idx+100])
print("Is it inside w:txbxContent?", '<w:txbxContent>' in xml[max(0,idx-500):idx+100])

# Now let's check what text appears around the residual
# Find the corresponding text run
text_around = text[9000:9600]  # approximate
print("\nText around position 9000-9600:")
print(repr(text_around))

# Count total text runs
runs = re.findall(r'<w:t[^>]*>([^<]*)</w:t>', xml)
print("\nTotal text runs:", len(runs))

# Show the problematic run
for i, run in enumerate(runs):
    if '\u3010' in run or '\u3011' in run:
        print(f"Run {i} contains bracket: {repr(run)}")