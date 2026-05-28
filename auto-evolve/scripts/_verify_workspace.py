import json
import os
import sys
from pathlib import Path

workspace_root = Path(r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\expert-workspace')

files = list(workspace_root.rglob('*'))
files = [f for f in files if f.is_file()]
print(f"Total files found: {len(files)}")

md_files = [f for f in files if f.suffix == '.md']
print(f"Markdown files: {len(md_files)}")

contract = workspace_root / 'surface_contract.json'
print(f"Contract exists: {contract.exists()}")

if contract.exists():
    with open(contract, encoding='utf-8') as f:
        c = json.load(f)
    print(f"Profile: {c.get('profile')}")
    print(f"Documents count: {len(c.get('documents', []))}")
    print(f"Entry: {c.get('entry')}")

manifest = workspace_root / 'manifest.md'
print(f"Manifest exists: {manifest.exists()}")

for f in sorted(files):
    rel = f.relative_to(workspace_root)
    print(f"  {rel}")