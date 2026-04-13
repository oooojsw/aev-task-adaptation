import json
import re
import sys
from pathlib import Path

from word_text_utils import extract_word_text


NUMBER_RE = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?%?")


def load_json(path_value: str):
    with open(path_value, "r", encoding="utf-8") as fh:
        return json.load(fh)


def resolve_target(item, payload_targets):
    explicit = item.get("targetPath")
    if isinstance(explicit, str) and explicit.strip():
        return str(Path(explicit).resolve())

    label = item.get("targetLabel")
    role = item.get("targetRole")
    index = item.get("targetIndex")

    if isinstance(index, int) and 0 <= index < len(payload_targets):
        candidate = payload_targets[index]
        if isinstance(candidate, dict) and isinstance(candidate.get("path"), str):
            return str(Path(candidate["path"]).resolve())

    for candidate in payload_targets:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("path"), str):
            continue
        if label and candidate.get("label") == label:
            return str(Path(candidate["path"]).resolve())
        if role and candidate.get("role") == role:
            return str(Path(candidate["path"]).resolve())
    return None


def normalize_number_token(token: str) -> str:
    return token.replace(",", "").replace("％", "%").strip()


def extract_number_tokens(text: str, min_digits: int) -> list[str]:
    values = []
    for match in NUMBER_RE.findall(text):
        normalized = normalize_number_token(match)
        digit_count = sum(1 for char in normalized if char.isdigit())
        if digit_count < min_digits:
            continue
        values.append(normalized)
    return sorted(set(values))


def main():
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {
                    "passed": False,
                    "summary": "Missing required arguments.",
                    "details": [
                        "Usage: python validate-word-targets-against-references.py <validator-input.json> <mapping.json>"
                    ],
                    "blocking": True,
                },
                ensure_ascii=False,
            )
        )
        return 1

    payload = load_json(sys.argv[1])
    mapping_path = Path(sys.argv[2]).resolve()
    mapping = load_json(str(mapping_path))
    payload_targets = payload.get("targetPaths", [])
    pairs = mapping.get("pairs", [])

    if not isinstance(pairs, list) or not pairs:
        print(
            json.dumps(
                {
                    "passed": False,
                    "summary": "Reference mapping is empty.",
                    "details": [str(mapping_path)],
                    "blocking": True,
                },
                ensure_ascii=False,
            )
        )
        return 1

    details = []
    failed = []
    for pair in pairs:
        if not isinstance(pair, dict):
            continue
        target_path = resolve_target(pair, payload_targets)
        reference_raw = pair.get("referencePath")
        if not target_path or not isinstance(reference_raw, str) or not reference_raw.strip():
            failed.append("unresolved_pair")
            details.append(f"unresolved pair: {pair}")
            continue

        if Path(reference_raw).is_absolute():
            reference_path = str(Path(reference_raw).resolve())
        else:
            reference_path = str((mapping_path.parent / reference_raw).resolve())

        if not Path(target_path).exists():
            failed.append(f"{pair.get('label') or Path(target_path).name}:missing_target")
            details.append(f"missing target: {target_path}")
            continue
        if not Path(reference_path).exists():
            failed.append(f"{pair.get('label') or Path(reference_path).name}:missing_reference")
            details.append(f"missing reference: {reference_path}")
            continue

        target_text = extract_word_text(target_path)
        reference_text = extract_word_text(reference_path)
        min_digits = int(pair.get("minNumericDigits", 2))
        reference_numbers = extract_number_tokens(reference_text, min_digits)
        target_numbers = set(extract_number_tokens(target_text, min_digits))
        matched_numbers = [token for token in reference_numbers if token in target_numbers]
        numeric_recall = len(matched_numbers) / len(reference_numbers) if reference_numbers else 1.0

        min_numeric_recall = float(pair.get("minNumericRecall", 0.80))
        required_tokens = [
            str(token).strip()
            for token in pair.get("requiredContains", [])
            if isinstance(token, str) and str(token).strip()
        ]
        matched_required_tokens = [token for token in required_tokens if token in target_text]
        required_token_recall = len(matched_required_tokens) / len(required_tokens) if required_tokens else 1.0
        min_required_token_recall = float(pair.get("minRequiredTokenRecall", 1.0 if required_tokens else 0.0))
        label = pair.get("label") or Path(target_path).name

        details.append(
            (
                f"{label}: numeric_recall={numeric_recall:.3f}, matched_numbers={len(matched_numbers)}/{len(reference_numbers)}, "
                f"required_token_recall={required_token_recall:.3f}, matched_required_tokens={len(matched_required_tokens)}/{len(required_tokens)}"
            )
        )
        if numeric_recall < min_numeric_recall:
            failed.append(f"{label}:low_numeric_recall")
        if required_tokens and required_token_recall < min_required_token_recall:
            failed.append(f"{label}:missing_required_tokens")

    passed = not failed
    print(
        json.dumps(
            {
                "passed": passed,
                "summary": "Generated Word targets are data-consistent with the reference documents for the required filled values."
                if passed
                else "Generated Word targets are missing required filled data or do not retain enough reference-side data consistency.",
                "details": details + ([f"failed: {', '.join(failed)}"] if failed else []),
                "blocking": False,
            },
            ensure_ascii=False,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
