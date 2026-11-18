#!/usr/bin/env python3
"""build_doudian_product.py 单元测试

策略:
  - 调纯函数 build_doudian_product(),断言返回 dict 结构,**不依赖文件**
  - monkeypatch llm_client.ask_llm 注入固定决策
  - mock console schema 返回 fixture
  - fixture 用 合成商品 fixture

覆盖:
  1. 类目匹配:token 召回命中 + LLM 失败回退
  2. 属性匹配:token=0 剔除
  3. 端到端:addv2 / canonical / doudian_values / pending / removed_sku_count 字段齐
  4. 质量红线:stock=0 / price<=0 的 SKU 被剔除
"""
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from unittest.mock import patch

import json
import copy

_SKILL_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_SKILL_ROOT))
sys.path.insert(0, str(_SKILL_ROOT / "scripts"))

from preprocess import load_json
from scripts.build_doudian_product import (
    build_doudian_product,
    fill_required_attributes,
    resolve_attributes,
    resolve_category,
    _source_attributes,
    _llm_pick_property,
    upload_canonical_images,
    apply_ai_text_policy,
)
import build_doudian_product as product_builder

EXAMPLE_DIR = Path(__file__).resolve().parent
EXAMPLE_RAW = {
    "BaseInfo": {"Title": "合成商品", "Attr": {"SourceAttr": [
        {"Label": "材质", "Value": "帆布"},
        {"Label": "品牌", "Value": "无品牌"},
        {"Label": "图案", "Value": "卡通动漫"},
    ]}},
    "PriceAndStock": {"Skus": [
        {"SkuId": "synthetic-sku-1", "Quantity": 10, "Price": 12.5, "SkuSpec": []},
        {"SkuId": "synthetic-sku-2", "Quantity": 8, "Price": 13.5, "SkuSpec": []},
    ]},
}

TREE_PATH = _SKILL_ROOT.parent.parent.parent / "reports" / "doudian-category-tree.json"
PROPS_PATH = _SKILL_ROOT.parent.parent.parent / "reports" / "doudian-category-properties.json"

MOCK_PROFILE = {
    "profileId": "shop-test-001",
    "shopName": "测试店铺",
    "listing": {
        "productType": 0, "reduceType": 1, "commit": False,
        "serviceMobile": "13800000000", "startSaleType": 1, "pickupMethod": "0",
    },
    "shipping": {"freightTemplateId": 1234567890, "presellType": 0, "deliveryDelayDay": 2},
    "afterSale": {"damagedOrderReturn": 1},
    "brand": {"defaultDoudianBrandId": 596120136},
    "pricing": {"strategy": "source_price_plus_fixed_amount", "markup": 10.0},
}

# build_canonical / validate 实际读的最小 schema 字段
MOCK_SCHEMA = {
    "properties": {
        "title": {"properties": {"text": {"minLength": 1, "maxLength": 60}}},
        "images": {
            "properties": {
                "main": {"maxItems": 5},
                "detail": {"minItems": 1, "maxItems": 45},
            },
            "x-doudian-total-max": 50,
        },
        "brand": {"properties": {"doudianBrandId": {"default": 596120136}}},
        "skus": {"items": {"properties": {"price": {"multipleOf": 0.01}}}},
    }
}


class TestAiTextPolicy(unittest.TestCase):
    def canonical(self):
        return {
            "title": {"text": "品牌商品", "sourceText": "品牌商品"},
            "specs": [{"name": "颜色", "values": [{"value": "红"}]}],
            "qualityReport": {"errors": [], "risks": [], "warnings": [], "pending": []},
        }

    def test_short_title_is_written(self):
        canonical = self.canonical()
        apply_ai_text_policy(canonical, {"text": {"enableAiShortTitle": True}}, lambda *args, **kwargs: {"shortTitle": "短标题"})
        self.assertEqual(canonical["title"]["shortName"], "短标题")
        self.assertEqual(canonical["title"]["sourceText"], "品牌商品")

    def test_cleanup_changes_only_outward_text(self):
        canonical = self.canonical()
        apply_ai_text_policy(canonical, {"text": {"removeBrandByAi": True}}, lambda *args, **kwargs: {"title": "可爱毛绒商品", "specs": [{"name": "颜色", "values": ["红色"]}]})
        self.assertEqual(canonical["title"]["text"], "可爱毛绒商品")
        self.assertEqual(canonical["title"]["sourceText"], "品牌商品")
        self.assertEqual(canonical["specs"][0]["values"][0]["value"], "红色")

    def test_malformed_ai_response_is_rejected(self):
        with self.assertRaises(ValueError):
            apply_ai_text_policy(self.canonical(), {"text": {"removeSensitiveByAi": True}}, lambda *args, **kwargs: {})


def _load_fixtures():
    props = [
        {"id": "1996", "name": "材质", "required": False, "ui": "select", "options": [["11", "棉"], ["12", "毛绒"]]},
        {"id": "1687", "name": "品牌", "required": True, "ui": "select", "options": [["596120136", "无品牌"]]},
        {"id": "1869", "name": "图案", "required": False, "ui": "select", "options": [["29635", "卡通动漫"]]},
        {"id": "4", "name": "功能", "required": False, "ui": "select", "options": [["41", "透气"]]},
        {"id": "5", "name": "风格", "required": False, "ui": "select", "options": [["51", "可爱"]]},
    ]
    props_by_leaf = {"1000000001": {"name": "合成商品", "path": "玩具/合成商品", "props": props}}
    leaves = {"合成商品": [(1000000001, 3, 1000000000)]}
    return leaves, props_by_leaf


class TestResolveCategory(unittest.TestCase):

    def test_文本命中的类目名只当线索交给模型而不是短路它(self):
        """【2026-09-03 契约变更】捷径不再否决模型判断，降级成一条线索。

        旧契约是「标题含唯一完整叶子类目时，模型不能把它改成近似类目」——
        捷径命中并过 fits 校验就直接 return，逐级下钻一次都不跑。

        推翻它的理由不是校验不够严，是【它凭什么排在模型判断前面】：命中判据是
        「叶子名逐字出现在源文本里」，而源文本大头是 1688 的 SEO 标题 —— 关键词
        堆砌，不是品类声明。它还拿字符长度当证据强度（len>=3 才参赛、最长者胜），
        在判据集上主动选错：女装长袖 T 恤标题里的「打底衫」(3 字、最长) 赢了，
        而正解叶子「T恤/Polo衫」里的「T恤」只有 2 字，连参赛资格都没有。

        现在命中结果作为 product["文本里疑似出现的类目名"] 进入模型上下文，
        由模型在每一层自己权衡。
        """
        raw = {
            "BaseInfo": {
                "Title": "欧美跨境新款女士分体泳衣紧身长袖平角裤潜水服",
                "Attr": {"SourceAttr": [
                    {"Label": "适用性别", "Value": "女"},
                    {"Label": "适用场景", "Value": "游泳涉水运动"},
                ]},
            },
        }
        leaves = {
            "女士分体泳衣": [(1000000364, 3, 1000000071)],
            "背心/吊带": [(1000003357, 3, 1000000001)],
        }
        paths = {
            "1000000364": "运动休闲用品/游泳/女士分体泳衣",
            "1000003357": "服装/女装/背心/吊带",
        }
        seen_context = []

        def fake_llm(prompt, context=None, **kw):
            seen_context.append(context or {})
            picked = ((context or {}).get("candidates") or [None])[0]
            return {"picked": picked, "fits": True, "reason": "测试桩"}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            resolve_category(raw, leaves, no_llm=False, leaf_paths=paths)

        # 线索确实喂进去了 —— 否则模型连这条信息都看不到，等于白丢。
        hints = [c.get("文本里疑似出现的类目名") for c in seen_context]
        keys = sorted(seen_context[0]) if seen_context else []
        self.assertIn("运动休闲用品/游泳/女士分体泳衣", hints,
                      f"命中的类目名要作为线索进模型上下文，实际 context 键={keys}")
        # 且模型确实被调用了 —— 旧实现在这里会直接 return，一次都不调。
        self.assertTrue(seen_context, "捷径不得再短路逐级下钻")

    def test_leaf_llm_failure_does_not_fallback_to_first_candidate(self):
        """叶子阶段失败时不能拿候选列表第一项冒充模型结果。"""
        raw = {"BaseInfo": {"Title": "测试商品"}}
        leaves = {"商品": [(1, 3, 10), (2, 3, 10)]}
        paths = {"1": "家居/商品", "2": "家居/另一个商品"}

        def fake_llm(prompt, context=None, **kw):
            if "top_level_categories" in (context or {}):
                return {"picked": "家居", "reason": "x"}
            raise RuntimeError("mock leaf LLM down")

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            cat = resolve_category(raw, leaves, no_llm=False, leaf_paths=paths)

        self.assertIsNone(cat)

    def test_token_only_no_llm(self):
        raw = copy.deepcopy(EXAMPLE_RAW)
        leaves, _ = _load_fixtures()
        cat = resolve_category(raw, leaves, no_llm=True)
        self.assertIsNone(cat, "没有 LLM 时不能仅靠词面相似度猜类目")

    def test_llm_failure_fallback(self):
        """LLM 抛异常时函数不抛错，也不猜一个类目"""
        raw = copy.deepcopy(EXAMPLE_RAW)
        leaves, _ = _load_fixtures()
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=RuntimeError("mock LLM down")):
            cat = resolve_category(raw, leaves, no_llm=False)
        self.assertIsNone(cat)


class TestSourceAttributesForCategory(unittest.TestCase):
    """类目决策必须拿到**全部**来源属性,不做任何筛选。

    背景:一个近视镜片商品被选进了「防蓝光镜」(成品眼镜)类目。第一版修法是加一个
    「品类关键词白名单」只抽 `产品类别` 那一条 —— 那把信号想窄了两次:
      · 白名单只覆盖 6 个已采商品里的 1 个,其余全是空手;
      · 真正的信号是**属性名的集合本身**(1688 属性表按类目下发,出现「领型/袖长/
        裤长/尺码」基本锁定服装),而不是某一条属性的值。
    现在全部属性名+值原样交给 LLM,由有语义的那一层去判断。
    """

    REAL_TITLE = "班格利1.56青少年1.61 全焦点360环焦近视镜片蓝光学生眼镜片"

    @classmethod
    def _raw(cls, attrs, title=None):
        return {"BaseInfo": {"Title": title or cls.REAL_TITLE,
                             "Attr": {"SourceAttr": attrs}}}

    def test_keeps_every_attribute_no_whitelist(self):
        raw = self._raw([{"Label": "产品类别", "Value": "近视镜片"},
                         {"Label": "折射率", "Value": "1.56"},
                         {"Label": "货号", "Value": "班格利环焦镜片"}])
        got = _source_attributes(raw)
        self.assertEqual([a["name"] for a in got], ["产品类别", "折射率", "货号"])
        self.assertEqual(got[0]["value"], "近视镜片")

    def test_drops_only_nameless_entries(self):
        raw = self._raw([{"Label": "", "Value": "x"}, {"Label": "材质", "Value": "树脂"}])
        self.assertEqual([a["name"] for a in _source_attributes(raw)], ["材质"])

    def test_no_attrs_is_empty_not_crash(self):
        self.assertEqual(_source_attributes({}), [])
        self.assertEqual(_source_attributes({"BaseInfo": {}}), [])

    def test_attributes_reach_the_llm_context(self):
        """抽出来还得真送进去 —— 只抽不送等于没做。

        逐级下钻后「每一段」变成「每一层」,断言不变:每次决策都要带上来源属性。
        """
        raw = self._raw([{"Label": "产品类别", "Value": "近视镜片"}])
        leaves = {"成品眼镜片": [(1000008435, 3, 1)], "防蓝光镜": [(1000008483, 3, 1)]}
        seen = []
        route = {"": "钟表眼镜", "钟表眼镜": "眼镜及配件", "钟表眼镜/眼镜及配件": "成品眼镜片"}

        def fake_llm(prompt, context=None, **kw):
            seen.append((prompt, context))
            trail = (context or {}).get("已确定的上级类目") or ""
            key = "" if trail == "(顶层)" else trail.replace(" / ", "/")
            return {"picked": route[key], "fits": True, "reason": "按品类"}

        paths = {"1000008435": "钟表眼镜/眼镜及配件/成品眼镜片",
                 "1000008483": "钟表眼镜/眼镜及配件/防蓝光镜"}
        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            cat = resolve_category(raw, leaves, no_llm=False, leaf_paths=paths)
        ctxs = [c for _, c in seen]
        self.assertTrue(ctxs, "至少要问一次")
        self.assertTrue(all(c.get("source_attributes") for c in ctxs),
                        "每一层决策都要带上来源属性")
        self.assertEqual(cat["doudianLeafId"], 1000008435)

    def test_每层带上已确定的上级类目(self):
        """只给兄弟节点名会丢掉消歧所需的上位词(同名叶子挂在不同一级下)。

        旧两段式靠「候选带全路径」保住这个信息;逐级下钻里对应的载体是
        「已确定的上级类目」—— 换了形式,不变量不能丢。
        """
        raw = self._raw([{"Label": "产品类别", "Value": "近视镜片"}])
        leaves = {"成品眼镜片": [(1000008435, 3, 1)]}
        paths = {"1000008435": "钟表眼镜/眼镜及配件/成品眼镜片",
                 "1000008483": "钟表眼镜/眼镜及配件/防蓝光镜",
                 "1000009999": "服装/上装/T恤"}
        seen = []
        route = {"": "钟表眼镜", "钟表眼镜": "眼镜及配件", "钟表眼镜/眼镜及配件": "成品眼镜片"}

        def fake_llm(prompt, context=None, **kw):
            seen.append(context)
            trail = (context or {}).get("已确定的上级类目") or ""
            key = "" if trail == "(顶层)" else trail.replace(" / ", "/")
            return {"picked": route[key], "fits": True, "reason": "x"}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            resolve_category(raw, leaves, no_llm=False, leaf_paths=paths)
        trails = [c.get("已确定的上级类目") for c in seen]
        self.assertEqual(trails[0], "(顶层)")
        self.assertIn("钟表眼镜", trails[1])
        self.assertIn("眼镜及配件", trails[-1], "最后一层要知道自己在哪个二级下")

    def test_某层无贴切时回退换上一层的分支(self):
        """逐级下钻存在的全部理由:一级选错要能回头。

        吹风机被放进「个人护理/洗护美用具/焗油用具」就是因为旧实现在叶子层
        发现走错了也回不去。这里模拟:先走个人护理,叶子层报 fits=false,
        必须回到顶层改走家用电器。
        """
        raw = self._raw([{"Label": "额定功率", "Value": "2400W"}])
        paths = {"1": "个人护理/洗护美用具/焗油用具",
                 "2": "家用电器/个护电器/电吹风"}

        def fake_llm(prompt, context=None, **kw):
            trail = (context or {}).get("已确定的上级类目") or ""
            cands = (context or {}).get("candidates") or []
            excluded = set((context or {}).get("已排除") or [])
            if trail == "(顶层)":
                # 第一次选个人护理;它被排除后只剩家用电器。
                return {"picked": "个人护理" if "个人护理" in cands and "个人护理" not in excluded
                        else "家用电器", "fits": True, "reason": "x"}
            if "焗油用具" in cands:
                return {"picked": "焗油用具", "fits": False, "reason": "吹风机属小家电"}
            return {"picked": cands[0], "fits": True, "reason": "x"}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            cat = resolve_category(raw, {}, no_llm=False, leaf_paths=paths)
        self.assertIsNotNone(cat, "回退后应当选出类目")
        self.assertEqual(cat["doudianLeafId"], 2, "应当回退到家用电器分支")

    def test_prompt_stays_domain_agnostic(self):
        """prompt 对所有类目生效,不许写进某一个商品的词汇。

        这条是防我自己:第一版把「防蓝光」「360环焦」「镜片」「眼镜」「镜架」
        直接焊进了 prompt —— 那是拿一个样本过拟合,跑睡衣/公仔/零食时全是噪声。
        """
        raw = self._raw([{"Label": "产品类别", "Value": "近视镜片"}])
        leaves = {"成品眼镜片": [(1000008435, 3, 1)]}
        paths = {"1000008435": "钟表眼镜/眼镜及配件/成品眼镜片"}
        seen = []

        def fake_llm(prompt, context=None, **kw):
            seen.append(prompt)
            if "top_level_categories" in (context or {}):
                return {"picked": "钟表眼镜", "reason": "x"}
            return {"picked_leaf_id": 1000008435, "reason": "x"}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            resolve_category(raw, leaves, no_llm=False, leaf_paths=paths)
        for word in ("防蓝光", "360环焦", "青少年", "镜片", "眼镜", "镜架"):
            for prompt in seen:
                self.assertNotIn(word, prompt,
                                 f"prompt 里出现了商品特定词「{word}」—— 这是过拟合")


class TestResolveAttributes(unittest.TestCase):

    def test_real_category_option_matches_exactly(self):
        """A synthetic category option keeps the value id/type contract covered."""
        props_by_leaf = {"1": {"name": "合成类目", "path": "合成类目", "props": [
            {"id": "1996", "name": "内衣质地", "required": False,
             "options": [["19165", "棉"]]},
        ]}}
        overlay, _, unresolved = resolve_attributes(
            _raw(("内衣质地", "棉")), 1, props_by_leaf, no_llm=True)

        self.assertEqual(unresolved, [])
        # int 而非 "1996"：canonical.schema 声明 doudianPropertyId 是 integer，
        # 同一条里的 valueId 也一直是 int，投影层 build_addv2 用 out[str(pid)] 自己
        # stringify。之前透传字符串让这份 canonical 过不了自己的契约。
        self.assertEqual(overlay[0]["doudianPropertyId"], 1996)
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 19165)
        self.assertEqual(overlay[0]["doudianValues"][0]["name"], "棉")

    def test_unmatched_value_is_left_blank(self):
        """属性名命中但属性值不在抖店 options 时，值必须留空而不是 DIY。"""
        raw = {
            "BaseInfo": {"Attr": {"SourceAttr": [{"Label": "材质", "Value": "帆布"}]}},
        }
        props = {
            "100": {
                "props": [{
                    "id": "1996",
                    "name": "材质",
                    "required": False,
                    "options": [["19165", "棉"], ["14460", "纯棉(棉含量100%)"]],
                }],
            },
        }

        overlay, records, unresolved = resolve_attributes(raw, 100, props, no_llm=True)

        self.assertEqual(len(unresolved), 1)
        self.assertIn("帆布", unresolved[0]["evidence"])
        # int 而非 "1996"：canonical.schema 声明 doudianPropertyId 是 integer，
        # 同一条里的 valueId 也一直是 int，投影层 build_addv2 用 out[str(pid)] 自己
        # stringify。之前透传字符串让这份 canonical 过不了自己的契约。
        self.assertEqual(overlay[0]["doudianPropertyId"], 1996)
        self.assertEqual(overlay[0]["doudianValues"], [])
        self.assertEqual(records[0]["doudianValues"], [])

    def test_channel_failure_is_not_reported_as_a_data_conclusion(self):
        """LLM 通道挂掉 ≠ 抖店没有等价选项 —— 两者排查方向相反，措辞不能混。

        实测撞上：羽毛球拍 4 个属性全是 llm_error（「产地」225 个候选把本地模型顶
        崩），pending 里却写着「不在抖店真实选项中」。而「广东省汕头市」对应的
        「中国大陆」就在候选里 —— 模型压根没看过，这句话是假的。
        """
        raw = {"BaseInfo": {"Attr": {"SourceAttr": [{"Label": "产地", "Value": "广东省汕头市"}]}}}
        props = {"100": {"props": [{
            "id": "1880", "name": "产地", "required": True,
            "options": [["1", "中国大陆"], ["2", "香港特别行政区"]],
        }]}}

        def fake_llm(prompt, context=None, **kw):
            if "items" in (context or {}):          # 属性【值】批处理 —— 通道挂掉
                raise RuntimeError("Ollama 连接超时")
            return {"picks": [{"source_index": 0, "property_id": "1880"}]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            overlay, records, unresolved = resolve_attributes(raw, 100, props, no_llm=False)

        self.assertEqual(records[0]["matchedBy"], "llm_error")
        self.assertEqual(overlay[0]["doudianValues"], [])
        codes = [u["code"] for u in unresolved]
        self.assertIn("attribute_value_channel_failed", codes)
        msg = next(u["message"] for u in unresolved
                   if u["code"] == "attribute_value_channel_failed")
        self.assertNotIn("不在抖店真实选项中", msg, "通道失败不得被说成数据结论")

    def test_model_said_no_match_stays_a_data_conclusion(self):
        """模型看过了、判定无等价项 —— 这条措辞不能被上一条改动带偏。"""
        raw = {"BaseInfo": {"Attr": {"SourceAttr": [{"Label": "材质", "Value": "帆布"}]}}}
        props = {"100": {"props": [{
            "id": "1996", "name": "材质", "required": False,
            "options": [["19165", "棉"], ["14460", "纯棉(棉含量100%)"]],
        }]}}

        def fake_llm(prompt, context=None, **kw):
            if "items" in (context or {}):          # 模型看过了，判定无等价项
                return {"picks": [{"key": it["key"], "picked_value_id": None}
                                  for it in context["items"]]}
            return {"picks": [{"source_index": 0, "property_id": "1996"}]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            _, records, unresolved = resolve_attributes(raw, 100, props, no_llm=False)

        self.assertEqual(records[0]["matchedBy"], "none")
        self.assertEqual(unresolved[0]["code"], "attribute_value_unmapped")
        self.assertIn("不在抖店真实选项中", unresolved[0]["message"])

    def test_multi_select_keeps_only_real_options(self):
        """多选属性逐值匹配，未命中的来源值不能混入抖店属性。"""
        raw = {
            "BaseInfo": {"Attr": {"SourceAttr": [{"Label": "功能", "Value": "透气,舒适"}]}},
        }
        props = {
            "100": {
                "props": [{
                    "id": "810",
                    "name": "功能",
                    "required": False,
                    "multi": True,
                    "ui": "multi_select",
                    "options": [["22283", "透气"], ["11178", "速干"]],
                }],
            },
        }

        overlay, records, unresolved = resolve_attributes(raw, 100, props, no_llm=True)

        self.assertEqual([v["name"] for v in overlay[0]["doudianValues"]], ["透气"])
        self.assertEqual(records[0]["matchedBy"], "mixed")
        self.assertEqual(len(unresolved), 1)
        self.assertIn("舒适", unresolved[0]["evidence"])

    def test_zero_token_skipped(self):
        """'功能' / '风格' token=0 落 pending(不进 overlay)"""
        raw = copy.deepcopy(EXAMPLE_RAW)
        _, props_by_leaf = _load_fixtures()
        overlay_attrs, _, _ = resolve_attributes(raw, 1000000001, props_by_leaf, no_llm=True)
        names = [a["sourceName"] for a in overlay_attrs]
        self.assertIn("材质", names)
        self.assertIn("品牌", names)
        self.assertIn("图案", names)
        self.assertNotIn("功能", names)
        self.assertNotIn("风格", names)

    def test_overlay_attrs_carries_doudian_values_when_value_match(self):
        """overlay_attrs 必须带 doudianValues 字段(project_product_format_new
        同时需要 property_id + value_id 才不返回 None)。旧实现只带 doudianPropertyId,
        product_format_new 永远空,抖店 addv2 必拒类目必填属性 —— 这是 round 2 修复的真 bug。

        不强求命中 options(kitty fixture 的 "塑胶" 也可能不在 prop options 里),
        只断言 overlay_attrs 把 doudianValues 字段也带上了 —— 命中与否由 fixture 内容决定,
        跑断言的 prod_code 与 round 2 修复前一致:property_id 在 + value 字段在 = 合。"""
        raw = copy.deepcopy(EXAMPLE_RAW)
        _, props_by_leaf = _load_fixtures()
        overlay_attrs, _, _ = resolve_attributes(raw, 1000000001, props_by_leaf, no_llm=True)

        # 所有带 dpid 的 overlay 项必须带 doudianValues；未命中时数组为空。
        for a in overlay_attrs:
            self.assertIsNotNone(a.get("doudianPropertyId"),
                                 f"overlay 项必须先有 dpid:{a}")
            self.assertIn("doudianValues", a,
                          f"overlay 项必须带 doudianValues(给 product_format_new 用),"
                          f"实际:{a}")
            for v in a["doudianValues"]:
                self.assertIsInstance(v["valueId"], int)
                self.assertEqual(v["diyType"], 0)
                self.assertIn("name", v)

        # '材质'='帆布' 不在 options 里，留空并进入 unresolved。
        cai_zhi = next(a for a in overlay_attrs if a["sourceName"] == "材质")
        self.assertEqual(cai_zhi["doudianValues"], [])


class TestBuildDoudianProduct(unittest.TestCase):
    """端到端:纯函数 build_doudian_product() 返回 dict,断言返回值结构"""

    def setUp(self):
        self.raw = copy.deepcopy(EXAMPLE_RAW)

    def _run(self, raw=None, **overrides):
        llm_side_effect = overrides.pop("_llm_side_effect", RuntimeError("LLM disabled in test"))
        leaves, props_by_leaf = _load_fixtures()
        kwargs = dict(
            profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
            leaves=leaves, props_by_leaf=props_by_leaf,
            tree_path=None, props_path=None,
            category_leaf_id=1000000001,
        )
        kwargs.update(overrides)
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=llm_side_effect):
            return build_doudian_product(raw or self.raw, **kwargs)

    def test_returns_one_product_body(self):
        result = self._run()
        self.assertIn("canonical", result)
        self.assertIn('publication', result)
        self.assertIn("removed_sku_count", result)
        self.assertNotIn('addv2', result)
        self.assertNotIn('doudian_values', result)
        self.assertEqual(result["canonical"]["category"]["doudianLeafId"], 1000000001)
        _, props_by_leaf = _load_fixtures()
        expected_props = [
            {
                "id": prop["id"],
                "name": prop["name"],
                "ui": prop["ui"],
                "required": bool(prop.get("required")),
            }
            for prop in props_by_leaf["1000000001"]["props"]
        ]
        self.assertEqual(result["canonical"]["category"]["categoryProps"], expected_props)

        # 只断言 token 命中的属性有 doudianPropertyId("功能"/"风格" token=0 落 pending)
        overlay_attrs, _, _ = resolve_attributes(self.raw, 1000000001, props_by_leaf, no_llm=True)
        expected_with_prop = {a["sourceName"] for a in overlay_attrs}
        actual_with_prop = {
            a["sourceName"] for a in result["canonical"]["attributes"]
            if a.get("doudianPropertyId") is not None
        }
        self.assertEqual(actual_with_prop, expected_with_prop)

    def test_can_skip_in_memory_images_without_passing_an_output_directory(self):
        with patch("scripts.build_doudian_product.build_canonical", return_value={}) as build:
            build_doudian_product(
                {},
                profile=None,
                no_llm=True,
                schema=MOCK_SCHEMA,
                leaves={},
                props_by_leaf={},
                no_project=True,
                download_images=False,
                tree_path=None,
                props_path=None,
            )

        self.assertIsNone(build.call_args.kwargs["image_assets"])

    def test_llm_call_receives_remaining_product_budget(self):
        seen = []

        def fake(prompt, context=None, timeout=None):
            seen.append(timeout)
            return {"ok": True}

        with patch.object(product_builder, "ask_llm", side_effect=fake):
            with product_builder.llm_budget(10):
                product_builder._ask_llm("test", context={})

        self.assertEqual(len(seen), 1)
        self.assertGreaterEqual(seen[0], 1)
        self.assertLessEqual(seen[0], 10)

    def test_expired_product_budget_fails_closed_before_llm_call(self):
        with patch.object(product_builder, "ask_llm") as ask:
            with product_builder.llm_budget(-1):
                with self.assertRaisesRegex(RuntimeError, "LLM budget exhausted"):
                    product_builder._ask_llm("test", context={})
        ask.assert_not_called()

    def test_omitted_product_budget_uses_dynamic_allocation(self):
        seen = []

        @product_builder._with_llm_budget
        def operation(*, no_llm=False, **_kwargs):
            seen.append(product_builder._LLM_DEADLINE)
            return {}

        operation(no_llm=False, llm_budget_seconds=None)
        self.assertIsNone(seen[0])

    def test_unmatched_values_remain_empty_in_canonical(self):
        result = self._run()
        canvas = next((d for d in result['canonical']['attributes'] if d['sourceName'] == '材质'), None)
        self.assertIsNotNone(canvas)
        self.assertFalse(canvas.get("doudianValues"), canvas)

    def test_canonical_attributes_have_confirmed_values(self):
        def pick_first_option(prompt, context=None):
            if context and "source_attribute_name" in context:
                return {"picked_property_id": context["candidates"][0]["property_id"]}
            if context and context.get("candidates"):
                return {"picked_value_id": context["candidates"][0]["value_id"]}
            return {"picked_value_id": None}

        result = self._run(no_llm=False, _llm_side_effect=pick_first_option)
        mapped = [attribute for attribute in result['canonical']['attributes'] if attribute.get('doudianValues')]
        self.assertTrue(mapped)
        for attribute in mapped:
            self.assertIsInstance(attribute['doudianPropertyId'], int)
            for value in attribute['doudianValues']:
                if value.get('diyType') != 1:
                    self.assertIsInstance(value['valueId'], int)

    def test_unmatched_attributes_keep_quality_evidence(self):
        result = self._run()
        report = result['canonical'].get('qualityReport', {})
        pending = (report.get('pending') or []) + (report.get('warnings') or [])
        self.assertTrue(any(p.get("code") == "attribute_value_unmapped" and "帆布" in p.get("evidence", "")
                            for p in pending),
                        f"未命中属性值应落 qualityReport.pending,实际 pending:{pending}")

    def test_zero_stock_sku_removed(self):
        """SKILL.md 质量红线:stock=0 的 SKU 从 canonical.skus 剔除(不期望 addv2 一定成功 —
        build_addv2 规则 5 会守住"SKU 数 == 规格组合数" invariant,这是正确的 safety check,
        不是 bug。剔除 SKU 后数量对不上就是该被阻断。"""
        raw = copy.deepcopy(EXAMPLE_RAW)
        skus = (raw.get("PriceAndStock") or {}).get("Skus") or []
        if not skus:
            self.skipTest("fixture 无 SKU")
        original_count = len(skus)
        skus[0]["Quantity"] = 0

        result = self._run(raw=raw)

        # 1. 剔除数量 = 1
        self.assertEqual(result["removed_sku_count"], 1,
                         f"应剔除 1 个 stock=0 的 SKU,实际:{result['removed_sku_count']}")

        # 2. canonical.skus 数量 = 原始 - 1(被剔除的不在内)
        self.assertEqual(len(result["canonical"]["skus"]), original_count - 1)

        # 3. canonical.skus 里没有 stock=0 的
        zero_stock = [s for s in result["canonical"]["skus"] if (s.get("stock") or 0) <= 0]
        self.assertEqual(zero_stock, [], f"canonical.skus 仍有 stock<=0:{zero_stock}")


class TestProjectionIntegration(unittest.TestCase):
    """build_doudian_product.py [5/5] 阶段:projection 集成 + 退出码映射。

    `collect_findings` 和 `verdict` 都用 mock 屏蔽:前者避免真实 LLM 调用,
    后者避免 missing_required_attributes 受 fixture 影响(它依赖真实 props 表)。
    我们只验证"集成路径" —— projection 怎么挂回主流程、退出码怎么映射。
    """

    def setUp(self):
        self.raw = copy.deepcopy(EXAMPLE_RAW)

    def test_no_project_flag_skips(self):
        """no_project=True:collect_findings 不被调,projection_verdict=None"""
        with patch(
            "scripts.build_doudian_product.collect_findings"
        ) as mock_cf, patch(
            "scripts.build_doudian_product.verdict",
            return_value={"status": "ready", "reason": "mock"},
        ), patch(
            "scripts.build_doudian_product.ask_llm",
            side_effect=RuntimeError("LLM disabled in test"),
        ):
            result = build_doudian_product(
                self.raw, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
                no_project=True, leaves=_load_fixtures()[0], props_by_leaf=_load_fixtures()[1],
                tree_path=None, props_path=None, category_leaf_id=1000000001,
            )
        mock_cf.assert_not_called()
        self.assertIsNone(result["projection_verdict"])
        self.assertIsNone(result["projection_error"])

    def test_projection_default_runs(self):
        """默认开:collect_findings 被调,findings 合入 canonical.qualityReport.risks"""
        from projection.detect import Finding
        finding_obj = Finding(field="/title/text", kind="platform",
                              evidence="淘宝", confidence=0.9)
        with patch(
            "scripts.build_doudian_product.collect_findings",
            return_value=[finding_obj],
        ) as mock_cf, patch(
            "scripts.build_doudian_product.verdict",
            return_value={"status": "ready", "reason": "mock"},
        ), patch(
            "scripts.build_doudian_product.ask_llm",
            side_effect=RuntimeError("LLM disabled in test"),
        ):
            result = build_doudian_product(
                self.raw, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
                leaves=_load_fixtures()[0], props_by_leaf=_load_fixtures()[1],
                tree_path=None, props_path=None, category_leaf_id=1000000001,
            )
        mock_cf.assert_called_once()
        self.assertIsNotNone(result["projection_verdict"])
        self.assertEqual(result["projection_verdict"]["status"], "ready")
        # findings 必须进了 canonical.qualityReport.risks
        # (_finding_entry 把 Finding 转成 code/message/field/evidence,code 由 kind 经
        # RISK_CODES 映射;platform → infringing_platform_mention)
        risks = result["canonical"]["qualityReport"].get("risks") or []
        self.assertTrue(
            any(r.get("code") == "infringing_platform_mention"
                and "淘宝" in (r.get("evidence") or "") for r in risks),
            f"platform finding 应进 risks,实际:{risks}",
        )

    def test_projection_verdict_needs_human(self):
        """verdict=needs_human → projection_verdict 完整传递,findings_count 正确"""
        with patch(
            "scripts.build_doudian_product.collect_findings",
            return_value=[],
        ), patch(
            "scripts.build_doudian_product.verdict",
            return_value={"status": "needs_human", "reason": "1 项风险待确认", "risks": 1, "pending": 0},
        ), patch(
            "scripts.build_doudian_product.ask_llm",
            side_effect=RuntimeError("LLM disabled in test"),
        ):
            result = build_doudian_product(
                self.raw, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
                leaves=_load_fixtures()[0], props_by_leaf=_load_fixtures()[1],
                tree_path=None, props_path=None, category_leaf_id=1000000001,
            )
        self.assertEqual(result["projection_verdict"]["status"], "needs_human")
        # projection_error 不应被填(通道没炸)
        self.assertIsNone(result["projection_error"])

    def test_projection_detector_unavailable(self):
        """collect_findings 抛 DetectorUnavailable → projection_error 填,verdict=None,不抛"""
        from projection.detect import DetectorUnavailable
        with patch(
            "scripts.build_doudian_product.collect_findings",
            side_effect=DetectorUnavailable("opencode 不在"),
        ), patch(
            "scripts.build_doudian_product.verdict",
            return_value={"status": "ready", "reason": "mock"},
        ), patch(
            "scripts.build_doudian_product.ask_llm",
            side_effect=RuntimeError("LLM disabled in test"),
        ):
            result = build_doudian_product(
                self.raw, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
                leaves=_load_fixtures()[0], props_by_leaf=_load_fixtures()[1],
                tree_path=None, props_path=None, category_leaf_id=1000000001,
            )
        self.assertIsNotNone(result["projection_error"])
        self.assertIn("opencode", result["projection_error"])
        self.assertIsNone(result["projection_verdict"])
        self.assertFalse(result['publication']['canPublish'])



# ==========================================================================
# 属性名 / 属性值匹配级联 —— 内联 fixture,不依赖磁盘商品目录
#
# 上面那些 test 全部 gate 在 EXAMPLE_DIR 上,换台机器就整片 skip 成"假绿"。
# 这一组只用内存里造的 props / raw,任何机器都真跑,专门盯住这次改的分支:
#   属性名: exact → (no_llm ? top0 : LLM) → LLM 判无对应 / 通道失败都落 unresolved
#   属性值: exact → 非 exact 统一交 LLM(可返回 null) → 留空
# ==========================================================================

def _leaf(*props):
    """props_by_leaf fixture,leaf_id 固定 "1"。"""
    return {"1": {"name": "测试类目", "path": "测试类目", "props": list(props)}}


def _prop(pid, name, options=(), required=0):
    return {"id": pid, "name": name, "required": required,
            "options": [list(o) for o in options]}


def _raw(*pairs):
    return {"BaseInfo": {"Attr": {"SourceAttr": [
        {"Label": lab, "Value": val} for lab, val in pairs]}}}


class TestPropertyNameSeesOptions(unittest.TestCase):
    """属性名决策必须看得到候选属性的取值域和来源值。

    实测:「镜片功能 = 抗辐射,抗紫外线,防蓝光」在「成品眼镜片」类目下被选进了
    「镜片镀膜」(紫晶膜/黄金膜/蓝膜/绿膜…),而正确的「镜片分类」的 options 里
    就摆着「抗辐射」—— 与来源值逐字相同。当时送给模型的候选只有
    {property_id, name, required, options_count},那个铁证被挡在上下文之外;
    名字上「功能/镀膜/分类」三个词都跟「镜片」沾边,光看名字分不出来。

    连锁后果还不止选错:镜片镀膜是 multi=False,逗号串不会被拆分,整串去匹配
    必然失败;而镜片分类是 multi=True,拆开后「抗辐射」本可精确命中。
    """

    REAL_PROPS = [
        {"id": "919", "name": "镜片镀膜", "required": 0,
         "options": [["1", "紫晶膜"], ["2", "黄金膜"], ["3", "蓝膜"], ["4", "绿膜"]]},
        {"id": "2149", "name": "镜片分类", "required": 0, "multi": True,
         "options": [["11", "抗辐射"], ["12", "非球面镜片"], ["13", "变色"], ["14", "偏光"]]},
    ]

    def _capture_ctx(self):
        seen = {}

        def fake_llm(prompt, context=None, **kw):
            seen["prompt"], seen["ctx"] = prompt, context
            return {"picked_property_id": "2149", "reason": "取值域命中"}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            _llm_pick_property("镜片功能", self.REAL_PROPS, "抗辐射,抗紫外线,防蓝光")
        return seen

    def test_candidates_carry_options_sample(self):
        seen = self._capture_ctx()
        by_id = {c["property_id"]: c for c in seen["ctx"]["candidates"]}
        self.assertIn("抗辐射", by_id["2149"]["options_sample"],
                      "正确候选的取值域必须可见,否则模型看不到决定性证据")
        self.assertIn("紫晶膜", by_id["919"]["options_sample"])

    def test_source_value_is_passed(self):
        seen = self._capture_ctx()
        self.assertEqual(seen["ctx"]["source_value"], "抗辐射,抗紫外线,防蓝光",
                         "没有来源值就无从比对取值域")

    def test_options_sample_is_capped(self):
        """全量 options 是下一层的事;在这里灌满会稀释信号。"""
        big = [{"id": "1", "name": "型号", "required": 0,
                "options": [[str(i), f"v{i}"] for i in range(500)]}]
        seen = {}

        def fake_llm(prompt, context=None, **kw):
            seen["ctx"] = context
            return {"picked_property_id": None, "reason": "x"}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake_llm):
            _llm_pick_property("型号", big, "ABC-1")
        self.assertLessEqual(len(seen["ctx"]["candidates"][0]["options_sample"]), 12)
        self.assertEqual(seen["ctx"]["candidates"][0]["options_count"], 500,
                         "样例截断了,但真实总数仍要如实告知")


class TestFreeTextAttribute(unittest.TestCase):
    """无 options 的自由文本属性(型号/货号/尺寸…,占属性条目 42.6%)。

    它们**没有枚举可匹配**,来源值本身就是答案。原实现对所有属性一视同仁地走
    枚举匹配,于是这类属性的值全部被当成「匹配失败」,落 pending 说「不在抖店
    真实选项中,已留空」—— 那句话在没有选项的属性上根本不成立,真实数据就这么丢了。
    """

    def test_free_text_value_is_kept_as_diy_not_dropped(self):
        props = _leaf(_prop(3171, "货号"))  # options 为空
        overlay, records, unresolved = resolve_attributes(
            _raw(("货号", "班格利环焦镜片")), 1, props, no_llm=True)

        self.assertEqual(unresolved, [], "自由文本属性不该产生「不在选项中」的 pending")
        vals = overlay[0]["doudianValues"]
        self.assertEqual(len(vals), 1)
        self.assertIsNone(vals[0]["valueId"], "自由文本没有抖店 value_id")
        self.assertEqual(vals[0]["diyType"], 1)
        self.assertEqual(vals[0]["name"], "班格利环焦镜片", "来源值必须原样保留")
        self.assertEqual(records[0]["matchedBy"], "diy")

    def test_enum_attribute_still_refuses_to_invent_values(self):
        """对照组:**枚举**属性没有等价项时仍须留空,不许造 diy 值混进去。

        这是 SKILL.md 的硬规矩,和上一条不冲突 —— 枚举里硬塞是往商品写错值,
        自由文本写来源真值是唯一正确行为。两者的分界就是 options 空不空。
        """
        props = _leaf(_prop(1996, "材质", [("19165", "棉")]))
        overlay, records, unresolved = resolve_attributes(
            _raw(("材质", "帆布")), 1, props, no_llm=True)

        self.assertEqual(overlay[0]["doudianValues"], [], "枚举无等价项必须留空")
        self.assertEqual(len(unresolved), 1)
        self.assertIn("帆布", unresolved[0]["evidence"])
        self.assertEqual(records[0]["matchedBy"], "none")


class TestValueMatchCascade(unittest.TestCase):
    """属性值匹配:完全相等直取，其他值交 LLM，null 留空。"""

    def test_similar_value_is_resolved_by_llm(self):
        """相似值由 LLM 从完整真实 options 中选择(整批一次调用)。"""

        props = _leaf(_prop(1869, "图案", [("11", "卡通动漫"), ("12", "植物花卉")]))
        seen = {}

        def fake(prompt, context=None, **kw):
            seen["ctx"] = context
            return {"picks": [{"key": it["key"], "picked_value_id": "11"}
                              for it in context["items"]]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake) as spy:
            overlay, patch_records, unresolved = resolve_attributes(
                _raw(("图案", "动漫卡通")), 1, props, no_llm=False)
        spy.assert_called_once()

        self.assertEqual([c["value_id"] for c in seen["ctx"]["items"][0]["candidates"]],
                         ["11", "12"])
        self.assertEqual(unresolved, [])
        dv = overlay[0]["doudianValues"][0]
        self.assertEqual(dv["valueId"], 11)
        self.assertEqual(dv["name"], "卡通动漫")
        self.assertEqual(dv["diyType"], 0)
        self.assertEqual(patch_records[0]["matchedBy"], "llm")

    def test_non_exact_offline_value_is_blank(self):
        """离线模式不对非 exact 值做字符串猜测。"""
        props = _leaf(_prop(1, "配色", [("11", "红蓝蓝")]))
        overlay, _, _ = resolve_attributes(
            _raw(("配色", "红红蓝")), 1, props, no_llm=True)
        self.assertEqual(overlay[0]["doudianValues"], [])

    def test_exact_value_skips_llm(self):
        """完全相等值可安全直取，不触发 LLM。"""
        props = _leaf(_prop(1, "图案", [("11", "动漫卡通"), ("12", "卡通动漫")]))
        overlay, _, _ = resolve_attributes(
            _raw(("图案", "动漫卡通")), 1, props, no_llm=True)
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 11)

    def test_similar_substring_value_still_uses_llm(self):
        """即使是子串关系，也必须交 LLM 做语义等价判断。"""
        props = _leaf(_prop(1, "品牌", [("11", "无品牌"), ("12", "其他")]))

        def fake(prompt, context=None, **kw):
            return {"picks": [{"key": it["key"], "picked_value_id": "11"}
                              for it in context["items"]]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake) as spy:
            overlay, patch_records, _ = resolve_attributes(
                _raw(("品牌", "无品牌/无注册商标")), 1, props, no_llm=False)
        spy.assert_called_once()
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 11)
        self.assertEqual(patch_records[0]["matchedBy"], "llm")

    def test_similar_value_sends_all_options_to_llm(self):
        """非 exact 值统一交 LLM，候选池包含全部真实 options。"""
        props = _leaf(_prop(1, "材质", [("11", "棉麻"), ("12", "全棉"), ("13", "涤纶")]))
        seen = {}

        def fake(prompt, context=None, **kw):
            seen["ctx"] = context
            return {"picks": [{"key": it["key"], "picked_value_id": "12"}
                              for it in context["items"]]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake):
            overlay, patch_records, _ = resolve_attributes(
                _raw(("材质", "棉")), 1, props, no_llm=False)

        self.assertEqual([c["value_id"] for c in seen["ctx"]["items"][0]["candidates"]],
                         ["11", "12", "13"],
                         "相似值匹配的候选池必须是完整真实 options")
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 12)
        self.assertEqual(patch_records[0]["matchedBy"], "llm")

    def test_full_miss_sends_all_options_no_overlap_prefilter(self):
        """全 miss 时候选池是**全表**,含字符零重合项。

        不能按字符重合预筛，否则「仿皮」↔「PU」/「人造革」这类语义等价但字符零重合的
        对子会被直接筛掉，LLM 再没机会看到。
        """
        props = _leaf(_prop(1, "材质", [("11", "PU"), ("12", "人造革"), ("13", "涤纶")]))
        seen = {}

        def fake(prompt, context=None, **kw):
            seen["ctx"] = context
            return {"picks": [{"key": it["key"], "picked_value_id": "12"}
                              for it in context["items"]]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake):
            overlay, _, _ = resolve_attributes(
                _raw(("材质", "仿皮")), 1, props, no_llm=False)

        self.assertEqual(len(seen["ctx"]["items"][0]["candidates"]), 3,
                         "全 miss 的候选池必须是全表,不做任何字符预筛")
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 12)

    def test_llm_null_leaves_value_blank(self):
        """LLM 说「没有等价值」→ 留空并交人工,不勉强选近似值。

        SKILL.md 记着实测把「帆布」选成「毛绒」的教训:留空是看得见的空缺,
        选错是看不见的错值。
        """
        props = _leaf(_prop(1, "材质", [("11", "毛绒"), ("12", "涤纶")]))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=lambda *a, **k: {"picked_value_id": None, "reason": "无等价项"}):
            overlay, patch_records, _ = resolve_attributes(
                _raw(("材质", "帆布")), 1, props, no_llm=False)
        self.assertEqual(overlay[0]["doudianValues"], [])
        self.assertEqual(patch_records[0]["matchedBy"], "none")

    def test_llm_hallucinated_value_id_is_rejected(self):
        """LLM 返回候选外的 id 视同没选中,不去全表兜底。"""
        props = _leaf(_prop(1, "材质", [("11", "毛绒")]))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=lambda *a, **k: {"picked_value_id": "99999"}):
            overlay, _, _ = resolve_attributes(
                _raw(("材质", "帆布")), 1, props, no_llm=False)
        self.assertEqual(overlay[0]["doudianValues"], [])

    def test_llm_value_channel_failure_marked(self):
        """值层 LLM 通道失败 → 留空,并在补丁里标 llm_error 以便审计。"""
        props = _leaf(_prop(1, "材质", [("11", "毛绒")]))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=RuntimeError("opencode not found")):
            overlay, patch_records, _ = resolve_attributes(
                _raw(("材质", "帆布")), 1, props, no_llm=False)
        self.assertEqual(overlay[0]["doudianValues"], [])
        self.assertEqual(patch_records[0]["matchedBy"], "llm_error")

    def test_no_llm_does_not_guess_ambiguous_values(self):
        """--no-llm(CI / 离线)遇到多子串或全 miss 都留空，不猜值。"""
        props = _leaf(_prop(1, "材质", [("11", "棉麻"), ("12", "全棉")]))
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            overlay, _, _ = resolve_attributes(
                _raw(("材质", "棉")), 1, props, no_llm=True)
            miss, _, _ = resolve_attributes(
                _raw(("材质", "帆布")), 1, props, no_llm=True)
        spy.assert_not_called()
        self.assertEqual(overlay[0]["doudianValues"], [])
        self.assertEqual(miss[0]["doudianValues"], [])

    def test_all_values_resolved_in_one_batch_call(self):
        """全部待定属性值合并成**一次**调用,且结果按来源顺序回填。

        原实现是每个值一次调用、最多 3 路并发,而 opencode 把会话状态存在本地
        SQLite,多进程同时写就报 `database is locked` —— 失败又会被 fail-closed
        当成「无等价项」落 pending,一条真实可映射的值就白丢了。串行批处理不存在
        这个竞争,也不需要靠重试兜。这条断言就是防止并发被改回来。
        """
        props = _leaf(
            _prop(1, "材质", [("11", "棉")]),
            _prop(2, "风格", [("21", "可爱")]),
            _prop(3, "版型", [("31", "宽松")]),
            _prop(4, "功能", [("41", "透气")]),
        )

        def fake(prompt, context=None, **kw):
            # 每项只能从**自己的** candidates 里取,跨项取值是错的
            return {"picks": [{"key": it["key"],
                               "picked_value_id": it["candidates"][0]["value_id"]}
                              for it in context["items"]]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake) as spy:
            overlay, _, unresolved = resolve_attributes(
                _raw(
                    ("材质", "棉质"),
                    ("风格", "可爱型"),
                    ("版型", "宽松版"),
                    ("功能", "透气性"),
                ),
                1,
                props,
                no_llm=False,
            )

        self.assertEqual(spy.call_count, 1, "4 个值必须合并成一次调用")
        self.assertEqual([a["doudianValues"][0]["valueId"] for a in overlay],
                         [11, 21, 31, 41], "批处理不得打乱来源顺序")
        self.assertEqual(unresolved, [])

class TestPropertyNameMatch(unittest.TestCase):
    """属性名匹配:删掉唯一候选盲采 + LLM null 出口 + 不再静默丢弃。"""

    def test_single_candidate_no_longer_blind_picked(self):
        """「上市年份季节」只与「适用年龄」共享一个「年」字,改前是唯一候选直采 —— 静默错映射。"""
        props = _leaf(_prop(2595, "适用年龄", [("11", "15周岁以上")]))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=lambda *a, **k: {"picked_property_id": None,
                                                "reason": "年份季节与适用年龄无关"}) as spy:
            overlay, _, unresolved = resolve_attributes(
                _raw(("上市年份季节", "2025年春季")), 1, props, no_llm=False)
        spy.assert_called_once()
        self.assertEqual(overlay, [], "LLM 判定无对应时不得落进 overlay")
        self.assertEqual(len(unresolved), 1)
        # 「查清楚了确实没有」有自己的 code —— 它不阻塞发布（见 project.verdict 的
        # NON_BLOCKING_PENDING_CODES）。通道失败那种仍是 attribute_name_unmapped。
        self.assertEqual(unresolved[0]["code"], "attribute_name_no_counterpart")
        self.assertEqual(unresolved[0]["evidence"], "上市年份季节")

    def test_llm_channel_failure_still_blocks(self):
        """LLM 通道失败 ≠ 该类目没有这个属性。前者是「没查清楚」，必须继续挡住发布，
        所以它不能拿到那个可豁免的 code —— 否则一次模型抽风就变成一句「类目里没有」。"""
        props = _leaf(_prop(2595, "适用年龄", [("11", "15周岁以上")]))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=RuntimeError("connection refused")):
            _overlay, _records, unresolved = resolve_attributes(
                _raw(("上市年份季节", "2025年春季")), 1, props, no_llm=False)
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["code"], "attribute_name_unmapped",
                         f"通道失败被当成了「类目里没有」：{unresolved[0]}")

    def test_exact_name_skips_llm(self):
        """属性名完全相同时不花 LLM 调用。"""
        props = _leaf(_prop(3127, "材质", [("11", "毛绒")]),
                      _prop(1, "材质说明", []))
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            overlay, _, _ = resolve_attributes(
                _raw(("材质", "毛绒")), 1, props, no_llm=False)
        spy.assert_not_called()
        self.assertEqual(overlay[0]["doudianPropertyId"], 3127)

    def test_name_channel_failure_is_not_silent_fallback(self):
        """LLM 通道失败 → 落 unresolved 并写明原因,**不**回落 top[0] 盲采。"""
        props = _leaf(_prop(2595, "适用年龄", [("11", "15周岁以上")]))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=RuntimeError("opencode timeout")):
            overlay, _, unresolved = resolve_attributes(
                _raw(("上市年份季节", "2025年春季")), 1, props, no_llm=False)
        self.assertEqual(overlay, [])
        self.assertEqual(len(unresolved), 1)
        self.assertIn("通道失败", unresolved[0]["message"])
        self.assertIn("opencode timeout", unresolved[0]["message"])

    def test_offline_non_exact_name_lands_in_unresolved(self):
        """离线路径只接受完全同名,不做字符串猜测,但要留痕。

        改前是按字符重合度取榜首硬猜(「上市年份季节」→「适用年龄」,只共享一个
        「年」字);再改前是直接 continue,产物里毫无痕迹。现在既不猜也不静默。
        """
        props = _leaf(_prop(3127, "材质", [("11", "毛绒")]))
        overlay, _, unresolved = resolve_attributes(
            _raw(("风格", "清新甜美")), 1, props, no_llm=True)
        self.assertEqual(overlay, [])
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["evidence"], "风格")
        self.assertIn("完全同名", unresolved[0]["message"])

    def test_zero_overlap_still_reaches_llm(self):
        """生产路径:字符零重合不再是准入门槛,「功能」↔「玩具类型」照样送进 LLM。

        改前召回层 `token_overlap > 0` 过滤把这类语义相关但字符零重合的对子
        直接 continue 掉,LLM 连看都看不到 —— 这是漏映射的最大一类。
        """
        props = _leaf(_prop(2108, "玩具类型", [("11", "毛绒玩具")], required=1),
                      _prop(3127, "材质", [("21", "毛绒")]))
        seen = {}

        def fake(prompt, context=None, **kw):
            if "source_attributes" in (context or {}):
                seen["ctx"] = context
                return {"mappings": [{"index": 0, "picked_property_id": "2108",
                                      "reason": "功能即玩具类型"}]}
            return {"picks": [{"key": it["key"], "picked_value_id": "11"}
                              for it in context["items"]]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake):
            overlay, _, unresolved = resolve_attributes(
                _raw(("功能", "毛绒玩具")), 1, props, no_llm=False)

        self.assertEqual(len(seen["ctx"]["candidates"]), 2,
                         "候选池必须是全表属性名,不被字符重合过滤")
        self.assertEqual(unresolved, [])
        self.assertEqual(overlay[0]["doudianPropertyId"], 2108)
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 11)

    def test_property_not_reused_across_source_attrs(self):
        """一个抖店属性只能被一条来源属性占用。

        project_product_format_new 是 `out[str(pid)] = confirmed` 直接赋值,
        两条 source 属性映射到同一 pid 时后者**静默覆盖**前者的值 —— 实测「风格」
        和「图案」都被 LLM 判给 prop 1869。exact 命中的属性在批调用前就被预留,
        压根不进候选池。
        """
        props = _leaf(_prop(1869, "图案", [("11", "卡通动漫")]),
                      _prop(1752, "种类", [("21", "挂件")]))
        pools = []

        def fake(prompt, context=None, **kw):
            if "source_attributes" not in (context or {}):
                return {"picks": [{"key": it["key"], "picked_value_id": None}
                                  for it in context["items"]]}
            pools.append([c["name"] for c in context["candidates"]])
            return {"mappings": [{"index": 0,
                                  "picked_property_id": context["candidates"][0]["property_id"]}]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake):
            overlay, _, unresolved = resolve_attributes(
                _raw(("图案", "卡通动漫"), ("风格", "清新甜美")), 1, props, no_llm=False)

        # 「图案」走 exact 不进批;「风格」的候选里 1869 已被摘掉
        self.assertEqual(pools, [["种类"]],
                         "已被 exact 占用的属性必须从候选池里摘掉")
        self.assertEqual([a["doudianPropertyId"] for a in overlay], [1869, 1752])
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["code"], "attribute_value_unmapped")
        self.assertIn("清新甜美", unresolved[0]["evidence"])

    def test_all_properties_exhausted_lands_in_unresolved(self):
        """类目属性被占满后,剩下的来源属性落 pending 而不是崩。"""
        props = _leaf(_prop(1869, "图案", [("11", "卡通动漫")]))
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            overlay, _, unresolved = resolve_attributes(
                _raw(("图案", "卡通动漫"), ("风格", "清新甜美")), 1, props, no_llm=False)
        spy.assert_not_called()
        self.assertEqual(len(overlay), 1)
        self.assertEqual(len(unresolved), 1)
        self.assertIn("占满", unresolved[0]["message"])

    def test_no_llm_refuses_to_guess_a_non_identical_name(self):
        """--no-llm 不再按字符重合硬猜属性名。

        这条测试原本断言的是**反面教材**:离线路径把「上市年份季节」映射到
        「适用年龄」并视为正确 —— 两者只共享一个「年」字,SKILL.md 自己就拿这对
        当盲采的例子。字符重合度删除后,离线路径只接受完全同名,对不上就留痕不映射。
        """
        props = _leaf(_prop(2595, "适用年龄", [("11", "15周岁以上")]))
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            overlay, _, unresolved = resolve_attributes(
                _raw(("上市年份季节", "2025年春季")), 1, props, no_llm=True)
        spy.assert_not_called()
        self.assertEqual(overlay, [], "离线路径不许猜出一个属性来")
        self.assertEqual(len(unresolved), 1)
        self.assertEqual(unresolved[0]["code"], "attribute_name_unmapped")
        self.assertIn("完全同名", unresolved[0]["message"])

    def test_all_property_names_resolved_in_one_batch_call(self):
        """全部属性名映射合并成**一次**调用,结果按来源顺序回填。

        原实现每条一次调用、最多 3 路并发 —— 既抢 opencode 的本地 SQLite 锁,
        又因为各判各的会把同一个抖店属性分给两条来源属性,只能事后冲突重试。
        一次给全,模型自己就能当成分配问题做。
        """
        props = _leaf(
            _prop(1, "属性甲"),
            _prop(2, "属性乙"),
            _prop(3, "属性丙"),
            _prop(4, "属性丁"),
        )
        source_to_property = {"来源甲": "1", "来源乙": "2", "来源丙": "3", "来源丁": "4"}

        def fake(prompt, context=None, **kw):
            self.assertIn("source_attributes", context or {},
                          "属性名决策必须整批送,不是逐条")
            return {"mappings": [
                {"index": s["index"], "picked_property_id": source_to_property[s["name"]]}
                for s in context["source_attributes"]
            ]}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake) as spy:
            overlay, _, unresolved = resolve_attributes(
                _raw(("来源甲", ""), ("来源乙", ""), ("来源丙", ""), ("来源丁", "")),
                1,
                props,
                no_llm=False,
            )

        self.assertEqual(spy.call_count, 1, "4 条属性名必须合并成一次调用")
        self.assertEqual([a["doudianPropertyId"] for a in overlay], [1, 2, 3, 4])
        self.assertEqual(unresolved, [])

class TestFillRequiredAttributes(unittest.TestCase):
    """必填属性自动填写:只填有 options 的,且必须带证据。"""

    RAW = {
        "BaseInfo": {
            "Title": "超萌kitty公仔毛绒玩偶挂件",
            "Attr": {"SourceAttr": [{"Label": "风格", "Value": "清新甜美"}]},
        },
        "PriceAndStock": {"SkuProperties": [
            {"PropertyName": "颜色", "Values": [{"ValueName": "粉色"}]}]},
    }

    def _leaf_data(self, *props):
        return {"name": "毛绒玩偶/公仔", "props": list(props)}

    def test_fills_enumerated_required_gap(self):
        """有 options 的必填缺口 → 按标题推断填上,并带证据。"""
        leaf = self._leaf_data(
            _prop(2108, "玩具类型", [("11", "毛绒玩具"), ("12", "积木")], required=1))
        seen = {}

        def fake(prompt, context=None):
            seen["ctx"] = context
            return {"picked_value_id": "11", "evidence": "标题含「毛绒玩偶」"}

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake):
            overlay, records, notes = fill_required_attributes(
                self.RAW, leaf, covered_ids=set(), no_llm=False)

        self.assertEqual(seen["ctx"]["title"], "超萌kitty公仔毛绒玩偶挂件")
        self.assertEqual(seen["ctx"]["source_attributes"],
                         [{"name": "风格", "value": "清新甜美"}],
                         "没映射上的 source 属性也要进上下文 —— 它对推断别的属性有用")
        self.assertEqual(seen["ctx"]["sku_dimensions"],
                         [{"name": "颜色", "values": ["粉色"]}])

        self.assertEqual(len(overlay), 1)
        self.assertEqual(overlay[0]["doudianPropertyId"], 2108)
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 11)
        self.assertEqual(records[0]["matchedBy"], "llm_inferred")
        self.assertEqual(records[0]["evidence"], "标题含「毛绒玩偶」")
        self.assertEqual(notes[0]["code"], "required_attribute_inferred")

    def test_overlay_entry_carries_rawvalue_and_values(self):
        """追加项必须自带 rawValue / values。

        canonical.schema 把这两个列为 attributes 项的 required,而 projection 的
        _attribute_index 正是读它们判「填没填」—— 缺了的话属性追加进去了,
        必填检测却仍然报缺失,等于白填。
        """
        leaf = self._leaf_data(_prop(2108, "玩具类型", [("11", "毛绒玩具")], required=1))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=lambda *a, **k: {"picked_value_id": "11", "evidence": "标题"}):
            overlay, _, _ = fill_required_attributes(
                self.RAW, leaf, covered_ids=set(), no_llm=False)
        self.assertEqual(overlay[0]["rawValue"], "毛绒玩具")
        self.assertEqual(overlay[0]["values"], ["毛绒玩具"])
        self.assertEqual(overlay[0]["sourceName"], "玩具类型")

    def test_never_fills_free_text_required(self):
        """无 options 的必填属性一律不碰 —— 那是「生产企业名称」「统一社会信用代码」
        这类只能由商家提供的字段,让模型写就是造假证。"""
        leaf = self._leaf_data(
            _prop(4129, "生产企业统一社会信用代码", [], required=1),
            _prop(1479, "生产企业名称", [], required=1))
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            overlay, records, notes = fill_required_attributes(
                self.RAW, leaf, covered_ids=set(), no_llm=False)
        spy.assert_not_called()
        self.assertEqual((overlay, records, notes), ([], [], []))

    def test_skips_already_covered_property(self):
        """已被来源属性占用的必填项不碰 —— 哪怕它的值是 diyType=1 待人工。

        「材质=帆布」映射上了但没匹到 value_id,绝不能被推断成「毛绒」顶掉。
        """
        leaf = self._leaf_data(_prop(3127, "材质", [("11", "毛绒")], required=1))
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            overlay, _, _ = fill_required_attributes(
                self.RAW, leaf, covered_ids={"3127"}, no_llm=False)
        spy.assert_not_called()
        self.assertEqual(overlay, [])

    def test_skips_hidden_and_optional(self):
        """hidden 必填项 / 非必填项都不填 —— 与 projection 的缺失检测同口径。"""
        leaf = self._leaf_data(
            _prop(1, "隐藏必填", [("11", "x")], required=1),
            _prop(2, "选填项", [("21", "y")], required=0))
        leaf["props"][0]["hidden"] = True
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            overlay, _, _ = fill_required_attributes(
                self.RAW, leaf, covered_ids=set(), no_llm=False)
        spy.assert_not_called()
        self.assertEqual(overlay, [])

    def test_llm_null_leaves_gap_open(self):
        """依据不足 → 不填,也不落 finding(projection 层已经在报这一条,别记双份账)。"""
        leaf = self._leaf_data(_prop(2108, "玩具类型", [("11", "毛绒玩具")], required=1))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=lambda *a, **k: {"picked_value_id": None, "evidence": ""}):
            overlay, records, notes = fill_required_attributes(
                self.RAW, leaf, covered_ids=set(), no_llm=False)
        self.assertEqual((overlay, records, notes), ([], [], []))

    def test_hallucinated_id_rejected(self):
        """LLM 返回候选外的 id → 视同没推断出来,不去枚举里随便抓一个。"""
        leaf = self._leaf_data(_prop(2108, "玩具类型", [("11", "毛绒玩具")], required=1))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=lambda *a, **k: {"picked_value_id": "99999", "evidence": "x"}):
            overlay, _, _ = fill_required_attributes(
                self.RAW, leaf, covered_ids=set(), no_llm=False)
        self.assertEqual(overlay, [])

    def test_no_llm_disables_inference(self):
        """--no-llm 下整个功能关闭:没有 LLM 就没有推断能力,不做任何猜测。"""
        leaf = self._leaf_data(_prop(2108, "玩具类型", [("11", "毛绒玩具")], required=1))
        with patch("scripts.build_doudian_product.ask_llm") as spy:
            out = fill_required_attributes(self.RAW, leaf, covered_ids=set(), no_llm=True)
        spy.assert_not_called()
        self.assertEqual(out, ([], [], []))

    def test_llm_channel_failure_leaves_gap_open(self):
        """LLM 通道失败 → 缺口原样留着,不回落任何兜底值。"""
        leaf = self._leaf_data(_prop(2108, "玩具类型", [("11", "毛绒玩具")], required=1))
        with patch("scripts.build_doudian_product.ask_llm",
                   side_effect=RuntimeError("opencode timeout")):
            overlay, records, notes = fill_required_attributes(
                self.RAW, leaf, covered_ids=set(), no_llm=False)
        self.assertEqual((overlay, records, notes), ([], [], []))


class 孤儿规格值清理Tests(unittest.TestCase):
    """剔除无效 SKU 后，规格维度必须同步收缩。

    实测工控机(996299841528)：89 个 SKU 里 14 个「麒麟/鸿蒙」库存为 null 被质量红线剔掉，
    但「麒麟/鸿蒙」还留在 版本 维度里。规则 5 于是拿 6×15=90 去比 75，把整个商品判死。
    """

    def _canonical(self):
        return {
            "specs": [
                {"name": "版本", "values": [{"value": "win"}, {"value": "安卓"}, {"value": "鸿蒙"}]},
                {"name": "尺寸", "values": [{"value": "7寸"}, {"value": "8寸"}]},
            ],
            "skus": [
                {"specs": [{"name": "版本", "value": "win"}, {"name": "尺寸", "value": "7寸"}]},
                {"specs": [{"name": "版本", "value": "win"}, {"name": "尺寸", "value": "8寸"}]},
                {"specs": [{"name": "版本", "value": "安卓"}, {"name": "尺寸", "value": "7寸"}]},
                {"specs": [{"name": "版本", "value": "安卓"}, {"name": "尺寸", "value": "8寸"}]},
            ],
        }

    def test_没有sku引用的规格值被剔除(self):
        c = self._canonical()
        pruned = product_builder.prune_orphan_spec_values(c)
        self.assertEqual(pruned, ["版本=鸿蒙"])
        self.assertEqual([v["value"] for v in c["specs"][0]["values"]], ["win", "安卓"])

    def test_剔除后sku数等于笛卡尔积(self):
        c = self._canonical()
        product_builder.prune_orphan_spec_values(c)
        combos = 1
        for spec in c["specs"]:
            combos *= len(spec["values"])
        self.assertEqual(combos, len(c["skus"]))

    def test_全部有引用时不动任何值(self):
        c = self._canonical()
        c["skus"].append({"specs": [{"name": "版本", "value": "鸿蒙"},
                                    {"name": "尺寸", "value": "7寸"}]})
        self.assertEqual(product_builder.prune_orphan_spec_values(c), [])
        self.assertEqual(len(c["specs"][0]["values"]), 3)


class 精确命中捷径必须过贴切校验Tests(unittest.TestCase):
    """来源文本里出现某个叶子类目的名字，只是线索，不是判决。

    实测：一件女装长袖 T 恤（标题「80s液氨丝光棉正肩白色长袖T恤女…内搭打底衫」）
    因为字面出现「打底衫」被直接拍进【服装/男装/打底衫】——抖店根本没有女装打底衫
    这个叶子，正解是【服装/女装/T恤/Polo衫】。捷径 return 在逐级下钻之前，
    于是「先判一级、再判二级、直到末级」一次都没跑。
    """

    RAW = {"Title": "80s液氨丝光棉正肩白色长袖T恤女26秋季新款匹马棉圆领内搭打底衫"}
    LEAVES = {"1000003411": "服装/男装/打底衫", "1000003396": "服装/女装/T恤/Polo衫"}

    def _run(self, fits_answer):
        calls = []

        def fake_llm(prompt, context=None, tier=None):
            calls.append(prompt)
            if '"fits": true|false, "reason"' in prompt and '"picked"' not in prompt:
                return {"fits": fits_answer, "reason": "测试桩"}
            return {"picked": "服装", "fits": True, "reason": "测试桩"}

        with mock.patch.object(product_builder, "_ask_llm", fake_llm), \
             mock.patch.object(product_builder, "_exact_leaf_match",
                               lambda raw, lp: (1000003411, "服装/男装/打底衫")):
            ok, why = product_builder._verify_leaf_fits(
                {"title": self.RAW["Title"]}, "服装/男装/打底衫")
        return ok, calls

    def test_校验不通过时捷径不算数(self):
        ok, calls = self._run(False)
        self.assertFalse(ok, "fits=false 必须让捷径失效，落回逐级下钻")
        self.assertTrue(calls, "必须真的问过模型，而不是直接采信字面命中")

    def test_校验通过时捷径仍然有效(self):
        ok, calls = self._run(True)
        self.assertTrue(ok)
        self.assertGreaterEqual(len(calls), 2, "要全票通过，单票不算数")

    def test_一票否决就够不必再问(self):
        seq = [True, False]
        calls = []

        def flaky(prompt, context=None, tier=None):
            calls.append(prompt)
            return {"fits": seq[min(len(calls) - 1, len(seq) - 1)], "reason": "抖动"}

        with mock.patch.object(product_builder, "_ask_llm", flaky):
            ok, _ = product_builder._verify_leaf_fits({"title": "x"}, "服装/男装/打底衫")
        self.assertFalse(ok, "单次抖动的 true 不能把错类目放进来")

    def test_校验没跑成时落回逐级下钻而不是放行(self):
        """校验不了的捷径不能背书放行。

        先前这里写的是「按通过处理」，理由是「没回答不等于否定」。但捷径是启发式、
        逐级下钻才是权威，而本文件既有原则明写「返回 None 比发一个错类目安全」
        （见 resolve_category 文档）。校验没跑成就采信捷径，等于在最没把握的时候
        跳过权威流程——女装被拍进男装就是这么来的。
        """
        def boom(prompt, context=None, tier=None):
            raise RuntimeError("通道挂了")
        with mock.patch.object(product_builder, "_ask_llm", boom):
            ok, why = product_builder._verify_leaf_fits({"title": "x"}, "服装/男装/打底衫")
        self.assertFalse(ok)
        self.assertIn("落回逐级下钻", why)

    def test_预算不够时不借也不放行(self):
        """捷径校验和逐级下钻共用同一份商品级预算。

        实测：两次 strong 档校验就能把 480 秒吃光，下钻第一次调用直接抛
        「LLM budget exhausted」，表现成「顶层没有给出有效候选」。
        """
        with mock.patch.object(product_builder, "_llm_budget_remaining", lambda: 10.0), \
             mock.patch.object(product_builder, "_ask_llm",
                               lambda *a, **k: self.fail("预算不够就不该发起调用")):
            ok, why = product_builder._verify_leaf_fits({"title": "x"}, "服装/男装/打底衫")
        self.assertFalse(ok)
        self.assertIn("预算", why)


class 类目名里的斜杠不是路径分隔符Tests(unittest.TestCase):
    """抖店 4275 个叶子里有 771 个名字自带斜杠（18%）。

    实测：一件女式圆领长袖 T 恤本该落在【服装/女装/T恤/Polo衫】——那是**一个**
    名叫「T恤/Polo衫」的叶子。按 "/" 切 path 会把它劈成 T恤 → Polo衫 两层，
    模型走到「Polo衫」那层正确地判「这不是 Polo 衫」，然后一路回退到顶层放弃。
    模型没错，是我们把它放到了一个不存在的层级上。
    """

    ROOTS = [{
        "id": 1, "name": "服装", "is_leaf": False,
        "children": [{
            "id": 2, "name": "女装", "is_leaf": False,
            "children": [{"id": 1000003396, "name": "T恤/Polo衫", "is_leaf": True,
                          "children": []}],
        }],
    }]

    def test_按嵌套结构建树时叶子名保持完整(self):
        tree = product_builder._category_tree_from_nodes(self.ROOTS)
        self.assertEqual(sorted(tree["children"]), ["服装"])
        女装 = tree["children"]["服装"]["children"]["女装"]
        self.assertEqual(sorted(女装["children"]), ["T恤/Polo衫"],
                         "「T恤/Polo衫」是一个类目，不能被劈成两层")
        self.assertEqual(女装["children"]["T恤/Polo衫"]["leaf_id"], 1000003396)

    def test_按路径切分会劈坏叶子名(self):
        # 记录旧路径的错误行为：这正是必须改用嵌套结构的理由
        bad = product_builder._category_tree({"1000003396": "服装/女装/T恤/Polo衫"})
        女装 = bad["children"]["服装"]["children"]["女装"]
        self.assertEqual(sorted(女装["children"]), ["T恤"],
                         "切字符串会造出一个不存在的「T恤」中间层")
        self.assertIsNone(女装["children"]["T恤"]["leaf_id"])

    def test_doudianPath_不把叶子名劈成两段(self):
        """这份路径是发布 book 点类目的依据，多一层假层级就点不到。"""
        segs = product_builder._leaf_path_segments(self.ROOTS, 1000003396)
        self.assertEqual(segs, ["服装", "女装", "T恤/Polo衫"])

    def test_树里找不到该叶子时返回None让调用方兜底(self):
        self.assertIsNone(product_builder._leaf_path_segments(self.ROOTS, 999999))
        self.assertIsNone(product_builder._leaf_path_segments(None, 1000003396))

    def test_精确匹配用权威名字而不是路径末段(self):
        raw = {"BaseInfo": {"Title": "女式圆领长袖T恤/Polo衫 通勤"}}
        paths = {"1000003396": "服装/女装/T恤/Polo衫"}
        names = {"1000003396": "T恤/Polo衫"}
        hit = product_builder._exact_leaf_match(raw, paths, names)
        self.assertIsNotNone(hit, "给了权威名字就该按完整名字匹配")
        self.assertEqual(hit[0], 1000003396)


class LLM预算装饰器归属Tests(unittest.TestCase):
    """@_with_llm_budget 必须贴在 build_doudian_product 上。

    真实事故：在 build_doudian_product 之前插入一个新函数时，把它插进了装饰器和
    函数定义【之间】，装饰器于是贴到了新函数上。三个后果全是静默的——
    build_doudian_product 失去 LLM 预算控制、不再接受 llm_budget_seconds、
    调用它的 flow 适配器从此报 unexpected keyword argument（既有 flow 直接坏掉）。
    Python 不会为此报错，只有真正调用才暴露。
    """

    def test_装饰器贴在正确的函数上(self):
        self.assertTrue(hasattr(product_builder.build_doudian_product, "__wrapped__"),
                        "build_doudian_product 必须被 _with_llm_budget 包住")
        self.assertFalse(hasattr(product_builder.prune_orphan_spec_values, "__wrapped__"),
                         "纯函数不该被预算装饰器包住——那是装饰器贴错了对象")

    def test_接受llm_budget_seconds关键字(self):
        """flow 适配器就是这么传的；不接受这个关键字等于把适配器打死。"""
        captured = {}

        def fake_inner(*args, **kwargs):
            captured.update(kwargs)
            return {"ok": True}

        wrapped = product_builder._with_llm_budget(fake_inner)
        wrapped(raw={}, llm_budget_seconds=120, no_llm=True)
        self.assertNotIn("llm_budget_seconds", captured,
                         "装饰器要把它吃掉，不能透传给内层函数")


class 候选名匹配放宽空白Tests(unittest.TestCase):
    """模型回的名字要能对回候选集，否则「选对了」会被当成「没选出来」。

    真实事故：本地模型回 "T 恤/Polo 衫"（中英混排加了空格），候选是 "T恤/Polo衫"。
    精确相等匹配不上 → _pick_child 认为没有有效候选 → 回退并把【正确的】男装分支
    排除掉 → 一路走到「服装/特殊服装/其他特殊服装」。判断没错，是匹配把答案丢了。
    """

    AVAIL = ["T恤/Polo衫", "衬衫", "卫衣", "针织衫/毛衣/羊毛衫"]

    def test_中英混排的空格不该让答案丢失(self):
        self.assertEqual(product_builder._match_candidate("T 恤/Polo 衫", self.AVAIL), "T恤/Polo衫")

    def test_精确命中原样返回(self):
        self.assertEqual(product_builder._match_candidate("衬衫", self.AVAIL), "衬衫")

    def test_只放宽空白_不放宽语义(self):
        """再松一档就会把真正不同的候选混起来，那是另一类错误。"""
        self.assertIsNone(product_builder._match_candidate("T恤", self.AVAIL))
        self.assertIsNone(product_builder._match_candidate("毛衣", self.AVAIL))

    def test_空值与不存在的候选返回None(self):
        self.assertIsNone(product_builder._match_candidate("", self.AVAIL))
        self.assertIsNone(product_builder._match_candidate("汤勺", self.AVAIL))


class QualityReportShapeTests(unittest.TestCase):
    """qualityReport 四个桶里每一条都必须是带 code 的 finding 对象。

    实测撞上：软水壶那轮 8 条 warning 里 7 个 dict、1 个裸字符串
    （「剔除无 SKU 引用的规格值 1 个: 颜色=天蓝色+白色」）。任何按 w["code"]
    过滤或计数的读取方要么当场崩，要么静默漏掉它 —— 而它恰恰是「SKU 被质量红线
    剔掉之后规格少了几个」这条最该被人看见的账。
    """

    def _run_with(self, canonical):
        with patch("scripts.build_doudian_product.build_canonical", return_value=canonical):
            return build_doudian_product(
                {}, profile=None, no_llm=True, schema=MOCK_SCHEMA,
                leaves={}, props_by_leaf={}, no_project=True, download_images=False,
                tree_path=None, props_path=None,
            )

    def test_孤儿规格值告警是_finding_对象而不是裸字符串(self):
        canonical = {
            "specs": [{"name": "颜色", "values": [
                {"value": "红"}, {"value": "蓝"}, {"value": "绿"}]}],
            "skus": [{"specs": [{"name": "颜色", "value": v}], "stock": 3, "sourcePrice": 1.0}
                     for v in ("红", "蓝")],
            "qualityReport": {"errors": [], "risks": [], "warnings": [], "pending": []},
        }
        qr = self._run_with(canonical)["canonical"]["qualityReport"]

        for bucket in ("errors", "risks", "warnings", "pending"):
            for item in qr.get(bucket) or []:
                self.assertIsInstance(
                    item, dict, f"{bucket} 里混进了 {type(item).__name__}: {item!r}")
                self.assertIn("code", item, f"{bucket} 里有条目没有 code: {item!r}")

        self.assertIn("orphan_spec_values_pruned", [w["code"] for w in qr["warnings"]])
        msg = next(w["message"] for w in qr["warnings"]
                   if w["code"] == "orphan_spec_values_pruned")
        self.assertIn("绿", msg, "被剔掉的规格值名要留在报文里，否则人不知道少了什么")

    def test_没有孤儿时不刷这条告警(self):
        canonical = {
            "specs": [{"name": "颜色", "values": [{"value": "红"}, {"value": "蓝"}]}],
            "skus": [{"specs": [{"name": "颜色", "value": v}], "stock": 3, "sourcePrice": 1.0}
                     for v in ("红", "蓝")],
            "qualityReport": {"errors": [], "risks": [], "warnings": [], "pending": []},
        }
        qr = self._run_with(canonical)["canonical"]["qualityReport"]
        self.assertNotIn("orphan_spec_values_pruned",
                         [w.get("code") for w in qr.get("warnings") or []])


class 逐级下钻回退Tests(unittest.TestCase):
    """回退机制的四条契约。靶子是实测的吹风机那轮：

        1. (顶层)   → 个人护理      fits=true
        2. 个人护理  → 洗发护发      fits=true
        3. 洗发护发  → 护发精油      fits=FALSE 「候选列表中无对应电器类目」
        4. 个人护理  → 洗护美用具    fits=true   ← 只退一层，在错分支里换了条路
        5. 洗护美用具→ 其他洗护美用具 fits=true   ← 兜底叶子，恒为真，再不回退

    模型在第 3 步已经知道整条分支都错了，系统却只退一层。
    """

    PATHS = {
        "1": "电器/个护健康电器/电吹风",
        "2": "个人护理/洗发护发/护发精油",
        "3": "个人护理/洗护美用具/其他洗护美用具",
    }

    def _run(self, script):
        """script: trail 元组 → (name, fits, backTo)"""
        seen = []

        # **kw 与兄弟桩 fake_llm 一致：桩不该因为被测函数多了一个可选参数就整批变红。
        # 这里记下 images 是为了下面那条断言 —— 顶层带图、其余层不带。
        def fake_pick(product, trail, node, excluded, votes, tried_paths=None, **kw):
            seen.append({"trail": list(trail), "excluded": sorted(excluded),
                         "tried": list(tried_paths or []),
                         "images": kw.get("images")})
            name, fits, back = script(tuple(trail))
            return name, "测试桩", fits, back

        with mock.patch.object(product_builder, "_pick_child", fake_pick), \
             mock.patch.object(product_builder, "_exact_leaf_match", lambda *a, **k: None):
            cat = product_builder.resolve_category(
                {"BaseInfo": {"Title": "吹风机"}}, {}, no_llm=False,
                leaf_paths=self.PATHS, tree_roots=None, leaf_names={})
        return cat, seen

    def test_模型说退到顶层就真的退到顶层(self):
        """backTo=0 时必须回到顶层重选一级，而不是只退一层。"""
        state = {"bounced": False}

        def script(trail):
            if trail == ():
                return ("电器", True, None) if state["bounced"] else ("个人护理", True, None)
            if trail == ("个人护理",):
                return ("洗发护发", True, None)
            if trail == ("个人护理", "洗发护发"):
                state["bounced"] = True
                return ("护发精油", False, 0)          # ← 明确要求退回顶层
            if trail == ("电器",):
                return ("个护健康电器", True, None)
            if trail == ("电器", "个护健康电器"):
                return ("电吹风", True, None)
            raise AssertionError(f"意外的 trail: {trail}")

        cat, seen = self._run(script)
        self.assertIsNotNone(cat, "退回顶层后应能走到电吹风")
        self.assertEqual(cat["doudianLeafId"], 1, f"实际 {cat}")
        top_calls = [c for c in seen if c["trail"] == []]
        self.assertTrue(any("个人护理" in c["excluded"] for c in top_calls),
                        f"顶层重选时未排除走错的一级，excluded 轨迹={[c['excluded'] for c in top_calls]}")

    def test_兜底叶子不直接收下而是先回退确认(self):
        """名字以「其他」开头的末级叶子，fits=true 也要先回退一次。

        这条一度被我误撤：当时只看到「三个误判跳出兜底叶子后仍然不对」，没注意
        trash-bin 正是靠它救回来的 —— 垃圾桶会落进「居家日用/收纳整理工具/
        其他收纳整理工具」，拒收并回退才找到「家装建材/垃圾处理/垃圾桶」。
        3 轮实测：有它 6/11，没它稳定 5/11。
        """
        hits = {"n": 0}

        def script(trail):
            if trail == ():
                return ("个人护理", True, None)
            if trail == ("个人护理",):
                return ("洗护美用具", True, None)
            if trail == ("个人护理", "洗护美用具"):
                hits["n"] += 1
                return ("其他洗护美用具", True, None)   # 模型坚持它，且 fits=true
            raise AssertionError(f"意外的 trail: {trail}")

        cat, seen = self._run(script)
        self.assertGreater(hits["n"], 1, "兜底叶子第一次不该直接收下，应回退后再问一次")
        self.assertIsNotNone(cat)
        self.assertIn("存疑", cat["_reason"], f"最终接受兜底叶子时必须标存疑：{cat['_reason']}")

    def test_已试过的完整路径会喂给下一次判断(self):
        """否则模型会在几条错分支之间来回绕，每次都觉得没试过。"""
        def script(trail):
            if trail == ():
                return ("个人护理", True, None)
            if trail == ("个人护理",):
                return ("洗发护发", True, None)
            if trail == ("个人护理", "洗发护发"):
                return ("护发精油", False, 1)
            raise AssertionError(f"意外的 trail: {trail}")

        cat, seen = self._run(script)
        later = [c for c in seen if c["tried"]]
        self.assertTrue(later, "回退之后的判断没有拿到 tried_paths")
        self.assertIn("个人护理/洗发护发/护发精油", later[0]["tried"])

    def test_候选排空时不能拿None当收手选择(self):
        """name 为 None 意味着「没有模型认可过的选择」，收手分支必须放行给放弃逻辑。

        实测：少了这条判据，回退到上限且该层拿不到候选时会 node["children"][None]
        抛 KeyError —— 判据集跑到第 4 例当场炸，而 91 条单测全绿没抓到。
        """
        def script(trail):
            if trail == ():
                return ("个人护理", True, None)
            if trail == ("个人护理",):
                return ("洗发护发", True, None)
            if trail == ("个人护理", "洗发护发"):
                return (None, False, None)      # 该层候选已全部排除
            raise AssertionError(f"意外的 trail: {trail}")

        cat, seen = self._run(script)   # 不抛异常即算通过
        self.assertTrue(cat is None or "doudianLeafId" in cat)

    def test_回退到上限不采用被模型否定的类目(self):
        def script(trail):
            if trail == ():
                return ("个人护理", True, None)
            if trail == ("个人护理",):
                return ("洗发护发", True, None)
            if trail == ("个人护理", "洗发护发"):
                return ("护发精油", False, None)   # 每次都说不合适
            raise AssertionError(f"意外的 trail: {trail}")

        cat, _seen = self._run(script)
        self.assertIsNone(cat)


class 品牌不变量Tests(unittest.TestCase):
    """品牌只能是【抖店品牌库匹配到的官方品牌】或【无品牌】。

    一个 valueId 为空、名字又不是「无品牌」的值，等于未授权声明他人品牌 ——
    比从候选里挑错一个更糟：挑错至少还是抖店库里的真实品牌，自由文本是凭空主张。

    实测撞上：换药弯盘盒改用抖店建议的类目「餐饮厨具/一次性餐桌用品/一次性碗/碟/盘」
    之后，该类目品牌字段是 ui=select 但 optionCount=0，于是品牌被当成【自由文本属性】，
    doudianValues 装着源站的「妙其灵」而不为空 —— 原来那条 `not doudianValues` 判据
    整个失效，发布页上试图把源站品牌填进品牌下拉（step 23 报 saw:[] 一个选项都没有）。
    """

    RAW = {"BaseInfo": {"Title": "一次性换药盘",
                        "Attr": {"SourceAttr": [{"Label": "品牌", "Value": "妙其灵"}]}}}

    def _brand_values(self, brand_options):
        props = {"1": {"name": "测试类目", "path": "测试类目",
                       "props": [{"id": 1687, "name": "品牌", "required": True,
                                  "options": [list(o) for o in brand_options]}]}}
        result = build_doudian_product(
            self.RAW, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
            leaves={}, props_by_leaf=props, no_project=True, download_images=False,
            category_leaf_id=1,
        )
        attrs = result["canonical"].get("attributes") or []
        brand = next((a for a in attrs if a.get("doudianPropertyId") == 1687), None)
        return brand

    def test_品牌字段没有选项时不得填源站品牌名(self):
        """optionCount=0 的品牌字段会走自由文本路径，doudianValues 不为空 ——
        必须靠「没有任何 valueId」这条判据兜住，而不是「值为空」。"""
        brand = self._brand_values(brand_options=())
        self.assertIsNotNone(brand, "品牌项应存在")
        names = [v.get("name") for v in brand["doudianValues"]]
        self.assertNotIn("妙其灵", names, f"源站品牌名不得作为自定义值发出：{brand}")
        self.assertEqual(names, ["无品牌"])

    def test_匹配到官方品牌时保留它(self):
        """有 valueId 说明是抖店品牌库里的真实条目，不该被退化掉。"""
        brand = self._brand_values(brand_options=[("11", "妙其灵")])
        self.assertIsNotNone(brand)
        self.assertEqual(brand["doudianValues"][0]["valueId"], 11)
        self.assertEqual(brand["doudianValues"][0]["name"], "妙其灵")

    def test_候选里有无品牌时必须用它的官方value_id(self):
        """「无品牌」在多数类目里是**官方候选值**，不是自由文本。

        写 valueId=None / diyType=1 的后果不是"少个 id"：
        build_addv2.project_product_format_new 要求 property_id 与 value_id 两者
        俱全，valueId 为空的值被踢进 pending_di，于是 product_format_new 整个投影
        不出 → projectionVerdict=needs_human → Flow 的 ready 分支不放行，商品发不
        出去。实测 FlowRun 13a7c88a-7640-44ec-a1c3-4b0763cd4a46：类目 DIY饰品套装
        的品牌槽位有 ['596120136', '无品牌']，产出却是 valueId=None。
        """
        brand = self._brand_values(brand_options=[("596120136", "无品牌")])
        self.assertIsNotNone(brand, "品牌项应存在")
        self.assertEqual([v["name"] for v in brand["doudianValues"]], ["无品牌"])
        self.assertEqual(brand["doudianValues"][0]["valueId"], 596120136,
                         f"候选里有「无品牌」就必须用它的官方 value_id：{brand}")
        self.assertEqual(brand["doudianValues"][0]["diyType"], 0,
                         "官方候选值不是自定义值，diyType 必须是 0")

    def test_来源没有品牌时补出的无品牌项保留来源语义字段(self):
        """品牌不在源站属性里时，追加项仍必须满足 canonical.attributes 契约。"""
        raw = {"BaseInfo": {"Title": "一次性换药盘", "Attr": {"SourceAttr": []}}}
        props = {"1": {"name": "测试类目", "path": "测试类目",
                       "props": [{"id": 1687, "name": "品牌", "required": True,
                                  "options": [["596120136", "无品牌"]]}]}}
        result = build_doudian_product(
            raw, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
            leaves={}, props_by_leaf=props, no_project=True, download_images=False,
            category_leaf_id=1,
        )
        brand = next(a for a in result["canonical"]["attributes"]
                     if a.get("doudianPropertyId") == 1687)
        self.assertEqual(brand["rawValue"], "无品牌")
        self.assertEqual(brand["values"], ["无品牌"])

    def test_源站有真品牌却没映射上时补项仍只能发无品牌(self):
        """补品牌项那条分支(entry is None)上，源站真品牌一样不许当自定义值发出。

        这条分支曾被认为「构造不出可达用例」——不是的：源站标签写 `Brand` 时
        src_brand 认（代码显式匹配 品牌/brand/Brand），属性匹配器在 no_llm 下按
        中文名比对却匹配不上，于是 entry is None 而 src_brand 非空，正好落进补项
        分支。此前那里写 `"无品牌" if no_brand else src_brand`，这一路就会把「妙其灵」
        当 diyType=1 自定义值发出去 —— 未授权声明他人品牌，比挑错一个官方品牌更糟。
        """
        raw = {"BaseInfo": {"Title": "一次性换药盘",
                            "Attr": {"SourceAttr": [{"Label": "Brand", "Value": "妙其灵"}]}}}
        props = {"1": {"name": "测试类目", "path": "测试类目",
                       "props": [{"id": 1687, "name": "品牌", "required": True,
                                  "options": [["596120136", "无品牌"]]}]}}
        result = build_doudian_product(
            raw, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
            leaves={}, props_by_leaf=props, no_project=True, download_images=False,
            category_leaf_id=1,
        )
        brand = next(a for a in result["canonical"]["attributes"]
                     if a.get("doudianPropertyId") == 1687)
        self.assertEqual([v["name"] for v in brand["doudianValues"]], ["无品牌"],
                         f"补项不得把源站品牌名发出去：{brand}")
        self.assertEqual(brand["rawValue"], "无品牌",
                         f"来源语义字段同样不能带上源站品牌名：{brand}")
        # 放弃品牌主张可以，抹掉「放弃了哪个名字」不行 —— 授权层面的后果要留痕。
        self.assertEqual(brand["doudianValues"][0]["sourceValue"], "妙其灵")

    def test_候选里没有无品牌时才退回自由文本形态(self):
        """有些类目的品牌槽位是 ui:search / optionCount=0，那时 diyType=1 是唯一
        能填的形状 —— 查不到才退化，不能反过来无条件退化。"""
        # 候选表里既没有源站品牌「妙其灵」也没有「无品牌」
        brand = self._brand_values(brand_options=[("12", "其他")])
        self.assertIsNotNone(brand)
        self.assertEqual([v["name"] for v in brand["doudianValues"]], ["无品牌"])
        self.assertIsNone(brand["doudianValues"][0]["valueId"])
        self.assertEqual(brand["doudianValues"][0]["diyType"], 1)


class 品牌门Tests(unittest.TestCase):
    """必填的品牌属性却零候选 = 本店在该类目发不了，预处理就该阻断。

    抖店的原话（2026-09-03 从发布页那个下拉里直接读到）：
        「暂无可选品牌 / 当前类目不支持发布无品牌商品，请申请品牌资质，
          或在已有品牌下新增所属类目」

    不是加载慢也不是控件形态问题 —— 下拉带 select-dropdown-empty 类名，点开、输入、
    等网络静默都试过，候选恒为零。落 error（verdict → blocked）而不是 warning，
    是因为它确定发不出去，让它走到发布等于白跑一轮 3 分钟。

    判据来自本店会话抓的类目属性表：4236 个叶子里 223 个品牌必填且零候选、
    4011 个候选含「无品牌」，界限干净。
    """

    RAW = {"BaseInfo": {"Title": "一次性餐盘",
                        "Attr": {"SourceAttr": [{"Label": "品牌", "Value": "妙其灵"}]}}}

    def _errors(self, brand_prop):
        props = {"1": {"name": "一次性碗/碟/盘", "path": "餐饮厨具/一次性餐桌用品/一次性碗/碟/盘",
                       "props": [brand_prop]}}
        result = build_doudian_product(
            self.RAW, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
            leaves={}, props_by_leaf=props, no_project=True, download_images=False,
            category_leaf_id=1,
        )
        qr = result["canonical"].get("qualityReport") or {}
        return [e.get("code") for e in qr.get("errors") or []]

    def test_品牌必填且零候选时阻断(self):
        codes = self._errors({"id": 1687, "name": "品牌", "required": True, "options": []})
        self.assertIn("brand_gated_category", codes,
                      f"必填品牌零候选应阻断，实际 errors={codes}")

    def test_品牌有候选时不阻断(self):
        codes = self._errors({"id": 1687, "name": "品牌", "required": True,
                              "options": [["11", "无品牌"]]})
        self.assertNotIn("brand_gated_category", codes,
                         f"有候选不该阻断，实际 errors={codes}")

    def test_品牌选填且零候选时不阻断(self):
        """选填的品牌填不上不影响发布，别把它也拦下。"""
        codes = self._errors({"id": 1687, "name": "品牌", "required": False, "options": []})
        self.assertNotIn("brand_gated_category", codes)


class 标品类目判定Tests(unittest.TestCase):
    """标品类目必须在预处理阶段就被识别出来，而不是等发布跑到第一页才炸。

    2026-09-04 实测：消毒湿巾类目下，类目映射完全正确，发布仍被第一页拦死 ——
    「选择标品 / 当前类目为标准化商品」要求关联平台标品库的 SPU，品牌与产品名称
    都是下拉选择而非自由文本，填不进自造的值。而「保存草稿」按钮在第二页，
    于是连草稿都存不下，报错还伪装成「找不到保存草稿按钮」。
    """

    def test_标品类目命中(self):
        from category_capture import is_spu_category
        entry = {"raw": {"additions": {"support_spu_product": True}}}
        self.assertTrue(is_spu_category(entry))

    def test_非标品类目不命中(self):
        from category_capture import is_spu_category
        entry = {"raw": {"additions": {"support_spu_product": False}}}
        self.assertFalse(is_spu_category(entry))

    def test_判据不是must_spu(self):
        """真正卡住我们的那个标品类目 must_spu 反而是 False —— 用它做判据会漏掉。

        这条断言把「为什么不用名字更像的那个字段」钉住：换成 must_spu 就会红。
        """
        from category_capture import is_spu_category
        entry = {"raw": {"additions": {"support_spu_product": True, "must_spu": False}}}
        self.assertTrue(is_spu_category(entry), "must_spu=False 不能否定标品判定")

    def test_缺字段时不误判为标品(self):
        """未采集成功 / 老形状条目返回 False —— 但那是「不知道」不是「不是」，
        调用方的 collection.ok 检查不能省。"""
        from category_capture import is_spu_category
        self.assertFalse(is_spu_category({}))
        self.assertFalse(is_spu_category({"raw": None}))
        self.assertFalse(is_spu_category({"raw": {"additions": {}}}))

    def test_真实快照里三个已知类目判定正确(self):
        """拿真实采集产物验，不只验构造出来的假数据。"""
        from category_capture import load_props_capture, is_spu_category
        import os
        p = os.path.join(os.path.dirname(__file__), "..", "..", "..", "reports",
                         "doudian-category-properties.json")
        if not os.path.exists(p):
            self.skipTest("类目属性采集产物不在，跳过")
        b = load_props_capture(p)
        self.assertTrue(is_spu_category(b["1000004736"]), "消毒湿巾是标品类目")
        self.assertFalse(is_spu_category(b["1000006022"]), "汽车挂摆件不是")
        self.assertFalse(is_spu_category(b["1000004861"]), "柔性墙板不是")


class TestQualificationGateAndEmptySku(unittest.TestCase):
    """两条「类目/数据本身决定发不出去」的阻断门，都必须在预处理阶段就报。

    共同点：不是商品填得好不好的问题，重试也无用 —— 属于 blocked 而非 needs_human。
    """

    def test_有必填资质的类目被判阻断(self):
        from category_capture import blocking_qualifications
        entry = {
            "collection": {"ok": True},
            "qualification": {"items": [
                {"label": "包装标签图", "required": True},
                {"label": "报关单", "required": False},        # 选填，不该算
                {"label": "隐藏项", "required": True, "hidden": True},   # 隐藏，不该算
                {"label": "不可用项", "required": True, "available": False},  # 不可用，不该算
            ]},
        }
        got = blocking_qualifications(entry)
        self.assertEqual([q["label"] for q in got], ["包装标签图"],
                         "只有 required 且未隐藏且可用的才算阻断项 —— 把选填也算进来会把 3% 的阻断面放大成一大片")

    def test_无必填资质的类目放行(self):
        from category_capture import blocking_qualifications
        entry = {"collection": {"ok": True},
                 "qualification": {"items": [{"label": "报关单", "required": False}]}}
        self.assertEqual(blocking_qualifications(entry), [])

    def test_已确认无必填资质时撤销初始化的未核验标记(self):
        """build_canonical 独立运行时会诚实标未核验；完整预处理已查到该叶子
        且无必填项后，最终 canonical 不能继续携带这条 stale pending。"""
        with tempfile.TemporaryDirectory() as tmp:
            qualification_path = Path(tmp) / "qualifications.json"
            qualification_path.write_text(json.dumps({
                "1": {
                    "collection": {"ok": True},
                    "qualification": {"items": [{"label": "报关单", "required": False}]},
                },
            }), encoding="utf-8")
            with patch("scripts.build_doudian_product.DEFAULT_QUALIFICATION", qualification_path):
                result = build_doudian_product(
                    _raw(("材质", "涤纶")),
                    tree_path=None,
                    props_path=None,
                    category_leaf_id=1,
                    leaves={"测试类目": [(1, 3, 0)]},
                    props_by_leaf=_leaf(
                        _prop("1687", "品牌", [("11", "无品牌")], required=1),
                        _prop("3127", "材质", [("12", "涤纶")], required=1),
                    ),
                    profile=MOCK_PROFILE,
                    no_llm=True,
                    schema=MOCK_SCHEMA,
                    no_project=True,
                )
        pending = [item["code"] for item in result["canonical"]["qualityReport"]["pending"]]
        self.assertNotIn("qualifications_unchecked", pending)

    def test_未采集成功时返回空但那是不知道不是没有(self):
        """docstring 立的规矩：返回空列表 ≠ 没有要求。调用方必须先看 collection.ok。

        这条断言钉住的是【调用方的义务】：主流程若只看返回值为空就放行，
        会把 39 个采集失败的类目当成「无资质要求」静默发出去。
        """
        from category_capture import blocking_qualifications
        entry = {"collection": {"ok": False, "error": "code 500"}, "qualification": None}
        self.assertEqual(blocking_qualifications(entry), [])
        self.assertIs((entry.get("collection") or {}).get("ok"), False,
                      "主流程必须据此判 unknown 并阻断，不能只看上面那个空列表")

    def test_真实快照的阻断面在预期量级(self):
        """接线前先量过：139 个必填资质 + 39 个采集失败。数量级跑偏说明判据被改坏了。"""
        import os
        from category_capture import load_qualification_capture, blocking_qualifications
        p = os.path.join(os.path.dirname(__file__), "..", "..", "..", "reports",
                         "doudian-category-qualification.json")
        if not os.path.exists(p):
            self.skipTest("资质采集产物不在，跳过")
        q = load_qualification_capture(p)
        blocked = sum(1 for e in q.values()
                      if (e.get("collection") or {}).get("ok") is not False
                      and blocking_qualifications(e))
        self.assertEqual(blocked, 139, f"必填资质类目数应为 139，实际 {blocked}")


class TestImageBedUpload(unittest.TestCase):
    def test_上传内存图片后更新_url_并保留来源_sourceUrl(self):
            canonical = {
                "images": {
                    "main": [{"url": "https://source.example/main.jpg", "sourceUrl": "https://source.example/main.jpg"}],
                    "detail": [{"url": "https://source.example/detail.jpg", "sourceUrl": "https://source.example/detail.jpg"}],
                },
            }
            assets = {"/images/main/0": b"main", "/images/detail/0": b"detail"}
            calls = []

            class Response:
                def __enter__(self): return self
                def __exit__(self, *_): return False
                def read(self):
                    return json.dumps({"cdn_url": "https://cdn.example/upload.jpg"}).encode()

            def fake_urlopen(request, timeout=None):
                calls.append((request, timeout))
                return Response()

            with patch("scripts.build_doudian_product.urlopen", side_effect=fake_urlopen):
                upload_canonical_images(canonical, assets, "http://console.test")

            self.assertEqual(canonical["images"]["main"][0]["sourceUrl"], "https://source.example/main.jpg")
            self.assertEqual(canonical["images"]["main"][0]["url"], "https://cdn.example/upload.jpg")
            self.assertEqual(canonical["images"]["detail"][0]["url"], "https://cdn.example/upload.jpg")
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][0].data, b"main")
            self.assertEqual(calls[1][0].data, b"detail")
            self.assertEqual(calls[0][0].get_header("Content-type"), "application/octet-stream")

    def test_没有源规格图的值不应被误判为上传缺失(self):
        canonical = {
            "images": {"main": [], "detail": []},
            "specs": [
                {"name": "颜色", "values": [{"value": "红", "imageUrl": "https://source.example/red.jpg", "sourceImageUrl": "https://source.example/red.jpg"}]},
                {"name": "高度", "values": [{"value": "40cm"}]},
            ],
        }
        assets = {"/specs/0/values/0": b"red"}

        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self): return json.dumps({"cdn_url": "https://cdn.example/red.jpg"}).encode()

        with patch("scripts.build_doudian_product.urlopen", return_value=Response()):
            upload_canonical_images(canonical, assets, "http://console.test")

        self.assertEqual(canonical["specs"][0]["values"][0]["imageUrl"], "https://cdn.example/red.jpg")
        self.assertNotIn("imageUrl", canonical["specs"][1]["values"][0])


if __name__ == "__main__":
    unittest.main()


class 检测顺序Tests(unittest.TestCase):
    """合规检测必须跑在 addv2 投影【之前】。

    顺序反了的后果不是"晚一点标记"，而是 ready 永远不可达：build_addv2 拿到一份
    checked 全 false 的 canonical，「未过水印/侵权判定」这条 pending 必然成立并落进
    qualityReport，verdict 于是永远看得见它。历史上就是这么写的，那条 pending 的正文
    甚至自带一句「build_addv2 应在 merge_canonical 之后跑」——写下它的人看见了症状，
    但顺序没改。这条断言守的就是顺序，不是标记规则本身（那些在 projection 层）。
    """

    RAW = {"BaseInfo": {"Title": "毛绒挂件",
                        "Attr": {"SourceAttr": [{"Label": "品牌", "Value": "无"}]},
                        "CommodityImage": {"ConfigList": [{"List": ["https://e.com/m0.jpg"]}]},
                        "DetailImage": {"ConfigList": [{"List": ["https://e.com/d0.jpg"]}]}}}

    def _run(self):
        props = _leaf(_prop(1687, "品牌", [("596120136", "无品牌")], required=1))
        # no_llm=False 是必须的：mark_checked_images 在 skip_model 时一张都不标
        # （没检测 ≠ 干净）。检测本身用桩替掉，属性侧的 ask_llm 也挡住，测试不碰网络。
        with patch("build_canonical._download_image_bytes", return_value=(b"fakejpegbytes", None)), \
             patch("scripts.build_doudian_product.collect_findings", return_value=[]), \
             patch("scripts.build_doudian_product.ask_llm",
                   side_effect=lambda *a, **k: {"picked_property_id": None, "reason": "测试桩"}), \
             patch("scripts.build_doudian_product.upload_canonical_images", return_value={"uploaded": 0, "skipped": 0}):
            return build_doudian_product(
                self.RAW, profile=MOCK_PROFILE, no_llm=False, schema=MOCK_SCHEMA,
                leaves={}, props_by_leaf=props, no_project=False,
                download_images=True, category_leaf_id=1,
            )

    def test_检测干净的图在投影前就被标记(self):
        result = self._run()
        main = (result["canonical"].get("images") or {}).get("main") or []
        self.assertTrue(main, "主图应该有")
        self.assertTrue(all(i.get("checked") for i in main),
                        f"检测跑过且干净，投影前就该标上：{main}")

    def test_全部送检且干净后不再报未过判定(self):
        """主图和详情图都进检测通道，都干净 → 这条 pending 应当彻底消失。

        它是 ready 可达性的最后一环：只要还剩一张没被标记，pending 就成立，verdict
        就停在 needs_human。断言写成"消失"，而不是"张数变少"——只检主图的那一版做不到
        这一点，正是那次没做完留下的洞。

        注意 fixture 必须同时有主图和详情图：0 张详情图会被规则1（description 必填）
        先把 addv2 挡住，那条 pending 根本没机会生成，断言就成了空转通过。"""
        result = self._run()
        msgs = [str(p) for p in (result.get("pending") or []) if "checked != true" in str(p)]
        self.assertEqual(msgs, [], f"仍有图没被标记：{msgs}")
        images = result["canonical"]["images"]
        self.assertTrue(all(i.get("checked") for i in images["main"] + images["detail"]),
                        f"主图与详情图都该标上：{images}")


class 值映射不上的记账层级Tests(unittest.TestCase):
    """「源站的值抖店没有」是过程记账，不是发布阻塞项 —— 不填就是了。

    能不能发布看的是**抖店必填有没有填上**，那由 missing_required_attributes 独立判
    （它的覆盖判据已对齐"投影得出去"：枚举属性要有非空 valueId）。把过程记账也算进
    pending 就是拿过程当结果：一个非必填属性在抖店没有等价选项，商品会永远停在
    needs_human。

    但只降级 attribute_value_unmapped 这一种 ——「查清楚了，抖店确实没有这个值」。
    通道失败那种是「没查清楚」，降级它等于假装检查过。
    """

    RAW = {"BaseInfo": {"Title": "毛绒挂件",
                        "Attr": {"SourceAttr": [{"Label": "颜色", "Value": "藏青"}]},
                        "CommodityImage": {"ConfigList": [{"List": ["https://e.com/m0.jpg"]}]},
                        "DetailImage": {"ConfigList": [{"List": ["https://e.com/d0.jpg"]}]}}}

    def _buckets(self):
        props = _leaf(_prop(1687, "颜色", [("11", "红"), ("12", "蓝")]))
        result = build_doudian_product(
            self.RAW, profile=MOCK_PROFILE, no_llm=True, schema=MOCK_SCHEMA,
            leaves={}, props_by_leaf=props, no_project=True, download_images=False,
            category_leaf_id=1,
        )
        qr = result["canonical"].get("qualityReport") or {}
        codes = lambda bucket: [f.get("code") for f in (qr.get(bucket) or [])]
        return codes("warnings"), codes("pending")

    def test_值映射不上落warnings不落pending(self):
        warnings, pending = self._buckets()
        self.assertIn("attribute_value_unmapped", warnings,
                      f"过程记账该进 warnings：warnings={warnings} pending={pending}")
        self.assertNotIn("attribute_value_unmapped", pending,
                         f"过程记账不该挡路：pending={pending}")


class 必填属性兜底Tests(unittest.TestCase):
    """严格推断放弃之后的第二问：这个属性填错了要不要紧？

    两步分开、失败路径合流。分两步而不是把两个问题塞进一个提示词，是因为
    「有没有依据」和「要不要紧」是不同的判断——混在一起时模型会拿"不要紧"去补
    "没依据"，而那正是这个功能最该防的事。判断交给模型，代码里不写死任何属性名单：
    类目属性表 4275 个叶子上万条属性，白名单既写不全也会过期。
    """

    RAW = {"BaseInfo": {"Title": "毛绒挂件", "Attr": {"SourceAttr": []}}}

    def _leaf(self, *props):
        return {"name": "毛绒玩偶/公仔", "path": "玩具/毛绒布艺玩具/毛绒玩偶/公仔",
                "props": list(props)}

    def _run(self, prop, answers):
        """answers: 依次返回给 ask_llm 的结果（第一次是严格推断，第二次是兜底）。"""
        calls = []

        def fake(prompt, context=None):
            calls.append(prompt)
            return answers[min(len(calls) - 1, len(answers) - 1)]

        with patch("scripts.build_doudian_product.ask_llm", side_effect=fake):
            overlay, records, notes = fill_required_attributes(
                self.RAW, self._leaf(prop), covered_ids=set(), no_llm=False)
        return overlay, records, notes, calls

    def test_严格推断命中时不问兜底(self):
        prop = _prop(2108, "玩具类型", [("11", "毛绒玩具")], required=1)
        overlay, records, notes, calls = self._run(
            prop, [{"picked_value_id": "11", "evidence": "标题含毛绒"}])
        self.assertEqual(len(calls), 1, "严格那一步已经拿到值，不该再问第二次")
        self.assertEqual(records[0]["matchedBy"], "llm_inferred")
        self.assertEqual(notes[0]["code"], "required_attribute_inferred")

    def test_严格放弃且模型判定不要紧则兜底选值(self):
        prop = _prop(1869, "图案", [("29635", "卡通动漫"), ("29636", "纯色")], required=1)
        overlay, records, notes, calls = self._run(prop, [
            {"picked_value_id": None, "evidence": None},
            {"low_stakes": True, "why": "只影响平台归类", "picked_value_id": "29635",
             "evidence": "标题与已确定属性都指向卡通形象"},
        ])
        self.assertEqual(len(calls), 2, "严格放弃后必须再问一次")
        self.assertEqual(len(overlay), 1)
        self.assertEqual(overlay[0]["doudianValues"][0]["valueId"], 29635)
        self.assertEqual(records[0]["matchedBy"], "llm_default",
                         "兜底来的值必须与有依据的推断分开记账")
        self.assertEqual(notes[0]["code"], "required_attribute_defaulted")

    def test_模型判定要紧时仍然放弃(self):
        """材质/含量/适用人群这类能被量化成商品价值的，宁可空着被拦下。"""
        prop = _prop(3127, "材质", [("26588", "绒布"), ("26589", "棉")], required=1)
        overlay, records, notes, calls = self._run(prop, [
            {"picked_value_id": None, "evidence": None},
            {"low_stakes": False, "why": "材质会被买家量化成价值，填错即货不对板",
             "picked_value_id": "26588", "evidence": "猜的"},
        ])
        self.assertEqual(len(calls), 2)
        self.assertEqual(overlay, [], f"判定要紧就不该落 overlay：{overlay}")
        self.assertEqual(notes, [], "放弃时不落 finding —— projection 层已经在报缺失了")

    def test_兜底不接受候选之外的值(self):
        """模型给了个不在 candidates 里的 id = 编造，必须丢弃而不是照填。"""
        prop = _prop(1869, "图案", [("29635", "卡通动漫")], required=1)
        overlay, _records, _notes, _calls = self._run(prop, [
            {"picked_value_id": None, "evidence": None},
            {"low_stakes": True, "why": "不要紧", "picked_value_id": "99999", "evidence": "编的"},
        ])
        self.assertEqual(overlay, [], "候选外的 value_id 必须丢弃")


class 缺shop_profile仍要跑完Tests(unittest.TestCase):
    """profile=None 是签名与文档都承诺过的入参，不是理论情况。

    CLI 不传 --shop-profile、preprocess_wrapper.default_profile() 在默认档不存在时，
    送进来的都是 None；而缺 profile 早就有既定产物 —— build_canonical 的
    shop_profile_missing(pending) / shop_profile_incomplete(error)。

    2026-09-07 实测：品牌那段后加的代码直接写了 profile.get("brand")，于是
    `--capture x.json` 不带 profile 跑必崩 AttributeError，崩的位置离「你没给
    profile」这个真因隔着一整个函数。承诺过的入参没人测，坏了就没人知道。
    """

    RAW = {"BaseInfo": {"Title": "一次性换药盘", "Attr": {"SourceAttr": []}}}
    PROPS = {"1": {"name": "测试类目", "path": "测试类目",
                   "props": [{"id": 1687, "name": "品牌", "required": True,
                              "options": [["596120136", "无品牌"]]}]}}

    def _run(self, profile):
        return build_doudian_product(
            self.RAW, profile=profile, no_llm=True, schema=MOCK_SCHEMA,
            leaves={}, props_by_leaf=self.PROPS, no_project=True,
            download_images=False, category_leaf_id=1,
        )

    def test_profile为None时不抛异常(self):
        result = self._run(None)   # 崩过的就是这一行
        self.assertIn("canonical", result)

    def test_profile为None时如实记账而不是静默(self):
        """跑得完 ≠ 跑得对：缺 profile 必须留下 shop_profile_missing，
        否则一份没加价、店铺必填全缺的产物会看起来和正常产物一样。"""
        qr = self._run(None)["canonical"]["qualityReport"]
        codes = [f["code"] for f in (qr.get("pending") or [])] + \
                [f["code"] for f in (qr.get("errors") or [])]
        self.assertIn("shop_profile_missing", codes, f"缺 profile 却没记账：{codes}")

    def test_空dict与None同义(self):
        """入口归一化的直接后果。两者若产出不同，说明还有使用点在区分它们，
        那就是下一个 AttributeError 的埋点。"""
        a = self._run(None)["canonical"]["qualityReport"]
        b = self._run({})["canonical"]["qualityReport"]
        self.assertEqual([f["code"] for f in (a.get("pending") or [])],
                         [f["code"] for f in (b.get("pending") or [])])


class 类目顶层带图Tests(unittest.TestCase):
    """图片只送顶层那一次调用。

    三例误判（毛绒公仔→DIY配件 / 妈咪包→待产用品 / 平板→视频转换器）都是在顶层就偏了，
    后面每一级只是在错误子树里挑最优；而顶层选完之后，分辨细分靠功率/材质/尺寸这些属性，
    文本反而比图片强。所以图只送一次 —— 每层都带是 3-8 次视觉调用，覆盖面不增加、成本翻几倍。
    """

    PATHS = {"1": "电器/个护健康电器/电吹风", "2": "个人护理/洗发护发/护发精油"}

    def _run_with_image(self, image):
        seen = []

        def fake_pick(product, trail, node, excluded, votes, tried_paths=None, **kw):
            seen.append({"trail": list(trail), "images": kw.get("images")})
            # 顺着走到叶子：每层选第一个候选
            avail = sorted(node["children"])
            return (avail[0] if avail else None), "测试桩", True, None

        with mock.patch.object(product_builder, "_pick_child", fake_pick), \
             mock.patch.object(product_builder, "_exact_leaf_match", lambda *a, **k: None), \
             mock.patch.object(product_builder, "_first_main_image_b64", lambda raw: image):
            product_builder.resolve_category(
                {"BaseInfo": {"Title": "吹风机"}}, {}, no_llm=False,
                leaf_paths=self.PATHS, tree_roots=None, leaf_names={})
        return seen

    def test_顶层带图其余层不带(self):
        seen = self._run_with_image(["FAKE_B64"])
        self.assertGreaterEqual(len(seen), 2, "至少要走两层才谈得上「只有顶层带」")
        self.assertEqual(seen[0]["trail"], [], "第一次调用就是顶层")
        self.assertEqual(seen[0]["images"], ["FAKE_B64"], "顶层必须带图")
        for call in seen[1:]:
            self.assertIsNone(call["images"],
                              f"非顶层不该带图，却在 {call['trail']} 带了：{call['images']}")

    def test_取不到图时照旧跑完(self):
        """带图是增强不是前提：1688 图床偶发 403/超时是常态，
        让它拖垮类目决策就是把锦上添花变成单点故障。"""
        seen = self._run_with_image(None)
        self.assertGreaterEqual(len(seen), 1)
        self.assertTrue(all(c["images"] is None for c in seen))
