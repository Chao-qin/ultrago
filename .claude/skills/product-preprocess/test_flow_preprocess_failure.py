import sys
import io
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent / 'scripts'))
import build_doudian_product as builder
from projection import detect, project
import preprocess_wrapper


class FlowPreprocessFailureTests(unittest.TestCase):
    @staticmethod
    def _image_bytes():
        out = io.BytesIO()
        Image.new('RGB', (32, 32), (20, 20, 20)).save(out, 'JPEG')
        return out.getvalue()

    def test_rejected_leaf_is_not_accepted_when_backtracking_is_exhausted(self):
        decisions = [('饰品', 'ok', True, None), ('扣', '成品不是组件', False, 0)]
        with patch.object(builder, '_pick_child', side_effect=decisions), \
             patch.object(builder, 'MAX_BACKTRACK_ROUNDS', 1):
            category = builder.resolve_category(
                {'BaseInfo': {'Title': '毛绒挂件'}}, {}, False,
                leaf_paths={'1': '饰品/扣'},
            )
        self.assertIsNone(category)

    def test_rejected_only_top_branch_is_not_accepted(self):
        with patch.object(builder, '_pick_child', return_value=('扣', '不适合', False, 0)):
            category = builder.resolve_category(
                {'BaseInfo': {'Title': '毛绒挂件'}}, {}, False,
                leaf_paths={'1': '扣'},
            )
        self.assertIsNone(category)

    def test_detector_errors_use_the_same_type_as_the_pipeline(self):
        self.assertIs(project.DetectorUnavailable, builder.DetectorUnavailable)

    def test_expired_product_budget_stops_detection_before_requests(self):
        with patch.object(detect.time, 'monotonic', return_value=100), \
             patch.object(detect.urllib.request, 'urlopen') as request:
            with self.assertRaisesRegex(detect.DetectorUnavailable, '预算'):
                project.collect_findings(
                    {'title': {'text': '商品'}, 'images': {'main': [{'url': 'x'}]}},
                    {'/images/main/0': b'image'}, False, deadline=99,
                )
        request.assert_not_called()

    def test_image_workers_and_text_share_remaining_budget(self):
        timeouts = []
        responses = [
            b'{"choices":[{"message":{"content":"[{\\"slot\\":1,\\"hasOverlay\\":false,\\"items\\":[]}]"}}]}',
            b'{"choices":[{"message":{"content":"{\\"hasOverlay\\":false,\\"items\\":[]}"}}]}',
        ]

        def respond(_request, timeout):
            timeouts.append(timeout)
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.read.return_value = responses.pop(0)
            return response

        with patch.object(detect.time, 'monotonic', return_value=100), \
             patch.object(detect.urllib.request, 'urlopen', side_effect=respond):
            found = project.collect_findings(
                {'title': {'text': '商品'}, 'images': {'main': [{'url': 'x'}]}},
                {'/images/main/0': self._image_bytes()}, False, deadline=107,
            )
        self.assertEqual(found, [])
        self.assertEqual(timeouts, [7, 7])

    def test_retry_cannot_start_after_shared_budget_expires(self):
        with patch.object(detect.time, 'monotonic', side_effect=[100, 107]), \
             patch.object(detect.time, 'sleep') as sleep, \
             patch.object(detect.urllib.request, 'urlopen', side_effect=TimeoutError) as request:
            with self.assertRaisesRegex(detect.DetectorUnavailable, '预算'):
                with detect.detection_budget(107):
                    detect._run_detector('检测')
        self.assertEqual(request.call_count, 1)
        sleep.assert_not_called()

    def test_publication_uses_required_properties_and_preserves_risk_notes(self):
        canonical = {
            'category': {'doudianLeafId': 91}, 'title': {'text': '测试商品'},
            'images': {'main': [{'url': 'x'}]}, 'skus': [{'stock': 1}],
            'attributes': [{'doudianPropertyId': 73, 'rawValue': '甲',
                            'doudianValues': [{'valueId': 8}]}],
            'qualityReport': {'errors': [], 'risks': [{'code': 'review_note'}],
                              'pending': [{'code': 'attribute_name_unmapped'}]},
        }
        props = {'props': [{'id': 73, 'name': '动态属性', 'required': True,
                             'options': [{'id': 8}]}]}
        checks = {'results': [{'status': 'pass', 'detail': '齐全'}]}
        decision = project.publication_readiness(
            canonical, props, checks, detection_complete=True,
        )
        self.assertTrue(decision['canPublish'])
        self.assertTrue(canonical['qualityReport']['risks'])
        canonical['attributes'][0]['doudianValues'] = []
        decision = project.publication_readiness(
            canonical, props, checks, detection_complete=True,
        )
        self.assertFalse(decision['canPublish'])
        self.assertTrue(decision['canDraft'])
        self.assertTrue(decision['missingRequired'])

    def test_unknown_category_and_incomplete_detection_cannot_publish(self):
        canonical = {'category': {'doudianLeafId': 91}, 'title': {'text': '测试商品'},
                     'images': {'main': [{'url': 'x'}]}, 'skus': [{'stock': 1}]}
        for props, complete in [(None, True), ({'props': []}, False)]:
            decision = project.publication_readiness(
                canonical, props, {'results': []},
                detection_complete=complete,
            )
            self.assertFalse(decision['canPublish'])
        canonical['qualityReport'] = {'errors': [{'message': '来源损坏'}]}
        decision = project.publication_readiness(
            canonical, {'props': []}, {'results': []},
            detection_complete=True,
        )
        self.assertFalse(decision['canDraft'])

    def test_wrapper_exposes_the_publication_decision(self):
        publication = {'canPublish': True, 'canDraft': True, 'missingRequired': []}
        output = preprocess_wrapper.build_output({'publication': publication})
        self.assertEqual(output['publication'], publication)


if __name__ == '__main__':
    unittest.main()
