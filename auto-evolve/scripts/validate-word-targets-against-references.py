import json
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

from word_text_utils import extract_word_text, normalize_text


NUMBER_RE = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?%?")
STRICT_NUMBER_RE = re.compile(r"^[-+]?\d[\d,]*(?:\.\d+)?%?$")
NUMERIC_TRANSLATION = str.maketrans(
    {
        "，": ",",
        "％": "%",
        "\uff05": "%",
        "﹪": "%",
        " ": "",
    }
)


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
    return token.strip().translate(NUMERIC_TRANSLATION)


def canonicalize_numeric_token(token: str) -> str | None:
    normalized = normalize_number_token(token)
    if not normalized:
        return None
    is_percent = normalized.endswith("%")
    number_part = normalized[:-1] if is_percent else normalized
    try:
        decimal_value = Decimal(number_part)
    except InvalidOperation:
        return None
    canonical = format(decimal_value.normalize(), "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    if canonical == "-0":
        canonical = "0"
    return f"{canonical}%" if is_percent else canonical


def is_strict_numeric_token(token: str) -> bool:
    return bool(STRICT_NUMBER_RE.fullmatch(token.strip()))


def extract_number_tokens(text: str, min_digits: int) -> list[str]:
    values = []
    for match in NUMBER_RE.findall(text):
        normalized = normalize_number_token(match)
        digit_count = sum(1 for char in normalized if char.isdigit())
        if digit_count < min_digits:
            continue
        canonical = canonicalize_numeric_token(normalized)
        if canonical is None:
            continue
        values.append(canonical)
    return sorted(set(values))


def contains_expected_token(token: str, normalized_target_text: str, target_numbers: set[str]) -> bool:
    normalized_token = token.strip()
    if not normalized_token:
        return False
    if is_strict_numeric_token(normalized_token):
        canonical = canonicalize_numeric_token(normalized_token)
        return canonical in target_numbers if canonical is not None else False
    return normalize_text(normalized_token) in normalized_target_text


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
        if not target_path:
            failed.append("unresolved_pair")
            details.append(f"unresolved pair: {pair}")
            continue

        if not Path(target_path).exists():
            failed.append(f"{pair.get('label') or Path(target_path).name}:missing_target")
            details.append(f"missing target: {target_path}")
            continue

        try:
            target_text = extract_word_text(target_path)
        except RuntimeError as exc:
            failed.append(f"{pair.get('label') or Path(target_path).name}:unreadable_target")
            details.append(f"cannot extract text from target {target_path}: {exc}")
            continue
        normalized_target_text = normalize_text(target_text)
        min_digits = int(pair.get("minNumericDigits", 2))
        target_numbers = set(extract_number_tokens(target_text, min_digits))

        required_tokens = [
            str(token).strip()
            for token in pair.get("requiredContains", [])
            if isinstance(token, str) and str(token).strip()
        ]
        matched_required_tokens = [
            token for token in required_tokens if contains_expected_token(token, normalized_target_text, target_numbers)
        ]
        required_token_recall = len(matched_required_tokens) / len(required_tokens) if required_tokens else 1.0
        min_required_token_recall = float(pair.get("minRequiredTokenRecall", 1.0 if required_tokens else 0.0))

        reference_numbers: list[str] = []
        reference_raw = pair.get("referencePath")
        label = pair.get("label") or Path(target_path).name
        numeric_basis_label = "required_tokens"

        if isinstance(reference_raw, str) and reference_raw.strip():
            if Path(reference_raw).is_absolute():
                reference_path = str(Path(reference_raw).resolve())
            else:
                reference_path = str((mapping_path.parent / reference_raw).resolve())

            if not Path(reference_path).exists():
                failed.append(f"{label}:missing_reference")
                details.append(f"missing reference: {reference_path}")
                continue

            try:
                reference_text = extract_word_text(reference_path)
                reference_numbers = extract_number_tokens(reference_text, min_digits)
                numeric_basis_label = "reference_document"
            except RuntimeError as exc:
                details.append(f"{label}: reference extraction skipped ({exc})")

        required_numeric_tokens = [
            canonical
            for token in required_tokens
            if is_strict_numeric_token(token)
            for canonical in [canonicalize_numeric_token(token)]
            if canonical is not None
        ]
        numeric_basis = reference_numbers or required_numeric_tokens
        matched_numbers = [token for token in numeric_basis if token in target_numbers]
        numeric_recall = len(matched_numbers) / len(numeric_basis) if numeric_basis else 1.0
        min_numeric_recall = float(pair.get("minNumericRecall", 0.80))

        details.append(
            (
                f"{label}: numeric_recall={numeric_recall:.3f}, matched_numbers={len(matched_numbers)}/{len(numeric_basis)}, "
                f"numeric_basis={numeric_basis_label if reference_numbers else 'required_tokens'}, "
                f"required_token_recall={required_token_recall:.3f}, matched_required_tokens={len(matched_required_tokens)}/{len(required_tokens)}, "
                f"expected_tokens={required_tokens}, "
                f"found_numbers={sorted(target_numbers)}, "
                f"missing_tokens={[t for t in required_tokens if t not in matched_required_tokens]}"
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
                "summary": "Generated Word targets contain the required task values and match the configured numeric baseline."
                if passed
                else "Generated Word targets are missing required task values or numeric consistency checks.",
                "details": details + ([f"failed: {', '.join(failed)}"] if failed else []),
                "blocking": False,
            },
            ensure_ascii=False,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
