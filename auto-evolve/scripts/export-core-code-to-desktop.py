import os
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


def should_skip_dir(name: str) -> bool:
    return name in SKIP_DIRS


def should_keep(rel: str) -> bool:
    rel = rel.replace("\\", "/")
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
            if not should_keep(rel):
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
