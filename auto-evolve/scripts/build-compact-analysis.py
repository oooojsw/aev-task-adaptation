from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

SOURCE_ROOT = Path(r"C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-flat-docs")
OUTPUT_FILE = Path(r"C:\Users\ZhuanZ\Desktop\try4-expert-bootstrap-flat-docs\ALL_ANALYSIS_COMPACT.md")

LIST_LIMIT = 4
WORKING_MEMORY_LIMIT = 5
TREE_HOTSPOT_LIMIT = 8


def read_flat_payload(path: Path) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) <= 6:
        return ""
    return "\n".join(lines[6:]).strip()


def load_flat_json(path: Path):
    payload = read_flat_payload(path)
    return json.loads(payload) if payload else None


def normalize(text) -> str:
    if text is None:
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()


def truncate(text, max_len: int = 180) -> str:
    clean = normalize(text)
    if len(clean) <= max_len:
        return clean
    if max_len <= 1:
        return clean[:1]
    return clean[: max_len - 1].rstrip() + "…"


def unique_limited(items, limit: int, max_len: int = 180) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items or []:
        text = truncate(item, max_len)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= limit:
            break
    return out or ["none"]


def field_from_markdown(text: str, field: str) -> str:
    match = re.search(rf"(?m)^\-\s*{re.escape(field)}:\s*(.+)$", text)
    return normalize(match.group(1)) if match else ""


def section_items(text: str, heading: str, limit: int = 4, max_len: int = 180) -> list[str]:
    match = re.search(
        rf"(?ms)^##\s+{re.escape(heading)}\s*\r?\n(?P<body>.*?)(?=^##\s+|\Z)",
        text,
    )
    if not match:
        return []
    items = []
    for raw_line in match.group("body").splitlines():
        line = raw_line.strip()
        if line.startswith("- "):
            items.append(truncate(line[2:].strip(), max_len))
    return unique_limited(items, limit, max_len)


def format_cmd(outcome) -> str:
    unit = outcome.get("unitID") or outcome.get("unitId") or "unknown"
    attempt = outcome.get("attempt") or "na"
    success_count = len(outcome.get("successCommands") or [])
    fail_count = len(outcome.get("failedCommands") or [])
    return f"{unit}#{attempt} (+{success_count}/-{fail_count})"


def counts_by(items, key: str) -> str:
    counter = Counter(normalize(item.get(key) or "unknown") for item in items or [])
    return ", ".join(f"{name}={count}" for name, count in sorted(counter.items()))


def top_items(items, kind: str, limit: int = WORKING_MEMORY_LIMIT):
    filtered = [item for item in items or [] if item.get("kind") == kind]
    filtered.sort(
        key=lambda item: (
            item.get("evidenceCount", 0),
            item.get("lastSeenRound", 0),
        ),
        reverse=True,
    )
    return filtered[:limit]


def parse_round_number(path: Path) -> int | None:
    match = re.match(r"^r(\d{3})_", path.name)
    return int(match.group(1)) if match else None


def main() -> None:
    if not SOURCE_ROOT.exists():
        raise FileNotFoundError(f"Source root not found: {SOURCE_ROOT}")

    files = [p for p in SOURCE_ROOT.iterdir() if p.is_file() and re.match(r"^r\d{3}_", p.name)]

    campaign_file = next((p for p in files if re.match(r"^r000_.*__campaign\.json$", p.name)), None)
    tree_file = next((p for p in files if re.match(r"^r000_.*__exploration-tree\.json$", p.name)), None)
    memory_file = next((p for p in files if re.match(r"^r000_.*__campaign-working-memory\.json$", p.name)), None)
    if not campaign_file or not tree_file or not memory_file:
        raise FileNotFoundError("Missing one or more root campaign files.")

    campaign = load_flat_json(campaign_file)
    tree = load_flat_json(tree_file)
    memory = load_flat_json(memory_file)

    round_map: dict[int, dict] = {}
    for path in files:
        round_num = parse_round_number(path)
        if round_num is None:
            continue
        if round_num == 0:
            continue
        entry = round_map.setdefault(round_num, {})
        if path.name.endswith("__round-summary.md"):
            entry["summary_text"] = read_flat_payload(path)
        elif path.name.endswith("__run-trace-digest.json"):
            entry["digest"] = load_flat_json(path)

    tree_status_counts = Counter(normalize(node.get("status") or "unknown") for node in tree.get("nodes", []))
    memory_kind_counts = Counter(normalize(item.get("kind") or "unknown") for item in memory.get("items", []))

    top_tree_nodes = sorted(
        tree.get("nodes", []),
        key=lambda node: (node.get("attemptCount", 0), node.get("lastUpdatedRound", 0)),
        reverse=True,
    )[:TREE_HOTSPOT_LIMIT]

    real_blockers = top_items(memory.get("items", []), "real_blocker")
    stable_facts = top_items(memory.get("items", []), "stable_fact")
    validated_methods = top_items(memory.get("items", []), "validated_method")
    package_gaps = top_items(memory.get("items", []), "package_gap")
    forbidden_paths = top_items(memory.get("items", []), "forbidden_path")

    out: list[str] = []
    out.append("# Try4 Expert Bootstrap Compact Analysis")
    out.append("")
    out.append(f"Source: {SOURCE_ROOT}")
    out.append(f"Captured rounds: {sum(1 for p in files if p.name.endswith('__round-summary.md'))}")
    out.append(f"Generated rounds: {len(round_map)}")
    out.append("")

    out.append("## Campaign Snapshot")
    out.append(f"id: {campaign.get('id')}")
    out.append(f"title: {campaign.get('title')}")
    out.append(f"status: {campaign.get('status')}")
    out.append(f"mode: {campaign.get('mode')}")
    out.append(f"currentRound: {campaign.get('currentRound')}")
    out.append(f"tree.updatedThroughRound: {tree.get('updatedThroughRound')}")
    out.append(f"tree.currentPhase: {tree.get('currentPhase')}")
    out.append(f"lastSummary: {truncate(campaign.get('lastSummary'), 220)}")
    out.append(f"createdAt: {campaign.get('createdAt')}")
    out.append(f"updatedAt: {campaign.get('updatedAt')}")
    out.append("")

    out.append("## Tree Snapshot")
    out.append(f"nodes: {len(tree.get('nodes', []))}")
    out.append(f"statusCounts: {counts_by(tree.get('nodes', []), 'status')}")
    out.append(f"frontierRegions: {' | '.join(unique_limited(tree.get('frontierRegions', []), 5, 140))}")
    out.append("")
    out.append("Tree hotspots:")
    for node in top_tree_nodes:
        notes = node.get("notes") or []
        note_text = ""
        if notes:
            note_text = " | notes=" + "; ".join(unique_limited(notes, 2, 120))
        out.append(
            "- "
            + f"{node.get('region')} | status={node.get('status')} | attempts={node.get('attemptCount')} | "
            + f"success={node.get('successCount')} | fail={node.get('failCount')} | "
            + f"lastRound={node.get('lastUpdatedRound')} | summary={truncate(node.get('summary'), 180)}{note_text}"
        )
    out.append("")

    out.append("## Working Memory Snapshot")
    out.append(f"items: {len(memory.get('items', []))}")
    out.append(f"kinds: {counts_by(memory.get('items', []), 'kind')}")
    out.append("")

    out.append("Real blockers:")
    if real_blockers:
        for item in real_blockers:
            out.append(f"- {truncate(item.get('statement'), 180)}")
    else:
        out.append("- none")
    out.append("")

    out.append("Stable facts:")
    if stable_facts:
        for item in stable_facts:
            out.append(
                "- "
                + f"{truncate(item.get('statement'), 180)} | evidence={item.get('evidenceCount')} | "
                + f"rounds={item.get('firstSeenRound')}-{item.get('lastSeenRound')}"
            )
    else:
        out.append("- none")
    out.append("")

    out.append("Validated methods:")
    if validated_methods:
        for item in validated_methods:
            out.append(
                "- "
                + f"{truncate(item.get('statement'), 180)} | evidence={item.get('evidenceCount')} | "
                + f"rounds={item.get('firstSeenRound')}-{item.get('lastSeenRound')}"
            )
    else:
        out.append("- none")
    out.append("")

    out.append("Package gaps:")
    if package_gaps:
        for item in package_gaps:
            out.append(
                "- "
                + f"{truncate(item.get('statement'), 180)} | evidence={item.get('evidenceCount')} | "
                + f"rounds={item.get('firstSeenRound')}-{item.get('lastSeenRound')}"
            )
    else:
        out.append("- none")
    out.append("")

    out.append("Forbidden paths:")
    if forbidden_paths:
        for item in forbidden_paths:
            out.append(
                "- "
                + f"{truncate(item.get('statement'), 180)} | evidence={item.get('evidenceCount')} | "
                + f"rounds={item.get('firstSeenRound')}-{item.get('lastSeenRound')}"
            )
    else:
        out.append("- none")
    out.append("")

    out.append("## Round Timeline")
    for round_num in sorted(round_map):
        entry = round_map[round_num]
        summary_text = entry.get("summary_text", "")
        digest = entry.get("digest") or {}

        mode = field_from_markdown(summary_text, "mode")
        status = digest.get("finalStatus") or field_from_markdown(summary_text, "status") or "unknown"
        summary = digest.get("summary") or field_from_markdown(summary_text, "summary") or ""
        failure_packets = field_from_markdown(summary_text, "failure_packets") or "na"
        retry_lessons = field_from_markdown(summary_text, "retry_lessons") or "na"
        learning_units = field_from_markdown(summary_text, "learning_units") or "na"

        out.append("")
        out.append(f"## Round {round_num:03d}")
        out.append(f"status: {status}")
        if mode:
            out.append(f"mode: {mode}")
        out.append(f"summary: {truncate(summary, 220)}")
        out.append(f"packets/retries/learning: {failure_packets}/{retry_lessons}/{learning_units}")

        explored = unique_limited(digest.get("exploredRegions", []), LIST_LIMIT, 160)
        success = unique_limited(digest.get("keySuccessPaths", []), LIST_LIMIT, 180)
        failure = unique_limited(digest.get("keyFailurePaths", []), LIST_LIMIT, 180)
        blockers = unique_limited(digest.get("blockers", []), LIST_LIMIT, 180)
        carryover = unique_limited(section_items(summary_text, "Retry Strategy Carryover", LIST_LIMIT, 180), LIST_LIMIT, 180)
        gaps = unique_limited(digest.get("packageGaps", []), LIST_LIMIT, 180)
        validated = unique_limited(digest.get("validatedMethods", []), 2, 180)
        commands = unique_limited([format_cmd(item) for item in digest.get("commandOutcomes", [])], 6, 180)

        out.append(f"explored: {' | '.join(explored)}")
        out.append(f"success: {' | '.join(success)}")
        out.append(f"failure: {' | '.join(failure)}")
        out.append(f"blockers: {' | '.join(blockers)}")
        out.append(f"carryover: {' | '.join(carryover)}")
        out.append(f"gaps: {' | '.join(gaps)}")
        out.append(f"validated: {' | '.join(validated)}")
        out.append(f"commands: {' | '.join(commands)}")

    OUTPUT_FILE.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"Wrote compact analysis to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
