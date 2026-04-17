#!/usr/bin/env python3
import zipfile
import re
import os

# Check original template
template_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\report-template-extracted\word\document.xml'
with open(template_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Search for the specific pattern
search = '产权持有单位'
idx = content.find(search)
if idx >= 0:
    print(f'Found "{search}" at index {idx}')
    print(f'Context: ...{content[max(0,idx-100):idx+100]}...')
else:
    print(f'"{search}" not found - may be split across elements')

# Check bracket counts
u300a = '\u300a'  # LEFT CORNER BRACKET
u300b = '\u300b'  # RIGHT CORNER BRACKET
print(f'\nU+300A (LEFT CORNER BRACKET) count: {content.count(u300a)}')
print(f'U+300B (RIGHT CORNER BRACKET) count: {content.count(u300b)}')

# Search for the full placeholder text
full_ph = '【产权持有单位】'
if full_ph in content:
    print(f'Full placeholder "{full_ph}" found')
else:
    print(f'Full placeholder NOT found - likely split across elements')
    # Find where each half is
    idx_left = content.find('【')
    idx_right = content.find('】')
    if idx_left >= 0:
        print(f'  【 found at index {idx_left}: ...{content[max(0,idx_left-30):idx_left+50]}...')
    if idx_right >= 0:
        print(f'  】 found at index {idx_right}: ...{content[max(0,idx_right-50):idx_right+30]}...')
