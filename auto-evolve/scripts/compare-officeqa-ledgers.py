from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def load(path: Path) -> dict[str, dict]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    by_id = {str(row["id"]): row for row in rows}
    if len(rows) != len(by_id):
        raise ValueError(f"duplicate ids in {path}")
    return by_id


def mcnemar_exact(left_only: int, right_only: int) -> float:
    discordant = left_only + right_only
    if discordant == 0:
        return 1.0
    tail = sum(math.comb(discordant, i) for i in range(min(left_only, right_only) + 1)) / (2**discordant)
    return min(1.0, 2 * tail)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("left", type=Path)
    parser.add_argument("right", type=Path)
    parser.add_argument("--left-name", default="left")
    parser.add_argument("--right-name", default="right")
    args = parser.parse_args()

    left = load(args.left)
    right = load(args.right)
    if set(left) != set(right):
        raise ValueError("UID sets differ")

    both = left_only = right_only = neither = 0
    for uid in sorted(left):
        left_ok = int(left[uid].get("hard", 0)) == 1
        right_ok = int(right[uid].get("hard", 0)) == 1
        if left_ok and right_ok:
            both += 1
        elif left_ok:
            left_only += 1
        elif right_ok:
            right_only += 1
        else:
            neither += 1

    result = {
        "left": args.left_name,
        "right": args.right_name,
        "n": len(left),
        "bothCorrect": both,
        "leftOnly": left_only,
        "rightOnly": right_only,
        "bothWrong": neither,
        "mcnemarExactTwoSided": mcnemar_exact(left_only, right_only),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
