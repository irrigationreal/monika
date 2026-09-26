"""Private bounded render child; invoke through ``art-workshop render``."""

from __future__ import annotations

import argparse
from pathlib import Path

from .security import ValidationError, read_svg
from .rendering import checked_dimensions


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    args = parser.parse_args(argv)
    try:
        width, height = checked_dimensions(args.width, args.height)
        data, _ = read_svg(args.source)
        try:
            import cairosvg
        except ImportError as exc:
            raise ValidationError("CairoSVG is required for render") from exc
        args.output.parent.mkdir(parents=True, exist_ok=True)
        cairosvg.svg2png(
            bytestring=data,
            write_to=str(args.output),
            output_width=width,
            output_height=height,
            unsafe=False,
        )
        if not args.output.is_file() or args.output.stat().st_size == 0:
            raise ValidationError("CairoSVG produced no output")
        return 0
    except (ValidationError, OSError, ValueError) as exc:
        print(f"art-workshop: {exc}", flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
