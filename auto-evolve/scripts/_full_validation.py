import json
import subprocess
import sys
from pathlib import Path

workspace_root = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\expert-workspace'
validator_input = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\scripts\_validator_input.json'
config_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\scripts\formal-config.json'

result_layout = subprocess.run(
    ['node', r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\orchestrator\schema\validate-experience-workspace-layout.js',
     '--workspace', workspace_root,
     '--profile', 'governed'],
    capture_output=True, text=True, cwd=r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve'
)

print("WORKSPACE-LAYOUT VALIDATOR")
print(f"  returncode: {result_layout.returncode}")
print(f"  stdout: {result_layout.stdout[:500]}")
print(f"  stderr: {result_layout.stderr[:500]}")

result_surf = subprocess.run(
    ['python', r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\scripts\validate-experience-surface-generalization.py',
     validator_input, config_path],
    capture_output=True, text=True
)

print("\nEXPERT-SURFACE-GENERALIZATION VALIDATOR")
print(f"  returncode: {result_surf.returncode}")
print(f"  stdout: {result_surf.stdout[:1000]}")
print(f"  stderr: {result_surf.stderr[:500]}")

try:
    with open(r'E:\opencode-auto-evolve-history\runtime-state\long-task-campaigns\20260503-020544680-try4-expert-bootstrap-campaign\dispatch-tickets.json', encoding='utf-8') as f:
        dt = json.load(f)
    tickets = dt.get('tickets', [])
    all_closed = all(t.get('status') == 'closed' for t in tickets)
    print(f"\nDISPATCH-TICKETS.JSON")
    print(f"  total_tickets: {len(tickets)}")
    print(f"  all_closed: {all_closed}")
    for t in tickets:
        print(f"    {t['id']} - {t['key']} - status={t['status']} - updatedAt={t['updatedAt']}")
except Exception as e:
    print(f"\nDISPATCH-TICKETS.JSON ERROR: {e}")