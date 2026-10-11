import os
import sys
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

MANIFEST_PATH = Path(r"E:\project\SkillOpt-length-cap-runs\officeqa-clean42-length5768-minimax27-20260921\experiment-manifest.json")
KEY_PATH = Path(r"C:\Users\ZhuanZ\Desktop\minimaxkey.txt")
OUT_DIR = Path(r"E:\project\SkillOpt-length-cap-runs\officeqa-clean42-merge-as-old-length5768-minimax27-20260923")
CAP_BYTES = 5768

def get_api_key() -> str:
    lines = [l.strip() for l in KEY_PATH.read_text(encoding="utf-8").splitlines() if l.strip()]
    if len(lines) < 2:
        raise ValueError("minimaxkey.txt must have at least 2 non-empty lines")
    return lines[1]  # Approved second key (fingerprint a42b67863641)

def call_minimax(prompt: str, system: str = "", max_tokens: int = 4000, temperature: float = 0.2) -> str:
    api_key = get_api_key()
    url = "https://api.minimaxi.com/anthropic/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
    }
    messages = [{"role": "user", "content": prompt}]
    payload = {
        "model": "MiniMax-M2.7",
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature
    }
    if system:
        payload["system"] = system

    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                texts = [item.get("text", "") for item in data.get("content", []) if item.get("type") == "text"]
                res = "\n".join(texts).strip()
                if res:
                    return res
                print(f"[Warn] Empty text response (attempt {attempt+1}), raw: {data}")
        except Exception as e:
            print(f"[Warn] MiniMax API call error (attempt {attempt+1}): {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError("Failed to call MiniMax API after 5 attempts")

def read_skill_files(root: Path) -> str:
    parts = []
    for f in sorted(root.glob("**/*")):
        if f.is_file() and f.suffix in {".md", ".txt", ".json"}:
            try:
                content = f.read_text(encoding="utf-8", errors="ignore").strip()
                rel_path = f.relative_to(root).as_posix()
                parts.append(f"=== File: {rel_path} ===\n{content}\n")
            except Exception:
                pass
    return "\n".join(parts)

def main():
    print(f"Starting merge-as-old hierarchical pipeline...")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    source_packages = manifest.get("sourcePackages", [])
    print(f"Loaded {len(source_packages)} clean sources from manifest.")

    # 1. Collect sources
    sources = []
    for pkg in source_packages:
        uid = pkg["id"]
        s_root = Path(pkg["skillRoot"])
        content = read_skill_files(s_root)
        sources.append({"id": uid, "content": content})

    # System instruction adhering to AEV hierarchical-merge-generic rules
    system_prompt = (
        "You are an expert hierarchical skill merge agent for Treasury financial reasoning (OfficeQA Pro).\n"
        "Your task is to synthesize multiple case-specific skills into a unified, reusable expert methodology.\n"
        "Rules:\n"
        "1. Extract universal reasoning workflows, table lookups, and calculation rules.\n"
        "2. Retain essential domain traps: Unit Conversion (millions -> nominal dollars: multiply by 1,000,000), "
        "Denominator Selection ('percent of total bids' uses total-bids, NOT accepted-tenders), Yield-Spread calculation, etc.\n"
        "3. NEVER copy case-specific answers, numeric results, or private question texts.\n"
        "4. Structure the output clearly in markdown with actionable checklists and workflow phases."
    )

    # Level 1: 42 sources -> groups of 5 (9 groups)
    level1_dir = OUT_DIR / "phase2-hierarchical-merge" / "level-1"
    level1_dir.mkdir(parents=True, exist_ok=True)
    group_size = 5
    level1_groups = [sources[i:i + group_size] for i in range(0, len(sources), group_size)]
    print(f"Level 1: {len(sources)} sources split into {len(level1_groups)} groups.")

    level1_outputs = []
    for g_idx, group in enumerate(level1_groups):
        gid = f"level-01-group-{g_idx+1:03d}"
        g_dir = level1_dir / gid
        g_out = g_dir / "output"
        g_out.mkdir(parents=True, exist_ok=True)
        core_path = g_out / "CORE.md"

        if core_path.is_file() and core_path.stat().st_size > 50:
            print(f"[{gid}] Reusing existing group output.")
            level1_outputs.append({"id": gid, "content": core_path.read_text(encoding="utf-8")})
            continue

        print(f"[{gid}] Merging {len(group)} skills: {[item['id'] for item in group]}...")
        group_text = "\n\n".join([f"--- Source Skill ID: {item['id']} ---\n{item['content']}" for item in group])
        prompt = (
            f"# Runtime Merge Assignment: Level 1 ({gid})\n"
            f"You are merging {len(group)} source skills into a coherent group skill.\n\n"
            f"## Input Skills:\n{group_text}\n\n"
            f"Write the unified CORE.md expert guide for this group. Do not include markdown code block backticks around the entire file. Output the raw markdown document directly."
        )
        merged_text = call_minimax(prompt, system=system_prompt, max_tokens=3000)
        core_path.write_text(merged_text, encoding="utf-8")
        level1_outputs.append({"id": gid, "content": merged_text})
        print(f"[{gid}] Completed: {len(merged_text.encode('utf-8'))} bytes.")

    # Level 2: 9 Level-1 outputs -> groups of 5 (2 groups: 5 + 4)
    level2_dir = OUT_DIR / "phase2-hierarchical-merge" / "level-2"
    level2_dir.mkdir(parents=True, exist_ok=True)
    level2_groups = [level1_outputs[i:i + group_size] for i in range(0, len(level1_outputs), group_size)]
    print(f"\nLevel 2: {len(level1_outputs)} group skills split into {len(level2_groups)} groups.")

    level2_outputs = []
    for g_idx, group in enumerate(level2_groups):
        gid = f"level-02-group-{g_idx+1:03d}"
        g_dir = level2_dir / gid
        g_out = g_dir / "output"
        g_out.mkdir(parents=True, exist_ok=True)
        core_path = g_out / "CORE.md"

        if core_path.is_file() and core_path.stat().st_size > 50:
            print(f"[{gid}] Reusing existing group output.")
            level2_outputs.append({"id": gid, "content": core_path.read_text(encoding="utf-8")})
            continue

        print(f"[{gid}] Merging {len(group)} level-1 skills: {[item['id'] for item in group]}...")
        group_text = "\n\n".join([f"--- Level 1 Skill: {item['id']} ---\n{item['content']}" for item in group])
        prompt = (
            f"# Runtime Merge Assignment: Level 2 ({gid})\n"
            f"You are merging {len(group)} level-1 consolidated skills into a higher-level consolidated skill.\n"
            f"Synthesize shared patterns, eliminate redundancies, and keep all critical operational checklists.\n\n"
            f"## Input Skills:\n{group_text}\n\n"
            f"Write the unified CORE.md expert guide. Output the raw markdown document directly."
        )
        merged_text = call_minimax(prompt, system=system_prompt, max_tokens=3500)
        core_path.write_text(merged_text, encoding="utf-8")
        level2_outputs.append({"id": gid, "content": merged_text})
        print(f"[{gid}] Completed: {len(merged_text.encode('utf-8'))} bytes.")

    # Level 3: 2 Level-2 outputs -> 1 final output
    level3_dir = OUT_DIR / "phase2-hierarchical-merge" / "level-3" / "level-03-group-001"
    level3_out = level3_dir / "output"
    level3_out.mkdir(parents=True, exist_ok=True)
    final_core_path = level3_out / "CORE.md"

    print(f"\nLevel 3: Merging {len(level2_outputs)} level-2 skills into final CORE.md...")
    level3_text = "\n\n".join([f"--- Level 2 Skill: {item['id']} ---\n{item['content']}" for item in level2_outputs])
    prompt = (
        f"# Runtime Merge Assignment: Final Level 3\n"
        f"Consolidate these two overarching skills into the single final CORE.md for OfficeQA quantitative reasoning.\n"
        f"CRITICAL CONSTRAINT: The final document must be concise and dense (target under 5,000 bytes). "
        f"Preserve all vital domain rules: Unit Conversion, Denominator Selection, Yield Spread logic, and calculation verification checklist. "
        f"Avoid wordy prose or redundant explanations.\n\n"
        f"## Input Skills:\n{level3_text}\n\n"
        f"Write the final authoritative CORE.md document directly without extra backticks."
    )
    final_skill = call_minimax(prompt, system=system_prompt, max_tokens=3500)

    # Length gate check and repair loop (Hard cap: 5,768 bytes)
    current_bytes = len(final_skill.encode("utf-8"))
    print(f"Initial Level 3 CORE.md size: {current_bytes} UTF-8 bytes.")
    attempt = 0
    while current_bytes > CAP_BYTES and attempt < 5:
        attempt += 1
        print(f"[Length Cap Warning] Skill exceeds {CAP_BYTES} bytes ({current_bytes} bytes). Performing dense repair attempt {attempt}...")
        repair_prompt = (
            f"The following CORE.md has {current_bytes} UTF-8 bytes, which exceeds the mandatory hard limit of {CAP_BYTES} bytes.\n"
            f"Rewrite it to be strictly under {CAP_BYTES} UTF-8 bytes (aim for ~4,500 bytes) while retaining 100% of the operational logic:\n"
            f"- Unit Conversion Rule (PDF millions to nominal dollars)\n"
            f"- Denominator Selection Rule ('percent of total bids' uses total-bids)\n"
            f"- Yield spread formula\n"
            f"- Systematic multi-step verification checklist\n\n"
            f"Trim all wordy explanations and filler sentences.\n\n"
            f"Current Document:\n{final_skill}"
        )
        final_skill = call_minimax(repair_prompt, system=system_prompt, max_tokens=3000)
        current_bytes = len(final_skill.encode("utf-8"))
        print(f"Repaired CORE.md size: {current_bytes} UTF-8 bytes.")

    if current_bytes > CAP_BYTES:
        raise RuntimeError(f"Failed to compress final skill under {CAP_BYTES} bytes: currently {current_bytes} bytes")

    final_core_path.write_text(final_skill, encoding="utf-8")
    (level3_out / "INDEX.md").write_text("# OfficeQA Pro Expert Skill\n\nSee CORE.md for primary guidance.\n", encoding="utf-8")
    meta = {
        "schema": "auto-evolve/hierarchical-merge-meta/v1",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceCount": len(sources),
        "levels": 3,
        "capBytes": CAP_BYTES,
        "finalBytes": current_bytes
    }
    (level3_out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # Also stage in final-skill-input for bundling
    final_input_dir = OUT_DIR / "final-skill-input"
    final_input_dir.mkdir(parents=True, exist_ok=True)
    (final_input_dir / "CORE.md").write_text(final_skill, encoding="utf-8")
    (final_input_dir / "INDEX.md").write_text("# OfficeQA Pro Expert Skill\n\nSee CORE.md for primary guidance.\n", encoding="utf-8")
    (final_input_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print(f"\n[SUCCESS] Hierarchical merge completed! Final CORE.md size: {current_bytes} bytes (<= {CAP_BYTES}).")
    print(f"Staged at: {final_core_path}")

if __name__ == "__main__":
    main()
