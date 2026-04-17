import zipfile
import xml.etree.ElementTree as ET
import codecs

xlsx_path = r'C:\Users\ZhuanZ\Desktop\try4 - 副本\材料\恩瑞特拟处置废旧物资项目评估计算表0330.xlsx'

with zipfile.ZipFile(xlsx_path, 'r') as z:
    with z.open('xl/sharedStrings.xml') as f:
        content = f.read()
    # Try different encodings
    try:
        content = content.decode('utf-8')
    except:
        content = content.decode('gbk')
    ss_tree = ET.fromstring(content)
    ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    strings = [elem.text for elem in ss_tree.findall('.//ns:t', ns)]
    
    with z.open('xl/worksheets/sheet2.xml') as f:
        content2 = f.read()
    try:
        content2 = content2.decode('utf-8')
    except:
        content2 = content2.decode('gbk')
    sheet2_tree = ET.fromstring(content2)
    
    def get_cell_value(tree, row, col):
        for cell in tree.findall(f'.//ns:c[@r="{col}{row}"]', ns):
            t = cell.get('t')
            v = cell.find('ns:v', ns)
            if v is not None and v.text:
                if t == 's':
                    idx = int(v.text)
                    if idx < len(strings):
                        return strings[idx]
                    return None
                return v.text
        return None
    
    print('Sheet2 verification:')
    print('A4:', get_cell_value(sheet2_tree, 4, 'A'))
    print('B7:', get_cell_value(sheet2_tree, 7, 'B'))
    print('AB7:', get_cell_value(sheet2_tree, 7, 'AB'))
    print('D7:', get_cell_value(sheet2_tree, 7, 'D'))
    print('V7:', get_cell_value(sheet2_tree, 7, 'V'))
    
    with z.open('xl/worksheets/sheet1.xml') as f:
        content1 = f.read()
    try:
        content1 = content1.decode('utf-8')
    except:
        content1 = content1.decode('gbk')
    sheet1_tree = ET.fromstring(content1)
    
    print('\nSheet1 verification:')
    print('A4:', get_cell_value(sheet1_tree, 4, 'A'))
    print('L12:', get_cell_value(sheet1_tree, 12, 'L'))
    
    # Check for 法定代表人, 注册地址 in sheet1
    print('\nSearching for specific cells in Sheet1:')
    for row in range(1, 50):
        for col in ['A', 'B', 'C', 'D', 'E']:
            val = get_cell_value(sheet1_tree, row, col)
            if val and ('法定代表人' in str(val) or '注册地址' in str(val) or '开办资金' in str(val)):
                print(f'{col}{row}: {val}')