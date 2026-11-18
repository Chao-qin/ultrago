#!/usr/bin/env python3

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from validate_source import validate_source
import preprocess


def complete_source():
    return {
        "GoodsID": "offer-123",
        "SourceID": "123",
        "sourceUrl": "https://detail.1688.com/offer/123.html",
        "BaseInfo": {
            "Title": "Example product",
            "Attr": {"SourceAttr": [{"Label": "Material", "Value": "Steel"}]},
        },
        "CommodityImage": {
            "ConfigList": [
                {"Label": "Main", "List": ["https://cbu01.alicdn.com/example.jpg"]}
            ]
        },
        "PriceAndStock": {
            "Skus": [{"Price": 1.0, "Quantity": 10, "OuterID": "sku-1"}]
        },
        "SourceMeta": {"captureMethod": "browser-dom", "pageState": "product"},
    }


class ValidateSourceTests(unittest.TestCase):
    def test_complete_source_is_valid(self):
        report = validate_source(complete_source())

        self.assertTrue(report["ok"])
        self.assertEqual(report["errors"], [])
        self.assertTrue(report["completeness"]["title"])
        self.assertTrue(report["completeness"]["skus"])

    def test_complete_sku_images_are_reported(self):
        data = complete_source()
        data["PriceAndStock"]["SkuProperties"] = [{
            "PropertyName": "颜色",
            "Values": [
                {"ValueName": "红色", "ImgUrl": "https://example.com/red.jpg"},
                {"ValueName": "蓝色", "ImgUrl": "https://example.com/blue.jpg"},
            ],
        }]

        report = validate_source(data)

        self.assertTrue(report["skuImages"]["complete"])
        self.assertEqual(report["skuImages"]["withImage"], 2)
        self.assertEqual(report["completeness"]["skuImages"]["missing"], [])

    def test_sku_image_mapping_matches_dom_evidence(self):
        data = complete_source()
        data["PriceAndStock"]["SkuProperties"] = [{
            "PropertyName": "颜色",
            "Values": [{"ValueName": "红色", "ImgUrl": "https://example.com/red.jpg"}],
        }]
        data["SourceMeta"]["skuImages"] = [{
            "propertyName": "颜色",
            "valueName": "红色",
            "imageUrl": "https://example.com/red.jpg",
        }]

        report = validate_source(data)

        self.assertTrue(report["ok"])
        self.assertTrue(report["skuImageMapping"]["consistent"])

    def test_sku_image_mapping_mismatch_is_an_error(self):
        data = complete_source()
        data["PriceAndStock"]["SkuProperties"] = [{
            "PropertyName": "颜色",
            "Values": [{"ValueName": "红色", "ImgUrl": "https://example.com/blue.jpg"}],
        }]
        data["SourceMeta"]["skuImages"] = [{
            "propertyName": "颜色",
            "valueName": "红色",
            "imageUrl": "https://example.com/red.jpg",
        }]

        report = validate_source(data)

        self.assertFalse(report["ok"])
        self.assertIn("SKU image mapping does not match captured DOM evidence", report["errors"])

    def test_sku_image_mapping_uses_property_and_value_name(self):
        data = complete_source()
        data["PriceAndStock"]["SkuProperties"] = [
            {"PropertyName": "颜色", "Values": [{"ValueName": "红色", "ImgUrl": "https://example.com/color-red.jpg"}]},
            {"PropertyName": "尺寸", "Values": [{"ValueName": "红色", "ImgUrl": "https://example.com/size-red.jpg"}]},
        ]
        data["SourceMeta"]["skuImages"] = [
            {"propertyName": "颜色", "valueName": "红色", "imageUrl": "https://example.com/color-red.jpg"},
            {"propertyName": "尺寸", "valueName": "红色", "imageUrl": "https://example.com/size-red.jpg"},
        ]

        report = validate_source(data)

        self.assertTrue(report["skuImageMapping"]["consistent"])

    def test_partial_sku_images_are_reported(self):
        data = complete_source()
        data["PriceAndStock"]["SkuProperties"] = [{
            "PropertyName": "颜色",
            "Values": [
                {"ValueName": "红色", "ImgUrl": "https://example.com/red.jpg"},
                {"ValueName": "蓝色", "ImgUrl": ""},
            ],
        }]

        report = validate_source(data)

        # Reported, NOT blocking. SKILL.md lists exactly three blocking
        # conditions — goodsId/sourceId/title missing, page blocked, and ALL
        # main images unavailable — and a partial SKU-image capture is none of
        # them: it is a known browser-side gap that downstream tooling decides
        # on per-SKU. b11a362 moved this from errors to warnings; this test kept
        # asserting the old placement, which is what made it fail.
        self.assertTrue(report["ok"])
        self.assertFalse(report["skuImages"]["complete"])
        self.assertEqual(report["skuImages"]["missing"], ["蓝色"])
        self.assertIn("partial SKU images: 1/2; missing: 蓝色", report["warnings"])
        self.assertEqual(report["errors"], [])

    def test_known_offer_preserves_all_sku_images(self):
        fixture = (
            Path(__file__).parents[3]
            / "products"
            / "offer-1063534334034"
            / "raw.json"
        )
        if not fixture.exists():
            self.skipTest("known offer fixture is not present")

        report = validate_source(json.loads(fixture.read_text(encoding="utf-8")))

        self.assertTrue(report["ok"])
        self.assertTrue(report["skuImages"]["complete"])
        self.assertEqual(report["skuImages"]["total"], 5)
        self.assertEqual(report["skuImages"]["withImage"], 5)

    def test_missing_goods_id_is_error(self):
        data = complete_source()
        del data["GoodsID"]

        report = validate_source(data)

        self.assertFalse(report["ok"])
        self.assertIn("missing GoodsID", report["errors"])

    def test_missing_images_and_prices_are_warnings(self):
        data = complete_source()
        data["CommodityImage"] = {"ConfigList": []}
        data["PriceAndStock"]["Skus"] = []

        report = validate_source(data)

        self.assertTrue(report["ok"])
        self.assertIn("missing images", report["warnings"])
        self.assertIn("missing SKU prices or stock", report["warnings"])

    def test_login_or_risk_marker_is_error(self):
        data = complete_source()
        data["SourceMeta"] = {"pageState": "login required"}

        report = validate_source(data)

        self.assertFalse(report["ok"])
        self.assertIn("page requires login or risk verification", report["errors"])


class PreprocessOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.products_dir = Path(self.temp_dir.name)
        self.products_patch = patch.object(preprocess, "PRODUCTS_DIR", self.products_dir)
        self.products_patch.start()

    def tearDown(self):
        self.products_patch.stop()
        self.temp_dir.cleanup()

    def test_raw_input_is_not_copied_over_itself(self):
        output_dir = self.products_dir / "existing-product"
        raw_file = output_dir / "raw.json"
        raw_file.parent.mkdir(parents=True)
        raw_file.write_text(json.dumps(complete_source()), encoding="utf-8")

        self.assertIsNone(preprocess.copy_raw_if_needed(raw_file, raw_file))
        self.assertEqual(
            json.loads(raw_file.read_text(encoding="utf-8"))["SourceID"],
            "123",
        )

    def test_legacy_source_is_copied_once(self):
        source = self.products_dir / "source-123.json"
        source.write_text(json.dumps(complete_source()), encoding="utf-8")
        output_dir = self.products_dir / "existing-product"
        raw_file = output_dir / "raw.json"
        output_dir.mkdir()

        preprocess.copy_raw_if_needed(source, raw_file)

        self.assertEqual(
            raw_file.read_text(encoding="utf-8"),
            source.read_text(encoding="utf-8"),
        )

    def test_capture_report_contains_method_and_completeness(self):
        source = complete_source()
        source["SourceMeta"]["warnings"] = ["partial SKU capture"]
        report_file = preprocess.write_capture_report(
            self.products_dir / "existing-product",
            source,
            {
                "ok": True,
                "errors": [],
                "warnings": [],
                "completeness": {"title": True},
            },
        )

        report = json.loads(report_file.read_text(encoding="utf-8"))
        self.assertEqual(report["captureMethod"], "browser-dom")
        self.assertEqual(report["completeness"]["title"], True)
        self.assertIn("partial SKU capture", report["warnings"])

    def test_sanitize_directory_title_removes_unsafe_characters(self):
        self.assertEqual(
            preprocess.sanitize_directory_title(" ../A/B\\C\x00\n. "),
            "-A-B-C",
        )
        self.assertEqual(preprocess.sanitize_directory_title(" . \t "), "product")
        self.assertEqual(len(preprocess.sanitize_directory_title("x" * 100)), 80)

    def test_sanitize_directory_title_obeys_utf8_component_budget(self):
        suffix = "-20260813-1a2b"
        title = "商品😀" * 100

        sanitized = preprocess.sanitize_directory_title(title)

        self.assertLessEqual(len((sanitized + suffix).encode("utf-8")), 255)
        self.assertEqual(sanitized.encode("utf-8").decode("utf-8"), sanitized)
        self.assertTrue(title.startswith(sanitized))

    @patch.object(preprocess.secrets, "token_hex", return_value="1a2b")
    @patch.object(preprocess, "datetime")
    def test_external_source_creates_title_date_random_directory(self, mock_datetime, _mock_token_hex):
        mock_datetime.now.return_value.strftime.return_value = "20260813"

        output_dir = preprocess.create_output_dir(complete_source(), self.products_dir / "source.json")

        self.assertEqual(output_dir, self.products_dir / "Example product-20260813-1a2b")
        self.assertTrue(output_dir.is_dir())

    @patch.object(preprocess.secrets, "token_hex", return_value="1a2b")
    @patch.object(preprocess, "datetime")
    def test_existing_product_raw_reuses_its_parent(self, mock_datetime, _mock_token_hex):
        mock_datetime.now.return_value.strftime.return_value = "20260813"
        raw_file = self.products_dir / "arbitrary-legacy-directory" / "raw.json"
        raw_file.parent.mkdir()
        raw_file.write_text(json.dumps(complete_source()), encoding="utf-8")
        changed_title = complete_source()
        changed_title["BaseInfo"]["Title"] = "A different title"

        output_dir = preprocess.create_output_dir(changed_title, raw_file)

        self.assertEqual(output_dir, raw_file.parent.resolve())
        self.assertTrue(output_dir.is_dir())

    @patch.object(preprocess.secrets, "token_hex", side_effect=["1a2b", "3c4d"])
    @patch.object(preprocess, "datetime")
    def test_directory_collision_retries_random_suffix(self, mock_datetime, mock_token_hex):
        mock_datetime.now.return_value.strftime.return_value = "20260813"
        (self.products_dir / "Example product-20260813-1a2b").mkdir()

        output_dir = preprocess.create_output_dir(complete_source(), self.products_dir / "source.json")

        self.assertEqual(output_dir, self.products_dir / "Example product-20260813-3c4d")
        self.assertEqual(mock_token_hex.call_count, 2)
        self.assertTrue(output_dir.is_dir())

    def test_ip_keyword_is_a_risk_not_a_blocking_error(self):
        source = complete_source()
        source["BaseInfo"]["Title"] = "蜘蛛侠主题面具"

        issues = preprocess.quality_check(source, {}, {"rows": []})
        summary = preprocess.generate_summary(source, issues)

        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["level"], "risk")
        self.assertEqual(issues[0]["category"], "ip_risk")
        self.assertEqual(summary["errors"], 0)
        self.assertEqual(summary["status"], "完整，有风险项需确认")


if __name__ == "__main__":
    unittest.main()
