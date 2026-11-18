import json
import unittest
import urllib.error
from unittest.mock import patch

from scripts import build_doudian_product as builder
from projection import detect, project
from scripts import llm_client


class SequentialPool:
    def __init__(self, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def map(self, function, jobs):
        return map(function, jobs)


class DynamicProductBudgetTests(unittest.TestCase):
    def test_gateway_timeouts_retry_images_and_text_within_remaining_budget(self):
        for text in (False, True):
            with self.subTest(text=text):
                response = unittest.mock.MagicMock()
                response.__enter__.return_value.read.return_value = json.dumps({
                    'choices': [{'message': {'content': '{"items":[]}'}}],
                }).encode()
                error = urllib.error.HTTPError('http://gateway', 504, 'Timeout', {}, None)
                with patch.object(detect.urllib.request, 'urlopen', side_effect=[error, response]) as request, \
                        patch.object(detect, 'ask_llm', llm_client.ask_llm), \
                        patch.object(detect.time, 'monotonic', return_value=100), \
                        patch.object(detect.time, 'sleep'), \
                        detect.detection_budget(500, request_timeout=180):
                    if text:
                        self.assertEqual(detect.detect_text('商品', '/title/text'), [])
                    else:
                        self.assertEqual(detect._run_detector('inspection'), '{"items":[]}')
                self.assertEqual(request.call_count, 2)

    def test_gateway_timeouts_do_not_retry_after_stage_deadline(self):
        for text in (False, True):
            with self.subTest(text=text):
                now = [100]

                def expire(_request, timeout):
                    now[0] += timeout
                    raise urllib.error.HTTPError('http://gateway', 504, 'Timeout', {}, None)

                with patch.object(detect.urllib.request, 'urlopen', side_effect=expire) as request, \
                        patch.object(detect, 'ask_llm', llm_client.ask_llm), \
                        patch.object(detect.time, 'monotonic', side_effect=lambda: now[0]), \
                        detect.detection_budget(280, request_timeout=180):
                    with self.assertRaisesRegex(detect.DetectorUnavailable, '预算耗尽'):
                        if text:
                            detect.detect_text('商品', '/title/text')
                        else:
                            detect._run_detector('inspection')
                self.assertEqual(request.call_count, 1)

    def test_mapping_client_sends_the_same_timeout_to_the_gateway(self):
        captured = []

        def respond(request, timeout):
            captured.append((dict((key.lower(), value) for key, value in request.header_items()), timeout))
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.read.return_value = b'{"choices":[{"message":{"content":"{}"}}]}'
            return response

        with patch.object(llm_client.urllib.request, 'urlopen', side_effect=respond):
            llm_client._ask_gateway('mapping', timeout=240)
        self.assertEqual(captured[0][0]['x-bcp-request-timeout-ms'], '240000')
        self.assertEqual(captured[0][1], 240)

    def test_detector_sends_remaining_queue_budget_to_the_gateway(self):
        captured = []

        def respond(request, timeout):
            captured.append((dict((key.lower(), value) for key, value in request.header_items()), timeout))
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.read.return_value = b'{"choices":[{"message":{"content":"{}"}}]}'
            return response

        with patch.object(detect.time, 'monotonic', return_value=100), \
                patch.object(detect.urllib.request, 'urlopen', side_effect=respond), \
                detect.detection_budget(820, request_timeout=720):
            detect._run_detector('inspection')
        self.assertEqual(captured[0][0]['x-bcp-request-timeout-ms'], '720000')
        self.assertEqual(captured[0][1], 720)

    def test_additional_mapping_calls_do_not_share_a_fixed_product_deadline(self):
        now = [0.0]
        timeouts = []

        def ask(_prompt, **kwargs):
            timeouts.append(kwargs['timeout'])
            now[0] += 200
            return {}

        @builder._with_llm_budget
        def operation(**_kwargs):
            for _index in range(4):
                builder._ask_llm('mapping')
            return {}

        with patch.object(builder.time, 'monotonic', side_effect=lambda: now[0]), \
                patch.object(builder, 'ask_llm', side_effect=ask):
            operation(no_llm=False)
        self.assertEqual(timeouts, [builder.DEFAULT_LLM_CALL_TIMEOUT_S] * 4)

    def test_inspection_has_its_own_budget_after_slow_preprocessing(self):
        now = [335.0]
        timeouts = []

        def inspect(_job):
            timeouts.append(detect._request_timeout())
            now[0] += 160
            return []

        def inspect_text(_text, _pointer):
            timeouts.append(detect._request_timeout())
            now[0] += 90
            return []

        with patch.object(project.time, 'monotonic', side_effect=lambda: now[0]), \
                patch.object(project, '_image_jobs', return_value=[object()] * 4), \
                patch.object(project, 'ThreadPoolExecutor', SequentialPool), \
                patch.object(project, 'detect_montage', side_effect=inspect), \
                patch.object(project, 'detect_text', side_effect=inspect_text):
            result = project.collect_findings({'title': {'text': '商品'}}, {}, False)
        self.assertEqual(result, [])
        self.assertEqual(timeouts, [720, 720, 580, 420, 180])
        self.assertGreater(now[0], 480)


if __name__ == '__main__':
    unittest.main()
