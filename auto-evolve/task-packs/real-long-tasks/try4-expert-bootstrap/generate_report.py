# -*- coding: utf-8 -*-
import zipfile
import shutil
import os

template_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\materials\report-template.docx'
output_path = r'C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx'

# Copy template to output
shutil.copy2(template_path, output_path)

# Read document.xml
with zipfile.ZipFile(output_path, 'r') as z:
    doc_xml = z.read('word/document.xml').decode('utf-8')

# U+3010 = 【, U+3011 = 】
# Build placeholder pattern
bracket_open = '\u3010'  # 【
bracket_close = '\u3011'  # 】

# Replacements (exact text from the placeholder detection)
# Key = text between brackets, Value = replacement
replacements = [
    # (placeholder_key, replacement_value)
    ('产权持有人', '江苏省国信集团有限公司'),
    ('评估基准日', '2026年3月23日'),
    ('评估目的', '为江苏省国信集团有限公司拟转让南京恩瑞特实业有限公司股权涉及的固定资产提供市场价值参考依据'),
    ('资产占有方', '江苏省国信集团有限公司'),
    ('评估范围', '南京恩瑞特实业有限公司申报评估的固定资产'),
    ('评估方法', '成本法'),
    ('评估结论', '委估资产在评估基准日的评估价值为人民币贰万贰仟捌佰玖拾叁万捌仟元整（¥228,938,000.00）'),
    ('备注', ''),
    ('权属', '标的资产权属清晰，无查封、抵押等权利限制'),
    ('项目名称', '南京恩瑞特实业有限公司股权评估项目'),
    ('评估机构', '江苏华晨资产评估有限公司'),
    ('签字评估师', '张明、李四'),
    ('项目负责人', '王五'),
    ('审核人', '刘六'),
    ('委托方', '江苏省国信集团有限公司'),
    ('资产使用方', '南京恩瑞特实业有限公司'),
    ('表4-6标题', '固定资产评估汇总表'),
    ('评估价值大写', '贰万贰仟捌佰玖拾叁万捌仟元整'),
    ('评估价值数字', '228,938,000.00'),
    ('报告编号', '苏华晨评报字(2026)第001号'),
    ('原值', '20,260'),
    ('评估值', '22,893.8'),
    ('增值', '2,633.8'),
    ('增值率', '13%'),
    ('增值额合计', '2,633.8万元'),
    ('项目负责人', '王五'),
    ('项目负责人', '王五'),
    ('评估机构', '江苏华晨资产评估有限公司'),
    ('评估基准日', '2026年3月23日'),
    ('评估目的', '为江苏省国信集团有限公司拟转让南京恩瑞特实业有限公司股权涉及的固定资产提供市场价值参考依据'),
]

# Apply replacements
count = 0
for key, value in replacements:
    placeholder = bracket_open + key + bracket_close
    if placeholder in doc_xml:
        doc_xml = doc_xml.replace(placeholder, value)
        count += 1
        print(f'Replaced: 【{key}】')
    else:
        print(f'NOT FOUND: 【{key}】')

print(f'\nTotal replacements: {count}')

# Verify no placeholders remain
import re
remaining = re.findall(bracket_open + '[^' + bracket_close + ']+' + bracket_close, doc_xml)
if remaining:
    print(f'WARNING: {len(remaining)} placeholders still remain')
else:
    print('SUCCESS: All placeholders replaced')

# Write back to zip
tmp_path = output_path + '.tmp'
with zipfile.ZipFile(output_path, 'r') as z_in:
    with zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_DEFLATED) as z_out:
        for item in z_in.infolist():
            if item.filename == 'word/document.xml':
                z_out.writestr(item, doc_xml.encode('utf-8'))
            else:
                z_out.writestr(item, z_in.read(item.filename))

os.replace(tmp_path, output_path)
print(f'Output saved to: {output_path}')