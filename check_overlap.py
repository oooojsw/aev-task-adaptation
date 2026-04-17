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

ref_rep_numbers = extract_number_tokens(ref_rep_text, 2)

# Check for 22xxx numbers
print("All reference report numbers containing '22' or '228' or '229':")
for n in ref_rep_numbers:
    if '22' in n or '228' in n or '229' in n:
        print(f"  {n}")

print("\nAll reference report numbers:")
for n in ref_rep_numbers:
    print(f"  {n}")

# Check the generated report numbers
import zipfile

gen_rep_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx"
with zipfile.ZipFile(gen_rep_path, 'r') as z:
    with z.open('word/document.xml') as f:
        gen_content = f.read().decode('utf-8')

gen_numbers = extract_number_tokens(gen_content, 2)
print(f"\nGenerated report numbers (total {len(gen_numbers)}):")
for n in gen_numbers[:30]:
    print(f"  {n}")

# Check overlap
matched = [n for n in ref_rep_numbers if n in gen_numbers]
print(f"\nMatched numbers: {len(matched)}/{len(ref_rep_numbers)}")
print(f"Matched: {matched[:20]}")
