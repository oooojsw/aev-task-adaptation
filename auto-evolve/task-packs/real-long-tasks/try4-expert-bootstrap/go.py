import zipfile, shutil
EquipExTax = 40925.2
EquipWithTax = 20665.2
for tmpl, out in [
    ('materials/report-template.docx', 'deployment/outputs/generated-report.docx'),
    ('materials/explanation-template.docx', 'deployment/outputs/generated-explanation.docx')
]:
    shutil.copy(tmpl, out)
    z = zipfile.ZipFile(out)
    xml_bytes = z.read('word/document.xml')
    z.close()
    xml = xml_bytes.decode('utf-8', errors='replace')
    print(tmpl, '->', out, '| size:', len(xml))
    print('Contains 设备:', '设备' in xml)
