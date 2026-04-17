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

# Unpack templates
os.makedirs(WORK_DIR, exist_ok=True)
shutil.copytree(os.path.join(OUTPUT_DIR, "report-template-extracted"), REPORT_TEMPLATE_DIR)
shutil.copytree(os.path.join(OUTPUT_DIR, "explanation-template-extracted"), EXPLANATION_TEMPLATE_DIR)

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

def find_split_placeholder_context(content, placeholder_text):
    """Find context where placeholder text might be split across elements"""
    # Find the text portion
    idx = content.find(placeholder_text)
    if idx < 0:
        return None
    # Look backward for 【 or a page break that might precede it
    search_start = max(0, idx - 500)
    context = content[search_start:idx + len(placeholder_text) + 100]
    return context

def fix_split_placeholders(content):
    """
    Handle placeholders that are split across XML elements.
    Word sometimes splits brackets across different <w:t> elements.
    """
    # Pattern to find 【 followed later by text and then 】
    # This handles cases like: 【</w:t>...<w:t>text】
    result = content
    
    # For each placeholder text, check if it's split
    all_placeholders = {**REPORT_PLACEHOLDERS, **EXPLANATION_PLACEHOLDERS}
    
    for key, value in all_placeholders.items():
        if not value:  # Skip empty replacements
            continue
        
        # Check if the placeholder with brackets exists as a continuous string
        full_bracket = f"【{key}】"
        if full_bracket in result:
            # Already continuous - just replace
            result = result.replace(full_bracket, value)
            continue
        
        # Check for split pattern: 【...text (possibly with XML between)
        # Pattern: 【 followed eventually by key and then 】
        # We need to find where the text might be split
        
        # Look for the closing bracket pattern: text}】 or text】 directly
        # The opening 【 is U+300A, closing 】 is U+300B
        
        # Find occurrences of the key text
        key_idx = result.find(key)
        while key_idx >= 0:
            # Look backward for 【
            search_start = max(0, key_idx - 200)
            segment = result[search_start:key_idx + len(key) + 50]
            
            # Check if there's a 【 somewhere before the key
            left_bracket_idx = segment.rfind('\u300a')  # 【
            if left_bracket_idx >= 0:
                # Check if there's a 】 after the key
                after_key = segment[key_idx + len(key):]
                right_bracket_idx = after_key.find('\u300b')  # 】
                if right_bracket_idx >= 0:
                    # Found a split placeholder
                    # Extract the full split placeholder pattern
                    full_start = search_start + left_bracket_idx
                    full_end = key_idx + len(key) + right_bracket_idx + 1
                    split_placeholder = result[full_start:full_end]
                    
                    # Create replacement value
                    if value:
                        replacement = f"【{key}】".replace(f"【{key}】", value)
                    else:
                        replacement = ""
                    
                    # Replace
                    result = result[:full_start] + value + result[full_end:]
                    
                    # Find next occurrence
                    key_idx = result.find(key, key_idx + len(value))
                else:
                    key_idx = result.find(key, key_idx + 1)
            else:
                key_idx = result.find(key, key_idx + 1)
    
    return result

def simple_replace_placeholders(content, placeholders):
    """Simple placeholder replacement"""
    result = content
    for key, value in placeholders.items():
        # Try full bracket pattern first
        full = f"【{key}】"
        if full in result:
            result = result.replace(full, value)
        else:
            # Try just the key if brackets are split
            if key in result and not value:
                # For empty values, we need to be careful
                pass
    return result

def advanced_replace(content, placeholders):
    """
    Advanced replacement that handles split brackets.
    Strategy: For each placeholder, find the bracket+text+bracket pattern
    even if brackets are in different XML elements.
    """
    result = content
    
    for key, value in placeholders.items():
        # The bracket characters
        LEFT = '\u300a'  # 【
        RIGHT = '\u300b'  # 】
        
        # Build patterns to search for
        # Pattern 1: 【key】 (continuous)
        # Pattern 2: 【...key...】 (split with XML in between)
        
        # First try simple replacement
        simple_pattern = f"{LEFT}{key}{RIGHT}"
        if simple_pattern in result:
            result = result.replace(simple_pattern, value)
            continue
        
        # Now handle split case
        # Find key in content
        key_pos = result.find(key)
        if key_pos < 0:
            continue
        
        # Search backward from key for LEFT bracket
        # We look back up to 500 chars
        search_back = max(0, key_pos - 500)
        segment = result[search_back:key_pos]
        
        left_idx = segment.rfind(LEFT)
        if left_idx < 0:
            # No left bracket found before key
            continue
        
        # Now search forward from key for RIGHT bracket
        search_forward = result[key_pos + len(key):key_pos + len(key) + 200]
        right_idx = search_forward.find(RIGHT)
        
        if right_idx < 0:
            # No right bracket found after key
            continue
        
        # Found split placeholder
        # Calculate absolute positions
        abs_left = search_back + left_idx
        abs_right = key_pos + len(key) + right_idx + 1
        
        # Extract and replace
        old_text = result[abs_left:abs_right]
        result = result[:abs_left] + value + result[abs_right:]
    
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
    doc_xml_path = os.path.join(REPORT_TEMPLATE_DIR, "word", "document.xml")
    
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Replace placeholders using advanced replacement
    new_content = advanced_replace(content, REPORT_PLACEHOLDERS)
    
    # Check for remaining placeholders (both continuous and split)
    remaining_continuous = re.findall(r'【[^】]*】', new_content)
    remaining_left = new_content.count('\u300a')
    remaining_right = new_content.count('\u300b')
    
    print(f"  After replacement:")
    print(f"    Continuous 【...】 patterns: {len(remaining_continuous)}")
    print(f"    Unmatched 【 count: {remaining_left}")
    print(f"    Unmatched 】 count: {remaining_right}")
    
    if remaining_continuous:
        print(f"    Remaining: {set(remaining_continuous)}")
    
    # Write updated document.xml
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Pack to docx
    pack_docx(REPORT_TEMPLATE_DIR, REPORT_DOCX)
    print(f"  Generated: {REPORT_DOCX} ({os.path.getsize(REPORT_DOCX)} bytes)")

def generate_explanation():
    """Generate the explanation docx"""
    print("Generating explanation...")
    doc_xml_path = os.path.join(EXPLANATION_TEMPLATE_DIR, "word", "document.xml")
    
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Replace placeholders
    new_content = advanced_replace(content, EXPLANATION_PLACEHOLDERS)
    
    # Check for remaining placeholders
    remaining_continuous = re.findall(r'【[^】]*】', new_content)
    remaining_left = new_content.count('\u300a')
    remaining_right = new_content.count('\u300b')
    
    print(f"  After replacement:")
    print(f"    Continuous 【...】 patterns: {len(remaining_continuous)}")
    print(f"    Unmatched 【 count: {remaining_left}")
    print(f"    Unmatched 】 count: {remaining_right}")
    
    if remaining_continuous:
        print(f"    Remaining: {set(remaining_continuous)}")
    
    # Write updated document.xml
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Pack to docx
    pack_docx(EXPLANATION_TEMPLATE_DIR, EXPLANATION_DOCX)
    print(f"  Generated: {EXPLANATION_DOCX} ({os.path.getsize(EXPLANATION_DOCX)} bytes)")

if __name__ == "__main__":
    print("=== Generating Word Documents (Advanced) ===\n")
    generate_report()
    print()
    generate_explanation()
    print("\n=== Done ===")
