#!/usr/bin/env python3
"""Debug placeholder extraction - show raw XML around brackets"""
import os

LEFT = '\u300a'
RIGHT = '\u300b'

def dump_brackets(path, label):
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    print(f"\n=== {label} ===")
    print(f"LEFT count: {content.count(LEFT)}")
    print(f"RIGHT count: {content.count(RIGHT)}")
    
    # Find all LEFT positions
    left_positions = []
    idx = 0
    while True:
        idx = content.find(LEFT, idx)
        if idx < 0:
            break
        left_positions.append(idx)
        idx += 1
    
    print(f"\nFirst 5 LEFT positions: {left_positions[:5]}")
    
    for i, left_pos in enumerate(left_positions[:5]):
        # Find RIGHT after this LEFT
        search = content[left_pos+1:left_pos+300]
        right_pos = search.find(RIGHT)
        
        print(f"\n--- Placeholder {i+1} at {left_pos} ---")
        if right_pos >= 0:
            right_abs = left_pos + 1 + right_pos
            print(f"RIGHT found at {right_abs}, distance = {right_pos}")
            print(f"TEXT: {repr(content[left_pos+1:right_abs])}")
            print(f"\\nFull XML context (200 chars around LEFT):")
            start = max(0, left_pos - 100)
            end = min(len(content), right_abs + 100)
            print(repr(content[start:end]))
        else:
            print("No RIGHT found within 300 chars")

# Report
report_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\report-template-extracted\word\document.xml'
dump_brackets(report_path, "REPORT")

# Explanation
exp_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\explanation-template-extracted\word\document.xml'
dump_brackets(exp_path, "EXPLANATION")
