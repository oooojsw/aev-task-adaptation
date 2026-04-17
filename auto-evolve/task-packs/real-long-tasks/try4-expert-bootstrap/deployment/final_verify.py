#!/usr/bin/env python3
"""Final verification of generated outputs"""
import zipfile, re, os

report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
exp_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"

def extract_text(path):
    with zipfile.ZipFile(path) as z:
        content = z.read('word/document.xml').decode('utf-8', errors='replace')
    return re.sub(r'<[^>]+>', '', content)

report_text = extract_text(report_path)
exp_text = extract_text(exp_path)

print("=== FINAL VERIFICATION ===")
print(f"\nReport: {os.path.getsize(report_path)} bytes")
print(f"Explanation: {os.path.getsize(exp_path)} bytes")

print(f"\nReport text (first 500 chars):")
print(report_text[:500])

print(f"\nExplanation text (first 500 chars):")
print(exp_text[:500])

# Check for 20665.2 variants
print("\n=== Checking tax values ===")
for val in ['20665.2', '20665', '20,665', '20665.2', '20,665.2']:
    in_report = val in report_text
    in_exp = val in exp_text
    print(f"'{val}': report={in_report}, exp={in_exp}")