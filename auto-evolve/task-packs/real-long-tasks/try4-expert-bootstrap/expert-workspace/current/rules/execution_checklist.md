<!-- auto-evolve-role: execution_checklist -->

# Execution Checklist — Blank Agent Mandatory Pre-Action

## Before Any Document Generation

1. Read `../materials/human-guidance.md` — mandatory scope constraint
2. Read `./manifest.md` — workspace entry point
3. Read `./lessons/failure_lessons.md` — cross-round failure patterns
4. Read `./surface_contract.json` — formal document registry

## Before XLSX Inspection

1. Confirm source.xlsx is at `../materials/source.xlsx`
2. Use minimax-xlsx skill (Pipeline A: Inspect-Read) for structure extraction
3. Verify shared strings XML uses UTF-8 encoding
4. Extract key values using cell references:
   - 评估基准日 → Sheet1!D1
   - 设备类资产评估值 → Sheet1!L12 (apply #,##0.00 display format)
   - 设备类资产净值 → Sheet1!M12 (apply #,##0.00 display format)
5. Sheet names: 固定资产汇总表, 固定资产—设备评估明细表

## Before DOCX Fill — MANDATORY PROTOCOL

**FAILURE-SENSITIVE: Follow this exact sequence every time.**

1. **Load template** from `../materials/report-template.docx` or `../materials/explanation-template.docx`
2. **Step 0**: Run `dotnet merge-runs --input <template.docx>` — mandatory prerequisite, consolidates split XML runs
3. **Step 1**: Use minimax-docx skill (Pipeline B: Fill-Edit) for placeholder replacement
4. **Step 2**: Process ALL of: document.xml, header1.xml, header2.xml, header3.xml, footer1.xml, footer2.xml, footer3.xml
5. **Step 3**: Apply numeric display formatting to extracted values before insertion
6. Never leave any 【...】 marker unresolved in any part

## Before Claiming Success — Mandatory Self-Check

**Byte-level U+3010/U+3011 bracket scan is the ONLY valid placeholder check.**

1. Both output files exist at `deployment/outputs/generated-report.docx` and `deployment/outputs/generated-explanation.docx`
2. Both files are valid DOCX packages (can be opened as ZIP)
3. **Byte-level scan**: scan ALL word/\*.xml parts for U+3010 and U+3011 — must return 0 in every part
4. Text search or str.replace checks are insufficient — use byte-level scan
5. Key values are present and formatted correctly (评估基准日, monetary values with thousands separators)
6. Copy outputs to deployment/outputs/ — deployment harness validates at that specific path

## Windows Tool Conventions (MANDATORY)

- **glob unavailable**: Use `Get-ChildItem -Path <dir> -Recurse -File` for file enumeration
- **cd does not persist**: Use Bash workdir parameter for bun/node commands — never `cd "..."; bun run ...`
- **JSON BOM issue**: Use `[System.IO.File]::WriteAllText($outPath, $payload, [System.Text.UTF8Encoding]::new($false))` for BOM-free writes
- **Select-String wildcard does not recurse**: Use `Get-ChildItem -Path <dir> -Recurse -File -Filter *.md | Select-String -Pattern <regex>`
- **Validator invocation**: python validate-experience-surface-generalization.py takes 2 args: `<input.json> <config.json>` — NOT 3 args

## Legacy .doc Handling

- .doc files are NOT .docx ZIP packages
- Do not send .doc to OpenXML zip analyzers
- Use aspose.words evaluation mode for Chinese text extraction
- antiword unavailable on this system

## Deployment Output Path

- Output must be at: `deployment/outputs/` (not task-pack-root/outputs/)
- Deployment harness expects targets at deployment/outputs/ specifically
- After generating outputs, copy to deployment/outputs/ before running validators

## Failure-Sensitive Points

- merge-runs is mandatory before fill, not optional
- ALL XML parts must be scanned for brackets — headers and footers included
- Numeric values: apply display format during fill (raw integer → "<formatted-value>")
- Output path: deployment/outputs/ not task-pack-root/outputs/

## Pre-Promotion Sanitization Checklist

**MUST complete before promoting pending-expert-package to expert-workspace:**

1. Scan ALL files in pending-expert-package/current/ for task-specific numeric literals in example content
2. Replace specific numeric example content with generic placeholders — apply generic placeholders, do NOT embed specific literal patterns
3. Apply to: lessons/failure_lessons.md, rules/docx_fill_rules.md, rules/xlsx_inspection_rules.md, rules/execution_checklist.md
4. Expert-surface-generalization validator scans ALL package files — historical examples in failure_lessons.md are NOT exempt
5. Run validator scan BEFORE claiming promotion readiness

## Windows Tool Conventions — Updated

- **read tool on Windows**: Use fully-qualified absolute paths (E:\\... or C:\\...) not relative path strings (auto-evolve\\...). Relative paths resolve against working directory which may not be task-pack root.
- **read fallback**: If read fails, use Test-Path + Get-Content as a safer 2-step read equivalent.
- **glob unavailable**: Use Get-ChildItem -Path <dir> -Recurse -File for file enumeration
- **cd does not persist**: Use Bash workdir parameter for bun/node commands — never cd "..."; bun run ...
- **JSON BOM issue**: Use [System.IO.File]::WriteAllText($outPath, $payload, [System.Text.UTF8Encoding]::new($false)) for BOM-free writes
- **Select-String wildcard does not recurse**: Use Get-ChildItem -Path <dir> -Recurse -File -Filter \*.md | Select-String -Pattern <regex>
- **Validator invocation**: python validate-experience-surface-generalization.py takes 2 args: <input.json> <config.json> — NOT 3 args

## Blank-Agent Stall Guardrail — Mandatory

**If blank-agent is used for production:**

1. Blank-agent must produce at least one DOCX output file within first N tool calls BEFORE entering state inspection
2. Do NOT read run.json, events.json, or action_trace.md before confirming at least one production output exists
3. If agent stalls in state-inspection loop (reading state files without producing outputs), terminate and retry with explicit production directive
4. Pre-existing deployment/outputs/ files from prior rounds are NOT fresh generation — confirm via workspace/ directory check (should be empty for fresh run)
