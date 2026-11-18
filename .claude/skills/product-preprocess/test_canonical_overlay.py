import unittest

from canonical_overlay import apply_attribute_overlay, deep_merge


class CanonicalOverlayTests(unittest.TestCase):
    def test_deep_merge_preserves_unmentioned_fields_and_replaces_lists(self):
        base = {'a': {'x': 1, 'y': 2}, 'specs': ['颜色', '尺码']}
        got = deep_merge(base, {'a': {'y': 3}, 'specs': ['型号']})
        self.assertEqual(got, {'a': {'x': 1, 'y': 3}, 'specs': ['型号']})
        self.assertEqual(base['specs'], ['颜色', '尺码'])

    def test_attribute_overlay_keeps_unmapped_source_attributes(self):
        base = {'attributes': [
            {'sourceName': '材质', 'rawValue': '帆布', 'doudianPropertyId': None},
            {'sourceName': '功能', 'rawValue': '其它', 'doudianPropertyId': None},
        ]}
        merged = apply_attribute_overlay(base, [{'sourceName': '材质', 'doudianPropertyId': 3127}])
        self.assertEqual(merged[0]['doudianPropertyId'], 3127)
        self.assertIsNone(merged[1]['doudianPropertyId'])
        self.assertEqual(len(merged), 2)

    def test_required_attributes_absent_from_source_are_appended(self):
        base = {'attributes': [{'sourceName': '材质', 'rawValue': '帆布'}]}
        merged = apply_attribute_overlay(base, [
            {'sourceName': '材质', 'doudianPropertyId': 3127},
            {'sourceName': '适用年龄', 'doudianPropertyId': 2595},
        ])
        self.assertEqual([item['sourceName'] for item in merged], ['材质', '适用年龄'])


if __name__ == '__main__':
    unittest.main()
