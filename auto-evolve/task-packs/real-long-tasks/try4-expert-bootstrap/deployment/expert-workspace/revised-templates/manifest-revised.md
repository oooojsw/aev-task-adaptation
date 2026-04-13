# Expert Workspace: Asset Evaluation Document Generation

Status: deployment-ready (revised)

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
| generated-report.docx      | report-template.docx      | 16+ placeholders (see below) |
| generated-explanation.docx | explanation-template.docx | 26+ placeholders (see below) |

## Critical Placeholder Syntax - CORRECTED

**ACTUAL BRACKETS USED**: U+3010 【 and U+3011 】 (left/right black lenticular brackets)

- U+3010 = 【 (left black lenticular bracket)
- U+3011 = 】 (right black lenticular bracket)
- These are NOT U+3008/3009 (which are 〈/〉 corner brackets)

**Verification**: Templates confirmed to use 【/】 brackets via XML parsing.

## Source Data Extract

### Sheet1 (固定资产汇总表) Key Values:

- Row 2: `评估基准日：2026年3月23日`
- Row 4: `产权持有人：江苏省国信集团有限公司`
- Row 12: `设备类合计` → M column = `22893.8` (含税净值)

### Sheet2 (废旧物资/设备清单) Key Values - 14 Equipment Items:

| Row | 序号 | 设备名称           | 规格型号 | 购置日期 | 总重量 | 碳钢重 | 状态           |
| --- | ---- | ------------------ | -------- | -------- | ------ | ------ | -------------- |
| 7   | 1    | 保护架             | -        | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 8   | 2    | 天线座运输支撑     | -        | -        | 1.5t   | 1.5t   | 已拆除、拟处置 |
| 9   | 3    | 过度环和轴承       | -        | -        | 0.7t   | 0.7t   | 已拆除、拟处置 |
| 10  | 4    | 阵面运输架及包装箱 | -        | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 11  | 5    | 句容过渡座         | -        | -        | 1t     | 1t     | 已拆除、拟处置 |
| 12  | 6    | 阵面工装           | -        | -        | 2.5t   | 2.5t   | 已拆除、拟处置 |
| 13  | 7    | 屏蔽网和支撑腿     | -        | -        | 0.3t   | 0.3t   | 已拆除、拟处置 |
| 14  | 8    | 屏蔽网和支撑腿     | -        | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 15  | 9    | 屏蔽网和支撑腿     | -        | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 16  | 10   | 屏蔽网和支撑腿     | -        | -        | 0.4t   | 0.4t   | 已拆除、拟处置 |
| 17  | 11   | 屏蔽网和支撑腿     | -        | -        | 0.6t   | 0.6t   | 已拆除、拟处置 |
| 18  | 12   | 天线子阵           | -        | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 19  | 13   | 储存柜             | -        | -        | 0.03t  | 0.03t  | 已拆除、拟处置 |
| 20  | 14   | 板房               | -        | -        | 0.6t   | 0.6t   | 已拆除、拟处置 |

**Note**: 规格型号 and 购置日期 columns are EMPTY for all rows.

## Report Template Placeholders (16 unique, 49 occurrences)

| Placeholder              | Source              | Resolution                      |
| ------------------------ | ------------------- | ------------------------------- |
| 〖产权持有单位〗         | Sheet1 Row 4        | direct: 江苏省国信集团有限公司  |
| 〖评估基准日〗           | Sheet1 Row 2        | direct: 2026年3月23日           |
| 〖评估机构〗             | NOT in source       | external_required (leave blank) |
| 〖报告文号〗             | NOT in source       | external_required (leave blank) |
| 〖评估结果金额〗         | Sheet1 Row 12       | direct: 22893.8                 |
| 〖评估目的详细描述〗     | contextual          | inferred: 拟处置设备资产项目    |
| 〖其他报告使用人说明〗   | NOT in source       | external_or_placeholder         |
| 〖宗旨和业务范围〗       | NOT in source       | external_required (leave blank) |
| 〖开办资金〗             | NOT in source       | external_required (leave blank) |
| 〖法定代表人〗           | NOT in source       | external_required (leave blank) |
| 〖注册地址〗             | NOT in source       | external_required (leave blank) |
| 〖统一社会信用代码〗     | NOT in source       | external_required (leave blank) |
| 〖报告日〗               | NOT in source       | external_or_default_today       |
| 〖报告日期中文大写〗     | derived from 报告日 | derived                         |
| 〖评估结论有效期截止日〗 | NOT in source       | external_required (leave blank) |
| 〖举办单位〗             | NOT in source       | external_required (leave blank) |

## Explanation Template Placeholders (26 unique, 49 occurrences)

| Placeholder          | Source              | Resolution                            |
| -------------------- | ------------------- | ------------------------------------- |
| 〖产权持有单位〗     | Sheet1 Row 4        | direct: 南京恩瑞特实业有限公司        |
| 〖评估基准日〗       | Sheet1 Row 2        | direct: 2026年3月23日                 |
| 〖评估机构〗         | NOT in source       | external_required (leave blank)       |
| 〖评估结果金额〗     | Sheet1 Row 12       | direct: 22893.8                       |
| 〖报告文号〗         | NOT in source       | external_required (leave blank)       |
| 〖存放地点〗         | NOT IN SHEET2       | leave blank (no such column)          |
| 〖具体存放位置〗     | NOT IN SHEET2       | leave blank (no such column)          |
| 〖设备类别一〗       | Sheet2 设备名称     | derived_first_unique: 保护架          |
| 〖设备类别二〗       | Sheet2 设备名称     | derived_second_unique: 天线座运输支撑 |
| 〖设备类别三〗       | Sheet2 设备名称     | derived_third_unique: 过度环和轴承    |
| 〖存放情况〗         | NOT IN SHEET2       | leave blank (no such column)          |
| 〖设备状态〗         | Sheet2 V column     | direct: 已拆除、拟处置                |
| 〖购置时间范围〗     | Sheet2 H column     | leave blank (all values empty)        |
| 〖是否申报账面价值〗 | contextual          | inferred: 否                          |
| 〖典型设备名称〗     | Sheet2 C column     | direct: 保护架 (first item)           |
| 〖规格型号〗         | Sheet2 D column     | leave blank (all values empty)        |
| 〖主材1〗            | Sheet2 废碳钢       | direct: 废碳钢                        |
| 〖主材2〗            | N/A                 | leave blank                           |
| 〖主材1重量〗        | Sheet2 K column     | direct: 0.5 (first item)              |
| 〖主材2重量〗        | N/A                 | leave blank                           |
| 〖主材1单价〗        | Sheet2 AC/AB column | direct: 1900-2000                     |
| 〖主材2单价〗        | N/A                 | leave blank                           |
| 〖主材构成〗         | Sheet2 废碳钢       | direct: 废碳钢                        |
| 〖案例计算公式〗     | NOT in source       | external_required (leave blank)       |
| 〖案例评估值〗       | NOT in source       | external_required (leave blank)       |
| 〖序号〗             | Sheet2 A column     | direct: 1 (first item)                |

## Core Rules

### Rule 1: Data Extraction Order

1. Always extract from Sheet1 (固定资产汇总表) first for summary values
2. Extract key values: 评估基准日 (Row 2), 产权持有人 (Row 4), 评估结果金额含税 (Row 12 = 22893.8)
3. Sheet2 (废旧物资/设备清单) for detail values only when needed

### Rule 2: Placeholder Resolution Priority

1. **Direct from xlsx**: 产权持有单位, 评估基准日, 评估结果金额, 设备状态
2. **From Sheet2 inference**: 设备类别 (unique values), 典型设备名称, 序号, 主材1重量
3. **External required**: 评估机构, 报告文号, 宗旨和业务范围, 开办资金, etc.
4. **Infer from context**: 评估目的详细描述 → "拟处置设备资产项目", 是否申报账面价值 → "否"

### Rule 3: Value Format

- Currency: 22893.8 (numeric, no comma formatting in placeholder)
- Date: "2026年3月23日" (Chinese format as string)
- Organization: "江苏省国信集团有限公司" (report), "南京恩瑞特实业有限公司" (explanation)

### Rule 4: IMPORTANT - Empty Value Handling

**CRITICAL FIX**: The previous workspace incorrectly used '详见设备清单' as fallback for empty Sheet2 values.

**CORRECT BEHAVIOR**:

- If Sheet2 source value is NON-EMPTY → use the actual value
- If Sheet2 source value is EMPTY → leave placeholder **BLANK** (empty string)
- ONLY leave placeholder text like 【待填写】 for truly external fields

**Fields that should be left BLANK (not '详见设备清单')**:

- 典型设备名称: when Sheet2 has no data → leave blank
- 规格型号: when Sheet2 D column is empty → leave blank
- 序号: when Sheet2 A column is empty → leave blank
- 购置时间范围: when all Sheet2 H values are empty → leave blank
- 存放地点: when column doesn't exist in Sheet2 → leave blank
- 存放情况: when column doesn't exist in Sheet2 → leave blank
- 具体存放位置: when column doesn't exist in Sheet2 → leave blank

### Rule 5: Document Generation Pipeline

Use minimax-docx Pipeline B (Fill/Edit) since templates exist:

1. Read capability SKILL.md
2. Preview templates with `docx_preview.sh`
3. Analyze structure with `$CLI analyze --input template.docx`
4. **CRITICAL**: Use U+3010 【 and U+3011 】 brackets when filling placeholders (not any other bracket type)
5. Fill placeholders using `$CLI edit fill-placeholders --data '{...}'`
6. Run validation pipeline: merge-runs → validate (XSD) → validate (business)
7. Diff check to verify minimal changes

### Rule 6: Numeric Recall Threshold

Both generated documents must achieve >= 80% numeric recall against reference:

- Report: 0.80 minimum
- Explanation: 0.80 minimum
- Key numbers: 22893.8 (评估结果金额), 2026年3月23日 (评估基准日)
- If below threshold, review data extraction and placeholder filling

## Validation Checklist

### Pre-Generation Checks

- [ ] Verify source.xlsx contains required data
- [ ] Confirm template uses U+3010 【/】 bracket syntax
- [ ] Identify all placeholder positions in both templates

### Post-Generation Checks

- [ ] **ALL 【/】 brackets resolved** (no unresolved placeholders except external ones)
- [ ] 评估结果金额 matches source xlsx exactly (22893.8)
- [ ] 评估基准日 correct format (2026年3月23日)
- [ ] 产权持有单位 correct (江苏省国信集团有限公司 for report, 南京恩瑞特实业有限公司 for explanation)
- [ ] 典型设备名称 shows "保护架" NOT '详见设备清单'
- [ ] 规格型号 is blank (empty) NOT '详见设备清单'
- [ ] 序号 shows "1" NOT '详见设备清单'
- [ ] 设备类别一/二/三 correctly show first three unique equipment names
- [ ] Document structure preserved (section count maintained)
- [ ] No content truncation or corruption
- [ ] Numeric recall >= 0.80 for both documents

## Exception Handling

### Exception 1: Missing Source Data

If a required placeholder value is NOT in source.xlsx AND is not externally provided:

- Leave the placeholder **completely blank** (empty string)
- Do NOT use '详见设备清单' or any other fallback text
- This applies to: 存放地点, 存放情况, 具体存放位置, 购置时间范围, 规格型号

### Exception 2: Reference .doc Files

The reference .doc files (Word 97-2003 format) may not parse fully due to encoding. Do NOT block on this - use templates and xlsx data only.

### Exception 3: Unknown Values for Output

For values like 评估机构, 报告文号 that are not in source:

- If task provides them, use provided values
- If not provided, leave as 【待填写】 or blank

## Deployment Validation

**IMPORTANT**: Validators check `deployment/outputs/` directory, NOT `expert-workspace/` files.

Deployment acceptance requires:

1. `deployment/outputs/generated-report.docx` exists and is placeholder-free (except external fields)
2. `deployment/outputs/generated-explanation.docx` exists and is placeholder-free (except external fields)
3. Both documents pass numeric recall >= 0.80

## Revised Template Location

The revised templates and alignment guide are located at:
`deployment/expert-workspace/revised-templates/`

Key file:

- `alignment-fix-guide.md` - Complete guide to correct placeholder filling

## Generalization Hints

This workspace pattern applies when:

- Source data is in structured xlsx format
- Templates exist with 【/】 placeholder brackets
- Output requires filling templates with extracted data
- Multiple templates share common placeholder values

Adapt by:

- Updating data mapping tables for new source structure
- Adding new placeholder resolution rules for new template fields
- Extending validation checklist for document-specific requirements
