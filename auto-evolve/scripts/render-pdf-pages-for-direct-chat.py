import argparse
import json
from pathlib import Path

import fitz


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--page-hint", type=int)
    parser.add_argument("--page-window", type=int, default=1)
    parser.add_argument("--dpi", type=int, default=160)
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(input_path))
    try:
        if args.page_hint is None:
            indexes = list(range(len(doc)))
        else:
            center = max(0, args.page_hint - 1)
            window = max(0, args.page_window)
            start = max(0, center - window)
            end = min(len(doc) - 1, center + window)
            indexes = list(range(start, end + 1))

        pages = []
        for index in indexes:
            output_path = output_dir / f"page-{index + 1:04d}.png"
            if not output_path.exists():
                page = doc.load_page(index)
                pix = page.get_pixmap(dpi=args.dpi, alpha=False)
                pix.save(str(output_path))
            pages.append({"page": index + 1, "path": str(output_path)})
    finally:
        doc.close()

    print(
        json.dumps(
            {
                "schema": "direct-chat-pdf-page-images/v1",
                "inputPath": str(input_path),
                "pageHint": args.page_hint,
                "pageWindow": args.page_window if args.page_hint is not None else None,
                "dpi": args.dpi,
                "pages": pages,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
