#!/usr/bin/env python3
"""Extract and display placeholder text properly"""
import os

LEFT = '\u300a'
RIGHT = '\u300b'

# Report
report_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\report-template-extracted\word\document.xml'
with open(report_path, 'r', encoding='utf-8') as f:
    report_content = f.read()

# Find placeholders
report_placeholders = []
idx = 0
while True:
    idx = report_content.find(LEFT, idx)
    if idx < 0:
        break
    segment = report_content[idx+1:idx+200]
    right_pos = segment.find(RIGHT)
    if right_pos >= 0:
        text = segment[:right_pos]
        report_placeholders.append(text)
    idx += 1

# Explanation
exp_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\explanation-template-extracted\word\document.xml'
with open(exp_path, 'r', encoding='utf-8') as f:
    exp_content = f.read()

exp_placeholders = []
idx = 0
while True:
    idx = exp_content.find(LEFT, idx)
    if idx < 0:
        break
    segment = exp_content[idx+1:idx+200]
    right_pos = segment.find(RIGHT)
    if right_pos >= 0:
        text = segment[:right_pos]
        exp_placeholders.append(text)
    idx += 1

# Write to file
output_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\placeholder_dump.txt'
with open(output_path, 'w', encoding='utf-8') as f:
    f.write("REPORT PLACEHOLDERS\n")
    f.write(f"Total: {len(report_placeholders)}\n")
    f.write(f"Unique: {len(set(report_placeholders))}\n\n")
    for i, p in enumerate(report_placeholders):
        f.write(f"{i+1}. {p}\n")
    
    f.write("\n\nEXPLANATION PLACEHOLDERS\n")
    f.write(f"Total: {len(exp_placeholders)}\n")
    f.write(f"Unique: {len(set(exp_placeholders))}\n\n")
    for i, p in enumerate(exp_placeholders):
        f.write(f"{i+1}. {p}\n")

print(f"Written to: {output_path}")
