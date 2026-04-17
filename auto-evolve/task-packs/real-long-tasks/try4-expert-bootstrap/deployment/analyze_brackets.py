#!/usr/bin/env python3
import zipfile, re

# Analyze all 30 U+300A/U+300B pairs in the original template
template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'

with zipfile.ZipFile(template_path) as z:
    xml = z.read('word/document.xml').decode('utf-8', errors='replace')

def find_all_pairs(text, left_char, right_char):
    pairs = []
    idx = 0
    while True:
        start = text.find(left_char, idx)
        if start < 0:
            break
        end = text.find(right_char, start + 1)
        if end < 0:
            break
        pairs.append((start, end, text[start+1:end]))
        idx = end + 1
    return pairs

# Find all U+300A/U+300B pairs
pairs_300a = find_all_pairs(xml, '\u300a', '\u300b')
print("U+300A/U+300B pairs:", len(pairs_300a))

# Find all U+3010/U+3011 pairs
pairs_3010 = find_all_pairs(xml, '\u3010', '\u3011')
print("U+3010/U+3011 pairs:", len(pairs_3010))

# For the problematic residual - find which bracket type it's using
idx = xml.find('\u3010')
print("\nResidual uses U+3010 at index:", idx)

# Check the corresponding U+300A pair in same location region
# Find if there are any U+300A brackets near index 94624
for p in pairs_300a:
    if abs(p[0] - 94624) < 500 or abs(p[1] - 94624) < 500:
        print(f"U+300A pair near residual: {p[0]}-{p[1]}, content={repr(p[2][:50])}")

# Let's also check the content between the U+3010 brackets
start = idx
end = xml.find('\u3011', start + 1)
content = xml[start+1:end]
print("\nContent between residual brackets:")
print(f"  Length: {len(content)}")
print(f"  Preview: {repr(content[:200])}")

# Check if this content spans multiple runs
runs = list(re.finditer(r'<w:t[^>]*>([^<]*)</w:t>', xml))
print(f"\nTotal text runs: {len(runs)}")

# Check how many runs this content spans
run_indices = []
for i, m in enumerate(runs):
    if m.start() >= start and m.end() <= end:
        run_indices.append(i)
print(f"Content spans runs: {run_indices}")

# For the 17 report placeholders from mappings, let's check their bracket type
report_placeholders = [
    "产权持有单位", "举办单位", "其他报告使用人说明", "宗旨和业务范围", "开办资金",
    "报告文号", "报告日", "报告日期中文大写", "法定代表人", "注册地址",
    "统一社会信用代码", "评估基准日", "评估机构", "评估目的详细描述",
    "评估结果金额", "评估结论有效期截止日"
]

print("\n=== Bracket type for each report placeholder ===")
for ph in report_placeholders:
    p300a = '\u300a' + ph + '\u300b'
    p3010 = '\u3010' + ph + '\u3011'
    has_300a = p300a in xml
    has_3010 = p3010 in xml
    print(f"{ph}: U+300A={has_300a}, U+3010={has_3010}")