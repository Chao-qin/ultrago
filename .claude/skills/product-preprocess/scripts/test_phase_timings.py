import unittest
from io import StringIO
from unittest.mock import patch

import build_doudian_product as product_builder
from projection.detect import DetectorUnavailable

try:
    from phase_timings import PhaseTimings
except ImportError:
    PhaseTimings = None


class FakeClock:
    def __init__(self):
        self.now = 10.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class PhaseTimingsTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(PhaseTimings, 'PhaseTimings must be implemented')
        self.clock = FakeClock()
        self.timings = PhaseTimings(clock=self.clock)

    def test_completed_and_failed_stages_use_nonnegative_elapsed_time(self):
        with self.timings.stage('data_preparation'):
            self.clock.advance(0.125)

        with self.assertRaisesRegex(RuntimeError, 'detector unavailable'):
            with self.timings.stage('llm_image_work'):
                self.clock.advance(0.050)
                raise RuntimeError('detector unavailable')

        self.clock.now -= 1
        with self.timings.stage('clock_adjustment'):
            pass
        self.assertEqual(self.timings.snapshot()['stages'], [
            {'name': 'data_preparation', 'durationMs': 125, 'status': 'success'},
            {'name': 'llm_image_work', 'durationMs': 50, 'status': 'failed'},
            {'name': 'clock_adjustment', 'durationMs': 0, 'status': 'success'},
        ])

    def test_total_uses_outer_elapsed_instead_of_summing_overlapping_stages(self):
        with self.timings.stage('outer'):
            self.clock.advance(0.100)
            with self.timings.stage('inner'):
                self.clock.advance(0.200)
            self.clock.advance(0.100)

        snapshot = self.timings.snapshot()
        self.assertEqual(snapshot['totalMs'], 400)
        self.assertEqual([stage['name'] for stage in snapshot['stages']], ['outer', 'inner'])
        self.assertEqual(sum(stage['durationMs'] for stage in snapshot['stages']), 600)

    def test_stage_switch_closes_the_previous_stage_once_and_skips_unknown_work(self):
        self.timings.start_stage('data_preparation')
        self.clock.advance(0.010)
        self.timings.start_stage('category_attribute_mapping')
        self.clock.advance(0.020)
        self.timings.finish_stage()

        self.assertEqual(self.timings.snapshot()['stages'], [
            {'name': 'data_preparation', 'durationMs': 10, 'status': 'success'},
            {'name': 'category_attribute_mapping', 'durationMs': 20, 'status': 'success'},
        ])

    def test_separate_collectors_do_not_share_stage_state(self):
        self.timings.start_stage('data_preparation')
        self.clock.advance(0.010)
        self.timings.finish_stage()
        other = PhaseTimings(clock=self.clock)

        self.assertEqual(other.snapshot(), {'totalMs': 0, 'stages': []})


class ProductTimingIntegrationTests(unittest.TestCase):
    CANONICAL = {
        'images': {'main': [], 'detail': []},
        'qualityReport': {'errors': [], 'risks': [], 'warnings': [], 'pending': []},
        'skus': [{'stock': 1, 'sourcePrice': 1}],
        'specs': [],
    }

    def test_unhandled_exception_keeps_completed_and_failed_stages_on_same_error(self):
        clock = FakeClock()
        error = RuntimeError('mapping failed')

        def prepared(_schema):
            clock.advance(0.010)
            return {}

        def fail_mapping(*_args, **_kwargs):
            clock.advance(0.025)
            raise error

        with patch.object(product_builder, 'load_constraints', side_effect=prepared), \
             patch.object(product_builder, 'load_rule_limits', return_value={}), \
             patch.object(product_builder, 'resolve_category', side_effect=fail_mapping):
            try:
                with self.assertRaises(RuntimeError) as raised:
                    product_builder.build_doudian_product(
                        {}, profile={}, no_llm=True, schema={}, leaves={}, props_by_leaf={},
                        tree_path=None, no_project=True, download_images=False,
                        _phase_clock=clock,
                    )
            except TypeError as exc:
                self.fail(f'builder must accept the injected timing clock: {exc}')

        self.assertIs(raised.exception, error)
        self.assertEqual(error.phase_timings['stages'], [
            {'name': 'data_preparation', 'durationMs': 10, 'status': 'success'},
            {'name': 'category_attribute_mapping', 'durationMs': 25, 'status': 'failed'},
        ])
        self.assertEqual(error.phase_timings['totalMs'], 35)

    def test_handled_detector_failure_is_observed_without_changing_result_semantics(self):
        clock = FakeClock()

        def detector_failure(*_args, **_kwargs):
            clock.advance(0.040)
            raise DetectorUnavailable('detector unavailable')

        with patch.object(product_builder, 'load_constraints', return_value={}), \
             patch.object(product_builder, 'load_rule_limits', return_value={}), \
             patch.object(product_builder, 'load_qualification_capture', return_value={
                 '1': {'collection': {'ok': True}, 'qualifications': []},
             }), \
             patch.object(product_builder, 'build_canonical', return_value=self.CANONICAL.copy()), \
             patch.object(product_builder, 'collect_findings', side_effect=detector_failure), \
             patch.object(product_builder, 'validate_publication', return_value=[]), \
             patch.object(product_builder, 'publication_readiness', return_value={
                 'canPublish': False, 'canDraft': False, 'missingRequired': [],
             }), \
             patch.object(product_builder.sys, 'stderr', StringIO()):
            try:
                result = product_builder.build_doudian_product(
                    {}, profile={}, no_llm=True, schema={}, leaves={},
                    props_by_leaf={'1': {'name': 'fixture', 'props': []}},
                    tree_path=None, category_leaf_id=1, no_project=False,
                    download_images=False, _phase_clock=clock,
                )
            except TypeError as exc:
                self.fail(f'builder must accept the injected timing clock: {exc}')

        self.assertEqual(result['projection_error'], 'detector unavailable')
        statuses = {stage['name']: stage['status'] for stage in result['phase_timings']['stages']}
        self.assertEqual(statuses['llm_image_work'], 'failed')
        self.assertEqual(statuses['data_preparation'], 'success')
        self.assertEqual(statuses['result_assembly'], 'success')

    def test_skipped_phases_are_absent_and_timing_state_does_not_cross_calls(self):
        clock = FakeClock()

        def run_once():
            with patch.object(product_builder, 'load_constraints', return_value={}), \
                 patch.object(product_builder, 'load_rule_limits', return_value={}), \
                 patch.object(product_builder, 'build_canonical', return_value=self.CANONICAL.copy()), \
                 patch.object(product_builder, 'validate_publication', return_value=[]), \
                 patch.object(product_builder, 'publication_readiness', return_value={
                     'canPublish': False, 'canDraft': False, 'missingRequired': [],
                 }):
                return product_builder.build_doudian_product(
                    {}, profile={}, no_llm=True, schema={}, leaves={}, props_by_leaf={},
                    tree_path=None, no_project=True, download_images=False,
                    _phase_clock=clock,
                )

        try:
            first = run_once()
            second = run_once()
        except TypeError as exc:
            self.fail(f'builder must accept the injected timing clock: {exc}')

        names = [stage['name'] for stage in first['phase_timings']['stages']]
        self.assertNotIn('llm_image_work', names)
        self.assertNotIn('projection_validation', names)
        self.assertIsNot(first['phase_timings'], second['phase_timings'])
        first['phase_timings']['stages'].append({'name': 'mutated'})
        self.assertNotIn({'name': 'mutated'}, second['phase_timings']['stages'])


if __name__ == '__main__':
    unittest.main()
