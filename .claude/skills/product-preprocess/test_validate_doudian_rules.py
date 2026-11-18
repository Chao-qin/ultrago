import json
import unittest
from pathlib import Path

from validate_doudian_rules import (
    FAIL,
    PASS,
    UNKNOWN,
    exit_code,
    extract_facts,
    load_rule_limits,
    validate,
)

# 与 test_build_canonical.py 同样的取舍：运行时契约来自 console 注册表
# （validate_doudian_rules.fetch_schema），这份文件只当**结构 fixture**，
# 让阈值抽取逻辑能在没有 console 的情况下按真实文档形状被测。
SCHEMA_FIXTURE = json.loads((Path(__file__).parent / "canonical.schema.json").read_text(encoding="utf-8"))
LIMITS = load_rule_limits(SCHEMA_FIXTURE)

CATEGORY_PROPS = {
    "1000001531": {
        "name": "毛绒玩偶/公仔",
        "path": "玩具/毛绒布艺玩具/毛绒玩偶/公仔",
        "props": [
            {"id": "1687", "name": "品牌", "required": True, "hidden": False, "optionCount": 0, "options": []},
            {"id": "2108", "name": "玩具类型", "required": True, "hidden": False, "optionCount": 0, "options": []},
            {"id": "3127", "name": "材质", "required": True, "hidden": False, "optionCount": 0, "options": []},
            {"id": "2595", "name": "适用年龄", "required": True, "hidden": False, "optionCount": 0, "options": []},
            {"id": "9999", "name": "风格", "required": False, "hidden": False, "optionCount": 0, "options": []},
        ],
    },
    "1000003442": {"name": "钥匙扣", "path": "服装/服装配饰/钥匙扣", "props": []},
}


def canonical(**overrides):
    """一个 7 条规则全过的 canonical 文档，按需覆盖单个字段。"""
    base = {
        "schemaVersion": 1,
        "title": {"text": "可爱毛绒玩偶挂件礼物"},
        "category": {"doudianLeafId": 1000003442},
        "images": {
            "main": [{"url": "https://e.com/m1.jpg"}],
            "detail": [{"url": "https://e.com/d1.jpg"}],
            "removed": [],
        },
        "specs": [{"name": "颜色", "values": [{"value": "红", "imageUrl": "https://e.com/s1.jpg"}]}],
        "skus": [{"specs": [{"name": "颜色", "value": "红"}], "price": 14.5, "stock": 1}],
        "attributes": [],
    }
    base.update(overrides)
    return base


def final(**overrides):
    """final.json 形状的等价文档（products/ 下现存的就是这种）。"""
    base = {
        "goodsId": "offer-1",
        "title": "可爱毛绒玩偶挂件礼物",
        "category": "礼品饰品>钥匙扣",
        "pricing": {"currency": "CNY", "skuPrices": [{"name": "红", "original": 4.5, "final": 14.5}]},
        "skuTable": {
            "columns": ["specs", "sourcePrice", "stock", "merchantCode"],
            "rows": [{"specs": [{"sourceName": "颜色", "value": "红"}], "sourcePrice": 4.5, "stock": 1, "merchantCode": ""}],
        },
        "skuProperties": [{"sourceName": "颜色", "values": [{"value": "红", "imageUrl": "https://e.com/s1.jpg"}]}],
        "attributeCandidates": [],
        "images": {"main": ["https://e.com/m1.jpg"], "detail": ["https://e.com/d1.jpg"]},
        "removedImages": [],
        "qualityReport": {},
    }
    base.update(overrides)
    return base


def rule(doc, n, **kw):
    return validate(doc, LIMITS, **kw)["results"][n - 1]


class LimitsFromSchemaTests(unittest.TestCase):
    """阈值必须来自 schema —— 这是校验器不和契约漂移的唯一保证。"""

    def test_limits_match_the_schema_document(self):
        self.assertEqual(LIMITS["title_max"], 60)
        self.assertEqual(LIMITS["main_max"], 5)
        self.assertEqual(LIMITS["total_max"], 50)

    def test_missing_constraint_exits_2_rather_than_guessing(self):
        broken = {"properties": {"title": {"properties": {"text": {}}}}}
        with self.assertRaises(SystemExit) as cm:
            load_rule_limits(broken)
        self.assertEqual(cm.exception.code, 2)


class ShapeAdapterTests(unittest.TestCase):
    def test_both_shapes_yield_the_same_facts(self):
        c, f = extract_facts(canonical()), extract_facts(final())
        self.assertEqual(c["shape"], "canonical")
        self.assertEqual(f["shape"], "final")
        for key in ("title", "main", "detail", "spec_pics", "prices", "sku_count"):
            self.assertEqual(c[key], f[key], f"{key} 在两种形状下不一致")

    def test_final_uses_selling_price_not_source_price(self):
        # skuTable.rows[].sourcePrice 是采购价 4.5，拿它校验就是验错了对象。
        self.assertEqual(extract_facts(final())["prices"], [14.5])


class Rule3TitleTests(unittest.TestCase):
    def test_cjk_counts_as_two_so_len_would_wave_it_through(self):
        # 31 个汉字 = len() 31（看着远小于 60），抖店口径 62（超）。
        long_title = "可" * 31
        r = rule(canonical(title={"text": long_title}), 3)
        self.assertEqual(r["status"], FAIL)
        self.assertIn("62", r["detail"])
        self.assertLess(len(long_title), LIMITS["title_max"])  # len() 会放行

    def test_exactly_at_limit_passes(self):
        r = rule(canonical(title={"text": "可" * 30}), 3)  # 恰好 60
        self.assertEqual(r["status"], PASS)

    def test_one_over_limit_fails(self):
        r = rule(canonical(title={"text": "可" * 30 + "a"}), 3)  # 61
        self.assertEqual(r["status"], FAIL)

    def test_too_short_fails(self):
        self.assertEqual(rule(canonical(title={"text": "短"}), 3)["status"], FAIL)


class Rule1DescriptionTests(unittest.TestCase):
    def test_emptied_by_infringement_says_so(self):
        """PIPE-5 的第 1 个后果：空数组必须能区分「被剔光」和「没采到」。"""
        doc = canonical(images={
            "main": [{"url": "m"}], "detail": [],
            "removed": [{"url": "d1", "reason": "otherBrandLogo（Sanrio 标识）", "detectedBy": "doubao-ask"}],
        })
        r = rule(doc, 1)
        self.assertEqual(r["status"], FAIL)
        self.assertIn("被剔光", r["detail"])
        self.assertIn("otherBrandLogo", r["detail"])

    def test_never_collected_says_something_different(self):
        doc = canonical(images={"main": [{"url": "m"}], "detail": [], "removed": []})
        r = rule(doc, 1)
        self.assertEqual(r["status"], FAIL)
        self.assertIn("未采集", r["detail"])


class Rule2And4ImageTests(unittest.TestCase):
    def test_pic_over_five_fails(self):
        doc = canonical(images={"main": [{"url": f"m{i}"} for i in range(22)], "detail": [{"url": "d"}], "removed": []})
        r = rule(doc, 2)
        self.assertEqual(r["status"], FAIL)
        self.assertIn("超 17", r["detail"])

    def test_zero_pic_fails_because_pic_is_required(self):
        doc = canonical(images={"main": [], "detail": [{"url": "d"}], "removed": []})
        self.assertEqual(rule(doc, 2)["status"], FAIL)

    def test_cross_field_total_over_50_fails(self):
        """单字段 maxItems 全部合法，合计仍可能超 —— 这条只有校验器能卡。"""
        doc = canonical(
            images={"main": [{"url": f"m{i}"} for i in range(5)],
                    "detail": [{"url": f"d{i}"} for i in range(40)], "removed": []},
            specs=[{"name": "颜色", "values": [{"value": f"v{i}", "imageUrl": f"s{i}"} for i in range(10)]}],
        )
        self.assertEqual(rule(doc, 2)["status"], PASS)   # 5 ≤ 5
        r = rule(doc, 4)
        self.assertEqual(r["status"], FAIL)              # 5 + 40 + 10 = 55
        self.assertIn("55", r["detail"])


class Rule5SkuTests(unittest.TestCase):
    def test_cartesian_product_across_two_dimensions(self):
        dims = [
            {"name": "颜色", "values": [{"value": "红"}, {"value": "黑"}]},
            {"name": "尺码", "values": [{"value": "S"}, {"value": "M"}, {"value": "L"}]},
        ]
        skus = [{"specs": [], "price": 1.0, "stock": 1} for _ in range(6)]
        self.assertEqual(rule(canonical(specs=dims, skus=skus), 5)["status"], PASS)
        self.assertEqual(rule(canonical(specs=dims, skus=skus[:5]), 5)["status"], FAIL)


class Rule6PriceTests(unittest.TestCase):
    def test_float_noise_does_not_false_alarm(self):
        # 1.09 是合法的两位小数，但 1.09*100 在二进制浮点下 = 100.00000000000001，
        # 朴素的 `(p*100).is_integer()` 会把它误报成非整数分。
        self.assertNotEqual(1.09 * 100, round(1.09 * 100))
        doc = canonical(skus=[{"specs": [], "price": 1.09, "stock": 1}])
        self.assertEqual(rule(doc, 6)["status"], PASS)

    def test_fractional_cent_from_decimal_markup_fails(self):
        doc = canonical(skus=[{"specs": [], "price": 14.555, "stock": 1}])
        self.assertEqual(rule(doc, 6)["status"], FAIL)


class Rule7CategoryTests(unittest.TestCase):
    def test_no_category_id_is_unknown_not_pass(self):
        r = rule(canonical(category={"doudianLeafId": None}), 7, cat_props=CATEGORY_PROPS)
        self.assertEqual(r["status"], UNKNOWN)

    def test_no_props_data_is_unknown_not_pass(self):
        self.assertEqual(rule(canonical(), 7)["status"], UNKNOWN)

    def test_missing_required_props_fails(self):
        doc = canonical(category={"doudianLeafId": 1000001531},
                        attributes=[{"sourceName": "a", "rawValue": "b", "values": ["b"], "doudianPropertyId": 1687},
                                    {"sourceName": "c", "rawValue": "d", "values": ["d"], "doudianPropertyId": 2108}])
        r = rule(doc, 7, cat_props=CATEGORY_PROPS)
        self.assertEqual(r["status"], FAIL)
        self.assertIn("材质", r["detail"])
        self.assertIn("适用年龄", r["detail"])

    def test_all_required_props_passes(self):
        doc = canonical(category={"doudianLeafId": 1000001531},
                        attributes=[{"sourceName": str(i), "rawValue": "v", "values": ["v"], "doudianPropertyId": i}
                                    for i in (1687, 2108, 3127, 2595)])
        self.assertEqual(rule(doc, 7, cat_props=CATEGORY_PROPS)["status"], PASS)

    def test_category_with_no_required_props_passes(self):
        self.assertEqual(rule(canonical(), 7, cat_props=CATEGORY_PROPS)["status"], PASS)

    def test_zero_mapped_attributes_is_unknown_not_fail(self):
        """一个都没映射 = 能力缺口（PIPE-2），不是「填错了」。"""
        doc = canonical(category={"doudianLeafId": 1000001531}, attributes=[])
        self.assertEqual(rule(doc, 7, cat_props=CATEGORY_PROPS)["status"], UNKNOWN)


class ExitCodeTests(unittest.TestCase):
    """unknown 不得折叠成 pass —— 退出码必须把「没问题」和「没检查」分开。"""

    def test_all_pass_is_zero(self):
        report = validate(canonical(), LIMITS, CATEGORY_PROPS)
        self.assertEqual(report["counts"][UNKNOWN], 0)
        self.assertEqual(exit_code(report), 0)

    def test_unknown_without_failure_is_three_not_zero(self):
        report = validate(canonical(), LIMITS)  # 无类目数据 → 规则 7 unknown
        self.assertEqual(report["counts"][FAIL], 0)
        self.assertEqual(exit_code(report), 3)

    def test_failure_wins_over_unknown(self):
        report = validate(canonical(images={"main": [], "detail": [], "removed": []}), LIMITS)
        self.assertEqual(exit_code(report), 1)


class RealProductRegressionTests(unittest.TestCase):
    """对着仓库里 3 个真实商品锁定实测结论（issue 文档 PIPE-6 表的复核）。"""

    PRODUCTS = Path(__file__).resolve().parents[3] / "products"

    def _load(self, needle):
        matches = [p for p in self.PRODUCTS.glob("*/final.json") if needle in p.parent.name]
        if not matches:
            self.skipTest(f"未找到商品 {needle}")
        return json.loads(matches[0].read_text(encoding="utf-8"))

    def test_kitty_title_is_59_of_60(self):
        r = validate(self._load("kitty"), LIMITS)["results"][2]
        self.assertEqual(r["status"], PASS)
        self.assertIn("59/60", r["detail"])

    def test_kitty_has_22_main_images(self):
        r = validate(self._load("kitty"), LIMITS)["results"][1]
        self.assertEqual(r["status"], FAIL)
        self.assertIn("22", r["detail"])

    def test_kitty_image_total_is_39(self):
        r = validate(self._load("kitty"), LIMITS)["results"][3]
        self.assertEqual(r["status"], PASS)
        self.assertIn("= 39", r["detail"])

    def test_kitty_detail_emptied_by_infringement(self):
        r = validate(self._load("kitty"), LIMITS)["results"][0]
        self.assertEqual(r["status"], FAIL)
        self.assertIn("被剔光", r["detail"])

    def test_xicha_has_no_main_images_at_all(self):
        """文档没记这条：喜茶那个商品主图 0 张，比 kitty 的超限更严重。"""
        r = validate(self._load("喜茶"), LIMITS)["results"][1]
        self.assertEqual(r["status"], FAIL)
        self.assertIn("0 张", r["detail"])


if __name__ == "__main__":
    unittest.main()
