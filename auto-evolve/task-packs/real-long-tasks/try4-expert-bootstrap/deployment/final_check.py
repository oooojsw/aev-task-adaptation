#!/usr/bin/env python3
import zipfile, re

report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
exp_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"

def extract_text(path):
    with zipfile.ZipFile(path) as z:
        content = z.read('word/document.xml').decode('utf-8', errors='replace')
    text = re.sub(r'<[^>]+>', '', content)
    return text

report_text = extract_text(report_path)
exp_text = extract_text(exp_path)

print("=== Report ===")
print("Size:", len(report_text))

# Key numeric values
print("\nNumeric value checks:")
checks = {
    '20,260': '20,260 (formatted)',
    '20260': '20260 (unformatted)',
    '20665.2': '20665.2 (with tax)',
    '20665': '20665 (partial)',
}
for val, label in checks.items():
    found_report = val in report_text
    found_exp = val in exp_text
    print(f"  {label}: report={found_report}, explanation={found_exp}")

# Bracket counts
print("\nBracket counts:")
print(f"  Report U+3010: {report_text.count(chr(0x3010))}, U+3011: {report_text.count(chr(0x3011))}")
print(f"  Report U+300A: {report_text.count(chr(0x300A))}, U+300B: {report_text.count(chr(0x300B))}")
print(f"  Exp U+3010: {exp_text.count(chr(0x3010))}, U+3011: {exp_text.count(chr(0x3011))}")
print(f"  Exp U+300A: {exp_text.count(chr(0x300A))}, U+300B: {exp_text.count(chr(0x300B))}")

# Verify files are valid ZIP
print("\n=== Validity ===")
print("Report is valid zip:", zipfile.is_zipfile(report_path))
print("Exp is valid zip:", zipfile.is_zipfile(exp_path))
with zipfile.ZipFile(report_path) as z:
    print("Report has word/document.xml:", 'word/document.xml' in z.namelist())
with zipfile.ZipFile(exp_path) as z:
    print("Exp has word/document.xml:", 'word/document.xml' in z.namelist())

# File sizes
import os
report_size = os.path.getsize(report_path)
exp_size = os.path.getsize(exp_path)
print(f"\nReport size: {report_size} bytes")
print(f"Explanation size: {exp_size} bytes")

print("\n=== Summary ===")
print("Report placeholders remaining (3010/3011):", report_text.count(chr(0x3010)))
print("Explanation placeholders remaining (3010/3011):", exp_text.count(chr(0x3010)))
print("Both files valid:", zipfile.is_zipfile(report_path) and zipfile.is_zipfile(exp_path))
print("Key value 20,260 in report:", '20,260' in report_text)
print("Key value 20,260 in explanation:", '20,260' in exp_text)