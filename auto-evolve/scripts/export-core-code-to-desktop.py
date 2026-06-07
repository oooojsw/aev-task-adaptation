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
    "frontend",
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
    # Keep these real reusable configs even though they match broad config rules.
    "!scripts/formal-config.json",
    "!scripts/formal-surface-generalization.json",
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
    if base in INCLUDE_FILES:
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
