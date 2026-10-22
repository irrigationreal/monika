"""Small semantic SVG string builders.

These helpers deliberately produce SVG source rather than exposing an editor API.  Values
are escaped before insertion, attribute order is stable, and the functions do not parse or
execute XML.  Keep them suitable for generating a reviewable working source file.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from hashlib import sha256
from html import escape as _html_escape
from typing import Any


_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:-]*$")
_XML_CONTROL = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")


def xml_escape(value: Any) -> str:
    """Escape a value for XML, rejecting characters XML 1.0 cannot represent."""
    text = str(value)
    if _XML_CONTROL.search(text):
        raise ValueError("value contains an XML 1.0 control character")
    return _html_escape(text, quote=True)


# A short alias reads naturally at call sites that build labels and paths.
escape_xml = xml_escape


def _attrs(values: Mapping[str, Any] | None = None, extra: Mapping[str, Any] | None = None) -> str:
    merged: dict[str, Any] = {}
    if values:
        merged.update(values)
    if extra:
        merged.update(extra)
    rendered: list[str] = []
    for name in sorted(merged):
        if not _NAME.fullmatch(name):
            raise ValueError(f"invalid SVG attribute name: {name!r}")
        value = merged[name]
        if value is None:
            continue
        rendered.append(f' {name}="{xml_escape(value)}"')
    return "".join(rendered)


def _children(parts: str | Iterable[str] | None) -> str:
    if parts is None:
        return ""
    if isinstance(parts, str):
        return parts
    return "".join(str(part) for part in parts)


def _element(tag: str, attrs: Mapping[str, Any] | None = None,
             children: str | Iterable[str] | None = None,
             extra: Mapping[str, Any] | None = None) -> str:
    body = _children(children)
    rendered_attrs = _attrs(attrs, extra)
    return f"<{tag}{rendered_attrs}>{body}</{tag}>" if body else f"<{tag}{rendered_attrs}/>"


def canvas(width: int | float | str, height: int | float | str,
           children: str | Iterable[str] | None = None, *,
           view_box: str | None = None, attrs: Mapping[str, Any] | None = None,
           **extra: Any) -> str:
    """Build a complete SVG canvas with stable namespace and attribute order."""
    values: dict[str, Any] = {
        "xmlns": "http://www.w3.org/2000/svg",
        "xmlns:inkscape": "http://www.inkscape.org/namespaces/inkscape",
        "width": width,
        "height": height,
    }
    if view_box is not None:
        values["viewBox"] = view_box
    values.update(attrs or {})
    values.update(extra)
    for reserved, expected in (("xmlns", "http://www.w3.org/2000/svg"),
                               ("xmlns:inkscape", "http://www.inkscape.org/namespaces/inkscape")):
        if values[reserved] != expected:
            raise ValueError(f"{reserved} is reserved by canvas()")
    return _element("svg", values, children)


def named_layer(name: str, children: str | Iterable[str] | None = None, *,
                layer_id: str | None = None, attrs: Mapping[str, Any] | None = None,
                **extra: Any) -> str:
    """Build an explicitly named Inkscape-compatible top-level layer."""
    if layer_id is None:
        slug = re.sub(r"[^A-Za-z0-9_-]+", "-", name.strip().lower()).strip("-") or "layer"
        digest = sha256(name.encode("utf-8")).hexdigest()[:10]
        layer_id = f"layer-{slug}-{digest}"
    values: dict[str, Any] = {
        "id": layer_id,
        "inkscape:groupmode": "layer",
        "inkscape:label": name,
    }
    values.update(attrs or {})
    values.update(extra)
    if values.get("inkscape:groupmode") != "layer" or values.get("inkscape:label") != name:
        raise ValueError("named_layer() reserves Inkscape layer metadata")
    return _element("g", values, children)


# ``layer`` is the concise spelling used by most studies.
def layer(name: str, children: str | Iterable[str] | None = None, **kwargs: Any) -> str:
    return named_layer(name, children, **kwargs)


def group(children: str | Iterable[str] | None = None, *, group_id: str | None = None,
          attrs: Mapping[str, Any] | None = None, **extra: Any) -> str:
    values = dict(attrs or {})
    if group_id is not None:
        values["id"] = group_id
    values.update(extra)
    return _element("g", values, children)


def ellipse(cx: int | float | str, cy: int | float | str,
            rx: int | float | str, ry: int | float | str, *,
            attrs: Mapping[str, Any] | None = None, **extra: Any) -> str:
    values = {"cx": cx, "cy": cy, "rx": rx, "ry": ry}
    values.update(attrs or {})
    values.update(extra)
    return _element("ellipse", values)


def circle(cx: int | float | str, cy: int | float | str, r: int | float | str, *,
           attrs: Mapping[str, Any] | None = None, **extra: Any) -> str:
    values = {"cx": cx, "cy": cy, "r": r}
    values.update(attrs or {})
    values.update(extra)
    return _element("circle", values)


def line(x1: int | float | str, y1: int | float | str,
         x2: int | float | str, y2: int | float | str, *,
         attrs: Mapping[str, Any] | None = None, **extra: Any) -> str:
    values = {"x1": x1, "x2": x2, "y1": y1, "y2": y2}
    values.update(attrs or {})
    values.update(extra)
    return _element("line", values)


def path(d: str, *, attrs: Mapping[str, Any] | None = None, **extra: Any) -> str:
    values = {"d": d}
    values.update(attrs or {})
    values.update(extra)
    return _element("path", values)


def linear_gradient(gradient_id: str, stops: Iterable[tuple[Any, Any] | tuple[Any, Any, Any]], *,
                    attrs: Mapping[str, Any] | None = None, **extra: Any) -> str:
    """Build a gradient from ``(offset, color[, opacity])`` stop tuples."""
    values = {"id": gradient_id}
    values.update(attrs or {})
    values.update(extra)
    rendered_stops: list[str] = []
    for stop in stops:
        if len(stop) not in (2, 3):
            raise ValueError("gradient stops must contain offset, color, and optional opacity")
        stop_values: dict[str, Any] = {"offset": stop[0], "stop-color": stop[1]}
        if len(stop) == 3:
            stop_values["stop-opacity"] = stop[2]
        rendered_stops.append(_element("stop", stop_values))
    return _element("linearGradient", values, rendered_stops)


def defs(*children: str) -> str:
    """Wrap definitions such as gradients without interpreting their contents."""
    return _element("defs", children=children)


__all__ = [
    "canvas", "circle", "defs", "ellipse", "escape_xml", "group", "layer", "line",
    "linear_gradient", "named_layer", "path", "xml_escape",
]
