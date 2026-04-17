import win32com.client

# Check explanation reference
ref_exp_path = r"C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\华辰评报字(2026)第XXXX号 南京恩瑞特实业有限公司拟处置废旧物资项目评估说明.doc"

app = win32com.client.DispatchEx("Word.Application")
app.Visible = False
app.DisplayAlerts = 0

doc = app.Documents.Open(ref_exp_path, False, True)
text = doc.Content.Text or ""
doc.Close(False)
app.Quit()

print("=== Reference Explanation Text ===")
print(f"Contains '22893.8': {'22893.8' in text}")
print(f"Contains '22,893.8': {'22,893.8' in text}")
print(f"Contains '20260': {'20260' in text}")
print(f"Contains '20,260': {'20,260' in text}")

# Find context around 22893
if '22893.8' in text:
    idx = text.find('22893.8')
    print(f"\nContext around '22893.8': ...{text[max(0,idx-30):idx+40]}...")
if '22,893.8' in text:
    idx = text.find('22,893.8')
    print(f"\nContext around '22,893.8': ...{text[max(0,idx-30):idx+40]}...")
