<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->

# Expert Workspace — try4 Expert Bootstrap

Status: bootstrap-complete-through-round-008

## Purpose

This workspace encodes formal expert experience for a blank agent to complete asset valuation report generation from declared materials in one uninterrupted session.

## Entry Points

- Read this file first: `manifest.md`
- Read surface contract: `surface_contract.json`
- Read cross-round failure lessons: `lessons/failure_lessons.md`
- Read execution checklist before taking action: `rules/execution_checklist.md`

## Deployment Constraint

The blank agent must be able to complete the declared deliverable using only:

- This expert workspace (all files under this root)
- Registered capability assets under `../capabilities/`
- Declared task materials under `../materials/`
- Task scope defined in `../materials/human-guidance.md`

No hidden answers, no runtime-state dependency, no historical logs.

## Workspace Structure

```
expert-workspace/
  manifest.md            — entry point (this file)
  surface_contract.json   — machine-readable contract
  change_log.md          — version history
  lessons/
    failure_lessons.md   — cross-round failure patterns (updated round-009)
  rules/
    execution_checklist.md   — mandatory pre-action checklist
    docx_fill_rules.md       — docx fill methodology
    xlsx_inspection_rules.md — xlsx inspection methodology
    legacy_doc_rules.md      — .doc extraction rules
```

## Deployment Validation

The learned workspace must pass deployment acceptance against the declared deliverable scope.

Target outputs (deployment/outputs/):

- `deployment/outputs/generated-report.docx`
- `deployment/outputs/generated-explanation.docx`

Both must be valid DOCX packages, fully resolved (no 【残留 placeholders】), with data consistent with source.xlsx values.

**Headless completion criteria**: targets-exist + placeholder-free only. reference-alignment and soft-document-quality require external resolution (validator-tool limitations).

## Source Materials Reference

- Source workbook: `../materials/source.xlsx`
  - Sheet names: 固定资产汇总表 (21 rows × 17 cols), 固定资产—设备评估明细表 (29 rows × 36 cols)
  - Key values (derive at runtime from cell references, do not substitute literals):
    - 评估基准日 → derive from Sheet1!D1
    - 设备类资产评估值 → derive from Sheet1!L12 (apply #,##0.00 display format)
    - 设备类资产净值 → Sheet1!M12 (apply #,##0.00 display format)
  - Encoding: UTF-8 shared strings
- Report template: `../materials/report-template.docx` — 3 headers, 3 footers, 【...】 placeholders
- Explanation template: `../materials/explanation-template.docx` — 3 headers, 2 footers, 【...】 placeholders
- Reference docs: `../materials/report-reference.doc` and `../materials/explanation-reference.doc` (legacy .doc format)

## Cross-Round Status

- round-001: bootstrap_complete — expert workspace synthesized with full rules, checklist, fill methodology, xlsx inspection, legacy doc rules, and failure lessons.
- round-002: bootstrap-grown — hardcoded numeric values purged from all rule documents; valid DOCX outputs generated; structural duplication (nested current/current/ subtree) cleaned; deployment acceptance not yet passed (placeholder residuals, numeric display format not applied).
- round-003: rules sanitized — hardcoded example values replaced with generic placeholders; nested subtree deleted; both completion validators pass on expert-workspace (workspace-layout: 7 docs + 1 control file; surface-generalization: 0 hits on 6 files).
- round-004: bootstrap-complete (DISPUTED) — All 6 work units completed and 2-of-2 required completion validators passed headlessly. Nested duplicate deletion claimed but reviewer pass-01 shows 7 files still present at pending source. All rules/lessons sanitized to generic placeholders. Expert workspace promoted. Headless ceiling 2-of-4.
- round-006: graph_completed — All work units completed and all required completion validators passed. Both dispatch tickets closed, routing-control readyForFinalAcceptance=true. Orphaned nested current/current/ subtree removed. Deployment/outputs/ DOCX files confirmed 0 bracket residuals. Expert-workspace populated with 0 forbidden literal hits.
- round-008: graph_completed — All work units completed and all required completion validators passed. surface_contract.json self-reference removed. failure_lessons.md numeric literals sanitized. Headless ceiling 2-of-4 (reference-alignment blocked by .doc format + comma-separator bug; soft-document-quality requires LLM).

## Fill Protocol Summary

1. Run dotnet merge-runs on template (MANDATORY prerequisite)
2. Fill placeholders across ALL word/_.xml parts (document.xml, header_.xml, footer\*.xml)
3. Apply display format (#,##0.00) to numeric values during extraction
4. Post-fill: byte-level U+3010/U+3011 scan across ALL word/\*.xml parts must return 0
5. Copy outputs to deployment/outputs/ before validators

## Critical Anti-Drift Rules

- **Validator scanning path**: Validators scan pending-expert-package/current/ NOT task-pack expert-workspace/. Passing validators against pending source is necessary but not sufficient — task-pack artifact paths must also be verified as populated.
- **Pre-promotion full-file scan**: Expert-surface-generalization validator scans ALL files in the package including historical failure records. Retry guidance examples are NOT exempt — use generic placeholders only.
- **Promotional copy-out verification**: After copying to task-pack expert-workspace, verify destination has files before claiming promotion success. Copy mechanism silent-failures are not visible from pending source validation alone.
- **Shell invocation on Windows**: From bash-compatible shell, prefix PowerShell cmdlets with 'powershell.exe -Command'. Without this prefix, Get-ChildItem/Select-Object/Test-Path fail with exit 127.
- **File-existence-before-read**: Before reading validator output logs (stdout.log), verify file exists with Test-Path.

## Validator Config Guidance

- Always use formal-surface-generalization.json (not custom configs) for authoritative surface-generalization validation
- Custom validator configs can produce false passes — formal config is the ground truth gate
