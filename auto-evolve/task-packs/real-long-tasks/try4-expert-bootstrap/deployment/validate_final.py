#!/usr/bin/env python3
import zipfile, re

report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
exp_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"

def extract_text(path):
    with zipfile.ZipFile(path) as z:
        content = z.read('word/document.xml').decode('utf-8', errors='replace')
    text = re.sub(r'<[^>]+>', '', content)
    return text

print("=== Report validation ===")
report_text = extract_text(report_path)
print("Report size:", len(report_text), "chars")

# Check key values
print("\nKey value checks:")
for val in ['20260', '20665.2', '20,260', '20,665', '南京恩瑞特实业有限公司', '2026年3月23日']:
    found = val in report_text
    print("  " + val + ": " + str(found))

# Check remaining placeholders with U+3010/U+3011
left_count = report_text.count('\u3010')
right_count = report_text.count('\u3011')
print("\nRemaining brackets (U+3010/U+3011):", left_count, "/", right_count)

# Check if the residual is in a textbox/drawing element
with zipfile.ZipFile(report_path) as z:
    xml = z.read('word/document.xml').decode('utf-8', errors='replace')

# Find where the remaining U+3010 is
idx = xml.find('\u3010')
if idx >= 0:
    print("First remaining U+3010 at index:", idx)
    print("Context:", repr(xml[idx-50:idx+200]))

print("\n=== Explanation validation ===")
exp_text = extract_text(exp_path)
print("Explanation size:", len(exp_text), "chars")

print("\nKey value checks:")
for val in ['20260', '20665.2', '20,260', '20,665', '南京恩瑞特实业有限公司', '2026年3月23日', '保护架', '废碳钢', '2000', '1900']:
    found = val in exp_text
    print("  " + val + ": " + str(found))

left_exp = exp_text.count('\u3010')
right_exp = exp_text.count('\u3011')
print("\nRemaining brackets (U+3010/U+3011):", left_exp, "/", right_exp)

print("\n=== Final checks ===")
print("Report is valid zip:", zipfile.is_zipfile(report_path))
print("Explanation is valid zip:", zipfile.is_zipfile(exp_path))
print("Report has word/document.xml:", 'word/document.xml' in zipfile.ZipFile(report_path).namelist())
print("Explanation has word/document.xml:", 'word/document.xml' in zipfile.ZipFile(exp_path).namelist())