"""Rendering, contact sheets, and OpenRaster assembly."""

from __future__ import annotations

import copy
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

from .security import ValidationError, ensure_output_is_distinct, read_svg

PACKAGE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_TIMEOUT = 15
MAX_DIMENSION = 4096
INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape"
ET.register_namespace("inkscape", INKSCAPE_NS)


def checked_dimensions(width: int | None, height: int | None) -> tuple[int | None, int | None]:
    for name, value in (("width", width), ("height", height)):
        if value is not None and (value < 1 or value > MAX_DIMENSION):
            raise ValidationError(f"{name} must be between 1 and {MAX_DIMENSION}")
    return width, height


def _atomic_publish(temp: Path, output: Path, force: bool = False) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and output.is_symlink():
        raise ValidationError(f"refusing to replace symlink output: {output}")
    if output.exists() and not force:
        raise ValidationError(f"output exists; use --force to replace it: {output}")
    if output.exists() and output.is_dir():
        raise ValidationError(f"output is a directory: {output}")
    if force:
        os.replace(temp, output)
        return
    # Hard-link then unlink gives a no-overwrite publication on the same filesystem.
    try:
        os.link(temp, output)
        temp.unlink()
    except FileExistsError as exc:
        temp.unlink(missing_ok=True)
        raise ValidationError(f"output appeared during publication: {output}") from exc


def render_subprocess(
    source: Path,
    output: Path,
    width: int | None = None,
    height: int | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    force: bool = False,
) -> None:
    """Render in a bounded child process, then atomically publish the PNG."""
    checked_dimensions(width, height)
    if timeout < 1 or timeout > 120:
        raise ValidationError("timeout must be between 1 and 120 seconds")
    source = source.absolute()
    output = output.absolute()
    ensure_output_is_distinct(output, [source])
    if source.is_symlink():
        raise ValidationError(f"symlink input is not allowed: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    os.close(fd)
    temp = Path(temp_name)
    args = [sys.executable, "-m", "art_workshop.render_worker", str(source), str(temp)]
    if width is not None:
        args += ["--width", str(width)]
    if height is not None:
        args += ["--height", str(height)]
    try:
        completed = subprocess.run(
            args, cwd=PACKAGE_DIR, capture_output=True, text=True, timeout=timeout,
            check=False,
        )
        if completed.returncode:
            detail = (completed.stderr or completed.stdout).strip().splitlines()
            raise ValidationError(detail[-1] if detail else "SVG renderer failed")
        if not temp.is_file() or temp.stat().st_size == 0:
            raise ValidationError("SVG renderer produced no PNG")
        _atomic_publish(temp, output, force)
    except subprocess.TimeoutExpired as exc:
        raise ValidationError(f"SVG rendering exceeded {timeout} seconds") from exc
    finally:
        temp.unlink(missing_ok=True)


def make_sheet(inputs: list[Path], output: Path, columns: int = 3,
               cell_width: int = 320, cell_height: int = 240,
               crop: bool = False, force: bool = False) -> None:
    if not inputs:
        raise ValidationError("sheet requires at least one raster preview")
    if columns < 1 or columns > 20:
        raise ValidationError("columns must be between 1 and 20")
    if cell_width < 32 or cell_width > MAX_DIMENSION or cell_height < 32 or cell_height > MAX_DIMENSION:
        raise ValidationError("cell dimensions must be between 32 and 4096")
    ensure_output_is_distinct(output.absolute(), inputs)
    try:
        from PIL import Image, ImageDraw, ImageOps
    except ImportError as exc:
        raise ValidationError("Pillow is required for sheet") from exc
    Image.MAX_IMAGE_PIXELS = 20_000_000
    rows = (len(inputs) + columns - 1) // columns
    label_height = 28
    canvas_width, canvas_height = columns * cell_width, rows * (cell_height + label_height)
    if canvas_width > MAX_DIMENSION or canvas_height > MAX_DIMENSION:
        raise ValidationError("sheet dimensions exceed the 4096 pixel limit")
    canvas = Image.new("RGB", (canvas_width, canvas_height), "white")
    draw = ImageDraw.Draw(canvas)
    for index, path in enumerate(inputs):
        path = path.absolute()
        if path.is_symlink() or not path.is_file():
            raise ValidationError(f"preview is not a regular local file: {path}")
        try:
            with Image.open(path) as opened:
                opened.verify()
            with Image.open(path) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
                if crop:
                    image = ImageOps.fit(image, (cell_width, cell_height), method=Image.Resampling.LANCZOS)
                else:
                    image.thumbnail((cell_width, cell_height), Image.Resampling.LANCZOS)
                    fitted = Image.new("RGB", (cell_width, cell_height), "#eeeeee")
                    fitted.paste(image, ((cell_width - image.width) // 2, (cell_height - image.height) // 2))
                    image = fitted
        except Exception as exc:
            raise ValidationError(f"cannot read raster preview {path}: {exc}") from exc
        x = (index % columns) * cell_width
        y = (index // columns) * (cell_height + label_height)
        canvas.paste(image, (x, y))
        draw.text((x + 5, y + cell_height + 6), path.name[:80], fill="black")
    output = output.absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    os.close(fd)
    temp = Path(temp_name)
    try:
        canvas.save(temp, format="PNG", optimize=False)
        _atomic_publish(temp, output, force)
    finally:
        temp.unlink(missing_ok=True)


def _layer_svg(root: ET.Element, selected_index: int) -> bytes:
    clone = copy.deepcopy(root)
    tagged_index = 0
    found = False
    for child in list(clone):
        local = child.tag.rsplit("}", 1)[-1] if isinstance(child.tag, str) else ""
        is_layer = local == "g" and child.attrib.get(f"{{{INKSCAPE_NS}}}groupmode") == "layer"
        if is_layer:
            if tagged_index == selected_index:
                found = True
            else:
                clone.remove(child)
            tagged_index += 1
        elif local not in {"defs", "metadata", "title", "desc", "style"}:
            clone.remove(child)
    if not found:
        raise ValidationError("could not isolate SVG layer")
    return ET.tostring(clone, encoding="utf-8", xml_declaration=True)


def export_openraster(source: Path, output: Path, width: int | None = None,
                      height: int | None = None, timeout: int = DEFAULT_TIMEOUT,
                      force: bool = False) -> None:
    """Export explicitly tagged top-level Inkscape layers to a simple ORA file."""
    checked_dimensions(width, height)
    source = source.absolute()
    output = output.absolute()
    data, root = read_svg(source)
    ensure_output_is_distinct(output, [source])
    layers = []
    harmless = {"defs", "metadata", "title", "desc", "style"}
    for child in list(root):
        local = child.tag.rsplit("}", 1)[-1] if isinstance(child.tag, str) else ""
        if local == "g" and child.attrib.get(f"{{{INKSCAPE_NS}}}groupmode") == "layer":
            name = child.attrib.get(f"{{{INKSCAPE_NS}}}label") or child.attrib.get("id")
            if not name:
                raise ValidationError("every top-level Inkscape layer needs an inkscape:label or id")
            layers.append((name, child))
            continue
        if local in harmless:
            continue
        style = child.attrib.get("style", "").replace(" ", "").lower()
        hidden = child.attrib.get("display", "").lower() == "none" or child.attrib.get("visibility", "").lower() == "hidden" or "display:none" in style or "visibility:hidden" in style
        if not hidden:
            raise ValidationError(f"visible top-level SVG node is not an explicit Inkscape layer: {local}")
    if not layers:
        raise ValidationError("SVG has no explicitly tagged top-level Inkscape layers")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="art-workshop-ora-") as temp_dir:
        temp_root = Path(temp_dir)
        source_copy = temp_root / "source.svg"
        source_copy.write_bytes(data)
        merged = temp_root / "merged.png"
        render_subprocess(source_copy, merged, width, height, timeout, force=True)
        try:
            from PIL import Image
            with Image.open(merged) as image:
                image.load()
                image_width, image_height = image.size
        except ImportError as exc:
            raise ValidationError("Pillow is required for OpenRaster export") from exc
        layer_files: list[tuple[str, Path]] = []
        for index, (name, _element) in enumerate(layers):
            layer_svg = temp_root / f"layer-{index:04d}.svg"
            layer_svg.write_bytes(_layer_svg(root, index))
            layer_png = temp_root / f"layer-{index:04d}.png"
            render_subprocess(layer_svg, layer_png, image_width, image_height, timeout, force=True)
            layer_files.append((name, layer_png))

        # This project treats the first ORA stack child as topmost (the reverse
        # of SVG's paint order). Consumers reconstruct bottom-to-top by iterating
        # this list backwards. Keep the image dimensions on the required ORA root.
        image = ET.Element("image", {"version": "0.0.1", "w": str(image_width), "h": str(image_height), "name": source.name})
        stack = ET.SubElement(image, "stack", {"name": source.name})
        for index, (name, _) in reversed(list(enumerate(layer_files))):
            ET.SubElement(stack, "layer", {"name": name, "src": f"data/layer-{index:04d}.png"})
        stack_xml = ET.tostring(image, encoding="utf-8", xml_declaration=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
        os.close(fd)
        temp = Path(temp_name)
        try:
            with zipfile.ZipFile(temp, "w") as archive:
                archive.writestr("mimetype", "image/openraster", compress_type=zipfile.ZIP_STORED)
                archive.writestr("stack.xml", stack_xml, compress_type=zipfile.ZIP_DEFLATED)
                archive.write(merged, "mergedimage.png", compress_type=zipfile.ZIP_DEFLATED)
                for index, (_, layer_png) in enumerate(layer_files):
                    archive.write(layer_png, f"data/layer-{index:04d}.png", compress_type=zipfile.ZIP_DEFLATED)
            _atomic_publish(temp, output, force)
        finally:
            temp.unlink(missing_ok=True)
