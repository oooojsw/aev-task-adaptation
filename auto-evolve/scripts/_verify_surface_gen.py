import json
import os
import sys
from pathlib import Path

workspace_root = Path(r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\expert-workspace')
config_path = Path(r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\scripts\formal-config.json')

with open(config_path, encoding='utf-8') as f:
    config = json.load(f)

forbidden = {item['value'] for item in config['forbiddenLiterals']}
max_hits_per_file = config.get('maxHitsPerFile', 4)
max_total_hits = config.get('maxTotalHits', 12)

files = list(workspace_root.rglob('*'))
files = [f for f in files if f.is_file() and f.suffix in config.get('allowedExtensions', [])]

total_hits = 0
file_hits = []

for f in files:
    try:
        with open(f, encoding='utf-8', errors='ignore') as fh:
            content = fh.read()
    except Exception as e:
        continue
    
    hits_in_file = []
    for literal in forbidden:
        if literal in content:
            count = content.count(literal)
            hits_in_file.append((literal, count))
            total_hits += count
    
    if hits_in_file:
        file_hits.append((str(f.relative_to(workspace_root)), hits_in_file))

print(f"scanned_roots: 1")
print(f"scanned_files: {len(files)}")
print(f"forbidden_literals_check:")
print(f"  total_hits: {total_hits}")
print(f"  max_allowed_per_file: {max_hits_per_file}")
print(f"  max_allowed_total: {max_total_hits}")
print(f"  violations: {len(file_hits)}")
if file_hits:
    for path, hits in file_hits:
        print(f"    {path}: {hits}")
print(f"passed: {total_hits == 0}")