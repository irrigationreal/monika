from __future__ import annotations

import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "art-workshop"))

from art_workshop.svg import (  # noqa: E402
    canvas,
    circle,
    defs,
    ellipse,
    escape_xml,
    group,
    layer,
    line,
    linear_gradient,
    named_layer,
    path,
)


class SemanticSvgTests(unittest.TestCase):
    def test_xml_escaping_covers_text_and_attribute_delimiters(self) -> None:
        self.assertEqual(escape_xml('a&<b>"\''), "a&amp;&lt;b&gt;&quot;&#x27;")
        with self.assertRaises(ValueError):
            escape_xml("bad\x00label")

        self.assertIn('inkscape:label="A &amp; &quot;study&quot;"', layer('A & "study"'))

    def test_canvas_output_is_deterministic(self) -> None:
        children = [circle(2, 3, 1, fill="red"), line(0, 0, 4, 4, stroke="#000")]
        expected = canvas(10, 20, children, view_box="0 0 10 20")
        self.assertEqual(expected, canvas(10, 20, children, view_box="0 0 10 20"))
        self.assertTrue(expected.startswith("<svg "))
        self.assertTrue(expected.endswith("</svg>"))

    def test_named_layers_have_stable_ids_and_layer_metadata(self) -> None:
        self.assertIn('id="layer-sky-study-', named_layer("Sky study"))
        self.assertNotEqual(named_layer("A B"), named_layer("A-B"))
        self.assertIn('id="foreground-v2"', layer("Foreground", layer_id="foreground-v2"))
        self.assertIn('inkscape:groupmode="layer"', layer("Foreground"))
        self.assertIn('inkscape:label="Foreground"', layer("Foreground"))
        with self.assertRaises(ValueError):
            canvas(10, 20, xmlns="not-svg")
        with self.assertRaises(ValueError):
            named_layer("Foreground", **{"inkscape:groupmode": "group"})

    def test_shape_group_and_definition_helpers(self) -> None:
        gradient = linear_gradient("wash", [("0%", "#fff"), ("100%", "#000", "0.5")])
        source = canvas(
            100,
            80,
            [defs(gradient), group([ellipse(10, 20, 4, 5), path("M 0 0 L 2 2")], group_id="marks")],
        )
        self.assertIn('<linearGradient id="wash">', source)
        self.assertIn('stop-color="#fff"', source)
        self.assertIn('stop-opacity="0.5"', source)
        self.assertIn('<g id="marks">', source)
        self.assertIn('<ellipse cx="10" cy="20" rx="4" ry="5"/>', source)
        self.assertIn('<path d="M 0 0 L 2 2"/>', source)


if __name__ == "__main__":
    unittest.main()
