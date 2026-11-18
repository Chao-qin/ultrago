import json
from io import StringIO
import unittest
from unittest.mock import patch

import preprocess_wrapper


class PreprocessWrapperTests(unittest.TestCase):
    def test_decode_preprocess_config_defaults_and_validates(self):
        self.assertTrue(preprocess_wrapper.decode_preprocess_config(None) is None)
        with self.assertRaisesRegex(ValueError, "未知字段"):
            preprocess_wrapper.decode_preprocess_config({"unknown": True})
        with self.assertRaisesRegex(ValueError, "不是合法正则"):
            preprocess_wrapper.decode_preprocess_config({"configId": "bad", "shopProfile": {}, "text": {"replaceRules": [{"pattern": "[", "replacement": "", "description": "bad"}]}})

    def test_process_product_passes_preprocess_config_to_builder(self):
        config = {"configId": "cfg-1", "shopProfile": {}, "pricing": {"strategy": "fixed_amount", "markup": 12}}
        decoded = preprocess_wrapper.decode_request(json.dumps({"raw": {}, "preprocessConfig": config}))
        result = {'publication': {'canPublish': False, 'canDraft': False, 'missingRequired': []}, 'canonical': {}, 'projection_verdict': None, 'projection_error': None}
        with patch.object(preprocess_wrapper, "build_doudian_product", return_value=result) as build:
            preprocess_wrapper.process_product(decoded)
        self.assertEqual(build.call_args.kwargs["config"]["configId"], "cfg-1")

    def test_decode_request_accepts_only_raw_category_and_single_persist_target(self):
        raw = {"title": "商品标题", "attributes": [], "skus": []}
        request = preprocess_wrapper.decode_request(json.dumps({
            "raw": raw,
            "category": {"kind": "fixed", "leafId": 1000000997},
            "persist": {"kind": "file", "path": "reports/processed/product.json"},
        }))

        self.assertEqual(request["raw"], raw)
        self.assertEqual(request["category_leaf_id"], 1000000997)
        self.assertTrue(str(request["persist_path"]).endswith("reports/processed/product.json"))

    def test_decode_request_rejects_legacy_policy_overrides(self):
        with self.assertRaisesRegex(ValueError, "未知字段"):
            preprocess_wrapper.decode_request(json.dumps({
                "raw": {},
                "options": {"noLlm": True},
            }))

    def test_decode_request_rejects_malformed_category_and_persist_unions(self):
        with self.assertRaisesRegex(ValueError, "category.kind"):
            preprocess_wrapper.decode_request(json.dumps({
                "raw": {},
                "category": {"kind": "fixed"},
            }))
        with self.assertRaisesRegex(ValueError, "persist.kind"):
            preprocess_wrapper.decode_request(json.dumps({
                "raw": {},
                "persist": {"kind": "file"},
            }))

    def test_process_product_uses_fixed_policy_and_only_category_override(self):
        decoded = preprocess_wrapper.decode_request(json.dumps({
            "raw": {"title": "商品标题", "attributes": [], "skus": []},
            "category": {"kind": "fixed", "leafId": 123},
        }))
        result = {
            'publication': {'canPublish': True, 'canDraft': True, 'missingRequired': []},
            "canonical": {"title": {"text": "商品标题"}},
            "projection_verdict": {"status": "ready", "reason": "ok"},
            "projection_error": None,
        }
        decoded["profile"] = {}
        with patch.object(preprocess_wrapper, "build_doudian_product", return_value=result) as build:
            output = preprocess_wrapper.process_product(decoded)

        self.assertEqual(output["canonical"], result["canonical"])
        self.assertEqual(build.call_args.kwargs["category_leaf_id"], 123)
        self.assertFalse(build.call_args.kwargs["no_llm"])
        self.assertFalse(build.call_args.kwargs["no_project"])
        self.assertTrue(build.call_args.kwargs["download_images"])

    def test_process_product_uses_in_memory_assets_and_returns_cdn_urls(self):
        decoded = preprocess_wrapper.decode_request(json.dumps({"raw": {"title": "商品"}}))
        result = {
            'publication': {'canPublish': True, 'canDraft': True, 'missingRequired': []},
            "canonical": {"images": {"main": [{"url": "https://source.example/a.jpg", "sourceUrl": "https://source.example/a.jpg"}]}},
            "projection_verdict": {"status": "ready", "reason": "ok"},
            "projection_error": None,
        }
        decoded["profile"] = {}
        with patch.object(preprocess_wrapper, "build_doudian_product", return_value=result) as build:
            output = preprocess_wrapper.process_product(decoded)

        self.assertTrue(build.call_args.kwargs["download_images"])
        self.assertNotIn("out_dir", build.call_args.kwargs)
        self.assertEqual(build.call_args.kwargs["console_url"], preprocess_wrapper.CONSOLE_URL)
        self.assertEqual(output["canonical"], result["canonical"])

    def test_build_output_returns_json_values_not_artifact_paths(self):
        output = preprocess_wrapper.build_output({
            'publication': {'canPublish': True, 'canDraft': True, 'missingRequired': []},
            "canonical": {"title": {"text": "商品标题"}},
            "projection_verdict": {"status": "ready", "reason": "ok"},
            "projection_error": None,
        })

        self.assertEqual(output['outcome']['status'], 'ready')
        self.assertTrue(output['publication']['canPublish'])
        self.assertEqual(output["canonical"]["title"]["text"], "商品标题")
        self.assertNotIn("addv2Path", output)
        self.assertNotIn("canonicalPath", output)

    def test_build_output_preserves_needs_human_as_business_status(self):
        output = preprocess_wrapper.build_output({
            'publication': {'canPublish': False, 'canDraft': False, 'missingRequired': ['类目未映射']},
            "canonical": {},
            "projection_verdict": None,
            "projection_error": None,
        })

        self.assertEqual(output['outcome']['status'], 'needs_input')
        self.assertFalse(output['publication']['canPublish'])
        self.assertNotIn("addv2", output)

    def test_build_output_maps_internal_phase_timings_on_success_and_blocked_results(self):
        timings = {
            'totalMs': 135,
            'stages': [
                {'name': 'data_preparation', 'durationMs': 35, 'status': 'success'},
                {'name': 'projection_validation', 'durationMs': 100, 'status': 'failed'},
            ],
        }
        ready = preprocess_wrapper.build_output({
            'publication': {'canPublish': True, 'canDraft': True, 'missingRequired': []},
            'canonical': {},
            'projection_verdict': {'status': 'ready'},
            'projection_error': None,
            'phase_timings': timings,
        })
        blocked = preprocess_wrapper.build_output({
            'canonical': {},
            'projection_verdict': None,
            'projection_error': 'detector unavailable',
            'phase_timings': timings,
        })

        self.assertEqual(ready['phaseTimings'], timings)
        self.assertEqual(blocked['phaseTimings'], timings)

    def test_main_keeps_exception_timing_evidence_without_changing_error_result(self):
        error = RuntimeError('mock preprocessing failure')
        error.phase_timings = {
            'totalMs': 80,
            'stages': [
                {'name': 'data_preparation', 'durationMs': 30, 'status': 'success'},
                {'name': 'category_attribute_mapping', 'durationMs': 50, 'status': 'failed'},
            ],
        }
        stdout = StringIO()
        stderr = StringIO()
        request = json.dumps({'raw': {}})
        with patch.object(preprocess_wrapper.sys, 'stdin', StringIO(request)), \
             patch.object(preprocess_wrapper.sys, 'stdout', stdout), \
             patch.object(preprocess_wrapper.sys, 'stderr', stderr), \
             patch.object(preprocess_wrapper, 'build_doudian_product', side_effect=error):
            exit_code = preprocess_wrapper.main()

        output = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(output['outcome']['status'], 'blocked')
        self.assertEqual(output['phaseTimings'], error.phase_timings)
        self.assertIn('mock preprocessing failure', stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
