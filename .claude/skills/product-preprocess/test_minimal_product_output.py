import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / 'scripts'))

import build_doudian_product as builder
import preprocess_wrapper as wrapper
from projection.project import publication_readiness


class MinimalProductOutputTests(unittest.TestCase):
    def test_output_contains_one_product_body_and_no_projection_artifacts(self):
        canonical = {'title': {'text': '商品'}}
        publication = {'canPublish': True, 'canDraft': True, 'missingRequired': []}
        output = wrapper.build_output({
            'canonical': canonical, 'publication': publication,
            'projection_verdict': {'status': 'ready', 'reason': '校验通过'},
        })
        self.assertEqual(set(output), {'canonical', 'publication', 'outcome'})
        self.assertIs(output['canonical'], canonical)
        self.assertEqual(output['publication'], publication)
        self.assertEqual(output['outcome']['status'], 'ready')

    def test_missing_required_data_remains_available_without_addv2(self):
        output = wrapper.build_output({
            'canonical': {'title': {'text': '商品'}},
            'publication': {'canPublish': False, 'canDraft': False,
                            'missingRequired': ['资质']},
        })
        self.assertEqual(output['outcome']['status'], 'needs_input')
        self.assertEqual(output['outcome']['missingRequired'], ['资质'])

    def test_detector_failure_is_blocked_even_with_draftable_product(self):
        output = wrapper.build_output({
            'canonical': {'title': {'text': '商品'}},
            'publication': {'canPublish': True, 'canDraft': True, 'missingRequired': []},
            'projection_error': '检测通道不可用',
        })
        self.assertEqual(output['outcome']['status'], 'blocked')
        self.assertFalse(output['publication']['canDraft'])
        self.assertFalse(output['publication']['canPublish'])

    def test_readiness_checks_canonical_without_an_api_payload(self):
        canonical = {
            'title': {'text': '商品'}, 'category': {'doudianLeafId': 1},
            'images': {'main': [{'url': 'image'}]}, 'skus': [{'stock': 1}],
        }
        decision = publication_readiness(
            canonical, {'props': []}, {'results': []}, detection_complete=True,
        )
        self.assertTrue(decision['canPublish'])

    def test_builder_does_not_construct_or_return_addv2(self):
        canonical = {
            'title': {'text': '商品'}, 'category': {'doudianLeafId': 1},
            'images': {'main': []}, 'skus': [{'stock': 1, 'sourcePrice': 1}],
            'qualityReport': {'errors': [], 'pending': [], 'warnings': [], 'risks': []},
        }
        with patch.object(builder, 'build_addv2', create=True,
                          side_effect=AssertionError('unused API projection executed')), \
             patch.object(builder, 'build_canonical', return_value=canonical), \
             patch.object(builder, 'load_qualification_capture', return_value={}), \
             patch.object(builder, 'validate_publication', return_value={'results': []}):
            result = builder.build_doudian_product(
                {'BaseInfo': {'Title': '商品'}},
                schema=json.loads((Path(__file__).resolve().parent / 'canonical.schema.json').read_text()),
                leaves={}, props_by_leaf={'1': {'props': [], 'path': '商品'}},
                category_leaf_id=1, no_llm=True, no_project=True,
                download_images=False,
            )
        self.assertNotIn('addv2', result)
        self.assertNotIn('doudian_values', result)
        self.assertNotIn('category_match', result)


if __name__ == '__main__':
    unittest.main()
