import os
import fnmatch
from datetime import datetime


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
OUT = os.path.join(DESKTOP, f"auto-evolve-core-code-{STAMP}.txt")

# Core code scope for this project.
INCLUDE_FILES = {
    "AGENTS.md",
    "cli.ts",
    "monitor-server.ts",
    "README.md",
}

INCLUDE_DIRS = {
    "orchestrator",
    "methods",
    "prompts",
    "scripts",
}

# Common noise / generated artifacts.
SKIP_DIRS = {
    ".git",
    ".runtime",
    ".gemini_consult_runs",
    "runtime-state",
    "node_modules",
    ".next",
    "dist",
    "build",
    "__pycache__",
    ".claude",
}

EXT = {
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".py",
    ".ps1",
    ".sh",
    ".css",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
}


# Export-only ignore rules. Keep this list inside the script so other agents only
# need to run/copy one file and cannot forget a separate ignore config.
IGNORE_PATTERNS = [
    # One-off validation payloads and old round/UID debug inputs.
    "scripts/*_input.json",
    "scripts/*-input.json",
    "scripts/*_config.json",
    "scripts/*-config.json",
    "scripts/*validator_input*.json",
    "scripts/*validation_input*.json",
    "scripts/current_surface_validation_*.json",
    "scripts/pending_surface_*.json",
    "scripts/r[0-9][0-9][0-9]_*.json",
    "scripts/ew_*.json",
    "scripts/fa_*.json",
    "scripts/fag_*.json",
    "scripts/expert_ws_*.json",
    "scripts/temp_*.json",
    "scripts/test_input.json",
    "scripts/validate-input-*.json",
    "scripts/validator_input*.json",
    # Temporary verifier helpers created during manual debugging.
    "scripts/_*.py",
    # Specific historical rerun/resume helpers tied to old OfficeQA IDs.
    "scripts/resume-uid0120-uid0223-rounds20.ts",
    "scripts/run-uid0120-uid0223-rerun.ts",
    # One-off operations / recovery scripts tied to old experiment states.
    "scripts/resume-*.ts",
    "scripts/finish-*.ts",
    "scripts/patch-*.ts",
    "scripts/monitor-*.ps1",
    "scripts/start-queued-*.ts",
    "scripts/audit-monitor-*.ps1",
    # Offline analysis flattening helpers, not core runtime architecture.
    "scripts/build-compact-analysis.*",
    "scripts/flatten-round-docs.ps1",
    "scripts/merge-flat-docs.ps1",
    # Local config snapshots with machine-specific paths / old literal guards.
    "scripts/formal-config.json",
    "scripts/formal-surface-generalization.json",
    # Local machine operations / one-off workspace checks.
    "scripts/run-workspace-validation.ts",
    "scripts/archive-*.ps1",
    "scripts/auto-evolve/config.json",
    "scripts/*try4*.ps1",
    # Dataset download / browser proof capture utilities, not core runtime.
    "scripts/download-*.py",
    "scripts/capture-qwen-web-proof.mjs",
    # Legacy dataset-specific launchers superseded by run-benchmark-orchestrator.
    "scripts/run-officeqa-pro-*.ts",
    "scripts/run-spreadsheetbench-*.ts",
    "scripts/run-audit-point-*.ts",
    # Dataset materialization scripts are useful operationally, but noisy for
    # a pure architecture export.
    "scripts/create-*.ts",
    # Report aggregation / bridge utilities are useful operationally, but they
    # are not part of the core orchestration / validation / permission engine.
    "scripts/aggregate-*.mjs",
    "scripts/generate-*.py",
    "scripts/update-direct-chat-master-report.py",
    "scripts/update-resource-cost-report.ts",
    "scripts/export-*bridge.ts",
    # Future method scaffold. The runtime is not wired yet, and fs.ts already
    # preserves the template source for architecture review.
    "methods/recipes/adversarial-test/*",
    # Smoke tests and local test harnesses prove behavior, but are noisy for a
    # single architecture/full-picture export.
    "scripts/smoke-*",
    "scripts/test-*",
    # init-assets duplicates the live methods/prompts/templates as copy seeds.
    # Keep the real methods/prompts tree in the export; omit the duplicate seed
    # source to avoid doubling prompt content.
    "init-assets/*",
    # Human dashboard UI is useful operationally, not core agent orchestration.
    "frontend/*",
    # Dataset-specific product validators and materialization/OCR helpers are
    # plug-in edges. The validation engine and profile wiring remain exported.
    "scripts/validate-*.py",
    "scripts/validate-*.ps1",
    "scripts/validate-*.ts",
    "scripts/materialize-*.py",
    "scripts/word_text_utils.py",
    "scripts/direct-chat-local-ocr.py",
    "scripts/render-pdf-pages-for-direct-chat.py",
    "scripts/*.ps1",
    "scripts/import-opencode-private-profile.ts",
    "scripts/update-*.ts",
    "scripts/update-*.py",
    "scripts/export-*.ts",
]


def should_skip_dir(name: str) -> bool:
    return name in SKIP_DIRS


def matches_ignore(rel: str, patterns: list[str]) -> bool:
    rel = rel.replace("\\", "/")
    base = os.path.basename(rel)
    ignored = False
    for pattern in patterns:
        negated = pattern.startswith("!")
        if negated:
            pattern = pattern[1:]
        pattern = pattern.rstrip("/")
        if not pattern:
            continue
        matched = False
        if "/" not in pattern and fnmatch.fnmatch(base, pattern):
            matched = True
        if fnmatch.fnmatch(rel, pattern):
            matched = True
        if matched:
            ignored = not negated
    return ignored


def should_keep(rel: str, ignore_patterns: list[str]) -> bool:
    rel = rel.replace("\\", "/")
    if matches_ignore(rel, ignore_patterns):
        return False
    base = os.path.basename(rel)
    # Root files only. Do not export every nested README.md from task data or
    # generated expert workspaces just because the basename matches.
    if rel in INCLUDE_FILES:
        return True
    top = rel.split("/", 1)[0]
    if top not in INCLUDE_DIRS:
        return False
    ext = os.path.splitext(base)[1].lower()
    return ext in EXT


def iter_files():
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if not should_skip_dir(d)]
        for name in files:
            full = os.path.join(root, name)
            try:
                rel = os.path.relpath(full, ROOT)
            except ValueError:
                continue
            if not should_keep(rel, IGNORE_PATTERNS):
                continue
            yield full, rel


def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception as e:
        return f"[READ_ERROR] {e}"


def main():
    files = sorted(iter_files(), key=lambda x: x[1].lower())
    with open(OUT, "w", encoding="utf-8") as out:
        out.write("# auto-evolve core code export\n")
        out.write("# export_kind: clean-full-picture\n")
        out.write(f"# root: {ROOT}\n")
        out.write(f"# generated_at: {datetime.now().isoformat(timespec='seconds')}\n")
        out.write(f"# embedded_ignore_patterns: {len(IGNORE_PATTERNS)}\n")
        out.write(f"# file_count: {len(files)}\n\n")
        for _, rel in files:
            out.write(f"- {rel.replace(os.sep, '/')}\n")
        out.write("\n")

        for full, rel in files:
            out.write("\n" + "=" * 100 + "\n")
            out.write(f"FILE: {rel.replace(os.sep, '/')}\n")
            out.write("=" * 100 + "\n\n")
            out.write(read_text(full))
            out.write("\n")

    print(OUT)
    print(len(files))


if __name__ == "__main__":
    main()
