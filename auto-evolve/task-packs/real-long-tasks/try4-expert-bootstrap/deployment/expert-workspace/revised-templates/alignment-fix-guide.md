# Revised Template Alignment Guide

## Overview

This document revises the expert workspace templates to address alignment gaps identified in the audit process. The key changes address data consistency and content coverage issues.

## Critical Fix: Bracket Syntax

**ACTUAL TEMPLATE BRACKETS**: U+3010 【 and U+3011 】 (left/right black lenticular brackets)

The manifest incorrectly states U+3008/3009. The actual templates use:

- U+3010 = 【 (left black lenticular bracket)
- U+3011 = 】 (right black lenticular bracket)

**Verification**: Both `report-template-verification.json` and `explanation-template-verification.json` confirm:

```json
"placeholder_bracket_type": "U+3010 【 and U+3011 】"
```

## Gap-002 Fix: Incorrect '详见设备清单' Fallback

### Problem

Generated explanation incorrectly fills these placeholders with '详见设备清单':

- 典型设备名称
- 规格型号
- 序号

### Root Cause

The fill logic uses '详见设备清单' as fallback when Sheet2 data is empty or when data extraction fails.

### Correct Data Mapping (Sheet2 Row 7 - First Equipment Item)

| Placeholder  | Sheet2 Column | Correct Value | Notes                 |
| ------------ | ------------- | ------------- | --------------------- |
| 典型设备名称 | C (设备名称)  | 保护架        | First item's 设备名称 |
| 规格型号     | D (规格型号)  | (empty)       | No spec available     |
| 序号         | A (序号)      | 1             | From column A         |

### Revised Fill Rules

```python
# Sheet2 Equipment Row Data (rowIndex 7, first data row)
equipment_row = {
    "A": "1",       # 序号
    "C": "保护架",  # 设备名称
    "D": "",        # 规格型号 (EMPTY - do NOT use fallback)
    "H": "",        # 购置日期 (EMPTY)
    "J": "0.5",     # 总重量
    "K": "0.5",     # 碳钢重
    "V": "已拆除、拟处置",  # 状态
}

# FILL RULES:
# 1. If Sheet2 value is non-empty → use actual value
# 2. If Sheet2 value is empty → leave placeholder BLANK (do NOT use '详见设备清单')
# 3. ONLY use '详见设备清单' if the ENTIRE Sheet2 column is missing (not just empty)

def fill_equipment_placeholder(field_name, sheet2_value, fallback_text=None):
    if sheet2_value and sheet2_value.strip():
        return sheet2_value.strip()
    elif fallback_text and field_name in ["典型设备名称", "规格型号", "序号"]:
        # For these specific fields, DO NOT use fallback - leave blank
        return ""  # Leave empty instead of '详见设备清单'
    else:
        return fallback_text if fallback_text else ""
```

### All Sheet2 Equipment Items (14 total)

| Row | 序号 | 设备名称           | 规格型号 | 总重量 | 碳钢重 | 状态           |
| --- | ---- | ------------------ | -------- | ------ | ------ | -------------- |
| 7   | 1    | 保护架             | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 8   | 2    | 天线座运输支撑     | -        | 1.5t   | 1.5t   | 已拆除、拟处置 |
| 9   | 3    | 过度环和轴承       | -        | 0.7t   | 0.7t   | 已拆除、拟处置 |
| 10  | 4    | 阵面运输架及包装箱 | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 11  | 5    | 句容过渡座         | -        | 1t     | 1t     | 已拆除、拟处置 |
| 12  | 6    | 阵面工装           | -        | 2.5t   | 2.5t   | 已拆除、拟处置 |
| 13  | 7    | 屏蔽网和支撑腿     | -        | 0.3t   | 0.3t   | 已拆除、拟处置 |
| 14  | 8    | 屏蔽网和支撑腿     | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 15  | 9    | 屏蔽网和支撑腿     | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 16  | 10   | 屏蔽网和支撑腿     | -        | 0.4t   | 0.4t   | 已拆除、拟处置 |
| 17  | 11   | 屏蔽网和支撑腿     | -        | 0.6t   | 0.6t   | 已拆除、拟处置 |
| 18  | 12   | 天线子阵           | -        | 0.5t   | 0.5t   | 已拆除、拟处置 |
| 19  | 13   | 储存柜             | -        | 0.03t  | 0.03t  | 已拆除、拟处置 |
| 20  | 14   | 板房               | -        | 0.6t   | 0.6t   | 已拆除、拟处置 |

## Gap-003 Fix: 设备类别 and 购置时间范围

### 设备类别一/二/三

Derived from unique 设备名称 values:

| Category   | Source Value   |
| ---------- | -------------- |
| 设备类别一 | 保护架         |
| 设备类别二 | 天线座运输支撑 |
| 设备类别三 | 过度环和轴承   |

**Note**: Since all equipment has the same status (已拆除、拟处置) and no actual categorization exists in Sheet2, use the first three unique 设备名称 values.

### 购置时间范围

**Problem**: All 购置日期 (column H) values in Sheet2 are empty strings.

**Resolution**: Since no purchase date data is available, leave the 购置时间范围 placeholder EMPTY. Do NOT use '详见设备清单' or any other fallback text.

## Gap-004 Fix: Location Fields

### Problem

The following placeholders were marked as `inferred_from_sheet2` but the correct Sheet2 columns were NOT identified:

- 存放地点
- 存放情况
- 具体存放位置

### Root Cause Analysis

After reviewing Sheet2 structure:

- Column A contains 序号
- Column C contains 设备名称
- Column D contains 规格型号 (all empty)
- Column H contains 购置日期 (all empty)
- Column V contains 状态 (已拆除、拟处置)
- **No columns for 存放地点, 存放情况, or 具体存放位置 exist in Sheet2**

### Resolution

Since the location-related columns do not exist in Sheet2:

1. Leave 存放地点 placeholder **EMPTY**
2. Leave 存放情况 placeholder **EMPTY**
3. Leave 具体存放位置 placeholder **EMPTY**

**Do NOT use '详见设备清单' or any other fallback text for these fields.**

## Complete Correct Value Map

### Explanation Template - All Placeholder Values

| Placeholder      | Correct Value          | Source                      | Fill Rule            |
| ---------------- | ---------------------- | --------------------------- | -------------------- |
| 产权持有单位     | 南京恩瑞特实业有限公司 | Sheet2 Row 4                | Direct               |
| 评估基准日       | 2026年3月23日          | Sheet1 Row 2                | Direct               |
| 评估机构         | 【待填写】             | External                    | Leave as placeholder |
| 报告文号         | 【待填写】             | External                    | Leave as placeholder |
| 评估结果金额     | 22893.8                | Sheet1 Row 12               | Direct               |
| 存放地点         | (blank)                | NOT IN SHEET2               | Leave empty          |
| 具体存放位置     | (blank)                | NOT IN SHEET2               | Leave empty          |
| 设备类别一       | 保护架                 | Sheet2 设备名称 unique      | Derived first        |
| 设备类别二       | 天线座运输支撑         | Sheet2 设备名称 unique      | Derived second       |
| 设备类别三       | 过度环和轴承           | Sheet2 设备名称 unique      | Derived third        |
| 存放情况         | (blank)                | NOT IN SHEET2               | Leave empty          |
| 设备状态         | 已拆除、拟处置         | Sheet2 V column             | Direct               |
| 购置时间范围     | (blank)                | Sheet2 H column empty       | Leave empty          |
| 是否申报账面价值 | 否                     | Contextual                  | Inferred             |
| 典型设备名称     | 保护架                 | Sheet2 C column             | First item           |
| 规格型号         | (blank)                | Sheet2 D column empty       | Leave empty          |
| 主材1            | 废碳钢                 | Sheet2 废碳钢               | Direct               |
| 主材2            | -                      | N/A                         | Leave empty          |
| 主材1重量        | 0.5                    | Sheet2 K column (first row) | Direct               |
| 主材2重量        | -                      | N/A                         | Leave empty          |
| 主材1单价        | 1900-2000              | Sheet2 AC/AB column         | Direct               |
| 主材2单价        | -                      | N/A                         | Leave empty          |
| 主材构成         | 废碳钢                 | Sheet2 废碳钢               | Direct               |
| 案例计算公式     | 【待填写】             | External                    | Leave as placeholder |
| 案例评估值       | 【待填写】             | External                    | Leave as placeholder |
| 序号             | 1                      | Sheet2 A column (first row) | Direct               |

### Report Template - Key Values

| Placeholder      | Correct Value          | Source        |
| ---------------- | ---------------------- | ------------- |
| 产权持有单位     | 江苏省国信集团有限公司 | Sheet1 Row 4  |
| 评估基准日       | 2026年3月23日          | Sheet1 Row 2  |
| 评估结果金额     | 22893.8                | Sheet1 Row 12 |
| 评估目的详细描述 | 拟处置设备资产项目     | Contextual    |

## Validation Checklist

After filling, verify:

- [ ] 典型设备名称 shows "保护架" NOT '详见设备清单'
- [ ] 规格型号 is blank (empty) NOT '详见设备清单'
- [ ] 序号 shows "1" NOT '详见设备清单'
- [ ] 设备类别一 shows "保护架"
- [ ] 设备类别二 shows "天线座运输支撑"
- [ ] 设备类别三 shows "过度环和轴承"
- [ ] 购置时间范围 is blank (no purchase date data)
- [ ] 存放地点, 存放情况, 具体存放位置 are all blank
- [ ] NO '详见设备清单' appears anywhere in filled output

## Metadata

- Created: 2026-04-13
- Based on: alignment-audit-report.json (alignment-audit-001)
- Supersedes: manifest.md bracket specifications
