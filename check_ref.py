import zipfile

# Check reference document
ref_path = r"C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\华辰评报字(2026)第XXXX号 南京恩瑞特实业有限公司拟处置废旧物资项目评估报告.doc"

print("=== Checking expert reference report ===")
try:
    with zipfile.ZipFile(ref_path, 'r') as z:
        with z.open('word/document.xml') as f:
            content = f.read().decode('utf-8')
    
    print(f"Contains '22893.8': {'22893.8' in content}")
    print(f"Contains '22,893.8': {'22,893.8' in content}")
    print(f"Contains '20260': {'20260' in content}")
    print(f"Contains '20,260': {'20,260' in content}")
except Exception as e:
    print(f"Error: {e}")
    print("Trying as regular doc (not docx)...")
    with open(ref_path, 'rb') as f:
        content = f.read()
    text = content.decode('utf-8', errors='ignore')
    print(f"Contains '22893.8': {'22893.8' in text}")
    print(f"Contains '22,893.8': {'22,893.8' in text}")
    print(f"Contains '20260': {'20260' in text}")
    print(f"Contains '20,260': {'20,260' in text}")
