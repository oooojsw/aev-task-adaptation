#!/usr/bin/env python3
"""Build private oracle files for DOCX format-transfer tasks.

This script is intentionally dataset-local infrastructure.  It extracts
verifiable signals from a source DOCX, a format-reference DOCX, and an optional
gold/accepted DOCX.  The generated oracle is for validators only; blank agents
must never receive these files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
}

PROTECTED_TAIL_KEYWORDS = [
    "代表性论文",
    "会议论文",
    "发明专利",
    "软件著作权",
    "软件著作权登记",
    "成果",
    "专利",
]


def read_zip_xml(docx: Path, name: str) -> ET.Element | None:
    try:
        with zipfile.ZipFile(docx) as zf:
            raw = zf.read(name)
        return ET.fromstring(raw)
    except Exception:
        return None


def iter_paragraph_texts(root: ET.Element | None) -> list[str]:
    if root is None:
        return []
    out: list[str] = []
    for paragraph in root.findall(".//w:p", NS):
        parts = [node.text or "" for node in paragraph.findall(".//w:t", NS)]
        text = normalize_text("".join(parts))
        if text:
            out.append(text)
    return out


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()[:16]


def select_ngrams(paragraphs: list[str], *, limit: int, min_len: int = 28) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for paragraph in paragraphs:
        text = normalize_text(paragraph)
        if len(text) < min_len:
            continue
        snippet = text[:160]
        key = stable_hash(snippet)
        if key in seen:
            continue
        seen.add(key)
        out.append({"hash": key, "text": snippet})
        if len(out) >= limit:
            break
    return out


def extract_comments(docx: Path) -> list[dict[str, str]]:
    root = read_zip_xml(docx, "word/comments.xml")
    if root is None:
        return []
    out: list[dict[str, str]] = []
    for comment in root.findall(".//w:comment", NS):
        cid = comment.attrib.get(f"{{{NS['w']}}}id", "")
        parts = [node.text or "" for node in comment.findall(".//w:t", NS)]
        text = normalize_text("".join(parts))
        if text:
            out.append({"id": cid, "hash": stable_hash(text), "text": text[:240]})
    return out


def extract_image_extents(root: ET.Element | None) -> list[dict[str, int]]:
    if root is None:
        return []
    out: list[dict[str, int]] = []
    for extent in root.findall(".//wp:extent", NS):
        try:
            cx = int(extent.attrib.get("cx", "0"))
            cy = int(extent.attrib.get("cy", "0"))
        except ValueError:
            continue
        out.append({"cx": cx, "cy": cy})
    return out


def extract_heading_like(paragraphs: list[str]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for text in paragraphs:
        if re.match(r"^(\d+(?:\.\d+)*|[一二三四五六七八九十]+[、.])", text) or len(text) <= 32:
            out.append({"hash": stable_hash(text), "text": text[:120]})
    return out[:120]


def extract_page_margins(root: ET.Element | None) -> list[dict[str, str]]:
    if root is None:
        return []
    out: list[dict[str, str]] = []
    for mar in root.findall(".//w:pgMar", NS):
        item = {}
        for key in ["top", "right", "bottom", "left", "header", "footer", "gutter"]:
            value = mar.attrib.get(f"{{{NS['w']}}}{key}")
            if value is not None:
                item[key] = value
        if item:
            out.append(item)
    return out


def extract_sections(root: ET.Element | None) -> list[dict[str, Any]]:
    if root is None:
        return []
    out: list[dict[str, Any]] = []
    for sect in root.findall(".//w:sectPr", NS):
        pg = sect.find("w:pgSz", NS)
        mar = sect.find("w:pgMar", NS)
        grid = sect.find("w:docGrid", NS)
        refs = [
            child.tag.split("}", 1)[-1]
            for child in list(sect)
            if child.tag.split("}", 1)[-1] in {"headerReference", "footerReference"}
        ]
        out.append(
            {
                "page": {
                    "w": pg.attrib.get(f"{{{NS['w']}}}w") if pg is not None else None,
                    "h": pg.attrib.get(f"{{{NS['w']}}}h") if pg is not None else None,
                    "orient": pg.attrib.get(f"{{{NS['w']}}}orient") if pg is not None else None,
                },
                "margins": {
                    key: mar.attrib.get(f"{{{NS['w']}}}{key}") if mar is not None else None
                    for key in ["top", "bottom", "left", "right", "header", "footer"]
                },
                "docGrid": dict(grid.attrib) if grid is not None else {},
                "header_footer_ref_count": len(refs),
            }
        )
    return out


def zip_part_summary(docx: Path) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(docx) as zf:
            names = zf.namelist()
    except Exception:
        return {"media_count": 0, "header_parts": [], "footer_parts": []}
    return {
        "media_count": len([name for name in names if name.startswith("word/media/")]),
        "header_parts": sorted(name for name in names if name.startswith("word/header")),
        "footer_parts": sorted(name for name in names if name.startswith("word/footer")),
    }


def style_names(styles: ET.Element | None) -> dict[str, str]:
    names: dict[str, str] = {}
    if styles is None:
        return names
    for style in styles.findall("w:style", NS):
        sid = style.attrib.get(f"{{{NS['w']}}}styleId")
        if not sid:
            continue
        name = style.find("w:name", NS)
        names[sid] = name.attrib.get(f"{{{NS['w']}}}val", sid) if name is not None else sid
    return names


def heading_style_info(root: ET.Element | None, styles: ET.Element | None) -> dict[str, Any]:
    names = style_names(styles)
    outlines: dict[str, str | None] = {}
    if styles is not None:
        for style in styles.findall("w:style", NS):
            sid = style.attrib.get(f"{{{NS['w']}}}styleId")
            if not sid:
                continue
            outline = style.find("w:pPr/w:outlineLvl", NS)
            outlines[sid] = outline.attrib.get(f"{{{NS['w']}}}val") if outline is not None else None
    counts: Counter[str] = Counter()
    samples: list[dict[str, str | None]] = []
    if root is not None:
        for paragraph in root.findall(".//w:p", NS):
            ppr = paragraph.find("w:pPr", NS)
            pstyle = ppr.find("w:pStyle", NS) if ppr is not None else None
            sid = pstyle.attrib.get(f"{{{NS['w']}}}val") if pstyle is not None else None
            if sid in {"1", "2", "3"}:
                counts[sid] += 1
                text = normalize_text("".join(node.text or "" for node in paragraph.findall(".//w:t", NS)))
                samples.append(
                    {
                        "style_id": sid,
                        "style_name": names.get(sid),
                        "outline": outlines.get(sid),
                        "text_hash": stable_hash(text[:160]),
                        "text": text[:100],
                    }
                )
    return {
        "counts": dict(counts),
        "outlines": {sid: outlines.get(sid) for sid in ["1", "2", "3"] if sid in names or sid in outlines},
        "samples": samples[:60],
    }


def usage_signature(root: ET.Element | None, styles: ET.Element | None) -> dict[str, Any]:
    if root is None:
        return {}
    names = style_names(styles)
    style_usage: Counter[str] = Counter()
    font_usage: Counter[str] = Counter()
    size_usage: Counter[str] = Counter()
    spacing_usage: Counter[str] = Counter()
    indent_usage: Counter[str] = Counter()
    for paragraph in root.findall(".//w:p", NS):
        ppr = paragraph.find("w:pPr", NS)
        pstyle = ppr.find("w:pStyle", NS) if ppr is not None else None
        sid = pstyle.attrib.get(f"{{{NS['w']}}}val") if pstyle is not None else None
        style_usage[names.get(sid or "", sid or "(no style)")] += 1
        spacing = ppr.find("w:spacing", NS) if ppr is not None else None
        indent = ppr.find("w:ind", NS) if ppr is not None else None
        spacing_usage[
            json.dumps(
                {k: spacing.attrib.get(f"{{{NS['w']}}}{k}") if spacing is not None else None for k in ["before", "after", "line", "lineRule"]},
                sort_keys=True,
                ensure_ascii=False,
            )
        ] += 1
        indent_usage[
            json.dumps(
                {k: indent.attrib.get(f"{{{NS['w']}}}{k}") if indent is not None else None for k in ["left", "firstLine", "hanging"]},
                sort_keys=True,
                ensure_ascii=False,
            )
        ] += 1
        for run in paragraph.findall("w:r", NS):
            rpr = run.find("w:rPr", NS)
            if rpr is None:
                continue
            fonts = child_attrs(rpr, "rFonts", ["ascii", "hAnsi", "eastAsia", "cs"])
            for key, value in fonts.items():
                font_usage[f"{key}:{value}"] += 1
            size = child_attrs(rpr, "sz", ["val"]).get("val")
            if size:
                size_usage[size] += 1
    return {
        "style_usage_top": style_usage.most_common(20),
        "font_usage_top": font_usage.most_common(20),
        "size_usage_top": size_usage.most_common(12),
        "spacing_top": spacing_usage.most_common(12),
        "indent_top": indent_usage.most_common(12),
    }


def child_attrs(node: ET.Element | None, child_name: str, keys: list[str]) -> dict[str, str]:
    if node is None:
        return {}
    child = node.find(f"w:{child_name}", NS)
    if child is None:
        return {}
    out: dict[str, str] = {}
    for key in keys:
        value = child.attrib.get(f"{{{NS['w']}}}{key}")
        if value is not None:
            out[key] = value
    return out


def flag_child(node: ET.Element | None, child_name: str) -> str | None:
    if node is None:
        return None
    child = node.find(f"w:{child_name}", NS)
    if child is None:
        return None
    value = child.attrib.get(f"{{{NS['w']}}}val")
    return value if value is not None else "true"


def rpr_signature(rpr: ET.Element | None) -> dict[str, Any]:
    if rpr is None:
        return {}
    out: dict[str, Any] = {}
    fonts = child_attrs(rpr, "rFonts", ["ascii", "hAnsi", "eastAsia", "cs"])
    if fonts:
        out["fonts"] = fonts
    for child_name, keys in [
        ("sz", ["val"]),
        ("szCs", ["val"]),
        ("color", ["val"]),
        ("highlight", ["val"]),
        ("vertAlign", ["val"]),
        ("lang", ["val", "eastAsia", "bidi"]),
    ]:
        attrs = child_attrs(rpr, child_name, keys)
        if attrs:
            out[child_name] = attrs
    for child_name in ["b", "i", "u", "strike", "smallCaps", "caps"]:
        value = flag_child(rpr, child_name)
        if value is not None:
            out[child_name] = value
    return out


def ppr_signature(ppr: ET.Element | None) -> dict[str, Any]:
    if ppr is None:
        return {}
    out: dict[str, Any] = {}
    for child_name, keys in [
        ("pStyle", ["val"]),
        ("jc", ["val"]),
        ("spacing", ["before", "after", "line", "lineRule", "beforeLines", "afterLines"]),
        ("ind", ["left", "right", "firstLine", "hanging"]),
        ("outlineLvl", ["val"]),
        ("numPr", ["val"]),
    ]:
        attrs = child_attrs(ppr, child_name, keys)
        if attrs:
            out[child_name] = attrs
    num_pr = ppr.find("w:numPr", NS)
    if num_pr is not None:
        ilvl = child_attrs(num_pr, "ilvl", ["val"])
        num_id = child_attrs(num_pr, "numId", ["val"])
        num: dict[str, Any] = {}
        if ilvl:
            num["ilvl"] = ilvl
        if num_id:
            num["numId"] = num_id
        if num:
            out["numPr"] = num
    return out


def styles_signature(docx: Path) -> dict[str, Any]:
    root = read_zip_xml(docx, "word/styles.xml")
    if root is None:
        return {"doc_defaults": {}, "paragraph_styles": []}
    defaults = root.find(".//w:docDefaults", NS)
    doc_defaults: dict[str, Any] = {}
    if defaults is not None:
        doc_defaults["rPrDefault"] = rpr_signature(defaults.find(".//w:rPrDefault/w:rPr", NS))
        doc_defaults["pPrDefault"] = ppr_signature(defaults.find(".//w:pPrDefault/w:pPr", NS))
    paragraph_styles: list[dict[str, Any]] = []
    for style in root.findall(".//w:style", NS):
        style_type = style.attrib.get(f"{{{NS['w']}}}type")
        style_id = style.attrib.get(f"{{{NS['w']}}}styleId")
        if style_type != "paragraph" or not style_id:
            continue
        name = style.find("w:name", NS)
        based_on = style.find("w:basedOn", NS)
        item: dict[str, Any] = {
            "styleId": style_id,
            "name": name.attrib.get(f"{{{NS['w']}}}val", "") if name is not None else "",
            "basedOn": based_on.attrib.get(f"{{{NS['w']}}}val", "") if based_on is not None else "",
            "qFormat": style.find("w:qFormat", NS) is not None,
            "pPr": ppr_signature(style.find("w:pPr", NS)),
            "rPr": rpr_signature(style.find("w:rPr", NS)),
        }
        if item["qFormat"] or item["pPr"] or item["rPr"] or item["name"]:
            paragraph_styles.append(item)
    return {
        "doc_defaults": doc_defaults,
        "paragraph_styles": paragraph_styles[:160],
    }


def paragraph_format_samples(root: ET.Element | None, limit: int = 140) -> list[dict[str, Any]]:
    if root is None:
        return []
    out: list[dict[str, Any]] = []
    for paragraph in root.findall(".//w:p", NS):
        parts = [node.text or "" for node in paragraph.findall(".//w:t", NS)]
        text = normalize_text("".join(parts))
        if not text:
            continue
        first_rpr = None
        for run in paragraph.findall("w:r", NS):
            first_rpr = run.find("w:rPr", NS)
            if first_rpr is not None:
                break
        out.append(
            {
                "text_hash": stable_hash(text[:160]),
                "text_len": len(text),
                "pPr": ppr_signature(paragraph.find("w:pPr", NS)),
                "firstRunRPr": rpr_signature(first_rpr),
            }
        )
        if len(out) >= limit:
            break
    return out


def format_signature(docx: Path) -> dict[str, Any]:
    root = read_zip_xml(docx, "word/document.xml")
    styles = read_zip_xml(docx, "word/styles.xml")
    paragraphs = iter_paragraph_texts(root)
    style_sig = styles_signature(docx)
    return {
        "paragraph_count": len(paragraphs),
        "heading_like": extract_heading_like(paragraphs),
        "heading_style_info": heading_style_info(root, styles),
        "image_extents": extract_image_extents(root),
        "page_margins": extract_page_margins(root),
        "sections": extract_sections(root),
        "package_parts": zip_part_summary(docx),
        "usage_signature": usage_signature(root, styles),
        "doc_defaults": style_sig["doc_defaults"],
        "paragraph_styles": style_sig["paragraph_styles"],
        "paragraph_format_samples": paragraph_format_samples(root),
    }


def build_oracle(source: Path, reference: Path, gold: Path | None) -> dict[str, Any]:
    source_root = read_zip_xml(source, "word/document.xml")
    reference_root = read_zip_xml(reference, "word/document.xml")
    gold_root = read_zip_xml(gold, "word/document.xml") if gold else None
    source_paragraphs = iter_paragraph_texts(source_root)
    reference_paragraphs = iter_paragraph_texts(reference_root)
    source_text = "\n".join(source_paragraphs)
    forbidden_reference = []
    for item in select_ngrams(reference_paragraphs, limit=160):
        if item["text"] not in source_text:
            forbidden_reference.append(item)

    return {
        "schema": "docx-format-oracle/v1",
        "source": str(source),
        "format_reference": str(reference),
        "gold": str(gold) if gold else None,
        "thresholds": {
            "min_keep_ngram_ratio": 0.65,
            "max_forbidden_reference_hits": 0,
            "min_comment_keep_ratio": 0.95,
            "min_image_keep_ratio": 0.95,
            "image_extent_tolerance_ratio": 0.08,
            "min_doc_default_match_ratio": 0.70,
            "min_style_definition_match_ratio": 0.62,
            "min_paragraph_format_sample_match_ratio": 0.48,
            "min_usage_distribution_overlap": 0.55,
        },
        "source_fingerprints": {
            "must_keep_ngrams": select_ngrams(source_paragraphs, limit=220),
            "must_keep_headings": extract_heading_like(source_paragraphs),
            "protected_tail_keywords": PROTECTED_TAIL_KEYWORDS,
        },
        "forbidden_template_content": {
            "reference_doc_ngrams": forbidden_reference,
        },
        "comments_oracle": {
            "comments": extract_comments(source),
        },
        "images_oracle": {
            "source_image_extents": extract_image_extents(source_root),
            "gold_image_extents": extract_image_extents(gold_root) if gold_root is not None else [],
        },
        "format_signatures": {
            "reference": format_signature(reference),
            "gold": format_signature(gold) if gold else None,
        },
        "reference_policy": {
            "front_reference_pile_should_not_remain_intact": True,
            "protected_tail_keywords": PROTECTED_TAIL_KEYWORDS,
            "forbid_importing_reference_doc_bibliography": True,
        },
    }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--format-reference", required=True)
    parser.add_argument("--gold")
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args(argv)

    source = Path(args.source).resolve()
    reference = Path(args.format_reference).resolve()
    gold = Path(args.gold).resolve() if args.gold else None
    out_dir = Path(args.out_dir).resolve()

    for label, file_path in [("source", source), ("format-reference", reference), ("gold", gold)]:
        if file_path is not None and not file_path.exists():
            raise SystemExit(f"{label} file not found: {file_path}")

    oracle = build_oracle(source, reference, gold)
    write_json(out_dir / "oracle.json", oracle)
    write_json(out_dir / "source-fingerprints.json", oracle["source_fingerprints"])
    write_json(out_dir / "forbidden-template-content.json", oracle["forbidden_template_content"])
    write_json(out_dir / "comments-oracle.json", oracle["comments_oracle"])
    write_json(out_dir / "images-oracle.json", oracle["images_oracle"])
    write_json(out_dir / "reference-format-signature.json", oracle["format_signatures"]["reference"])
    if oracle["format_signatures"].get("gold") is not None:
        write_json(out_dir / "gold-format-signature.json", oracle["format_signatures"]["gold"])
    write_json(out_dir / "reference-policy.json", oracle["reference_policy"])
    print(json.dumps({"passed": True, "oracle": str(out_dir / "oracle.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
