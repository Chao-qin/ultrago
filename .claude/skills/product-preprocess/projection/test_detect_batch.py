import io
import json
import unittest
from unittest.mock import patch

from PIL import Image

import detect
from detect import DetectorUnavailable, detect_montage
from vision_montage import build_montages


def image():
    out = io.BytesIO()
    Image.new("RGB", (800, 800), (20, 30, 40)).save(out, "JPEG")
    return out.getvalue()


class BatchDetectTests(unittest.TestCase):
    def task(self):
        return build_montages([(image(), "/images/main/0"), (image(), "/images/detail/0")])[0]

    def test_expands_results_to_original_fields(self):
        response = {"images": [
            {"slot": 1, "hasOverlay": True, "items": [{"text": "微信", "kind": "contact"}]},
            {"slot": 2, "hasOverlay": False, "items": []},
        ]}
        with patch.object(detect, "_run_detector", return_value=json.dumps(response)):
            findings = detect_montage(self.task())
        self.assertEqual([(f.field, f.kind, f.evidence) for f in findings],
                         [("/images/main/0", "contact", "微信")])

    def test_missing_duplicate_unknown_slots_fail_closed(self):
        for response in (
            {"images": [{"slot": 1, "hasOverlay": False, "items": []}]},
            {"images": [{"slot": 1, "hasOverlay": False, "items": []}, {"slot": 1, "hasOverlay": False, "items": []}]},
            {"images": [{"slot": 1, "hasOverlay": False, "items": []}, {"slot": 3, "hasOverlay": False, "items": []}]},
        ):
            with patch.object(detect, "_run_detector", return_value=json.dumps(response)):
                with self.assertRaises(DetectorUnavailable):
                    detect_montage(self.task())

    def test_qwen_bare_array_string_slots_and_string_items_are_normalised(self):
        response = [
            {"slot": "1", "hasOverlay": True, "items": ["NAILONG PENDANT"]},
            {"slot": "2", "hasOverlay": False, "items": []},
        ]
        with patch.object(detect, "_run_detector", return_value=json.dumps(response)):
            findings = detect_montage(self.task())
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].field, "/images/main/0")
        self.assertEqual(findings[0].evidence, "NAILONG PENDANT")
        self.assertEqual(findings[0].confidence, 0.4)


if __name__ == "__main__":
    unittest.main()
