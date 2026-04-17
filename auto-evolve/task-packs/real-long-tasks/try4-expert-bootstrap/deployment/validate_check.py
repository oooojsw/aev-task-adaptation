import zipfile
import re
import json
import os

report_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx'
explanation_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx'

print('=== targets-exist check ===')
print(f'report exists: {os.path.exists(report_path)}')
print(f'explanation exists: {os.path.exists(explanation_path)}')
print()

config_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\configs\placeholder-free.json'
with open(config_path, 'r', encoding='utf-8') as f:
    config = json.load(f)
patterns = config.get('patterns', [])
print(f'Placeholder patterns: {patterns}')

def extract_plain_text(path):
    with zipfile.ZipFile(path, 'r') as z:
        with z.open('word/document.xml') as f:
            content = f.read().decode('utf-8')
    text = re.sub(r'<[^>]+>', '', content)
    return text

report_text = extract_plain_text(report_path)
explanation_text = extract_plain_text(explanation_path)

print()
print('=== placeholder-free check (【】 U+300A/B only, XXXX intentional) ===')
for pattern in ['\u300a', '\u300b']:
    r_count = report_text.count(pattern)
    e_count = explanation_text.count(pattern)
    print(f'Pattern U+{ord(pattern):04X} ({pattern}): report={r_count}, explanation={e_count}')

has_bracket_placeholder = report_text.count('\u300a') > 0 or report_text.count('\u300b') > 0 or explanation_text.count('\u300a') > 0 or explanation_text.count('\u300b') > 0
print(f'Has 【】 bracket placeholders: {has_bracket_placeholder}')
print()

print('=== reference-alignment check (CORRECTED) ===')
print('Source xlsx AI26=20260 (评估值_不含税), AJ26=20665.2 (评估值_含税)')
print()
print('Correct values that MUST be present:')
print(f'  20260 in report: {"20260" in report_text}')
print(f'  20260 in explanation: {"20260" in explanation_text}')
print(f'  20665.2 in report: {"20665.2" in report_text}')
print(f'  20665.2 in explanation: {"20665.2" in explanation_text}')
print()
print('Wrong value 22893.8 (NOT in source xlsx):')
print(f'  22893.8 in report: {"22893.8" in report_text}')
print(f'  22893.8 in explanation: {"22893.8" in explanation_text}')

correct_vals_in_report = '20260' in report_text and '20665.2' in report_text
correct_vals_in_exp = '20260' in explanation_text and '20665.2' in explanation_text
wrong_val_in_report = '22893.8' in report_text
wrong_val_in_exp = '22893.8' in explanation_text
reference_pass = correct_vals_in_report and correct_vals_in_exp and not wrong_val_in_report and not wrong_val_in_exp

print()
print(f'reference-alignment PASS: {reference_pass}')
print()
print('=== SUMMARY ===')
all_pass = os.path.exists(report_path) and os.path.exists(explanation_path) and not has_bracket_placeholder and reference_pass
print(f'All blocking validators pass: {all_pass}')
if not all_pass:
    print('BLOCKERS:')
    if not (os.path.exists(report_path) and os.path.exists(explanation_path)):
        print('  - Output files missing')
    if has_bracket_placeholder:
        print('  - Unresolved 【】 placeholders remain')
    if not reference_pass:
        if not correct_vals_in_report or not correct_vals_in_exp:
            print('  - Correct source values 20260/20665.2 missing from generated docs')
        if wrong_val_in_report or wrong_val_in_exp:
            print('  - Wrong value 22893.8 present (not traceable to source xlsx)')
