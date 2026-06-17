import re
import win32com.client

NUMBER_RE = re.compile(r"[\d,]+(?:\.\d+)?")

def normalize_number_token(token):
    return token.replace(",", "").replace("％", "%").strip()

def extract_number_tokens(text, min_digits=2):
    values = []
    for match in NUMBER_RE.findall(text):
        normalized = normalize_number_token(match)
        digit_count = sum(1 for char in normalized if char.isdigit())
        if digit_count < min_digits:
            continue
        values.append(normalized)
    return sorted(set(values))

# Reference report
ref_rep_path = r"C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\华辰评报字(2026)第XXXX号 南京恩瑞特实业有限公司拟处置废旧物资项目评估报告.doc"
app = win32com.client.DispatchEx("Word.Application")
app.Visible = False
app.DisplayAlerts = 0
doc = app.Documents.Open(ref_rep_path, False, True)
ref_rep_text = doc.Content.Text or ""
doc.Close(False)
app.Quit()

# Reference explanation
ref_exp_path = r"C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\华辰评报字(2026)第XXXX号 南京恩瑞特实业有限公司拟处置废旧物资项目评估说明.doc"
doc = app.Documents.Open(ref_exp_path, False, True)
ref_exp_text = doc.Content.Text or ""
doc.Close(False)
app.Quit()

ref_rep_numbers = extract_number_tokens(ref_rep_text, 2)
ref_exp_numbers = extract_number_tokens(ref_exp_text, 2)

print(f"Reference report numbers (total {len(ref_rep_numbers)}):")
print(ref_rep_numbers[:30])
print()
print(f"Reference explanation numbers (total {len(ref_exp_numbers)}):")
print(ref_exp_numbers[:30])
print()

# Check if 22893.8 is in reference
print(f"'22893.8' in report numbers: {'22893.8' in ref_rep_numbers}")
print(f"'228938' in report numbers: {'228938' in ref_rep_numbers}")
print(f"'20260' in report numbers: {'20260' in ref_rep_numbers}")
