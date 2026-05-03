<!-- auto-evolve-role: docx_fill_rules -->

# DOCX Fill Rules

## Capability

Use minimax-docx skill. Pipeline: B (Fill-Edit) for existing templates.

## Placeholder Marker

- Pattern: 【...】 (U+3010 / U+3011 double-byte brackets)
- Target: All visible text regions across all XML parts

## Required Processing Parts (Report Template)

- word/document.xml
- word/header1.xml
- word/header2.xml
- word/header3.xml
- word/footer1.xml
- word/footer2.xml
- word/footer3.xml

## Required Processing Parts (Explanation Template)

- word/document.xml
- word/header1.xml
- word/header2.xml
- word/header3.xml
- word/footer1.xml
- word/footer2.xml

## Fill Protocol — Mandatory Sequence

**Step 0 (Prerequisite): Run dotnet merge-runs**

Before any placeholder replacement, run:

```
dotnet run --project <cli-project> -- merge-runs --input <template.docx>
```

This consolidates split `<w:r>` XML runs so that cross-run Chinese placeholders become visible to replace-text operations. Without this step, placeholder detection WILL fail.

**Step 1: Merge-Runs on Template**

- Consolidate template XML runs using dotnet OpenXML CLI merge-runs command
- This is a hard prerequisite, not an optional polish step
- Template must be merged before any fill operation

**Step 2: Fill Placeholders Across ALL Parts**

- Process word/document.xml AND all word/header*.xml AND all word/footer*.xml
- Do NOT process only document.xml — placeholders also live in headers and footers
- Use OpenXML-aware replacement (dotnet CLI replace-text or equivalent DOM traversal)
- Simple Python zipfile str.replace WILL miss cross-run placeholders

**Step 3: Post-Fill Bracket Scan**

After fill, run byte-level scan across ALL word/\*.xml parts:

- Pattern: count U+3010 and U+3011 characters in every XML part
- Must return 0 (zero) bracket residuals in all parts
- Text-extraction or str.replace-based checks are insufficient

**Step 4: Numeric Value Formatting**

When extracting monetary values from source.xlsx for docx insertion:

- Raw integer values (e.g., <raw-integer>) must be formatted as display strings (e.g., "<formatted-value>")
- Apply Excel column display format (#,##0.00) during fill, not after
- Derivation instruction: "Apply display format to extracted numeric value before inserting into document"

## Post-Fill Verification

1. Byte-level U+3010/U+3011 scan across ALL word/\*.xml parts — all must return 0
2. Confirm no 【 or 】 characters remain in any XML part
3. Verify key value fields are populated (not blank, not placeholder原样)
4. Monetary values: confirm formatted with thousands separator and 2 decimal places

## Output Rule

- Write to deployment/outputs/generated-report.docx or deployment/outputs/generated-explanation.docx
- Output path is deployment/outputs/ (not task-pack-root/outputs/)
- Do NOT overwrite ../materials/ original templates

## Encoding

- Use UTF-8 for all text operations
