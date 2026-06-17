import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

import fitz


def load_ppocr_pipe(umi_exe_path: str):
    umi_exe = Path(umi_exe_path).resolve()
    plugin_dir = umi_exe.parent
    api_path = plugin_dir / "PPOCR_api.py"
    if not umi_exe.exists():
        raise FileNotFoundError(f"Umi OCR executable not found: {umi_exe}")
    if not api_path.exists():
        raise FileNotFoundError(f"PPOCR_api.py not found beside executable: {api_path}")
    spec = importlib.util.spec_from_file_location("umi_ppocr_api", api_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load PPOCR_api from {api_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PPOCR_pipe(str(umi_exe))


def lines_from_result(result: dict) -> list[str]:
    if int(result.get("code", 0)) != 100:
        return []
    lines: list[str] = []
    for item in result.get("data", []):
        text = str(item.get("text", "")).strip()
        if text:
            lines.append(text)
    return lines


def ocr_image(ocr, image_path: Path):
    result = ocr.run(str(image_path))
    lines = lines_from_result(result)
    return {
        "text": "\n".join(lines).strip(),
        "pages": [{"page": 1, "lineCount": len(lines)}],
    }


def ocr_pdf(ocr, pdf_path: Path, dpi: int, page_hint: int | None = None, page_window: int = 4):
    doc = fitz.open(str(pdf_path))
    page_blocks: list[str] = []
    page_meta: list[dict] = []
    try:
        if page_hint is None:
            page_indexes = list(range(len(doc)))
        else:
            center = max(0, page_hint - 1)
            window = max(0, page_window)
            start = max(0, center - window)
            end = min(len(doc) - 1, center + window)
            page_indexes = list(range(start, end + 1))
        for index in page_indexes:
            page = doc.load_page(index)
            lines = []
            used_dpi = None
            last_error = None
            for candidate_dpi in [dpi, 150, 120, 96, 72]:
                try:
                    pix = page.get_pixmap(dpi=candidate_dpi, alpha=False)
                    result = ocr.runBytes(pix.tobytes("png"))
                    lines = lines_from_result(result)
                    used_dpi = candidate_dpi
                    break
                except Exception as exc:
                    last_error = exc
            if used_dpi is None:
                lines = [f"[OCR_PAGE_FAILED page={index + 1}: {type(last_error).__name__}: {last_error}]"]
            header = f"## Page {index + 1}"
            body = "\n".join(lines).strip()
            page_blocks.append(f"{header}\n{body}".strip())
            page_meta.append({"page": index + 1, "lineCount": len(lines), "dpi": used_dpi})
    finally:
        doc.close()
    return {
        "text": "\n\n".join(block for block in page_blocks if block.strip()).strip(),
        "pages": page_meta,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--umi-exe", required=True)
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--page-hint", type=int)
    parser.add_argument("--page-window", type=int, default=4)
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    ocr = load_ppocr_pipe(args.umi_exe)
    try:
        suffix = input_path.suffix.lower()
        if suffix == ".pdf":
            payload = ocr_pdf(ocr, input_path, args.dpi, args.page_hint, args.page_window)
        else:
            payload = ocr_image(ocr, input_path)
        payload.update(
            {
                "schema": "direct-chat-local-ocr/v1",
                "inputPath": str(input_path),
                "engine": "local-umi",
                "umiExePath": str(Path(args.umi_exe).resolve()),
                "pageHint": args.page_hint,
                "pageWindow": args.page_window if args.page_hint is not None else None,
            }
        )
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        try:
            ocr.exit()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        sys.exit(1)
