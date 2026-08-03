#!/usr/bin/env python3
"""Hard product validator for DOCX format-transfer outputs."""

from __future__ import annotations

import argparse
import html
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


def emit(passed: bool, summary: str, details: list[str], *, failure_kind: str | None = None) -> None:
    print(
        json.dumps(
            {
                "passed": passed,
                "blocking": True,
                "summary": summary,
                "details": details,
                "failureKind": None if passed else (failure_kind or "product_failure"),
            },
            ensure_ascii=False,
        )
    )


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def resolve_path(raw: str, base: Path) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p
    return (base / p).resolve()


def resolve_oracle_path(raw: str, payload_path: Path) -> Path:
    direct = resolve_path(raw, Path.cwd())
    if direct.exists():
        return direct
    near_payload = resolve_path(raw, payload_path.parent)
    if near_payload.exists():
        return near_payload
    for parent in [Path.cwd(), *Path.cwd().parents, payload_path.parent, *payload_path.parent.parents[:8]]:
        candidate = parent / raw
        if candidate.exists():
            return candidate.resolve()
    return direct


def collect_payload_paths(value: Any, out: list[Path]) -> None:
    if isinstance(value, str):
        out.append(Path(value))
        return
    if isinstance(value, list):
        for item in value:
            collect_payload_paths(item, out)
        return
    if isinstance(value, dict):
        if isinstance(value.get("path"), str):
            out.append(Path(value["path"]))
        for item in value.values():
            collect_payload_paths(item, out)


def find_candidate(payload: dict[str, Any], payload_path: Path, explicit: str | None) -> Path | None:
    if explicit:
        p = resolve_path(explicit, payload_path.parent)
        if p.exists():
            return p
    paths: list[Path] = []
    for key in ["expectedArtifacts", "targetPaths", "editablePaths"]:
        collect_payload_paths(payload.get(key), paths)
    bundle_path = payload.get("bundlePath")
    if isinstance(bundle_path, str):
        bp = resolve_path(bundle_path, payload_path.parent)
        if bp.exists():
            try:
                bundle = read_json(bp)
                for key in ["expectedArtifacts", "targetPaths", "editablePaths"]:
                    collect_payload_paths(bundle.get(key), paths)
            except Exception:
                pass
    for parent in [payload_path.parent, *payload_path.parent.parents[:8]]:
        paths.append(parent / "workspace" / "candidate.docx")
        paths.append(parent / "workspace" / "output.docx")
        paths.append(parent / "workspace" / "answer.docx")
    seen: set[str] = set()
    for p in paths:
        candidate = p if p.is_absolute() else (payload_path.parent / p).resolve()
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        if candidate.exists() and candidate.is_file() and candidate.suffix.lower() == ".docx":
            return candidate
    return None


def read_docx_xml(docx: Path, name: str) -> ET.Element | None:
    try:
        with zipfile.ZipFile(docx) as zf:
            raw = zf.read(name)
        return ET.fromstring(raw)
    except Exception:
        return None


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


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


def document_text(docx: Path) -> str:
    root = read_docx_xml(docx, "word/document.xml")
    if root is None:
        return ""
    paragraphs = iter_paragraph_texts(root)
    return normalize_text("\n".join(paragraphs))


def comments(docx: Path) -> list[str]:
    root = read_docx_xml(docx, "word/comments.xml")
    if root is None:
        return []
    out: list[str] = []
    for comment in root.findall(".//w:comment", NS):
        parts = [node.text or "" for node in comment.findall(".//w:t", NS)]
        text = normalize_text("".join(parts))
        if text:
            out.append(text)
    return out


def image_extents(docx: Path) -> list[dict[str, int]]:
    root = read_docx_xml(docx, "word/document.xml")
    if root is None:
        return []
    out: list[dict[str, int]] = []
    for extent in root.findall(".//wp:extent", NS):
        try:
            out.append({"cx": int(extent.attrib.get("cx", "0")), "cy": int(extent.attrib.get("cy", "0"))})
        except ValueError:
            continue
    return out


def page_margins(docx: Path) -> list[dict[str, str]]:
    root = read_docx_xml(docx, "word/document.xml")
    if root is None:
        return []
    out: list[dict[str, str]] = []
    for mar in root.findall(".//w:pgMar", NS):
        item: dict[str, str] = {}
        for key in ["top", "right", "bottom", "left", "header", "footer", "gutter"]:
            value = mar.attrib.get(f"{{{NS['w']}}}{key}")
            if value is not None:
                item[key] = value
        if item:
            out.append(item)
    return out


def section_signature(docx: Path) -> list[dict[str, Any]]:
    root = read_docx_xml(docx, "word/document.xml")
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


def package_part_summary(docx: Path) -> dict[str, Any]:
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
    root = read_docx_xml(docx, "word/styles.xml")
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
    return {"doc_defaults": doc_defaults, "paragraph_styles": paragraph_styles[:160]}


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


def heading_style_info(docx: Path) -> dict[str, Any]:
    root = read_docx_xml(docx, "word/document.xml")
    styles = read_docx_xml(docx, "word/styles.xml")
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
                samples.append({"style_id": sid, "style_name": names.get(sid), "outline": outlines.get(sid), "text_hash": stable_hash(text[:160])})
    return {
        "counts": dict(counts),
        "outlines": {sid: outlines.get(sid) for sid in ["1", "2", "3"] if sid in names or sid in outlines},
        "samples": samples[:60],
    }


def usage_signature(docx: Path) -> dict[str, Any]:
    root = read_docx_xml(docx, "word/document.xml")
    styles = read_docx_xml(docx, "word/styles.xml")
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


def stable_hash(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()[:16]


def paragraph_format_samples(docx: Path, limit: int = 140) -> list[dict[str, Any]]:
    root = read_docx_xml(docx, "word/document.xml")
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
    style_sig = styles_signature(docx)
    return {
        "page_margins": page_margins(docx),
        "sections": section_signature(docx),
        "package_parts": package_part_summary(docx),
        "heading_style_info": heading_style_info(docx),
        "usage_signature": usage_signature(docx),
        "doc_defaults": style_sig["doc_defaults"],
        "paragraph_styles": style_sig["paragraph_styles"],
        "paragraph_format_samples": paragraph_format_samples(docx),
    }


def margins_close(candidate: dict[str, str], expected: dict[str, str], tolerance_ratio: float = 0.05) -> bool:
    checked = 0
    for key in ["top", "right", "bottom", "left"]:
        if key not in expected:
            continue
        try:
            actual_value = int(candidate.get(key, "-1"))
            expected_value = int(expected[key])
        except ValueError:
            return False
        if expected_value <= 0:
            continue
        checked += 1
        if abs(actual_value - expected_value) / expected_value > tolerance_ratio:
            return False
    return checked >= 2


def flatten_props(value: Any, prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            out.update(flatten_props(child, child_prefix))
    elif value is not None:
        out[prefix] = str(value)
    return out


def prop_match_ratio(actual: Any, expected: Any) -> tuple[int, int, float]:
    expected_flat = flatten_props(expected)
    actual_flat = flatten_props(actual)
    if not expected_flat:
        return 0, 0, 1.0
    matched = sum(1 for key, value in expected_flat.items() if actual_flat.get(key) == value)
    return matched, len(expected_flat), matched / len(expected_flat)


def compare_scalar_dict(actual: dict[str, Any], expected: dict[str, Any], keys: list[str]) -> tuple[int, int]:
    checked = 0
    matched = 0
    for key in keys:
        expected_value = expected.get(key)
        if expected_value is None:
            continue
        checked += 1
        if actual.get(key) == expected_value:
            matched += 1
    return matched, checked


def top_overlap(actual_items: Any, expected_items: Any, limit: int = 8) -> float:
    if not isinstance(actual_items, list) or not isinstance(expected_items, list) or not expected_items:
        return 1.0
    actual_keys = {item[0] for item in actual_items[:limit] if isinstance(item, list | tuple) and item}
    expected_keys = [item[0] for item in expected_items[:limit] if isinstance(item, list | tuple) and item]
    if not expected_keys:
        return 1.0
    return sum(1 for key in expected_keys if key in actual_keys) / len(expected_keys)


def validate_format_signature(candidate: Path, expected_signature: dict[str, Any], thresholds: dict[str, Any]) -> list[str]:
    details: list[str] = []
    actual_signature = format_signature(candidate)

    expected_margins = expected_signature.get("page_margins")
    actual_margins = actual_signature.get("page_margins")
    if isinstance(expected_margins, list) and expected_margins:
        expected_first = expected_margins[0]
        if isinstance(expected_first, dict):
            if not isinstance(actual_margins, list) or not actual_margins or not margins_close(
                actual_margins[0], {str(k): str(v) for k, v in expected_first.items()}
            ):
                details.append("candidate page margins do not match expected format signature")

    min_default = float(thresholds.get("min_doc_default_match_ratio", 0.70))
    expected_defaults = expected_signature.get("doc_defaults") if isinstance(expected_signature.get("doc_defaults"), dict) else {}
    actual_defaults = actual_signature.get("doc_defaults") if isinstance(actual_signature.get("doc_defaults"), dict) else {}
    matched, total, match_ratio = prop_match_ratio(actual_defaults, expected_defaults)
    if total >= 3 and match_ratio < min_default:
        details.append(f"document default font/paragraph formatting mismatch: {matched}/{total} ({match_ratio:.2f})")

    expected_sections = expected_signature.get("sections")
    actual_sections = actual_signature.get("sections")
    if isinstance(expected_sections, list) and expected_sections:
        if not isinstance(actual_sections, list) or not actual_sections:
            details.append("candidate missing expected section/page layout signature")
        else:
            expected_first = expected_sections[0] if isinstance(expected_sections[0], dict) else {}
            actual_first = actual_sections[0] if isinstance(actual_sections[0], dict) else {}
            page_matched, page_checked = compare_scalar_dict(
                actual_first.get("page") if isinstance(actual_first.get("page"), dict) else {},
                expected_first.get("page") if isinstance(expected_first.get("page"), dict) else {},
                ["w", "h", "orient"],
            )
            if page_checked and page_matched < page_checked:
                details.append(f"page size/orientation mismatch: {page_matched}/{page_checked}")
            expected_grid = expected_first.get("docGrid") if isinstance(expected_first.get("docGrid"), dict) else {}
            actual_grid = actual_first.get("docGrid") if isinstance(actual_first.get("docGrid"), dict) else {}
            grid_matched, grid_checked = compare_scalar_dict(actual_grid, expected_grid, list(expected_grid.keys()))
            if grid_checked and grid_matched < grid_checked:
                details.append(f"document grid mismatch: {grid_matched}/{grid_checked}")
            expected_refs = expected_first.get("header_footer_ref_count")
            if isinstance(expected_refs, int) and actual_first.get("header_footer_ref_count") != expected_refs:
                details.append(
                    f"header/footer reference count mismatch: {actual_first.get('header_footer_ref_count')}/{expected_refs}"
                )

    expected_package = expected_signature.get("package_parts")
    actual_package = actual_signature.get("package_parts")
    if isinstance(expected_package, dict) and isinstance(actual_package, dict):
        for key in ["header_parts", "footer_parts"]:
            expected_count = len(expected_package.get(key) or [])
            actual_count = len(actual_package.get(key) or [])
            if actual_count != expected_count:
                details.append(f"{key} count mismatch: {actual_count}/{expected_count}")

    expected_heading = expected_signature.get("heading_style_info")
    actual_heading = actual_signature.get("heading_style_info")
    if isinstance(expected_heading, dict) and isinstance(actual_heading, dict):
        expected_counts = expected_heading.get("counts") if isinstance(expected_heading.get("counts"), dict) else {}
        actual_counts = actual_heading.get("counts") if isinstance(actual_heading.get("counts"), dict) else {}
        for sid, expected_count in expected_counts.items():
            if actual_counts.get(sid) != expected_count:
                details.append(f"heading style {sid} count mismatch: {actual_counts.get(sid, 0)}/{expected_count}")
        expected_outlines = expected_heading.get("outlines") if isinstance(expected_heading.get("outlines"), dict) else {}
        actual_outlines = actual_heading.get("outlines") if isinstance(actual_heading.get("outlines"), dict) else {}
        for sid, expected_outline in expected_outlines.items():
            if expected_outline is not None and actual_outlines.get(sid) != expected_outline:
                details.append(f"heading style {sid} outline level mismatch: {actual_outlines.get(sid)}/{expected_outline}")

    min_style = float(thresholds.get("min_style_definition_match_ratio", 0.62))
    expected_styles_raw = expected_signature.get("paragraph_styles")
    actual_styles_raw = actual_signature.get("paragraph_styles")
    expected_styles = expected_styles_raw if isinstance(expected_styles_raw, list) else []
    actual_styles = actual_styles_raw if isinstance(actual_styles_raw, list) else []
    actual_by_id = {
        item.get("styleId"): item
        for item in actual_styles
        if isinstance(item, dict) and isinstance(item.get("styleId"), str) and item.get("styleId")
    }
    style_checked = 0
    style_matched = 0
    for expected in expected_styles:
        if not isinstance(expected, dict):
            continue
        style_id = expected.get("styleId")
        if not isinstance(style_id, str) or not style_id:
            continue
        expected_props = {"pPr": expected.get("pPr") or {}, "rPr": expected.get("rPr") or {}}
        if not flatten_props(expected_props):
            continue
        style_checked += 1
        actual = actual_by_id.get(style_id)
        if isinstance(actual, dict):
            _, prop_total, prop_ratio = prop_match_ratio(
                {"pPr": actual.get("pPr") or {}, "rPr": actual.get("rPr") or {}}, expected_props
            )
            if prop_total == 0 or prop_ratio >= min_style:
                style_matched += 1
    if style_checked >= 4:
        style_ratio = style_matched / style_checked
        if style_ratio < min_style:
            details.append(f"paragraph style definitions mismatch: {style_matched}/{style_checked} ({style_ratio:.2f})")

    min_samples = float(thresholds.get("min_paragraph_format_sample_match_ratio", 0.48))
    expected_samples_raw = expected_signature.get("paragraph_format_samples")
    actual_samples_raw = actual_signature.get("paragraph_format_samples")
    expected_samples = expected_samples_raw if isinstance(expected_samples_raw, list) else []
    actual_samples = actual_samples_raw if isinstance(actual_samples_raw, list) else []
    sample_checked = 0
    sample_matched = 0
    for expected, actual in zip(expected_samples[:100], actual_samples[:100]):
        if not isinstance(expected, dict) or not isinstance(actual, dict):
            continue
        expected_props = {"pPr": expected.get("pPr") or {}, "firstRunRPr": expected.get("firstRunRPr") or {}}
        if not flatten_props(expected_props):
            continue
        sample_checked += 1
        _, prop_total, prop_ratio = prop_match_ratio(
            {"pPr": actual.get("pPr") or {}, "firstRunRPr": actual.get("firstRunRPr") or {}}, expected_props
        )
        if prop_total == 0 or prop_ratio >= min_style:
            sample_matched += 1
    if sample_checked >= 8:
        sample_ratio = sample_matched / sample_checked
        if sample_ratio < min_samples:
            details.append(f"paragraph-level formatting samples mismatch: {sample_matched}/{sample_checked} ({sample_ratio:.2f})")

    min_usage_overlap = float(thresholds.get("min_usage_distribution_overlap", 0.55))
    expected_usage = expected_signature.get("usage_signature") if isinstance(expected_signature.get("usage_signature"), dict) else {}
    actual_usage = actual_signature.get("usage_signature") if isinstance(actual_signature.get("usage_signature"), dict) else {}
    for key in ["style_usage_top", "font_usage_top", "size_usage_top", "spacing_top", "indent_top"]:
        overlap = top_overlap(actual_usage.get(key), expected_usage.get(key))
        if overlap < min_usage_overlap:
            details.append(f"{key} distribution overlap too low: {overlap:.2f}")

    return details


def package_health(docx: Path) -> list[str]:
    details: list[str] = []
    try:
        with zipfile.ZipFile(docx) as zf:
            names = set(zf.namelist())
            required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
            missing = sorted(required - names)
            if missing:
                details.append(f"missing required DOCX package entries: {', '.join(missing)}")
            for name in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels"]:
                if name in names:
                    try:
                        ET.fromstring(zf.read(name))
                    except Exception as exc:
                        details.append(f"invalid XML entry {name}: {exc}")
            if "word/comments.xml" in names:
                try:
                    ET.fromstring(zf.read("word/comments.xml"))
                except Exception as exc:
                    details.append(f"invalid comments.xml: {exc}")
    except Exception as exc:
        details.append(f"not a readable DOCX zip: {exc}")
    return details


def ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 1.0
    return numerator / denominator


def validate(candidate: Path, oracle: dict[str, Any], audit_path: Path | None) -> tuple[bool, list[str]]:
    details: list[str] = []
    details.extend(package_health(candidate))
    text = document_text(candidate)
    if not text:
        details.append("candidate document has no readable text")

    thresholds = oracle.get("thresholds", {}) if isinstance(oracle.get("thresholds"), dict) else {}
    min_keep = float(thresholds.get("min_keep_ngram_ratio", 0.72))
    min_comment = float(thresholds.get("min_comment_keep_ratio", 0.95))
    min_image = float(thresholds.get("min_image_keep_ratio", 0.95))
    max_forbidden = int(thresholds.get("max_forbidden_reference_hits", 0))

    must_keep = ((oracle.get("source_fingerprints") or {}).get("must_keep_ngrams") or [])
    kept = 0
    for item in must_keep:
        snippet = item.get("text") if isinstance(item, dict) else None
        if isinstance(snippet, str) and snippet and snippet in text:
            kept += 1
    keep_ratio = ratio(kept, len(must_keep))
    if must_keep and keep_ratio < min_keep:
        details.append(f"source content keep ratio too low: {kept}/{len(must_keep)} ({keep_ratio:.2f})")

    forbidden = ((oracle.get("forbidden_template_content") or {}).get("reference_doc_ngrams") or [])
    hits: list[str] = []
    for item in forbidden:
        snippet = item.get("text") if isinstance(item, dict) else None
        if isinstance(snippet, str) and snippet and snippet in text:
            hits.append(snippet[:80])
            if len(hits) > max_forbidden:
                break
    if len(hits) > max_forbidden:
        details.append(f"format reference content leaked into candidate: {len(hits)} hit(s)")

    expected_comments = ((oracle.get("comments_oracle") or {}).get("comments") or [])
    actual_comments = comments(candidate)
    if expected_comments:
        comment_ratio = ratio(len(actual_comments), len(expected_comments))
        if comment_ratio < min_comment:
            details.append(
                f"comment preservation ratio too low: {len(actual_comments)}/{len(expected_comments)} ({comment_ratio:.2f})"
            )

    expected_images = ((oracle.get("images_oracle") or {}).get("source_image_extents") or [])
    actual_images = image_extents(candidate)
    if expected_images:
        image_ratio = ratio(len(actual_images), len(expected_images))
        if image_ratio < min_image:
            details.append(f"image preservation ratio too low: {len(actual_images)}/{len(expected_images)} ({image_ratio:.2f})")
    if any(item.get("cx", 0) <= 0 or item.get("cy", 0) <= 0 for item in actual_images):
        details.append("candidate contains zero-sized image extent")

    signatures = oracle.get("format_signatures") if isinstance(oracle.get("format_signatures"), dict) else {}
    expected_signature = signatures.get("gold") if isinstance(signatures.get("gold"), dict) else signatures.get("reference")
    if isinstance(expected_signature, dict):
        details.extend(validate_format_signature(candidate, expected_signature, thresholds))
    else:
        details.append("oracle missing expected DOCX format signature")

    protected = ((oracle.get("reference_policy") or {}).get("protected_tail_keywords") or [])
    missing_protected = [kw for kw in protected if isinstance(kw, str) and kw and kw not in text]
    if len(missing_protected) >= max(2, min(4, len(protected))):
        details.append(f"protected tail section keywords missing: {', '.join(missing_protected[:8])}")

    if audit_path is not None:
        if not audit_path.exists():
            details.append(f"audit.json not found: {audit_path}")
        else:
            try:
                read_json(audit_path)
            except Exception as exc:
                details.append(f"audit.json is invalid: {exc}")

    return len(details) == 0, details


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("payload")
    parser.add_argument("--oracle", required=True)
    parser.add_argument("--candidate")
    parser.add_argument("--audit")
    args = parser.parse_args(argv)

    payload_path = Path(args.payload).resolve()
    payload = read_json(payload_path)
    oracle_path = resolve_oracle_path(args.oracle, payload_path)
    if not oracle_path.exists():
        emit(False, f"Oracle not found: {oracle_path}", [str(oracle_path)], failure_kind="validator_infrastructure")
        return 1
    candidate = find_candidate(payload, payload_path, args.candidate)
    if candidate is None:
        emit(False, "candidate.docx not found", ["No .docx candidate found in payload target paths or workspace fallbacks."])
        return 0
    audit_path = resolve_path(args.audit, payload_path.parent) if args.audit else candidate.parent / "audit.json"
    passed, details = validate(candidate, read_json(oracle_path), audit_path)
    if passed:
        emit(True, "DOCX format-transfer product validation passed.", [f"candidate={candidate}"])
    else:
        emit(False, "DOCX format-transfer product validation failed.", details)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
