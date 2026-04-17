import sys
import json
import zipfile
import re
from pathlib import Path

NUMBER_RE = re.compile(r"[\d,]+(?:\.\d+)?")

def normalize_number_token(token):
    return token.replace(",", "").replace("％", "%").strip()

def extract_number_tokens(text, min_digits=2):
    values = []
    for match in NUMBER_RE.findall(text):
        normalized = normalize_number_token(match)
        digit_count = sum(1 for char in normalized if char.isdigit())
        if digit_count < min_digits:
            continue
        values.append(normalized)
    return sorted(set(values))

def extract_text_from_docx(path):
    with zipfile.ZipFile(path, 'r') as z:
        with z.open('word/document.xml') as f:
            return f.read().decode('utf-8')

def resolve_target(item, payload_targets):
    explicit = item.get("targetPath")
    if isinstance(explicit, str) and explicit.strip():
        return str(Path(explicit).resolve())
    label = item.get("label")
    for candidate in payload_targets:
        if not isinstance(candidate, dict):
            continue
        if label and candidate.get("label") == label:
            return str(Path(candidate["path"]).resolve())
    return None

# Load mapping
mapping_path = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\configs\reference-mapping.json"
with open(mapping_path, 'r', encoding='utf-8') as f:
    mapping = json.load(f)

payload_targets = [
    {"path": r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-report.docx", "label": "generated report"},
    {"path": r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs\generated-explanation.docx", "label": "generated explanation"}
]

pairs = mapping.get("pairs", [])

print("=== Validation Results ===\n")

details = []
failed = []

for pair in pairs:
    target_path = resolve_target(pair, payload_targets)
    reference_path = pair.get("referencePath")
    label = pair.get("label") or "unknown"
    
    print(f"Label: {label}")
    print(f"  Target: {target_path}")
    
    if not target_path:
        print("  Result: TARGET UNRESOLVED")
        failed.append(f"{label}:unresolved_target")
        continue
    
    target_text = extract_text_from_docx(target_path)
    
    min_digits = int(pair.get("minNumericDigits", 2))
    target_numbers = set(extract_number_tokens(target_text, min_digits))
    
    required_tokens = [str(token).strip() for token in pair.get("requiredContains", []) if isinstance(token, str) and str(token).strip()]
    matched_required_tokens = [token for token in required_tokens if token in target_text]
    required_token_recall = len(matched_required_tokens) / len(required_tokens) if required_tokens else 1.0
    
    print(f"  Required tokens: {required_tokens}")
    print(f"  Matched required tokens: {matched_required_tokens}")
    print(f"  Required token recall: {required_token_recall:.3f} ({len(matched_required_tokens)}/{len(required_tokens)})")
    
    if required_tokens and required_token_recall < 1.0:
        failed.append(f"{label}:missing_required_tokens")
        print(f"  FAIL: missing required tokens")
    else:
        print(f"  PASS")
    print()

print(f"\n=== Summary ===")
print(f"Failed: {failed}")
