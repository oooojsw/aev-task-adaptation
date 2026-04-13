import contextlib
import re
from pathlib import Path

try:
    import win32com.client  # type: ignore
except Exception:  # pragma: no cover
    win32com = None


WHITESPACE_RE = re.compile(r"\s+")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f]")


def normalize_text(text: str) -> str:
    text = text.replace("\r", "\n").replace("\x07", " ").replace("\u00a0", " ")
    text = CONTROL_RE.sub(" ", text)
    text = WHITESPACE_RE.sub(" ", text)
    return text.strip()


@contextlib.contextmanager
def word_application():
    if win32com is None:
        raise RuntimeError("win32com is not available for Word text extraction.")
    app = win32com.client.DispatchEx("Word.Application")
    app.Visible = False
    app.DisplayAlerts = 0
    try:
        yield app
    finally:
        try:
            app.Quit(False)
        except Exception:
            pass


def extract_word_text(path_value: str, app=None) -> str:
    source = str(Path(path_value).resolve())
    if app is not None:
        doc = app.Documents.Open(source, False, True)
        try:
            return normalize_text(doc.Content.Text or "")
        finally:
            doc.Close(False)

    with word_application() as local_app:
        return extract_word_text(source, local_app)
