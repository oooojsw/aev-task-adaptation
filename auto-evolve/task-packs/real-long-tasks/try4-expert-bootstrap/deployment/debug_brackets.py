#!/usr/bin/env python3
"""Debug script to understand the bracket positions"""
import os
import re

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"
WORK_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\work"
REPORT_TEMPLATE_DIR = os.path.join(OUTPUT_DIR, "report-template-extracted")

doc_xml_path = os.path.join(REPORT_TEMPLATE_DIR, "word", "document.xml")
with open(doc_xml_path, 'r', encoding='utf-8') as f:
    content = f.read()

LEFT = '\u300a'  # 【
RIGHT = '\u300b'  # 】

print(f"Total length: {len(content)}")
print(f"U+300A (【) count: {content.count(LEFT)}")
print(f"U+300B (】) count: {content.count(RIGHT)}")

# Find all positions of LEFT bracket
left_positions = []
idx = 0
while True:
    idx = content.find(LEFT, idx)
    if idx < 0:
        break
    left_positions.append(idx)
    idx += 1

# Find all positions of RIGHT bracket
right_positions = []
idx = 0
while True:
    idx = content.find(RIGHT, idx)
    if idx < 0:
        break
    right_positions.append(idx)
    idx += 1

print(f"\nFirst 10 LEFT bracket positions: {left_positions[:10]}")
print(f"First 10 RIGHT bracket positions: {right_positions[:10]}")

# Look at context around each bracket
print("\n=== Context around LEFT brackets ===")
for pos in left_positions[:5]:
    context = content[max(0, pos-30):pos+30]
    print(f"Pos {pos}: ...{repr(context)}...")

print("\n=== Context around RIGHT brackets ===")
for pos in right_positions[:5]:
    context = content[max(0, pos-30):pos+30]
    print(f"Pos {pos}: ...{repr(context)}...")

# Check if any brackets are part of continuous placeholders
continuous_pattern = re.findall(r'【[^】]*】', content)
print(f"\nContinuous placeholders found: {len(continuous_pattern)}")
for p in continuous_pattern[:3]:
    print(f"  {repr(p)}")

# Find bracket pairs (opening before closing on same line/short segment)
print("\n=== Searching for split placeholders ===")
# Look for the pattern where we have RIGHT bracket close to a LEFT bracket
# by checking positions

# For each LEFT, check if there's a RIGHT after it within reasonable distance
for left_pos in left_positions[:15]:
    # Find next RIGHT after this LEFT
    for right_pos in right_positions:
        if right_pos > left_pos:
            distance = right_pos - left_pos
            if distance < 200:  # Close together
                segment = content[left_pos:right_pos+1]
                if '\n' not in segment and '</w:' not in segment[:50]:
                    print(f"Close pair: LEFT@{left_pos}, RIGHT@{right_pos}, dist={distance}")
                    print(f"  Content: {repr(segment[:100])}")
            break
