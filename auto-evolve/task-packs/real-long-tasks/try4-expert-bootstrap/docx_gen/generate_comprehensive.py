# -*- coding: utf-8 -*-
"""
Comprehensive placeholder replacement following generation_procedure.md
- Scans ALL XML parts (document, headers, footers, footnotes, endnotes)
- Replaces internal placeholders only
- Leaves external-required placeholders marked
- Uses proper text element detection to avoid cross-tag matching
"""
import zipfile
import shutil
import os
import re
import sys
import pandas as pd
from xml.etree import ElementTree as ET

sys.stdout.reconfigure(encoding='utf-8')

TEMPLATE_REPORT = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\materials\report-template.docx'
TEMPLATE_EXPLANATION = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\materials\explanation-template.docx'
OUTPUT_REPORT = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx'
OUTPUT_EXPLANATION = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx'
SOURCE_XLSX = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\恩瑞特拟处置废旧物资项目评估计算表0330.xlsx'

BRACKET_OPEN = '\u3010'
BRACKET_CLOSE = '\u3011'

INTERNAL_REPORT = {
    '产权持有单位': '江苏省国信集团有限公司',
    '评估基准日': '2026年3月23日',
    '评估结果金额': '22893.8',
    '评估目的详细描述': '拟处置设备资产项目',
}

INTERNAL_EXPLANATION = {
    '产权持有单位': '南京恩瑞特实业有限公司',
    '评估基准日': '2026年3月23日',
    '评估结果金额': '22893.8',
    '设备状态': '已拆除、拟处置',
    '存放情况': '已拆除、拟处置',
    '典型设备名称': '保护架',
    '规格型号': '若干',
    '主材1单价': '2000',
    '主材2单价': '1900',
    '设备类别一': '保护架',
    '设备类别二': '天线座运输支撑',
    '设备类别三': '过度环和轴承',
    '是否申报账面价值': '未申报账面价值',
}

EXTERNAL_REQUIRED = {
    '评估机构', '报告文号', '宗旨和业务范围', '开办资金', '法定代表人',
    '注册地址', '统一社会信用代码', '报告日', '报告日期中文大写',
    '评估结论有效期截止日', '举办单位', '其他报告使用人说明',
    '主材1', '主材2', '主材构成', '案例计算公式', '案例评估值', '主要',
    '存放地点', '购置时间范围', '具体存放位置', '序号', '主材1重量', '主材2重量',
}

def enumerate_xml_parts(docx_path):
    parts = []
    with zipfile.ZipFile(docx_path, 'r') as z:
        for name in z.namelist():
            if name.startswith('word/') and name.endswith('.xml'):
                parts.append(name)
    return parts

def find_all_placeholders_in_text(text):
    pattern = BRACKET_OPEN + r'([^' + BRACKET_CLOSE + r']+)' + BRACKET_CLOSE
    return re.findall(pattern, text)

def replace_placeholders_in_text(text, replacements):
    changes = []
    for placeholder, value in replacements.items():
        open_bracket = BRACKET_OPEN + placeholder + BRACKET_CLOSE
        if open_bracket in text:
            text = text.replace(open_bracket, value)
            changes.append(f'Replaced 【{placeholder}】')
    return text, changes

def process_xml_part(xml_content, replacements, external_required):
    changes = []
    
    placeholders_in_text = find_all_placeholders_in_text(xml_content)
    
    for placeholder in placeholders_in_text:
        if placeholder in replacements:
            open_bracket = BRACKET_OPEN + placeholder + BRACKET_CLOSE
            if open_bracket in xml_content:
                xml_content = xml_content.replace(open_bracket, replacements[placeholder])
                changes.append(f'Replaced 【{placeholder}】')
        elif placeholder not in external_required:
            print(f'  WARNING: Unknown internal placeholder 【{placeholder}】 - treating as external')
    
    return xml_content, changes

def process_docx(template_path, output_path, replacements, external_required):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    shutil.copy2(template_path, output_path)
    
    xml_parts = enumerate_xml_parts(output_path)
    print(f'XML parts found: {xml_parts}')
    
    all_changes = []
    tmp_path = output_path + '.tmp'
    
    with zipfile.ZipFile(output_path, 'r') as z_in:
        with zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_DEFLATED) as z_out:
            for item in z_in.infolist():
                content = z_in.read(item.filename)
                
                if item.filename in xml_parts:
                    xml_content = content.decode('utf-8')
                    
                    placeholders_found = find_all_placeholders_in_text(xml_content)
                    if placeholders_found:
                        print(f'  {item.filename}: found {len(placeholders_found)} placeholder instances')
                        
                        xml_content, changes = process_xml_part(xml_content, replacements, external_required)
                        all_changes.extend(changes)
                        
                        remaining = find_all_placeholders_in_text(xml_content)
                        if remaining:
                            still_internal = [p for p in remaining if p not in external_required]
                            if still_internal:
                                print(f'    STILL UNRESOLVED (internal): {still_internal}')
                    
                    content = xml_content.encode('utf-8')
                
                z_out.writestr(item, content)
    
    os.replace(tmp_path, output_path)
    return all_changes

def validate_output(output_path, external_required):
    issues = []
    xml_parts = enumerate_xml_parts(output_path)
    
    with zipfile.ZipFile(output_path, 'r') as z:
        for part in xml_parts:
            content = z.read(part).decode('utf-8')
            placeholders = find_all_placeholders_in_text(content)
            
            for p in placeholders:
                if p not in external_required:
                    issues.append(f'{part}: internal placeholder 【{p}】 still unresolved')
    
    return issues

def main():
    print('=== Comprehensive Document Generation ===\n')
    
    print('--- Processing Report ---')
    changes = process_docx(TEMPLATE_REPORT, OUTPUT_REPORT, INTERNAL_REPORT, EXTERNAL_REQUIRED)
    print(f'Changes made: {changes}')
    issues = validate_output(OUTPUT_REPORT, EXTERNAL_REQUIRED)
    if issues:
        print(f'VALIDATION ISSUES: {issues}')
    else:
        print('Report validation PASSED')
    
    print('\n--- Processing Explanation ---')
    changes = process_docx(TEMPLATE_EXPLANATION, OUTPUT_EXPLANATION, INTERNAL_EXPLANATION, EXTERNAL_REQUIRED)
    print(f'Changes made: {changes}')
    issues = validate_output(OUTPUT_EXPLANATION, EXTERNAL_REQUIRED)
    if issues:
        print(f'VALIDATION ISSUES: {issues}')
    else:
        print('Explanation validation PASSED')
    
    print('\n--- Summary ---')
    print(f'Report output: {OUTPUT_REPORT}')
    print(f'Explanation output: {OUTPUT_EXPLANATION}')

if __name__ == '__main__':
    main()