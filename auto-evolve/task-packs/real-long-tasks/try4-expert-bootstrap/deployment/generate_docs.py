#!/usr/bin/env python3
import zipfile
import json
import re
import os
import shutil

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"
REPORT_TEMPLATE = os.path.join(OUTPUT_DIR, "report-template-extracted")
EXPLANATION_TEMPLATE = os.path.join(OUTPUT_DIR, "explanation-template-extracted")
REPORT_DOCX = os.path.join(OUTPUT_DIR, "generated-report.docx")
EXPLANATION_DOCX = os.path.join(OUTPUT_DIR, "generated-explanation.docx")

# Report placeholders (17 total)
REPORT_PLACEHOLDERS = {
    "【产权持有单位】": "南京恩瑞特实业有限公司",
    "【举办单位】": "江苏省国信集团有限公司",
    "【其他报告使用人说明】": "除国家法律、法规另有规定外，未经我公司同意，不得将本报告书的内容提供给他人使用",
    "【宗旨和业务范围】": "电子、通信与自动控制技术研究；卫星通信技术开发；通信系统开发；通信设备制造；雷达及配套设备制造；其他计算机制造；软件开发；信息技术咨询服务",
    "【开办资金】": "",
    "【报告文号】": "华辰评报字(2026)第XXXX号",
    "【报告日】": "2026年3月23日",
    "【报告日期中文大写】": "二零二六年三月二十三日",
    "【法定代表人】": "",
    "【注册地址】": "",
    "【统一社会信用代码】": "",
    "【评估基准日】": "2026年3月23日",
    "【评估机构】": "HUACHEN ASSETS APPRAISAL CO.,LTD",
    "【评估目的详细描述】": "拟处置设备资产的快速变现价值",
    "【评估结果金额】": "20,260 (不含税)",
    "【评估结论有效期截止日】": "2027年3月22日",
}

# Explanation placeholders (26 total)
EXPLANATION_PLACEHOLDERS = {
    "【主材1】": "废碳钢",
    "【主材1单价】": "2,000 (元/吨)",
    "【主材1重量】": "0.5 (吨)",
    "【主材2】": "",
    "【主材2单价】": "1,900 (元/吨)",
    "【主材2重量】": "",
    "【主材构成】": "废碳钢",
    "【产权持有单位】": "南京恩瑞特实业有限公司",
    "【具体存放位置】": "",
    "【典型设备名称】": "保护架",
    "【存放地点】": "",
    "【存放情况】": "",
    "【序号】": "1",
    "【报告文号】": "华辰评报字(2026)第XXXX号",
    "【是否申报账面价值】": "",
    "【案例计算公式】": "0.5×2000=1000",
    "【案例评估值】": "1,000 (不含税)",
    "【规格型号】": "若干",
    "【设备状态】": "",
    "【设备类别一】": "",
    "【设备类别三】": "",
    "【设备类别二】": "",
    "【评估基准日】": "2026年3月23日",
    "【评估机构】": "HUACHEN ASSETS APPRAISAL CO.,LTD",
    "【评估结果金额】": "20,260 (不含税)",
    "【购置时间范围】": "",
}

def replace_placeholders_in_xml(xml_content, placeholders):
    """Replace all placeholders in XML content"""
    result = xml_content
    for placeholder, value in placeholders.items():
        result = result.replace(placeholder, value)
    return result

def pack_docx(extracted_dir, output_path):
    """Pack a directory into a docx (zip) file"""
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(extracted_dir):
            for file in files:
                file_path = os.path.join(root, file)
                arc_name = os.path.relpath(file_path, extracted_dir)
                zf.write(file_path, arc_name)

def generate_report():
    """Generate the report docx"""
    doc_xml_path = os.path.join(REPORT_TEMPLATE, "word", "document.xml")
    
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Replace placeholders
    new_content = replace_placeholders_in_xml(content, REPORT_PLACEHOLDERS)
    
    # Check for remaining placeholders
    remaining = re.findall(r'【[^】]*】', new_content)
    if remaining:
        print(f"WARNING: {len(remaining)} placeholders remaining in report: {set(remaining)}")
    
    # Write updated document.xml
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Pack to docx
    pack_docx(REPORT_TEMPLATE, REPORT_DOCX)
    print(f"Generated: {REPORT_DOCX}")
    print(f"  File size: {os.path.getsize(REPORT_DOCX)} bytes")

def generate_explanation():
    """Generate the explanation docx"""
    doc_xml_path = os.path.join(EXPLANATION_TEMPLATE, "word", "document.xml")
    
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Replace placeholders
    new_content = replace_placeholders_in_xml(content, EXPLANATION_PLACEHOLDERS)
    
    # Check for remaining placeholders
    remaining = re.findall(r'【[^】]*】', new_content)
    if remaining:
        print(f"WARNING: {len(remaining)} placeholders remaining in explanation: {set(remaining)}")
    
    # Write updated document.xml
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    
    # Pack to docx
    pack_docx(EXPLANATION_TEMPLATE, EXPLANATION_DOCX)
    print(f"Generated: {EXPLANATION_DOCX}")
    print(f"  File size: {os.path.getsize(EXPLANATION_DOCX)} bytes")

if __name__ == "__main__":
    print("=== Generating Word Documents ===\n")
    generate_report()
    print()
    generate_explanation()
    print("\n=== Done ===")
