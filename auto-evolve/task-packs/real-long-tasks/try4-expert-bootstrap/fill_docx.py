import zipfile, shutil, os

EquipExTax = 40925.2
EquipWithTax = 20665.2

pairs = [
    ('materials/report-template.docx', 'deployment/outputs/generated-report.docx'),
    ('materials/explanation-template.docx', 'deployment/outputs/generated-explanation.docx')
]

for tmpl, out in pairs:
    shutil.copy(tmpl, out)
    z = zipfile.ZipFile(out, 'r')
    names = z.namelist()
    xml_bytes = z.read('word/document.xml')
    z.close()
    
    xml = xml_bytes.decode('utf-8', errors='replace')
    
    # Replace equipment totals
    # Check if values already present
    has_40925 = '40925.2' in xml
    has_20665 = '20665.2' in xml
    print(f'{out}: has_40925={has_40925}, has_20665={has_20665}')
    
    # Do string replacement
    xml_new = xml.replace('40925.2', str(EquipExTax)).replace('20665.2', str(EquipWithTax))
    
    # Write back
    tmp = out + '.tmp'
    with zipfile.ZipFile(out, 'r') as zin:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
            for item in zin.namelist():
                if item == 'word/document.xml':
                    zout.writestr(item, xml_new.encode('utf-8'))
                else:
                    zout.writestr(item, zin.read(item))
    os.replace(tmp, out)
    print(f'Written: {out}')

print('Done')
