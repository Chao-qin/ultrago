import io
import json
import unittest
from unittest.mock import patch

from execution_budget import announce_work, plan_inspection


class InspectionBudgetTests(unittest.TestCase):
    def test_more_montages_receive_more_time(self):
        small = plan_inspection(1, [], workers=5, unit_seconds=180)
        large = plan_inspection(4, [], workers=5, unit_seconds=180)
        self.assertEqual(small.total_seconds, 180)
        self.assertEqual(large.total_seconds, 720)
        self.assertEqual(large.image_request_seconds, 720)

    def test_concurrency_changes_queue_allowance_without_assuming_upstream_parallelism(self):
        serial = plan_inspection(4, [], workers=1, unit_seconds=180)
        parallel = plan_inspection(4, [], workers=5, unit_seconds=180)
        self.assertEqual(serial.total_seconds, parallel.total_seconds)
        self.assertEqual(serial.image_request_seconds, 180)
        self.assertEqual(parallel.image_request_seconds, 720)

    def test_title_and_long_description_receive_separate_work_units(self):
        plan = plan_inspection(4, ['标题', '文' * 8_001], workers=5, unit_seconds=180)
        self.assertEqual(plan.text_request_seconds, (180, 540))
        self.assertEqual(plan.total_seconds, 1_440)

    def test_no_work_allocates_no_model_time(self):
        plan = plan_inspection(0, [], workers=5, unit_seconds=180)
        self.assertEqual(plan.total_seconds, 0)

    def test_announcements_are_opt_in_and_do_not_touch_stdout(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict('os.environ', {}, clear=True), patch('sys.stdout', stdout), patch('sys.stderr', stderr):
            announce_work('image-detection', 720)
        self.assertEqual(stderr.getvalue(), '')
        with patch.dict('os.environ', {'BCP_FLOW_BUDGET_PROTOCOL': '1'}), patch('sys.stdout', stdout), patch('sys.stderr', stderr):
            announce_work('image-detection', 720)
        prefix, body = stderr.getvalue().strip().split(' ', 1)
        self.assertEqual(prefix, 'BCP_BUDGET_V1')
        self.assertEqual(json.loads(body), {'stage': 'image-detection', 'remainingMs': 750_000})
        self.assertEqual(stdout.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
