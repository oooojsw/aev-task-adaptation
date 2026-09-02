import json
from pathlib import Path

ROOT = Path(r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest")
MANIFEST = ROOT / "auto-evolve/runtime-state/benchmark-runs/20260722-230100-officeqa40-merge-as-opt-native-minimax27/source-skill-snapshot-manifest.json"
OUT_DIR = ROOT / "auto-evolve/进度报告/2026-08-04-OfficeQA论文统计/aev-retained-lineage-audit-input"

manifest = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
tasks = {}
for item in manifest["skills"]:
    campaign_dir = str(Path(item["sourceSkillPath"]).parents[1])
    campaign_file = Path(campaign_dir) / "campaign.json"
    campaign_id = item["id"]
    if not campaign_file.exists():
        tasks[item["id"]] = {
            "id": item["id"],
            "status": "verified_success",
            "attempts": [],
            "auditLimitation": f"No campaign.json ancestor for {item['sourceKind']}",
        }
        continue
    try:
        campaign_id = json.loads(campaign_file.read_text(encoding="utf-8-sig")).get("id", campaign_id)
    except (OSError, json.JSONDecodeError):
        pass
    attempt = {
        "attemptID": f"retained-{item['id']}",
        "campaignID": campaign_id,
        "campaignDir": campaign_dir,
        "status": "verified_success",
    }
    tasks[item["id"]] = {
        "id": item["id"],
        "status": "verified_success",
        "activeCampaignID": campaign_id,
        "activeCampaignDir": campaign_dir,
        "attempts": [attempt],
    }

OUT_DIR.mkdir(parents=True, exist_ok=True)
(OUT_DIR / "task-ledger.json").write_text(
    json.dumps({"schema": "paper-audit-synthetic-ledger/v1", "tasks": tasks}, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(json.dumps({"out": str(OUT_DIR), "tasks": len(tasks)}, ensure_ascii=False))
