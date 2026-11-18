import json
import unittest
from pathlib import Path

from preprocess_config import (
    PREPROCESS_CONFIG_SCHEMA_VERSION,
    apply_regex_rules,
    audit_config,
    compile_replace_rules,
    normalize_config,
    select_image_urls,
)


class ConfigTests(unittest.TestCase):
    def policy(self, **sections):
        return {"configId": "test", "shopProfile": {}, **sections}

    def test_defaults(self):
        config = normalize_config(None)
        self.assertTrue(config["sku"]["dropZeroStock"])
        self.assertEqual(config["pricing"]["strategy"], "fixed_amount")
        self.assertEqual(config["pricing"]["markup"], 10.0)

    def test_unknown_fields_are_rejected(self):
        with self.assertRaises(ValueError):
            normalize_config({"unknown": True})

    def test_partial_policy_may_omit_configId_and_shopProfile(self):
        # 片段式策略：只想覆盖 pricing/text 时，不必再抄一遍 configId 和整份店铺配置。
        # configId 落到 DEFAULT_CONFIG 的 "default"；shopProfile 从 profile 参数回退
        # —— 这两条回退本来就在 normalize_config 里，是上面那两个必填检查把它们堵死的。
        profile = {"profileId": "shop-1", "listing": {}, "shipping": {}}
        config = normalize_config({"pricing": {"markup": 3}}, profile)
        self.assertEqual(config["configId"], "default")
        self.assertEqual(config["shopProfile"], profile)
        self.assertEqual(config["pricing"]["markup"], 3.0)

    def test_policy_shopProfile_still_wins_over_profile_argument(self):
        # 放宽的是"要不要给"，不是"给了谁优先"：策略里自带的那份仍然覆盖 flow 的 profile。
        config = normalize_config({"shopProfile": {"profileId": "in-policy"}}, {"profileId": "from-flow"})
        self.assertEqual(config["shopProfile"]["profileId"], "in-policy")

    def test_configId_must_be_non_empty_when_given(self):
        with self.assertRaises(ValueError):
            normalize_config({"configId": "   "})

    def test_audit_schema_version_matches_the_canonical_contract(self):
        """审计里写的配置契约版本必须等于 canonical 契约钉的 const。

        这两个数字一个住在 Python、一个住在 JSON，没有任何东西让它们同步 ——
        product-preprocess-config 升到 @2 时，Python 这侧就被漏掉了，于是 canonical
        里明明写着 const:1 是旧约定，audit 还在报 1（本次修复的起因）。这条测试把
        两边钉在一起：改契约版本时漏改任何一侧都会红。
        """
        schema = json.loads((Path(__file__).resolve().parent / "canonical.schema.json").read_text("utf-8"))
        const = schema["properties"]["preprocessConfig"]["properties"]["schemaVersion"]["const"]
        self.assertEqual(
            PREPROCESS_CONFIG_SCHEMA_VERSION,
            const,
            "preprocess_config.PREPROCESS_CONFIG_SCHEMA_VERSION 与 canonical.schema.json 的 const 不一致",
        )
        # …并且真正写出去的就是那个常量，而不是又一处硬编码。
        self.assertEqual(audit_config(normalize_config({"pricing": {"markup": 3}}, {}))["schemaVersion"], const)

    def test_invalid_regex_is_rejected(self):
        with self.assertRaises(ValueError):
            normalize_config({"text": {"replaceRules": [{"pattern": "[", "replacement": "", "description": "bad"}]}})

    def test_all_pricing_strategies_validate(self):
        self.assertEqual(normalize_config(self.policy(pricing={"strategy": "percentage", "markupPercent": 20}))["pricing"]["markupPercent"], 20.0)
        self.assertEqual(normalize_config(self.policy(pricing={"strategy": "percentage_plus_fixed", "markupPercent": 20, "markupFixed": 2}))["pricing"]["markupFixed"], 2.0)
        with self.assertRaises(ValueError):
            normalize_config(self.policy(pricing={"strategy": "min_max", "minPriceYuan": 10, "maxPriceYuan": 2}))

    def test_image_selection_is_one_based_closed(self):
        self.assertEqual(select_image_urls(["a", "b", "c", "d"], {"start": 2, "end": 3}, None), ["b", "c"])

    def test_seeded_shuffle_is_reproducible(self):
        urls = [str(i) for i in range(10)]
        selection = {"start": 1, "end": None, "shuffle": True}
        self.assertEqual(select_image_urls(urls, selection, 7), select_image_urls(urls, selection, 7))

    def test_regex_rules_are_ordered(self):
        rules = compile_replace_rules([
            {"pattern": "品牌", "replacement": "", "flags": "", "description": "去品牌"},
            {"pattern": "  +", "replacement": " ", "flags": "", "description": "合并空格"},
        ])
        self.assertEqual(apply_regex_rules("品牌  商品", rules), " 商品")


if __name__ == "__main__":
    unittest.main()
