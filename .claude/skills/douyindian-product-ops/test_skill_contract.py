import re
import unittest
from pathlib import Path


SKILL_TEXT = Path(__file__).with_name("SKILL.md").read_text(encoding="utf-8")


class SkillContractTests(unittest.TestCase):
    def test_source_lookup_scans_json_without_using_directory_names(self):
        source_lookup = self._section("7.1 图片源数据解析硬门")

        self.assertRegex(source_lookup, r"不得根据目录名")
        self.assertRegex(source_lookup, r"扫描 `products/`")
        for filename in ("raw.json", "preprocessed.json", "final.json"):
            self.assertIn(filename, source_lookup)
        for field in ("SourceID", "GoodsID", "标题"):
            self.assertRegex(source_lookup, rf"{field}.*匹配|匹配.*{field}")

    def test_source_lookup_stops_and_asks_for_zero_or_multiple_matches(self):
        source_lookup = self._section("7.1 图片源数据解析硬门")

        self.assertRegex(source_lookup, r"没有候选目录匹配.*停止.*询问")
        self.assertRegex(source_lookup, r"多个候选目录匹配.*停止.*明确选择")

    @staticmethod
    def _section(title):
        match = re.search(
            rf"^### {re.escape(title)}\n(.*?)(?=^## |^### |\Z)",
            SKILL_TEXT,
            re.MULTILINE | re.DOTALL,
        )
        if not match:
            raise AssertionError(f"missing section: ### {title}")
        return match.group(1)


if __name__ == "__main__":
    unittest.main()
