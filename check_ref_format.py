import subprocess
import sys

# Try using win32com to extract text from reference doc
try:
    import win32com.client
    
    ref_path = r"C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\华辰评报字(2026)第XXXX号 南京恩瑞特实业有限公司拟处置废旧物资项目评估报告.doc"
    
    app = win32com.client.DispatchEx("Word.Application")
    app.Visible = False
    app.DisplayAlerts = 0
    
    doc = app.Documents.Open(ref_path, False, True)
    text = doc.Content.Text or ""
    doc.Close(False)
    app.Quit()
    
    print("=== Reference Report Text (via win32com) ===")
    print(f"Contains '22893.8': {'22893.8' in text}")
    print(f"Contains '22,893.8': {'22,893.8' in text}")
    print(f"Contains '20260': {'20260' in text}")
    print(f"Contains '20,260': {'20,260' in text}")
    
    # Find context around 22893
    if '22893.8' in text:
        idx = text.find('22893.8')
        print(f"\nContext around '22893.8': ...{text[max(0,idx-20):idx+30]}...")
    if '22,893.8' in text:
        idx = text.find('22,893.8')
        print(f"\nContext around '22,893.8': ...{text[max(0,idx-20):idx+30]}...")
        
except Exception as e:
    print(f"win32com not available: {e}")
    print("Using alternative method...")
    
    # Try reading as binary and search for the string
    ref_path = r"C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\华辰评报字(2026)第XXXX号 南京恩瑞特实业有限公司拟处置废旧物资项目评估报告.doc"
    
    with open(ref_path, 'rb') as f:
        content = f.read()
    
    # Try different encodings
    for encoding in ['utf-8', 'gbk', 'gb2312', 'utf-16']:
        try:
            text = content.decode(encoding)
            has_228938 = '22893.8' in text
            has_228938_comma = '22,893.8' in text
            print(f"Encoding {encoding}: '22893.8'={has_228938}, '22,893.8'={has_228938_comma}")
        except:
            pass
