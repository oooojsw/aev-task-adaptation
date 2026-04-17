import zipfile
import re
import json

NUMBER_RE = re.compile(r"[\d,]+(?:\.\d+)?")

def extract_text_from_docx(path):
    with zipfile.ZipFile(path, 'r') as z:
        with z.open('word/document.xml') as f:
            return f.read().decode('utf-8')

def extract_numbers(text, min_digits=2):
    values = []
    for match in NUMBER_RE.findall(text):
        digit_count = sum(1 for c in match if c.isdigit())
        if digit_count >= min_digits:
            values.append(match.replace(",", ""))
    return sorted(set(values))

# Generated documents
report_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
explanation_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"

print("=== Checking Generated Documents ===\n")

report_text = extract_text_from_docx(report_path)
explanation_text = extract_text_from_docx(explanation_path)

# Check required tokens
required_report = ["22893.8"]
required_explanation = ["22893.8"]

print("Report required tokens:")
for token in required_report:
    found = token in report_text
    print(f"  '{token}': {'FOUND' if found else 'MISSING'}")

print("\nExplanation required tokens:")
for token in required_explanation:
    found = token in explanation_text
    print(f"  '{token}': {'FOUND' if found else 'MISSING'}")

# Check key values
print("\n=== Key Value Checks ===")
print(f"Report contains '20,260': {'20,260' in report_text}")
print(f"Report contains '22893.8': {'22893.8' in report_text}")
print(f"Report contains '22,893.8': {'22,893.8' in report_text}")
print(f"Explanation contains '20,260': {'20,260' in explanation_text}")
print(f"Explanation contains '22893.8': {'22893.8' in explanation_text}")
print(f"Explanation contains '22,893.8': {'22,893.8' in explanation_text}")

# Extract numbers
report_nums = extract_numbers(report_text)
explanation_nums = extract_numbers(explanation_text)

print(f"\nReport numbers (4+ digits): {report_nums[:20]}")
print(f"Explanation numbers (4+ digits): {explanation_nums[:20]}")
