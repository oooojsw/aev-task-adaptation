<!-- auto-evolve-role: legacy_doc_rules -->

# Legacy .doc Extraction Rules

## Format Warning

- .doc files are NOT .docx ZIP packages
- Do NOT use OpenXML zip analyzers on .doc files
- Do NOT rename .doc to .docx and expect parsing to work

## Approved Method

- Use aspose.words in evaluation mode
- Produces garbled but readable Chinese text
- antiword confirmed unavailable on this system

## Reference Docs

- ../materials/report-reference.doc — 资产评估报告
  - Parties: 评估机构=华晨资产评估有限公司, 产权持有人=南京恩瑞特实业有限公司
  - Report number: 中瑞评报字(2026)第XXXX号
  - Evaluation date: 2026年3月23日
  - Valuation type: 快速变现价值

- ../materials/explanation-reference.doc — 资产评估说明
  - Same parties as report reference

## Self-Check

- .doc files do not contain internal OOXML parts (headers/footers only exist in .docx ZIP)
- No header*.xml or footer*.xml extraction needed from .doc files
- Only extract plain text content for reference mapping
