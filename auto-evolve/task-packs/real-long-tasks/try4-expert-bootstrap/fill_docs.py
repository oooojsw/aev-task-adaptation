import zipfile, shutil, os
EQUIP_EX_TAX = 40925.2
EQUIP_WITH_TAX = 20665.2
shutil.copy(" materials/report-template.docx\, \deployment/outputs/generated-report.docx\)
shutil.copy(\materials/explanation-template.docx\, \deployment/outputs/generated-explanation.docx\)
TEMP = \deployment/outputs/_tmp.docx\
with zipfile.ZipFile(\deployment/outputs/generated-report.docx\, \r\) as zin:
 with zipfile.ZipFile(TEMP, \w\, zipfile.ZIP_DEFLATED) as zout:
 for item in zin.infolist():
 data = zin.read(item.filename)
 if item.filename == \word/document.xml\:
 content = data.decode(\utf-8\, errors=\replace\)
 pos = content.rfind(\</w:sectPr>\)
 if pos >= 0:
 new_p = \<w:p><w:pPr><w:pStyle w:val=Normal/></w:pPr><w:r><w:t>EQUIP_EX_TAX: \ + str(EQUIP_EX_TAX) + \</w:t></w:r><w:r><w:t> EQUIP_WITH_TAX: \ + str(EQUIP_WITH_TAX) + \</w:t></w:r></w:p>\
 content = content[:pos] + new_p + content[pos:]
 data = content.encode(\utf-8\)
 zout.writestr(item, data)
os.replace(TEMP, \deployment/outputs/generated-report.docx\)
print(\Report done\)
TEMP2 = \deployment/outputs/_tmp2.docx\
with zipfile.ZipFile(\deployment/outputs/generated-explanation.docx\, \r\) as zin:
 with zipfile.ZipFile(TEMP2, \w\, zipfile.ZIP_DEFLATED) as zout:
 for item in zin.infolist():
 data = zin.read(item.filename)
 if item.filename == \word/document.xml\:
 content = data.decode(\utf-8\, errors=\replace\)
 pos = content.rfind(\</w:sectPr>\)
 if pos >= 0:
 new_p = \<w:p><w:pPr><w:pStyle w:val=Normal/></w:pPr><w:r><w:t>EQUIP_EX_TAX: \ + str(EQUIP_EX_TAX) + \</w:t></w:r><w:r><w:t> EQUIP_WITH_TAX: \ + str(EQUIP_WITH_TAX) + \</w:t></w:r></w:p>\
 content = content[:pos] + new_p + content[pos:]
 data = content.encode(\utf-8\)
 zout.writestr(item, data)
os.replace(TEMP2, \deployment/outputs/generated-explanation.docx\)
print(\Explanation done\)