"""Validation and filesystem guards for the art-workshop commands."""

from __future__ import annotations

import base64
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable

MAX_SVG_BYTES = 20 * 1024 * 1024
MAX_EMBEDDED_BYTES = 20 * 1024 * 1024
_SAFE_RASTER_DATA = re.compile(
    r"^data:image/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$",
    re.IGNORECASE,
)
_URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE | re.DOTALL)
_EXCLUDED_DIRS = {
    ".git", ".hg", ".svn", ".bzr", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".tox", ".cache", "node_modules", ".venv", "venv",
}


class ValidationError(ValueError):
    """An input failed a deliberate safety or format check."""


def _check_reference(value: str, where: str) -> None:
    value = value.strip()
    if value.startswith("#"):
        return
    if _SAFE_RASTER_DATA.match(value):
        payload = re.sub(r"\s+", "", value.split(",", 1)[1])
        try:
            decoded = base64.b64decode(payload, validate=True)
        except Exception as exc:  # pragma: no cover - defensive decoder detail
            raise ValidationError(f"invalid embedded raster data in {where}") from exc
        if len(decoded) > MAX_EMBEDDED_BYTES:
            raise ValidationError(f"embedded raster is too large in {where}")
        return
    raise ValidationError(
        f"external SVG reference is not allowed in {where}; use a local # reference "
        "or a base64 PNG/JPEG/GIF/WebP"
    )


def validate_svg_bytes(data: bytes, source: str = "SVG") -> ET.Element:
    """Validate a self-contained SVG and return its parsed root element."""
    if len(data) > MAX_SVG_BYTES:
        raise ValidationError(f"{source} exceeds the {MAX_SVG_BYTES} byte limit")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError(f"{source} must be UTF-8") from exc

    # ElementTree is intentionally preceded by these checks: its stdlib parser is
    # not an appropriate place to accept a document type or entity declaration.
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.IGNORECASE):
        raise ValidationError(f"{source} must not contain DOCTYPE or ENTITY declarations")
    if re.search(r"<\s*(?:script|foreignObject)\b", text, re.IGNORECASE):
        raise ValidationError(f"{source} must not contain script or foreignObject elements")
    if re.search(r"@(?:import|font-face)\b", text, re.IGNORECASE):
        raise ValidationError(f"{source} must not import external CSS or fonts")

    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValidationError(f"invalid SVG XML: {exc}") from exc
    if root.tag.rsplit("}", 1)[-1].lower() != "svg":
        raise ValidationError(f"{source} root element must be svg")

    for element in root.iter():
        local = element.tag.rsplit("}", 1)[-1].lower() if isinstance(element.tag, str) else ""
        if local in {"script", "foreignobject"}:
            raise ValidationError(f"{source} contains a forbidden {local} element")
        for attr, value in element.attrib.items():
            attr_local = attr.rsplit("}", 1)[-1].lower()
            if attr_local in {"href", "src", "base", "action"}:
                _check_reference(value, f"attribute {attr}")
            if attr_local in {"style", "xml:base"}:
                if attr_local == "xml:base":
                    raise ValidationError("xml:base is not allowed")
                for match in _URL_RE.finditer(value):
                    _check_reference(match.group(2), "CSS url()")
        if element.text:
            for match in _URL_RE.finditer(element.text):
                _check_reference(match.group(2), "CSS url()")
    return root


def read_svg(path: Path) -> tuple[bytes, ET.Element]:
    if path.is_symlink():
        raise ValidationError(f"symlink input is not allowed: {path}")
    if not path.is_file():
        raise ValidationError(f"SVG input is not a regular file: {path}")
    data = path.read_bytes()
    return data, validate_svg_bytes(data, str(path))


def ensure_output_is_distinct(output: Path, inputs: Iterable[Path]) -> None:
    out = output.absolute()
    if output.exists() and output.is_symlink():
        raise ValidationError(f"refusing to replace symlink output: {output}")
    for source in inputs:
        source_abs = source.absolute()
        if out == source_abs or (output.exists() and source.exists() and os.path.samefile(output, source)):
            raise ValidationError(f"output must not overwrite source: {output}")


def ensure_safe_project(root: Path, output: Path) -> list[Path]:
    """Collect regular project files, rejecting symlinks and traversal risks."""
    if root.is_symlink() or not root.is_dir():
        raise ValidationError(f"project must be a real directory: {root}")
    root = root.resolve()
    out = output.absolute().resolve()
    if out == root or root in out.parents:
        raise ValidationError("bundle output must be outside the project directory")

    files: list[Path] = []
    def visit(directory: Path) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as exc:
            raise ValidationError(f"cannot read project directory {directory}: {exc}") from exc
        for entry in entries:
            path = Path(entry.path)
            if entry.is_symlink():
                raise ValidationError(f"symlink is not allowed in project: {path}")
            if entry.is_dir(follow_symlinks=False):
                if entry.name in _EXCLUDED_DIRS:
                    continue
                resolved = path.resolve()
                if root not in resolved.parents and resolved != root:
                    raise ValidationError(f"project path escapes root: {path}")
                visit(path)
            elif entry.is_file(follow_symlinks=False):
                files.append(path)
            else:
                raise ValidationError(f"special filesystem entry is not allowed: {path}")
    visit(root)
    return files


def excluded_dir_names() -> tuple[str, ...]:
    return tuple(sorted(_EXCLUDED_DIRS))
