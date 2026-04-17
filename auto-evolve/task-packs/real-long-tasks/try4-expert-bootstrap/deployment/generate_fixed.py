#!/usr/bin/env python3
import zipfile
import os
import shutil
import re

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"
WORK_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\work"
TEMPLATE_DIR = r"C:\Users\ZhuanZ\Desktop\try4 - 副本\材料"

LEFT = '\u3010'
RIGHT = '\u3011'

def make_pattern(text):
    return LEFT + text + RIGHT

REPORT_REPLACEMENTS = {
    make_pattern("产权持有单位"): "南京恩瑞特实业有限公司",
    make_pattern("举办单位"): "江苏省国信集团有限公司",
    make_pattern("其他报告使用人说明"): "除国家法律、法规另有规定外，未经我公司同意，不得将本报告书的内容提供给他人使用",
    make_pattern("宗旨和业务范围"): "电子、通信与自动控制技术研究；卫星通信技术开发；通信系统开发；通信设备制造；雷达及配套设备制造；其他计算机制造；软件开发；信息技术咨询服务",
    make_pattern("开办资金"): "",
    make_pattern("报告文号"): "华辰评报字(2026)第XXXX号",
    make_pattern("报告日"): "2026年3月23日",
    make_pattern("报告日期中文大写"): "二零二六年三月二十三日",
    make_pattern("法定代表人"): "",
    make_pattern("注册地址"): "",
    make_pattern("统一社会信用代码"): "",
    make_pattern("评估基准日"): "2026年3月23日",
    make_pattern("评估机构"): "HUACHEN ASSETS APPRAISAL CO.,LTD",
    make_pattern("评估目的详细描述"): "拟处置设备资产的快速变现价值",
    make_pattern("评估结果金额"): "20,260 (不含税)",
    make_pattern("评估结论有效期截止日"): "2027年3月22日",
}

legal_refs = [
    "中华人民共和国企业国有资产法",
    "中华人民共和国民法典",
    "中华人民共和国增值税暂行条例",
    "中华人民共和国增值税暂行条例实施细则",
    "国有资产评估管理办法",
    "国有资产评估管理办法实施细则",
    "关于改革国有资产评估行政管理方式加强资产评估监督管理工作意见的通知",
    "国有资产评估管理若干问题的规定",
    "企业国有资产监督管理暂行条例",
    "企业国有资产评估管理暂行办法",
    "企业国有资产交易监督管理办法",
    "关于加强企业国有资产评估管理工作有关问题的通知",
    "资产评估基本准则",
    "资产评估职业道德准则",
    "企业国有资产评估报告指南",
    "资产评估机构业务质量控制指南",
    "资产评估对象法律权属指导意见",
    "资产评估价值类型指导意见",
    "资产评估申报表",
    "关于全面推开营业税改征增值税试点的通知",
    "关于深化增值税改革有关政策的公告",
]
for ref in legal_refs:
    REPORT_REPLACEMENTS[make_pattern(ref)] = ""

EXPLANATION_REPLACEMENTS = {
    make_pattern("主材1"): "废碳钢",
    make_pattern("主材1单价"): "2,000 (元/吨)",
    make_pattern("主材1重量"): "0.5 (吨)",
    make_pattern("主材2"): "",
    make_pattern("主材2单价"): "1,900 (元/吨)",
    make_pattern("主材2重量"): "",
    make_pattern("主材构成"): "废碳钢",
    make_pattern("产权持有单位"): "南京恩瑞特实业有限公司",
    make_pattern("具体存放位置"): "",
    make_pattern("典型设备名称"): "保护架",
    make_pattern("存放地点"): "",
    make_pattern("存放情况"): "",
    make_pattern("序号"): "1",
    make_pattern("报告文号"): "华辰评报字(2026)第XXXX号",
    make_pattern("是否申报账面价值"): "",
    make_pattern("案例计算公式"): "0.5x2000=1000",
    make_pattern("案例评估值"): "1,000 (不含税)",
    make_pattern("规格型号"): "若干",
    make_pattern("设备状态"): "",
    make_pattern("设备类别一"): "",
    make_pattern("设备类别三"): "",
    make_pattern("设备类别二"): "",
    make_pattern("评估基准日"): "2026年3月23日",
    make_pattern("评估机构"): "HUACHEN ASSETS APPRAISAL CO.,LTD",
    make_pattern("评估结果金额"): "20,260 (不含税)",
    make_pattern("购置时间范围"): "",
    make_pattern("评估说明"): "评估说明",
    make_pattern("设备清查评估明细表"): "",
    make_pattern("中华人民共和国增值税暂行条例"): "",
    make_pattern("中华人民共和国增值税暂行条例实施细则"): "",
    make_pattern("关于深化增值税改革有关政策的公告"): "",
}

def extract_all_placeholders(content):
    results = []
    idx = 0
    while True:
        start = content.find(LEFT, idx)
        if start < 0:
            break
        end = content.find(RIGHT, start + 1)
        if end < 0:
            break
        results.append(content[start:end+1])
        idx = end + 1
    return results

def replace_all(content, replacements):
    result = content
    for placeholder, value in replacements.items():
        result = result.replace(placeholder, value)
    return result

def replace_in_xml_elements(content, replacements):
    result = content
    for placeholder, value in replacements.items():
        result = result.replace(placeholder, value)
    
    pattern = LEFT + r'([^' + RIGHT + r']*)' + RIGHT
    matches = re.findall(pattern, result)
    return result, matches

def pack_docx(dir_path, output_path):
    if os.path.exists(output_path):
        os.remove(output_path)
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(dir_path):
            for file in files:
                file_path = os.path.join(root, file)
                arc_name = os.path.relpath(file_path, dir_path)
                zf.write(file_path, arc_name)

def generate_report():
    print("=== Generating Report ===")
    template_path = os.path.join(TEMPLATE_DIR, "机器设备资产评估报告-空数据模板.docx")
    work_dir = os.path.join(WORK_DIR, "report_gen_v2")
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)
    
    with zipfile.ZipFile(template_path, 'r') as z:
        z.extractall(work_dir)
    
    doc_xml_path = os.path.join(work_dir, "word", "document.xml")
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_count = content.count(LEFT)
    print("Original bracket count: " + str(original_count))
    
    result, remaining = replace_in_xml_elements(content, REPORT_REPLACEMENTS)
    
    print("After replacement bracket count: " + str(result.count(LEFT)))
    print("Remaining bracket pairs: " + str(len(remaining)))
    if remaining:
        unique_remaining = sorted(set(remaining))
        print("Unique remaining: " + str(len(unique_remaining)))
        for p in unique_remaining:
            print("  pattern: " + repr(p))
    
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(result)
    
    output_path = os.path.join(OUTPUT_DIR, "generated-report.docx")
    pack_docx(work_dir, output_path)
    print("Generated: " + str(os.path.getsize(output_path)) + " bytes")
    return output_path

def generate_explanation():
    print("=== Generating Explanation ===")
    template_path = os.path.join(TEMPLATE_DIR, "机器设备资产评估说明-空数据模板.docx")
    work_dir = os.path.join(WORK_DIR, "explanation_gen_v2")
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir)
    os.makedirs(work_dir)
    
    with zipfile.ZipFile(template_path, 'r') as z:
        z.extractall(work_dir)
    
    doc_xml_path = os.path.join(work_dir, "word", "document.xml")
    with open(doc_xml_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_count = content.count(LEFT)
    print("Original bracket count: " + str(original_count))
    
    result, remaining = replace_in_xml_elements(content, EXPLANATION_REPLACEMENTS)
    
    print("After replacement bracket count: " + str(result.count(LEFT)))
    print("Remaining bracket pairs: " + str(len(remaining)))
    if remaining:
        unique_remaining = sorted(set(remaining))
        print("Unique remaining: " + str(len(unique_remaining)))
        for p in unique_remaining:
            print("  pattern: " + repr(p))
    
    with open(doc_xml_path, 'w', encoding='utf-8') as f:
        f.write(result)
    
    output_path = os.path.join(OUTPUT_DIR, "generated-explanation.docx")
    pack_docx(work_dir, output_path)
    print("Generated: " + str(os.path.getsize(output_path)) + " bytes")
    return output_path

if __name__ == "__main__":
    os.makedirs(WORK_DIR, exist_ok=True)
    report_path = generate_report()
    explanation_path = generate_explanation()
    print("\n=== Done ===")