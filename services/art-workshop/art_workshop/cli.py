from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .bundling import bundle_project
from .rendering import DEFAULT_TIMEOUT, export_openraster, make_sheet, render_subprocess
from .security import ValidationError

# Keep this module's parser intentionally small: the project is a one-shot tool,
# not a service or a job runner.


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="art-workshop", description="Offline SVG artwork workshop tools")
    sub = parser.add_subparsers(dest="command", required=True)

    render = sub.add_parser("render", help="render one self-contained SVG to PNG")
    render.add_argument("source", type=Path)
    render.add_argument("output", type=Path)
    render.add_argument("--width", type=int)
    render.add_argument("--height", type=int)
    render.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    render.add_argument("--force", action="store_true", help="replace an existing output explicitly")

    sheet = sub.add_parser("sheet", help="make a labeled contact sheet from local raster previews")
    sheet.add_argument("output", type=Path)
    sheet.add_argument("inputs", type=Path, nargs="+")
    sheet.add_argument("--columns", type=int, default=3)
    sheet.add_argument("--cell-width", type=int, default=320)
    sheet.add_argument("--cell-height", type=int, default=240)
    sheet.add_argument("--crop", action="store_true", help="center-crop each preview to its cell")
    sheet.add_argument("--force", action="store_true", help="replace an existing output explicitly")

    ora = sub.add_parser("export-ora", help="export explicit top-level Inkscape layers to OpenRaster")
    ora.add_argument("source", type=Path)
    ora.add_argument("output", type=Path)
    ora.add_argument("--width", type=int)
    ora.add_argument("--height", type=int)
    ora.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    ora.add_argument("--force", action="store_true", help="replace an existing output explicitly")

    bundle = sub.add_parser("bundle", help="snapshot a project directory with hashes")
    bundle.add_argument("project", type=Path)
    bundle.add_argument("output", type=Path)
    bundle.add_argument("--force", action="store_true", help="replace an existing output explicitly")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "render":
            render_subprocess(args.source, args.output, args.width, args.height, args.timeout, args.force)
        elif args.command == "sheet":
            make_sheet(args.inputs, args.output, args.columns, args.cell_width, args.cell_height, args.crop, args.force)
        elif args.command == "export-ora":
            export_openraster(args.source, args.output, args.width, args.height, args.timeout, args.force)
        elif args.command == "bundle":
            bundle_project(args.project, args.output, args.force)
        else:  # pragma: no cover - argparse enforces this
            raise ValidationError("unknown command")
        return 0
    except (ValidationError, OSError, ValueError) as exc:
        print(f"art-workshop: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
