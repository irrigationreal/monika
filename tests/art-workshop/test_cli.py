from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "services" / "art-workshop"
ENV = {**os.environ, "PYTHONPATH": str(PACKAGE)}


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, "-m", "art_workshop", *args], cwd=ROOT,
                          env=ENV, text=True, capture_output=True)


class ArtWorkshopTests(unittest.TestCase):
    def test_malicious_svg_is_rejected_and_failure_is_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for body in (
                '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/a.png"/></svg>',
                '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
                '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p>x</p></foreignObject></svg>',
            ):
                source = root / "input.svg"
                source.write_text(body)
                result = run_cli("render", str(source), str(root / "out.png"))
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse((root / "out.png").exists())

    def test_bundle_hashes_sources_and_excludes_caches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "project"
            project.mkdir()
            source = project / "drawing.svg"
            source.write_text("<svg/>")
            (project / ".git").mkdir()
            (project / ".git" / "secret").write_text("not source")
            archive = Path(directory) / "snapshot.tar.gz"
            result = run_cli("bundle", str(project), str(archive))
            self.assertEqual(result.returncode, 0, result.stderr)
            with tarfile.open(archive, "r:gz") as tar:
                names = tar.getnames()
                self.assertEqual(names, ["manifest.json", "project/drawing.svg"])
                manifest = json.load(tar.extractfile("manifest.json"))
            self.assertEqual(manifest["files"][0]["sha256"], hashlib.sha256(b"<svg/>").hexdigest())

    def test_bundle_rejects_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "project"
            project.mkdir()
            (project / "source.txt").write_text("source")
            os.symlink("source.txt", project / "alias.txt")
            result = run_cli("bundle", str(project), str(Path(directory) / "snapshot.tar.gz"))
            self.assertNotEqual(result.returncode, 0)

    def test_sheet_defaults_and_labels_when_pillow_is_available(self) -> None:
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is not installed in this environment")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            preview = root / "one.png"
            Image.new("RGB", (20, 10), "red").save(preview)
            output = root / "sheet.png"
            result = run_cli("sheet", str(output), str(preview))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())
            with Image.open(output) as image:
                self.assertEqual(image.size, (960, 268))

    def test_openraster_stack_reconstructs_merged_image(self) -> None:
        try:
            from PIL import Image, ImageChops
        except ImportError:
            self.skipTest("Pillow is not installed in this environment")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "layers.svg"
            source.write_text('''<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="24" height="16" viewBox="0 0 24 16">
  <defs><clipPath id="clip"><rect width="24" height="16"/></clipPath></defs>
  <g inkscape:groupmode="layer" inkscape:label="background" id="bg"><rect width="24" height="16" fill="red"/></g>
  <g inkscape:groupmode="layer" inkscape:label="foreground" id="fg"><rect x="4" y="3" width="16" height="10" fill="#0000ff" opacity="0.5" clip-path="url(#clip)"/></g>
</svg>''')
            ora = root / "layers.ora"
            result = run_cli("export-ora", str(source), str(ora))
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(ora) as archive:
                image_root = ET.fromstring(archive.read("stack.xml"))
                self.assertEqual(image_root.tag, "image")
                self.assertEqual((image_root.attrib["w"], image_root.attrib["h"]), ("24", "16"))
                children = image_root.find("stack")
                self.assertIsNotNone(children)
                names = [node.attrib["name"] for node in children]
                self.assertEqual(names, ["foreground", "background"])
                reconstructed = None
                # ORA children are topmost-first in this tool; composite reverse.
                for node in reversed(list(children)):
                    with Image.open(io.BytesIO(archive.read(node.attrib["src"]))) as layer:
                        rgba = layer.convert("RGBA")
                    reconstructed = rgba if reconstructed is None else Image.alpha_composite(reconstructed, rgba)
                with Image.open(io.BytesIO(archive.read("mergedimage.png"))) as merged:
                    self.assertIsNone(ImageChops.difference(reconstructed, merged.convert("RGBA")).getbbox())

    def test_openraster_rejects_visible_nonlayer_top_level_node(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "bad.svg"
            source.write_text('<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/><g xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:groupmode="layer" id="one"/></svg>')
            result = run_cli("export-ora", str(source), str(root / "bad.ora"))
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
