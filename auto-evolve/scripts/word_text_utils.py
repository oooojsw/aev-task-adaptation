import re
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


WHITESPACE_RE = re.compile(r"\s+")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f]")
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
TEXT_TAG = f"{{{WORD_NS}}}t"
TAB_TAG = f"{{{WORD_NS}}}tab"
PARAGRAPH_TAG = f"{{{WORD_NS}}}p"
BREAK_TAGS = {
    f"{{{WORD_NS}}}br",
    f"{{{WORD_NS}}}cr",
}
SKIP_XML_NAMES = {
    "word/fontTable.xml",
    "word/numbering.xml",
    "word/settings.xml",
    "word/styles.xml",
    "word/webSettings.xml",
}
PREFERRED_PREFIXES = (
    "word/document.xml",
    "word/header",
    "word/footer",
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml",
)
SUPPORTED_DOCX_SUFFIXES = {".docx", ".docm", ".dotx", ".dotm"}


def normalize_text(text: str) -> str:
    text = text.replace("\r", "\n").replace("\x07", " ").replace("\u00a0", " ")
    text = CONTROL_RE.sub(" ", text)
    text = WHITESPACE_RE.sub(" ", text)
    return text.strip()


def iter_docx_members(package: ZipFile) -> list[str]:
    names = [
        name
        for name in package.namelist()
        if name.startswith("word/") and name.endswith(".xml") and name not in SKIP_XML_NAMES
    ]

    ordered: list[str] = []
    for prefix in PREFERRED_PREFIXES:
        for name in names:
            if name.startswith(prefix) and name not in ordered:
                ordered.append(name)
    for name in names:
        if name not in ordered:
            ordered.append(name)
    return ordered


def paragraph_text(paragraph: ET.Element) -> str:
    chunks: list[str] = []
    for node in paragraph.iter():
        if node.tag == TEXT_TAG and node.text:
            chunks.append(node.text)
        elif node.tag == TAB_TAG:
            chunks.append(" ")
        elif node.tag in BREAK_TAGS:
            chunks.append("\n")
    return "".join(chunks)


def extract_docx_text(source: str) -> str:
    paragraphs: list[str] = []
    try:
        with ZipFile(source) as package:
            for member in iter_docx_members(package):
                try:
                    root = ET.fromstring(package.read(member))
                except ET.ParseError:
                    continue
                for paragraph in root.iter(PARAGRAPH_TAG):
                    text = paragraph_text(paragraph)
                    if text.strip():
                        paragraphs.append(text)
    except BadZipFile as exc:
        raise RuntimeError(f"Invalid DOCX package: {source}") from exc

    if not paragraphs:
        return ""
    return normalize_text("\n".join(paragraphs))


def extract_word_text(path_value: str, app=None) -> str:
    if app is not None:
        raise RuntimeError("Word COM automation is disabled for headless extraction.")

    source = str(Path(path_value).resolve())
    suffix = Path(source).suffix.lower()
    if suffix in SUPPORTED_DOCX_SUFFIXES:
        return extract_docx_text(source)
    raise RuntimeError(f"Unsupported Word format for headless extraction: {suffix or source}")
