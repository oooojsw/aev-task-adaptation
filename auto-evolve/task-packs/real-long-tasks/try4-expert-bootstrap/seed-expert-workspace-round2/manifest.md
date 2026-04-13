<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->

# Expert Workspace: Asset Evaluation Document Generation

Status: deployment-ready

## Purpose

This workspace enables a blank agent to generate two Word documents (资产评估报告 and 评估说明) from a source Excel workbook and two blank templates, using only the formal capability assets.

## Input Contract

| Artifact                  | Role                        | Path                                |
| ------------------------- | --------------------------- | ----------------------------------- |
| source.xlsx               | Data source                 | materials/source.xlsx               |
| report-template.docx      | Report output template      | materials/report-template.docx      |
| explanation-template.docx | Explanation output template | materials/explanation-template.docx |

## Output Contract

| Artifact                   | Source Template           | Required Placeholders        |
| -------------------------- | ------------------------- | ---------------------------- |
| generated-report.docx      | report-template.docx      | 13+ placeholders (see below) |
| generated-explanation.docx | explanation-template.docx | 20+ placeholders (see below) |

### Report Template Placeholders

- 产权持有单位 → from xlsx Sheet1 Row 4
- 评估基准日 → from xlsx Sheet1 Row 2
- 评估机构 → NOT in source - requires external input or inference
- 报告文号 → NOT in source - requires external input or inference
- 评估结果金额 → from xlsx Sheet1 Row 12 (含税 value = 22893.8)
- 评估目的详细描述 → requires contextual inference
- 其他报告使用人说明, 宗旨和业务范围, 开办资金, 法定代表人, 注册地址, 统一社会信用代码, 报告日, 报告日期中文大写, 评估结论有效期截止日 → NOT in source - requires external input or placeholders

### Explanation Template Placeholders

- 产权持有单位 → from xlsx Sheet1 Row 4
- 评估基准日 → from xlsx Sheet1 Row 2
- 评估机构 → NOT in source
- 评估结果金额 → from xlsx Sheet1 Row 12
- 存放地点, 具体存放位置 → from Sheet2 equipment location
- 设备类别一/二/三 → derived from Sheet2 设备名称 unique types
- 存放情况 → from Sheet2
- 设备状态 → from Sheet2 状态 column
- 购置时间范围 → from Sheet2 购置日期 data
- 是否申报账面价值 → contextual inference
- 主材1/2, 主材单价, 主材重量, 主材构成 → NOT in source - requires external
- 案例计算公式, 案例评估值 → NOT in source - requires external

### Common Placeholders (Both Templates)

1. 产权持有单位
2. 评估基准日
3. 评估机构
4. 评估结果金额

## Core Rules

### Rule 1: Data Extraction Order

1. Always extract from Sheet1 (固定资产汇总表) first for summary values
2. Extract key values: 评估基准日 (Row 2), 产权持有人 (Row 4), 评估结果金额含税 (Row 12)
3. Sheet2 (废旧物资/设备清单) for detail values only when needed

### Rule 2: Placeholder Resolution Priority

1. **Direct from xlsx**: 产权持有单位, 评估基准日, 评估结果金额
2. **From Sheet2 inference**: 存放地点, 设备类别, 设备状态, 购置时间范围
3. **External required**: 评估机构, 报告文号, and most explanation template fields
4. **Infer from context**: 评估目的详细描述 → "拟处置设备资产项目"

### Rule 3: Value Format

- Currency: 22893.8 (numeric, no comma formatting in placeholder)
- Date: "2026年3月23日" (Chinese format as string)
- Organization: "江苏省国信集团有限公司"

### Rule 4: Document Generation Pipeline

Use minimax-docx Pipeline B (Fill/Edit) since templates exist:

1. Read capability SKILL.md
2. Preview templates with `docx_preview.sh`
3. Analyze structure with `$CLI analyze --input template.docx`
4. Fill placeholders using `$CLI edit fill-placeholders --data '{...}'`
5. Run validation pipeline: merge-runs → validate (XSD) → validate (business)
6. Diff check to verify minimal changes

### Rule 5: Validation Checklist

- [ ] All 【】brackets resolved (no unresolved placeholders)
- [ ] 评估结果金额 matches source xlsx exactly (22893.8)
- [ ] 评估基准日 correct format (2026年3月23日)
- [ ] 产权持有单位 correct (江苏省国信集团有限公司)
- [ ] Document structure preserved (section count maintained)
- [ ] No content truncation or corruption

## Exception Handling

### Exception 1: Missing Source Data

If a required placeholder value is NOT in source.xlsx:

- Mark as "【placeholder】" with surrounding context intact
- Do NOT guess or fabricate values
- Log the missing field in the output summary

### Exception 2: Reference .doc Files

The reference .doc files (Word 97-2003 format) may not parse fully due to encoding. Do NOT block on this - use templates and xlsx data only.

### Exception 3: Unknown Values for Output

For values like 评估机构, 报告文号 that are not in source:

- If task provides them, use provided values
- If not provided, leave as placeholder but note in summary

## Tool Guidance

### XLSX Capability (minimax-xlsx)

Use for: Reading source.xlsx to extract data values

Key methods:

- `xlsx_reader.py` for structure discovery
- pandas DataFrame for value extraction
- Always use `data_only=True` to get computed values

### DOCX Capability (minimax-docx)

Use for: Template filling and document generation

Pipeline: B (Fill/Edit)

- `$CLI edit fill-placeholders --data '{...}'`
- `$CLI merge-runs --input doc.docx`
- `$CLI validate --input doc.docx --xsd assets/xsd/wml-subset.xsd`
- `$CLI validate --input doc.docx --business`
- `scripts/docx_preview.sh doc.docx`

## Execution Checklist

1. [ ] Read source.xlsx using xlsx capability
2. [ ] Extract: 评估基准日, 产权持有单位, 评估结果金额
3. [ ] Extract Sheet2 details: 设备类别, 存放地点, 设备状态
4. [ ] Preview report-template.docx
5. [ ] Preview explanation-template.docx
6. [ ] Build placeholder data map for report
7. [ ] Build placeholder data map for explanation
8. [ ] Fill report-template placeholders
9. [ ] Fill explanation-template placeholders
10. [ ] Validate both outputs
11. [ ] Verify no unresolved 【】brackets
12. [ ] Confirm data consistency across documents
13. [ ] Save as generated-report.docx and generated-explanation.docx

## Deployment Requirement

A blank agent receiving only:

- This expert workspace
- Registered capability assets (minimax-docx, minimax-xlsx)
- materials/source.xlsx
- materials/report-template.docx
- materials/explanation-template.docx

Must be able to generate both output documents in one uninterrupted session.

## Generalization Hints

This workspace pattern applies when:

- Source data is in structured xlsx format
- Templates exist with 【】placeholder brackets
- Output requires filling templates with extracted data
- Multiple templates share common placeholder values

Adapt by:

- Updating data mapping tables for new source structure
- Adding new placeholder resolution rules for new template fields
- Extending validation checklist for document-specific requirements
