<!-- auto-evolve-role: xlsx_inspection_rules -->

# XLSX Inspection Rules

## Capability

Use minimax-xlsx skill. Pipeline: A (Inspect-Read) for structure extraction.

## Source File

- Path: ../materials/source.xlsx
- Encoding: UTF-8 shared strings (not ISO-8859-1 or CP1252)

## Sheet Structure

Sheet 1: 固定资产汇总表

- Dimensions: 21 rows × 17 cols (A–Q)
- Key columns: A=分类编号, B=科目名称, C–H=原值/累计折旧/账面价值, L=评估价值(含税), M=净值(含税), Q=增值率%
- Row 12 (section 4-6-5): 设备类合计

Sheet 2: 固定资产—设备评估明细表

- Dimensions: 29 rows × 36 cols
- Contains: 序号, 设备名称, 规格型号, 数量, 评估价值, 增值率, 状态, 备注, 材料回收报价

## Key Values to Extract

All values must be derived at runtime from source.xlsx cell locations — do not substitute literal strings.

### 评估基准日

- Derive from: Sheet1 row1 col-D (or shared strings index for header cell)
- Display: format as "yyyy年M月d日" string

### 设备类资产评估值

- Derive from: Sheet1 row12 col-L
- Raw value is integer (e.g., <raw-integer>) — apply display format (#,##0.00) to produce display string
- Display format must include: thousands separator + 2 decimal places

### 设备类资产净值

- Derive from: Sheet1 row12 col-M
- Raw value is numeric — apply display format (#,##0.00)

### 产权持有人

- Derive from: Sheet2 (device row) — extract from relevant shared string
- Sheet1 row4 col-A or col-B for summary entity name

## Numeric Value Handling

Raw integer values from source.xlsx MUST be formatted before docx insertion:

- L12 raw = <raw-integer> (integer) → display = "<formatted-value>"
- M12 raw = <raw-decimal> (numeric) → display = "<formatted-value>"
- Apply Excel column display format during extraction, not after

## Self-Check

- Verify shared strings decode as readable Chinese (UTF-8, not garbled)
- Confirm 89 unique strings across 2 sheets
- Validate numeric display format is applied: raw value ≠ display value

## Cell Reference Quick Reference

- 评估基准日: Sheet1!D1 (date cell, apply date format)
- 设备类资产评估值: Sheet1!L12 (integer, apply #,##0.00 format)
- 设备类资产净值: Sheet1!M12 (numeric, apply #,##0.00 format)
- 设备类合计 label: Sheet1!B12
