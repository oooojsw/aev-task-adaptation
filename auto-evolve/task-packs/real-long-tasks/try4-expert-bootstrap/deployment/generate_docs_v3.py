#!/usr/bin/env python3
"""
Generate Word documents by replacing placeholders in templates.
Handles split placeholders that span multiple XML elements.
"""
import zipfile
import re
import os
import shutil

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"
WORK_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\work"

REPORT_TEMPLATE_DIR = os.path.join(WORK_DIR, "report-template")
EXPLANATION_TEMPLATE_DIR = os.path.join(WORK_DIR, "explanation-template")
REPORT_DOCX = os.path.join(OUTPUT_DIR, "generated-report.docx")
EXPLANATION_DOCX = os.path.join(OUTPUT_DIR, "generated-explanation.docx")

# Clean up work directory
if os.path.exists(WORK_DIR):
    shutil.rmtree(WORK_DIR)

# Report placeholders (17 total)
REPORT_PLACEHOLDERS = {
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

# Explanation placeholders (26 total)
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

LEFT = '\u300a'  # 【
RIGHT = '\u300b'  # 】

def find_all_placeholder_spans(content, placeholders):
    """
    Find all placeholder spans in content, including split ones.
    Returns list of (start, end, key) tuples.
    """
    spans = []
    
    for key, value in placeholders.items():
        # Skip empty replacements
        if not value and value != 0:
            continue
            
        # Pattern 1: Continuous 【key】
        continuous_pattern = f"【{key}】"
        idx = 0
        while True:
            idx = content.find(continuous_pattern, idx)
            if idx < 0:
                break
            spans.append((idx, idx + len(continuous_pattern), key))
            idx += len(continuous_pattern)
    
    # Sort spans by position
    spans.sort(key=lambda x: x[0])
    return spans

def replace_all_placeholders(content, placeholders):
    """
    Replace all placeholders, handling both continuous and split cases.
    """
    result = content
    
    # First, handle continuous placeholders (they don't affect bracket counts)
    for key, value in placeholders.items():
        if not value and value != 0:
            continue
        continuous = f"【{key}】"
        result = result.replace(continuous, value)
    
    # Now handle split placeholders - find LEFT bracket followed by key and RIGHT bracket
    for key, value in placeholders.items():
        if not value and value != 0:
            continue
        
        # Find key text
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
                # Found LEFT before key
                abs_left = search_start + left_pos
                
                # Look forward for RIGHT bracket after key
                search_end = min(len(result), key_pos + len(key) + 100)
                after_key = result[key_pos + len(key):search_end]
                right_pos = after_key.find(RIGHT)
                
                if right_pos >= 0:
                    # Found matching RIGHT after key
                    abs_right = key_pos + len(key) + right_pos + 1
                    
                    # Check this isn't crossing other text
                    # Make sure there's no other text between LEFT and this key
                    between = result[abs_left + 1:key_pos]
                    if LEFT not in between and RIGHT not in between:
                        # Valid split placeholder
                        old_text = result[abs_left:abs_right]
                        result = result[:abs_left] + value + result[abs_right:]
                        
                        # Restart search from beginning (positions changed)
                        key_pos = 0
                        continue
            
            key_pos += 1
    
    return result

def pack_docx(dir_path, output_path):
    """Pack a directory into a docx (zip) file"""
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(dir_path):
            for file in files:
                file_path = os.path.join(root, file)
                arc_name = os.path.relpath(file_path, dir_path)
                zf.write(file_path, arc_name)

def generate_report():
    """Generate the report docx"""
    print("Generating report...")
    
    # Copy fresh template
    if os.path.exists(REPORT_TEMPLATE_DIR):
        shutil.rmtree(REPORT_TEMPLATE_DIR)
    shutil.copytree(os.path.join(OUTPUT_DIR, "report-template-extracted"), REPORT_TEMPLATE_DIR)
    
    doc_xml_path = os.path.join(REPORT_TEMPLATE_DIR, "word", "document.xml")
    
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    print(f"  Original: LEFT={content.count(LEFT)}, RIGHT={content.count(RIGHT)}")
    
    # Replace placeholders
    new_content = replace_all_placeholders(content, REPORT_PLACEHOLDERS)
    
    print(f"  After: LEFT={new_content.count(LEFT)}, RIGHT={new_content.count(RIGHT)}")
    
    # Write updated document.xml
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Pack to docx
    pack_docx(REPORT_TEMPLATE_DIR, REPORT_DOCX)
    print(f"  Generated: {REPORT_DOCX} ({os.path.getsize(REPORT_DOCX)} bytes)")

def generate_explanation():
    """Generate the explanation docx"""
    print("Generating explanation...")
    
    # Copy fresh template
    if os.path.exists(EXPLANATION_TEMPLATE_DIR):
        shutil.rmtree(EXPLANATION_TEMPLATE_DIR)
    shutil.copytree(os.path.join(OUTPUT_DIR, "explanation-template-extracted"), EXPLANATION_TEMPLATE_DIR)
    
    doc_xml_path = os.path.join(EXPLANATION_TEMPLATE_DIR, "word", "document.xml")
    
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    print(f"  Original: LEFT={content.count(LEFT)}, RIGHT={content.count(RIGHT)}")
    
    # Replace placeholders
    new_content = replace_all_placeholders(content, EXPLANATION_PLACEHOLDERS)
    
    print(f"  After: LEFT={new_content.count(LEFT)}, RIGHT={new_content.count(RIGHT)}")
    
    # Write updated document.xml
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Pack to docx
    pack_docx(EXPLANATION_TEMPLATE_DIR, EXPLANATION_DOCX)
    print(f"  Generated: {EXPLANATION_DOCX} ({os.path.getsize(EXPLANATION_DOCX)} bytes)")

if __name__ == "__main__":
    print("=== Generating Word Documents (v3) ===\n")
    generate_report()
    print()
    generate_explanation()
    print("\n=== Done ===")
