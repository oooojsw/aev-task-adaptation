#!/usr/bin/env python3
"""
Generate Word documents from templates.
Replace all placeholders with appropriate values.
"""
import zipfile
import os
import shutil

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"
WORK_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\work"

LEFT = '\u300a'
RIGHT = '\u300b'

# All values to replace - combining data and legal references
REPORT_VALUES = {
    # Data placeholders
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
    # Legal references - keep as is or empty
    "【中华人民共和国企业国有资产法】": "",
    "【中华人民共和国民法典】": "",
    "【中华人民共和国增值税暂行条例】": "",
    "【中华人民共和国增值税暂行条例实施细则】": "",
    "【国有资产评估管理办法】": "",
    "【国有资产评估管理办法实施细则】": "",
    "【关于改革国有资产评估行政管理方式加强资产评估监督管理工作意见的通知】": "",
    "【国有资产评估管理若干问题的规定】": "",
    "【企业国有资产监督管理暂行条例】": "",
    "【企业国有资产评估管理暂行办法】": "",
    "【企业国有资产交易监督管理办法】": "",
    "【关于加强企业国有资产评估管理工作有关问题的通知】": "",
    "【资产评估基本准则】": "",
    "【资产评估职业道德准则】": "",
    "【企业国有资产评估报告指南】": "",
    "【资产评估机构业务质量控制指南】": "",
    "【资产评估对象法律权属指导意见】": "",
    "【资产评估价值类型指导意见】": "",
    "【资产评估申报表】": "",
    "【关于全面推开营业税改征增值税试点的通知】": "",
    "【关于深化增值税改革有关政策的公告】": "",
}

EXPLANATION_VALUES = {
    # Data placeholders
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
    # Section/table names
    "【评估说明】": "评估说明",
    "【设备清查评估明细表】": "",
    "【中华人民共和国增值税暂行条例】": "",
    "【中华人民共和国增值税暂行条例实施细则】": "",
    "【关于深化增值税改革有关政策的公告】": "",
}

def extract_all_placeholders(content):
    """Extract all placeholder texts from content"""
    placeholders = set()
    idx = 0
    while True:
        idx = content.find(LEFT, idx)
        if idx < 0:
            break
        search = content[idx+1:idx+500]
        right_pos = search.find(RIGHT)
        if right_pos >= 0:
            text = search[:right_pos]
            placeholders.add(text)
        idx += 1
    return placeholders

def replace_placeholders(content, replacements):
    """Replace all placeholders in content"""
    result = content
    for placeholder, value in replacements.items():
        pattern = LEFT + placeholder + RIGHT
        if pattern in result:
            result = result.replace(pattern, value)
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
    print("=== Generating Report ===")
    
    # Use the original template from source materials
    template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估报告-空数据模板.docx'
    
    # Copy to work dir
    work_dir = os.path.join(WORK_DIR, "report_gen")
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    
    # Extract template
    with zipfile.ZipFile(template_path, 'r') as z:
        z.extractall(work_dir)
    
    doc_xml_path = os.path.join(work_dir, "word", "document.xml")
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    print(f"Original: LEFT={content.count(LEFT)}, RIGHT={content.count(RIGHT)}")
    
    # Replace placeholders
    result = replace_placeholders(content, REPORT_VALUES)
    
    print(f"After replacement: LEFT={result.count(LEFT)}, RIGHT={result.count(RIGHT)}")
    
    # Find remaining placeholders
    remaining = extract_all_placeholders(result)
    if remaining:
        print(f"Remaining placeholders: {len(remaining)}")
        for p in sorted(list(remaining))[:5]:
            print(f"  {p}")
    
    # Write result
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(result)
    
    # Pack to docx
    output_path = os.path.join(OUTPUT_DIR, "generated-report.docx")
    pack_docx(work_dir, output_path)
    print(f"Generated: {output_path} ({os.path.getsize(output_path)} bytes)")

def generate_explanation():
    """Generate the explanation docx"""
    print("\n=== Generating Explanation ===")
    
    # Use the original template from source materials
    template_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\机器设备资产评估说明-空数据模板.docx'
    
    # Copy to work dir
    work_dir = os.path.join(WORK_DIR, "explanation_gen")
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    
    # Extract template
    with zipfile.ZipFile(template_path, 'r') as z:
        z.extractall(work_dir)
    
    doc_xml_path = os.path.join(work_dir, "word", "document.xml")
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    print(f"Original: LEFT={content.count(LEFT)}, RIGHT={content.count(RIGHT)}")
    
    # Replace placeholders
    result = replace_placeholders(content, EXPLANATION_VALUES)
    
    print(f"After replacement: LEFT={result.count(LEFT)}, RIGHT={result.count(RIGHT)}")
    
    # Find remaining placeholders
    remaining = extract_all_placeholders(result)
    if remaining:
        print(f"Remaining placeholders: {len(remaining)}")
        for p in sorted(list(remaining))[:5]:
            print(f"  {p}")
    
    # Write result
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(result)
    
    # Pack to docx
    output_path = os.path.join(OUTPUT_DIR, "generated-explanation.docx")
    pack_docx(work_dir, output_path)
    print(f"Generated: {output_path} ({os.path.getsize(output_path)} bytes)")

if __name__ == "__main__":
    if os.path.exists(WORK_DIR):
        shutil.rmtree(WORK_DIR)
    os.makedirs(WORK_DIR, exist_ok=True)
    
    generate_report()
    generate_explanation()
    print("\n=== Done ===")
