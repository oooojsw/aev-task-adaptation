#!/usr/bin/env python3
"""Self-validation of generated outputs before claiming completion"""
import zipfile, re, os

report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
exp_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"

print("=== SELF-CHECK: generate-deployment-outputs ===\n")

# 1. Files exist
print("1. Files exist:")
print(f"   report: {os.path.exists(report_path)} ({os.path.getsize(report_path)} bytes)")
print(f"   explanation: {os.path.exists(exp_path)} ({os.path.getsize(exp_path)} bytes)")

# 2. Valid ZIP/docx format
print("\n2. Valid ZIP format:")
print(f"   report: {zipfile.is_zipfile(report_path)}")
print(f"   explanation: {zipfile.is_zipfile(exp_path)}")

# 3. Contains word/document.xml
with zipfile.ZipFile(report_path) as z:
    report_has_xml = 'word/document.xml' in z.namelist()
with zipfile.ZipFile(exp_path) as z:
    exp_has_xml = 'word/document.xml' in z.namelist()
print(f"   report has word/document.xml: {report_has_xml}")
print(f"   explanation has word/document.xml: {exp_has_xml}")

# 4. Extract plain text
def extract_text(path):
    with zipfile.ZipFile(path) as z:
        content = z.read('word/document.xml').decode('utf-8', errors='replace')
    return re.sub(r'<[^>]+>', '', content)

report_text = extract_text(report_path)
exp_text = extract_text(exp_path)

# 5. Check key numeric values
print("\n3. Key numeric values present:")
print(f"   report has '20,260': {'20,260' in report_text}")
print(f"   explanation has '20,260': {'20,260' in exp_text}")
print(f"   report has '20665.2': {'20665.2' in report_text}")
print(f"   explanation has '20665.2': {'20665.2' in exp_text}")

# 6. Data placeholder check (U+3010/U+3011 = actual data placeholders)
report_3010 = len(re.findall(r'\u3010[^\u3011]*\u3011', report_text))
exp_3010 = len(re.findall(r'\u3010[^\u3011]*\u3011', exp_text))
print(f"\n4. Data placeholders (U+3010/U+3011) remaining:")
print(f"   report: {report_3010}")
print(f"   explanation: {exp_3010}")

# 7. Check U+300A/U+300B (structural headers)
report_300a = len(re.findall(r'\u300a[^\u300b]*\u300b', report_text))
exp_300a = len(re.findall(r'\u300a[^\u300b]*\u300b', exp_text))
print(f"\n5. Structural headers (U+300A/U+300B):")
print(f"   report: {report_300a} (section/table headers - not data placeholders)")
print(f"   explanation: {exp_300a} (section/table headers - not data placeholders)")

# 8. Verify key data values from xlsx source
print("\n6. Critical data verification:")
checks = [
    ('南京恩瑞特实业有限公司', '产权持有单位'),
    ('2026年3月23日', '评估基准日'),
    ('HUACHEN', '评估机构'),
    ('20,260', '评估结果金额'),
    ('保护架', '典型设备名称 (explanation only)'),
    ('废碳钢', '主材1 (explanation only)'),
]
for val, label in checks:
    in_report = val in report_text
    in_exp = val in exp_text
    print(f"   {label}: report={in_report}, explanation={in_exp}")

print("\n=== SELF-CHECK RESULT ===")
all_pass = (
    os.path.exists(report_path) and os.path.exists(exp_path) and
    zipfile.is_zipfile(report_path) and zipfile.is_zipfile(exp_path) and
    report_has_xml and exp_has_xml and
    '20,260' in report_text and '20,260' in exp_text and
    report_3010 == 0 and exp_3010 == 0
)
print(f"All checks pass: {all_pass}")
if not all_pass:
    print("FAILURES:")
    if not os.path.exists(report_path): print("  - report file missing")
    if not os.path.exists(exp_path): print("  - explanation file missing")
    if not zipfile.is_zipfile(report_path): print("  - report not valid ZIP")
    if not zipfile.is_zipfile(exp_path): print("  - explanation not valid ZIP")
    if not report_has_xml: print("  - report missing word/document.xml")
    if not exp_has_xml: print("  - explanation missing word/document.xml")
    if '20,260' not in report_text: print("  - report missing 20,260")
    if '20,260' not in exp_text: print("  - explanation missing 20,260")
    if report_3010 > 0: print(f"  - report has {report_3010} unreplaced data placeholders")
    if exp_3010 > 0: print(f"  - explanation has {exp_3010} unreplaced data placeholders")