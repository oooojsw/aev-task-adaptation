#!/usr/bin/env python3
"""Remove the residual multi-run bracket from report document"""
import zipfile, re, os, shutil

report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
work_dir = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\work\report_fix"

# Extract
if os.path.exists(work_dir):
    shutil.rmtree(work_dir)
os.makedirs(work_dir)

with zipfile.ZipFile(report_path) as z:
    z.extractall(work_dir)

# Read document.xml
doc_xml_path = os.path.join(work_dir, "word", "document.xml")
with open(doc_xml_path, 'r', encoding='utf-8') as f:
    content = f.read()

# The residual bracket pair is a multi-run spanning pair
# It starts at U+3010 and contains XML markup inside
# We need to find and remove just this specific malformed pair

# Find all U+3010 positions
positions_3010 = []
idx = 0
while True:
    idx = content.find('\u3010', idx)
    if idx < 0:
        break
    positions_3010.append(idx)
    idx += 1

print(f"Found {len(positions_3010)} U+3010 positions")

# For each position, check if it's a data placeholder or a structural bracket
# The residual has content that starts with </w:t> 
for pos in positions_3010:
    right = content.find('\u3011', pos + 1)
    if right < 0:
        continue
    between = content[pos+1:right]
    # Check if between contains XML (not a pure text placeholder)
    if '</w:' in between or '<w:' in between:
        print(f"\nResidual bracket pair at {pos}-{right}")
        print(f"Between: {repr(between[:100])}")
        print(f"Full between length: {len(between)}")
        
        # This is the malformed bracket - we need to remove just the brackets but keep the content
        # The content spans multiple XML runs - we just remove the bracket characters
        # Since the bracket chars are UTF-8 sequences in the raw XML, we need to remove them carefully
        
        # Actually the simplest approach: replace the specific bracket pair with just the content between
        # But the content includes XML structure... so we need to keep the XML but remove the brackets
        
        # Let's just remove the bracket characters from the content
        # The U+3010 and U+3011 are single characters in the string
        new_between = between.replace('\u3010', '').replace('\u3011', '')
        new_content = content[:pos] + new_between + content[right+1:]
        print(f"\nReplacing from {pos} to {right+1} with cleaned content")
        content = new_content
        break

# Also add 20665.2 value - check if it's referenced in the document
# The report should contain both 20,260 (excluding tax) and 20,665.2 (including tax)
# Let me check if the doc has a field for including-tax value

# Write back
with open(doc_xml_path, 'w', encoding='utf-8') as f:
    f.write(content)

# Repack
output_path = os.path.join(os.path.dirname(report_path), "generated-report.docx")
if os.path.exists(output_path):
    os.remove(output_path)

with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(work_dir):
        for file in files:
            file_path = os.path.join(root, file)
            arc_name = os.path.relpath(file_path, work_dir)
            zf.write(file_path, arc_name)

print(f"\nFixed report: {os.path.getsize(output_path)} bytes")

# Verify
with zipfile.ZipFile(output_path) as z:
    xml = z.read('word/document.xml').decode('utf-8', errors='replace')
    
remaining_3010 = xml.count('\u3010')
remaining_300a = xml.count('\u300a')
print(f"Remaining U+3010: {remaining_3010}")
print(f"Remaining U+300A: {remaining_300a}")

# Check key values
text = re.sub(r'<[^>]+>', '', xml)
print(f"Contains '20,260': {'20,260' in text}")
print(f"Contains '20665.2': {'20665.2' in text}")