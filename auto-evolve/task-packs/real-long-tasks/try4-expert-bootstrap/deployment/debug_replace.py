#!/usr/bin/env python3
"""Debug the replacement process"""
import zipfile
import re
import os
import shutil

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"
WORK_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\work"

LEFT = '\u300a'  # 【
RIGHT = '\u300b'  # 】

EXPLANATION_PLACEHOLDERS = {
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

# Copy template
EXPLANATION_TEMPLATE_DIR = os.path.join(WORK_DIR, "explanation-template")
if os.path.exists(WORK_DIR):
    shutil.rmtree(WORK_DIR)
os.makedirs(WORK_DIR, exist_ok=True)
shutil.copytree(os.path.join(OUTPUT_DIR, "explanation-template-extracted"), EXPLANATION_TEMPLATE_DIR)

doc_xml_path = os.path.join(EXPLANATION_TEMPLATE_DIR, "word", "document.xml")
with open(doc_xml_path, 'r', encoding='utf-8') as f:
    content = f.read()

print(f"Initial: LEFT={content.count(LEFT)}, RIGHT={content.count(RIGHT)}")

# First pass - continuous
result = content
for key, value in EXPLANATION_PLACEHOLDERS.items():
    if not value and value != 0:
        continue
    continuous = f"【{key}】"
    if continuous in result:
        count = result.count(continuous)
        result = result.replace(continuous, value)
        print(f"Continuous '{key}': replaced {count} occurrences")

print(f"After continuous: LEFT={result.count(LEFT)}, RIGHT={result.count(RIGHT)}")

# Second pass - split
replacements = 0
for key, value in EXPLANATION_PLACEHOLDERS.items():
    if not value and value != 0:
        continue
    
    key_pos = 0
    while True:
        key_pos = result.find(key, key_pos)
        if key_pos < 0:
            break
        
        # Look backward for LEFT bracket
        search_start = max(0, key_pos - 300)
        segment = result[search_start:key_pos]
        left_pos = segment.rfind(LEFT)
        
        if left_pos >= 0:
            abs_left = search_start + left_pos
            
            # Look forward for RIGHT bracket
            search_end = min(len(result), key_pos + len(key) + 100)
            after_key = result[key_pos + len(key):search_end]
            right_pos = after_key.find(RIGHT)
            
            if right_pos >= 0:
                abs_right = key_pos + len(key) + right_pos + 1
                
                # Validate no other brackets in between
                between = result[abs_left + 1:key_pos]
                if LEFT not in between and RIGHT not in between:
                    old_text = result[abs_left:abs_right]
                    result = result[:abs_left] + value + result[abs_right:]
                    replacements += 1
                    print(f"Split '{key}': replaced at {abs_left}-{abs_right}")
                    
                    # Restart
                    key_pos = 0
                    continue
        
        key_pos += 1

print(f"After split ({replacements} replacements): LEFT={result.count(LEFT)}, RIGHT={result.count(RIGHT)}")

# Check remaining brackets
remaining_left = result.count(LEFT)
remaining_right = result.count(RIGHT)
if remaining_left > 0 or remaining_right > 0:
    print(f"\nWARNING: {remaining_left} LEFT and {remaining_right} RIGHT brackets remain")
    # Find them
    idx = 0
    count = 0
    while count < 5:
        idx = result.find(LEFT, idx)
        if idx < 0:
            break
        print(f"  LEFT at {idx}: ...{repr(result[max(0,idx-20):idx+30])}...")
        idx += 1
        count += 1
