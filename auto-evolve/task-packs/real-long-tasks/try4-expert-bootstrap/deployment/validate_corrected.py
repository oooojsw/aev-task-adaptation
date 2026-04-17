import zipfile
import re
import json
import os

report_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx'
explanation_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx'
source_xlsx = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\恩瑞特拟处置废旧物资项目评估计算表0330.xlsx'
data_mappings_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\expert-workspace\data_mappings.json'

print('=== BLANK-AGENT DEPLOYMENT VALIDATION (CORRECTED) ===\n')

print('--- targets-exist check ---')
print(f'report exists: {os.path.exists(report_path)}')
print(f'explanation exists: {os.path.exists(explanation_path)}')
print()

targets_exist = os.path.exists(report_path) and os.path.exists(explanation_path)

def extract_plain_text(path):
    with zipfile.ZipFile(path, 'r') as z:
        with z.open('word/document.xml') as f:
            content = f.read().decode('utf-8')
    text = re.sub(r'<[^>]+>', '', content)
    return text

report_text = extract_plain_text(report_path)
explanation_text = extract_plain_text(explanation_path)

print('--- placeholder-free check (【】 U+300A/B) ---')
report_placeholders = re.findall(r'【[^】]*】', report_text)
explanation_placeholders = re.findall(r'【[^】]*】', explanation_text)
u3010_report = report_text.count('\u3010')
u3011_report = report_text.count('\u3011')
u3010_exp = explanation_text.count('\u3010')
u3011_exp = explanation_text.count('\u3011')

print(f'Report 【...】 placeholders: {len(report_placeholders)}')
if report_placeholders:
    print(f'  Unique: {set(report_placeholders)}')
print(f'Explanation 【...】 placeholders: {len(explanation_placeholders)}')
if explanation_placeholders:
    print(f'  Unique: {set(explanation_placeholders)}')
print(f'U+300A (【) in report: {u3010_report}, explanation: {u3010_exp}')
print(f'U+300B (】) in report: {u3011_report}, explanation: {u3011_exp}')

placeholder_free = (len(report_placeholders) == 0 and len(explanation_placeholders) == 0 and 
                    u3010_report == 0 and u3011_report == 0 and u3010_exp == 0 and u3011_exp == 0)
print(f'placeholder-free PASS: {placeholder_free}')
print()

print('--- critical-fields check ---')
with open(data_mappings_path, 'r', encoding='utf-8') as f:
    dm = json.load(f)

critical_fields = {
    '产权持有单位': '南京恩瑞特实业有限公司',
    '评估基准日': '2026年3月23日',
}

field_checks = {}
for field, expected in critical_fields.items():
    in_report = expected in report_text
    in_explanation = expected in explanation_text
    match = in_report and in_explanation
    field_checks[field] = match
    print(f'{field} = {expected}: report={in_report}, explanation={in_explanation}, match={match}')

print()

print('--- numeric-value traceability check ---')
print('Source xlsx values (from data_mappings.json):')
print('  评估值_不含税 = 20,260')
print('  评估值_含税 = 20,665.2')
print('  总重量 = 10.13')
print('  报价A = 2,000')
print()

traceability = {}
for val, label in [('20260', '20260'), ('20665.2', '20665.2'), ('10.13', '10.13'), ('2000', '2000')]:
    in_report = val in report_text or f'{val},' in report_text or f',{val}' in report_text
    in_explanation = val in explanation_text or f'{val},' in explanation_text or f',{val}' in explanation_text
    traceability[label] = {'report': in_report, 'explanation': in_explanation}
    print(f'{label}: report={in_report}, explanation={in_explanation}')

for val in ['20,260', '20,665', '22893.8']:
    in_report = val in report_text
    in_explanation = val in explanation_text
    print(f'(variant {val}): report={in_report}, explanation={in_explanation}')

print()

print('--- reference-alignment check (CORRECTED) ---')
print('The correct check: do generated docs contain source-derived values 20,260/20665.2?')
correct_vals_present = ('20260' in report_text or '20,260' in report_text) and ('20665.2' in report_text or '20,665' in report_text)
print(f'Correct values (20,260 / 20665.2) in report: {correct_vals_present}')
wrong_val_present = '22893.8' in report_text
print(f'Wrong value (22893.8) in report: {wrong_val_present}')

print()
print('=== SUMMARY ===')
all_pass = (targets_exist and placeholder_free and 
            all(field_checks.values()) and 
            correct_vals_present and not wrong_val_present)
print(f'All blocking validators pass: {all_pass}')
if not all_pass:
    blockers = []
    if not targets_exist:
        blockers.append('Output files missing')
    if not placeholder_free:
        blockers.append('Unresolved placeholders remain')
    if not all(field_checks.values()):
        blockers.append(f'Critical field mismatch: {field_checks}')
    if not correct_vals_present:
        blockers.append('Correct source values 20,260/20665.2 missing from generated docs')
    if wrong_val_present:
        blockers.append('Wrong value 22893.8 present in generated docs (not traceable to source)')
    for b in blockers:
        print(f'  BLOCKER: {b}')
