#!/usr/bin/env python3
"""
Extract placeholders from templates and replace them.
"""
import zipfile
import re
import os
import shutil

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"
WORK_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\work"

LEFT = '\u300a'  # 【
RIGHT = '\u300b'  # 】

def extract_placeholders(content):
    """Extract all placeholder texts from content"""
    placeholders = []
    left_positions = []
    idx = 0
    while True:
        idx = content.find(LEFT, idx)
        if idx < 0:
            break
        left_positions.append(idx)
        idx += 1
    
    for left_pos in left_positions:
        search = content[left_pos+1:left_pos+200]
        right_pos_in_search = search.find(RIGHT)
        if right_pos_in_search >= 0:
            right_pos = left_pos + 1 + right_pos_in_search
            text = content[left_pos+1:right_pos]
            placeholders.append(text)
    
    return placeholders

def build_replacement_dict(placeholders, value_source):
    """Build a replacement dict from placeholders"""
    result = {}
    for p in placeholders:
        if p in value_source:
            result[p] = value_source[p]
        else:
            result[p] = ""  # Unknown placeholder
    return result

def replace_placeholders(content, replacements):
    """Replace all placeholders in content"""
    result = content
    
    # First pass: replace continuous patterns
    for placeholder, value in replacements.items():
        if not value and value != 0:
            continue
        pattern = LEFT + placeholder + RIGHT
        if pattern in result:
            result = result.replace(pattern, value)
    
    return result

# --- REPORT ---
report_template_path = os.path.join(OUTPUT_DIR, "report-template-extracted", "word", "document.xml")
with open(report_template_path, 'r', encoding='utf-8') as f:
    report_content = f.read()

report_placeholders = extract_placeholders(report_content)
print(f"Report: found {len(report_placeholders)} placeholders")
report_unique = list(set(report_placeholders))
print(f"Report: {len(report_unique)} unique")

# Our data mapping values for placeholders we know
REPORT_VALUES = {
    "产权持有单位": "南京恩瑞特实业有限公司",
    "举办单位": "江苏省国信集团有限公司",
    "其他报告使用人说明": "除国家法律、法规另有规定外，未经我公司同意，不得将本报告书的内容提供给他人使用",
    "宗旨和业务范围": "电子、通信与自动控制技术研究；卫星通信技术开发；通信系统开发；通信设备制造；雷达及配套设备制造；其他计算机制造；软件开发；信息技术咨询服务",
    "开办资金": "",
    "报告文号": "华辰评报字(2026)第XXXX号",
    "报告日": "2026年3月23日",
    "报告日期中文大写": "二零二六年三月二十三日",
    "法定代表人": "",
    "注册地址": "",
    "统一社会信用代码": "",
    "评估基准日": "2026年3月23日",
    "评估机构": "HUACHEN ASSETS APPRAISAL CO.,LTD",
    "评估目的详细描述": "拟处置设备资产的快速变现价值",
    "评估结果金额": "20,260 (不含税)",
    "评估结论有效期截止日": "2027年3月22日",
}

# Build replacement dict
report_replacements = {}
for p in report_unique:
    if p in REPORT_VALUES:
        report_replacements[p] = REPORT_VALUES[p]
    else:
        # Unknown placeholder - try partial match
        found = False
        for key, val in REPORT_VALUES.items():
            if key in p or p in key:
                report_replacements[p] = val
                found = True
                break
        if not found:
            report_replacements[p] = ""

print(f"\nReport replacement keys ({len(report_replacements)}):")
for k, v in list(report_replacements.items())[:5]:
    print(f"  '{k}' -> '{v}'")

# Replace in report
report_result = replace_placeholders(report_content, report_replacements)

# Check remaining brackets
remaining_left = report_result.count(LEFT)
remaining_right = report_result.count(RIGHT)
print(f"\nReport after replacement: LEFT={remaining_left}, RIGHT={remaining_right}")

# --- EXPLANATION ---
exp_template_path = os.path.join(OUTPUT_DIR, "explanation-template-extracted", "word", "document.xml")
with open(exp_template_path, 'r', encoding='utf-8') as f:
    exp_content = f.read()

exp_placeholders = extract_placeholders(exp_content)
print(f"\nExplanation: found {len(exp_placeholders)} placeholders")
exp_unique = list(set(exp_placeholders))
print(f"Explanation: {len(exp_unique)} unique")

EXPLANATION_VALUES = {
    "主材1": "废碳钢",
    "主材1单价": "2,000 (元/吨)",
    "主材1重量": "0.5 (吨)",
    "主材2": "",
    "主材2单价": "1,900 (元/吨)",
    "主材2重量": "",
    "主材构成": "废碳钢",
    "产权持有单位": "南京恩瑞特实业有限公司",
    "具体存放位置": "",
    "典型设备名称": "保护架",
    "存放地点": "",
    "存放情况": "",
    "序号": "1",
    "报告文号": "华辰评报字(2026)第XXXX号",
    "是否申报账面价值": "",
    "案例计算公式": "0.5×2000=1000",
    "案例评估值": "1,000 (不含税)",
    "规格型号": "若干",
    "设备状态": "",
    "设备类别一": "",
    "设备类别三": "",
    "设备类别二": "",
    "评估基准日": "2026年3月23日",
    "评估机构": "HUACHEN ASSETS APPRAISAL CO.,LTD",
    "评估结果金额": "20,260 (不含税)",
    "购置时间范围": "",
}

exp_replacements = {}
for p in exp_unique:
    if p in EXPLANATION_VALUES:
        exp_replacements[p] = EXPLANATION_VALUES[p]
    else:
        exp_replacements[p] = ""

print(f"\nExplanation replacement keys ({len(exp_replacements)}):")
for k, v in list(exp_replacements.items())[:10]:
    print(f"  '{k}' -> '{v}'")

exp_result = replace_placeholders(exp_content, exp_replacements)
remaining_left = exp_result.count(LEFT)
remaining_right = exp_result.count(RIGHT)
print(f"\nExplanation after replacement: LEFT={remaining_left}, RIGHT={remaining_right}")
