import zipfile

# Check both documents
exp_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx"
rep_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"

print("=== Explanation document ===")
with zipfile.ZipFile(exp_path, 'r') as z:
    with z.open('word/document.xml') as f:
        content = f.read().decode('utf-8')

print(f"Contains '22,893.8': {'22,893.8' in content}")
print(f"Contains '22893.8': {'22893.8' in content}")
print(f"Contains '20260': {'20260' in content}")
print(f"Contains '20,260': {'20,260' in content}")

# Find context around 22,893
if '22,893.8' in content:
    idx = content.find('22,893.8')
    print(f"\nContext around '22,893.8': ...{content[max(0,idx-50):idx+60]}...")

print("\n=== Report document ===")
with zipfile.ZipFile(rep_path, 'r') as z:
    with z.open('word/document.xml') as f:
        content = f.read().decode('utf-8')

print(f"Contains '22,893.8': {'22,893.8' in content}")
print(f"Contains '22893.8': {'22893.8' in content}")
print(f"Contains '20260': {'20260' in content}")
print(f"Contains '20,260': {'20,260' in content}")
