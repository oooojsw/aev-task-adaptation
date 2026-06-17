import zipfile
import sys

docx_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"

with zipfile.ZipFile(docx_path, 'r') as z:
    with z.open('word/document.xml') as f:
        content = f.read().decode('utf-8')

print("=== Checking for key values in generated-report.docx ===")
print(f"Contains '22893.8': {'22893.8' in content}")
print(f"Contains '22,893.8': {'22,893.8' in content}")
print(f"Contains '20260': {'20260' in content}")
print(f"Contains '20,260': {'20,260' in content}")
print(f"Contains '20260' (without comma): {'20260' in content}")
print(f"Contains '22893.8' (without comma): {'22893.8' in content}")

# Check for Chinese date
print(f"Contains '2026年3月23日': {'2026年3月23日' in content}")
print(f"Contains '南京恩瑞特': {'南京恩瑞特' in content}")
