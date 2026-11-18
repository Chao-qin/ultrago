import json
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from unittest import mock

from PIL import Image

import build_canonical as bc_module
from build_canonical import (
    sanitize_text,
    extract_images,
    Report,
    _inspect_image,
    build_canonical,
    doudian_char_len,
    fetch_schema,
    load_constraints,
    _normalize_raw_input,
)
from preprocess_config import normalize_config


# At RUNTIME the contract comes from the console registry over HTTP — see
# build_canonical.fetch_schema. This file is kept as a STRUCTURAL FIXTURE so the
# extraction logic can be exercised against the real document shape without a
# running console. It is no longer what the mapper reads.
SCHEMA_FIXTURE = json.loads((Path(__file__).parent / "canonical.schema.json").read_text(encoding="utf-8"))
LIMITS = load_constraints(SCHEMA_FIXTURE)

PROFILE = {
    "profileId": "test-shop",
    "listing": {"productType": 0, "reduceType": 1, "commit": False, "serviceMobile": "4001234567"},
    "shipping": {"freightTemplateId": 0},
    "brand": {"defaultDoudianBrandId": 596120136, "assumeNoBrand": False},
    "pricing": {"strategy": "source_price_plus_fixed_amount", "markup": 10.0},
}


def raw(**overrides):
    """A minimal valid raw.json, overridable per test."""
    base = {
        "GoodsID": "offer-1",
        "SourceID": "1",
        "sourceUrl": "https://detail.1688.com/offer/1.html",
        "BaseInfo": {
            "Title": "可爱毛绒玩偶挂件礼物",
            "CategoryName": "",
            "Attr": {
                "SourceAttr": [
                    {"Label": "材质", "Value": "塑胶,树脂"},
                    {"Label": "品牌", "Value": "测试牌"},  # 让 brand_id_unmapped 触发
                ]
            },
        },
        "CommodityImage": {"ConfigList": [{"Label": "Main", "List": ["https://e.com/m1.jpg"]}]},
        "DetailImage": {"ConfigList": [{"Label": "Detail", "List": ["https://e.com/d1.jpg"]}]},
        "PriceAndStock": {
            "SkuProperties": [{"PropertyName": "颜色", "Values": [{"ValueName": "红"}]}],
            "Skus": [{"Price": 7.2, "Quantity": 20, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]}],
        },
        "SourceMeta": {"captureMethod": "browser-dom", "pageState": "product", "warnings": []},
    }
    base.update(overrides)
    return base


def codes(result, bucket):
    return [f["code"] for f in result["qualityReport"][bucket]]


class DoudianCharLenTests(unittest.TestCase):
    def test_cjk_counts_as_two_ascii_as_one(self):
        # The whole point: len() would say 4 here and wave through a title
        # Doudian counts as 8.
        self.assertEqual(doudian_char_len("可爱玩偶"), 8)
        self.assertEqual(doudian_char_len("abcd"), 4)
        self.assertEqual(doudian_char_len("可爱ab"), 6)


class PreprocessConfigIntegrationTests(unittest.TestCase):
    def test_config_applies_regex_image_range_and_audit(self):
        main_urls = [f"https://e.com/m{i}.jpg" for i in range(4)]
        result = build_canonical(
            raw(BaseInfo={"Title": "某品牌可爱毛绒玩偶挂件", "CategoryName": "", "Attr": {"SourceAttr": []}},
                CommodityImage={"ConfigList": [{"Label": "Main", "List": main_urls}]}),
            PROFILE,
            LIMITS,
            preprocess_config={
                "configId": "cfg-test",
                "shopProfile": PROFILE,
                "text": {"replaceRules": [{"pattern": "某品牌", "replacement": "", "description": "去品牌"}]},
                "images": {"main": {"start": 2, "end": 3}},
            },
        )
        self.assertEqual(result["title"]["sourceText"], "某品牌可爱毛绒玩偶挂件")
        self.assertNotIn("某品牌", result["title"]["text"])
        self.assertEqual([image["url"] for image in result["images"]["main"]], main_urls[1:3])
        self.assertEqual(result["preprocessConfig"]["configId"], "cfg-test")


class ConstraintSourcingTests(unittest.TestCase):
    def test_limits_come_from_the_schema_not_from_code(self):
        props = SCHEMA_FIXTURE["properties"]
        self.assertEqual(LIMITS["main_max"], props["images"]["properties"]["main"]["maxItems"])
        self.assertEqual(LIMITS["title_max"], props["title"]["properties"]["text"]["maxLength"])
        self.assertEqual(LIMITS["title_min"], props["title"]["properties"]["text"]["minLength"])
        self.assertEqual(LIMITS["total_max"], props["images"]["x-doudian-total-max"])

    def test_a_schema_missing_a_constraint_refuses_to_run(self):
        # Not "fall back to a default" — a mapper on guessed limits produces
        # data that passes our checks and fails Doudian's.
        with self.assertRaises(SystemExit) as cm:
            load_constraints({"properties": {}})
        self.assertEqual(cm.exception.code, 2)

    def test_an_unreachable_registry_refuses_to_run(self):
        # Port 1 is never listening. The point is that the mapper exits rather
        # than silently reading some bundled copy of the contract.
        with self.assertRaises(SystemExit) as cm:
            fetch_schema(base_url="http://127.0.0.1:1")
        self.assertEqual(cm.exception.code, 2)


class ImageTests(unittest.TestCase):
    def test_main_and_spec_images_are_preserved_and_only_detail_is_cropped(self):
        main_urls = [f"https://e.com/m{i}.jpg" for i in range(6)]
        detail_urls = [f"https://e.com/d{i}.jpg" for i in range(48)]
        spec_urls = ["https://e.com/spec-red.jpg", "https://e.com/spec-blue.jpg"]
        result = build_canonical(
            raw(
                CommodityImage={"ConfigList": [{"Label": "Main", "List": main_urls}]},
                DetailImage={"ConfigList": [{"Label": "Detail", "List": detail_urls}]},
                PriceAndStock={
                    "SkuProperties": [{
                        "PropertyName": "颜色",
                        "Values": [
                            {"ValueName": "红", "ImgUrl": spec_urls[0]},
                            {"ValueName": "蓝", "ImgUrl": spec_urls[1]},
                        ],
                    }],
                    "Skus": [{"Price": 7.2, "Quantity": 20, "SkuSpec": []}],
                },
            ),
            PROFILE,
            LIMITS,
        )

        self.assertEqual(
            [i["url"] for i in result["images"]["main"]], main_urls[: LIMITS["main_max"]]
        )
        self.assertEqual(len(result["images"]["detail"]), 43)
        self.assertEqual(
            [v["imageUrl"] for v in result["specs"][0]["values"]], spec_urls
        )
        self.assertIn("main_images_over_limit", codes(result, "warnings"))
        self.assertIn("images_total_over_limit", codes(result, "warnings"))
        removed_urls = [item["url"] for item in result["images"]["removed"]]
        self.assertIn(main_urls[-1], removed_urls)
        self.assertNotIn(spec_urls[0], removed_urls)

    def test_spec_images_dropped_whole_when_main_plus_spec_exceeds_total(self):
        """主图+规格图本身就超总量时，整组丢规格图 —— 它是三类里唯一选填的。

        免钉胶实测：主图 5 + 规格图 53 = 58 > 50，详情图容量算出来是 -8，
        详情图让到 0 张仍然不够。此前这里落一条阻断 error，addv2 直接没产出，
        53 个 SKU 的商品整个发不出去。
        """
        n_spec = LIMITS["total_max"]  # 单这一项就超总量
        result = build_canonical(
            raw(
                CommodityImage={"ConfigList": [{"Label": "Main", "List": [
                    f"https://e.com/m{i}.jpg" for i in range(LIMITS["main_max"])]}]},
                DetailImage={"ConfigList": [{"Label": "Detail", "List": [
                    f"https://e.com/d{i}.jpg" for i in range(10)]}]},
                PriceAndStock={
                    "SkuProperties": [{
                        "PropertyName": "规格",
                        "Values": [{"ValueName": f"v{i}", "ImgUrl": f"https://e.com/s{i}.jpg"}
                                   for i in range(n_spec)],
                    }],
                    "Skus": [{"Price": 7.2, "Quantity": 20,
                              "SkuSpec": [{"PropertyName": "规格", "ValueName": f"v{i}"}]}
                             for i in range(n_spec)],
                },
            ),
            PROFILE,
            LIMITS,
        )

        self.assertNotIn("images_total_over_limit", codes(result, "errors"),
                         "整组丢弃之后不该再有阻断 error")
        self.assertIn("spec_images_dropped_over_total", codes(result, "warnings"))
        left = [v.get("imageUrl") for s in result["specs"] for v in s["values"]]
        self.assertEqual([u for u in left if u], [], "规格图必须整组清空，不能剩一部分")
        # 腾出来的额度要真的还给详情图：整组丢完总量是 5+10=15，远在上限内。
        self.assertEqual(len(result["images"]["detail"]), 10)
        self.assertEqual(len(result["skus"]), n_spec, "丢图不该动 SKU")

    def test_spec_images_kept_when_total_fits(self):
        """没超总量时一张都不许丢 —— 上一条的改动不能变成无条件丢弃。"""
        spec_urls = ["https://e.com/s0.jpg", "https://e.com/s1.jpg"]
        result = build_canonical(
            raw(
                CommodityImage={"ConfigList": [{"Label": "Main", "List": ["https://e.com/m0.jpg"]}]},
                DetailImage={"ConfigList": [{"Label": "Detail", "List": ["https://e.com/d0.jpg"]}]},
                PriceAndStock={
                    "SkuProperties": [{"PropertyName": "颜色", "Values": [
                        {"ValueName": "红", "ImgUrl": spec_urls[0]},
                        {"ValueName": "蓝", "ImgUrl": spec_urls[1]},
                    ]}],
                    "Skus": [{"Price": 7.2, "Quantity": 20, "SkuSpec": []}],
                },
            ),
            PROFILE,
            LIMITS,
        )

        self.assertNotIn("spec_images_dropped_over_total", codes(result, "warnings"))
        self.assertEqual([v["imageUrl"] for v in result["specs"][0]["values"]], spec_urls)

    def test_main_images_are_capped_and_the_overflow_is_recorded(self):
        urls = [f"https://e.com/m{i}.jpg" for i in range(17)]
        result = build_canonical(
            raw(CommodityImage={"ConfigList": [{"Label": "Main", "List": urls}]}), PROFILE, LIMITS)

        kept = result["images"]["main"]
        removed = result["images"]["removed"]
        self.assertEqual(len(kept), LIMITS["main_max"])
        self.assertEqual(len(kept) + len(removed), len(urls))
        self.assertEqual([i["url"] for i in kept], urls[: LIMITS["main_max"]])
        self.assertIn("main_images_over_limit", codes(result, "warnings"))

    def test_missing_main_images_is_blocking(self):
        result = build_canonical(raw(CommodityImage={"ConfigList": []}), PROFILE, LIMITS)
        self.assertIn("main_images_missing", codes(result, "errors"))

    def test_image_dimensions_are_inspected_from_memory_assets(self):
        """不传 out_dir → 不下载,也不 inspect;宽度/高度/字节不会凭空出现。
        旧版的 image_dimensions_unverified pending 已移除 —— 现在有 out_dir
        才能探测,没 out_dir 就不探测,而不是装作「待人工」撒谎。
        """
        result = build_canonical(raw(), PROFILE, LIMITS)
        for img in result["images"]["main"]:
            self.assertNotIn("width", img)
            self.assertNotIn("height", img)
            self.assertNotIn("bytes", img)
            self.assertFalse(img["checked"])
        # pending 里也不再有 image_dimensions_unverified —— 已经查过的才写,
        # 没查(无 out_dir)就老实不写。
        self.assertNotIn("image_dimensions_unverified", codes(result, "pending"))

    def test_image_assets_stay_in_memory_and_never_add_local_paths(self):
        encoded = io.BytesIO()
        Image.new("RGB", (800, 600), "white").save(encoded, "JPEG")
        assets = {}
        with patch.object(bc_module, "_download_image_bytes", return_value=(encoded.getvalue(), None)):
            result = build_canonical(raw(), PROFILE, LIMITS, image_assets=assets)

        self.assertIn("/images/main/0", assets)
        self.assertNotIn("localPath", result["images"]["main"][0])
        self.assertEqual(result["images"]["main"][0]["sourceUrl"], result["images"]["main"][0]["url"])

    def test_image_assets_keep_upload_bytes_untouched_by_vision_compression(self):
        """给模型的压缩**不许**碰到这里 —— 这份字节是要上传给抖店的。

        送识别的那份会被 vision_image 压到长边 1024，而本模块的 image_assets 是
        upload_canonical_images 的输入。两者共用同一个 key，所以"顺手也压一下"是个
        随时会有人写下去的诱惑（省一次内存复制），代价是悄悄毁掉上架图、还可能让
        主图跌破抖店 600px 下限。这条断言把两者钉成不同的东西：

          · 主图 = 中心 1:1 裁剪件（1600×1600，来自 2400×1600）
          · 详情图 = 原图（2400×1600，一个字都不动）
        """
        encoded = io.BytesIO()
        Image.new("RGB", (2400, 1600), (10, 120, 200)).save(encoded, "JPEG")
        assets = {}
        with patch.object(bc_module, "_download_image_bytes", return_value=(encoded.getvalue(), None)):
            build_canonical(raw(), PROFILE, LIMITS, image_assets=assets)

        def size(key):
            with Image.open(io.BytesIO(assets[key])) as im:
                return im.size

        self.assertEqual(size("/images/main/0"), (1600, 1600), "主图应当只有裁剪，没有被压到 1024")
        self.assertEqual(size("/images/detail/0"), (2400, 1600), "详情图应当保持原图")


def _make_jpeg(path, w, h, target_bytes=None):
    """写真实 JPEG 到 path,可选地追加填充让文件接近 target_bytes。

    5M 边界测试不能用 PIL 默认压缩比(几百 K)直接得到 —— 所以写完后
    以追加方式扩到目标字节(图片仍可解码,JPEG 容忍 EOF 截断的尾巴)。
    """
    from PIL import Image
    img = Image.new("RGB", (w, h), (255, 255, 255))
    img.save(path, "JPEG", quality=85)
    if target_bytes is not None and target_bytes > path.stat().st_size:
        # JPEG 解码器看 SOI/EOI 标记,中段填充无意义字节仍可解;
        # 边界值测的是「文件大小 > 5M」,不需要图本身 5M 像素。
        with open(path, "ab") as f:
            f.write(b"\xff" * (target_bytes - path.stat().st_size))


class ImageInspectionTests(unittest.TestCase):
    """`_inspect_image` 按 role 校验 Doudian 图片硬约束。
    直接调函数测纯逻辑(无网络/无下载)。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        self.report = Report()

    def tearDown(self):
        self.tmp.cleanup()

    def _dest(self, name):
        return self.tmpdir / name

    def _codes(self, bucket):
        return [f["code"] for f in getattr(self.report, bucket)]

    # ---- main role ----

    def test_main_image_at_boundary_passes(self):
        """600×600 + <5M 是 main 合法边界,不应报错。"""
        dest = self._dest("main0.jpg")
        _make_jpeg(dest, 600, 600)
        img = {"url": "https://e.com/m0.jpg"}
        _inspect_image("main", 0, img, dest, self.report)
        self.assertEqual(self._codes("errors"), [], f"边界图误报:{self.report.errors}")
        self.assertEqual(img["width"], 600)
        self.assertEqual(img["height"], 600)
        self.assertGreater(img["bytes"], 0)

    def test_main_image_too_small_is_error(self):
        """500×500 < 600×600 → image_too_small blocking error。"""
        dest = self._dest("main0.jpg")
        _make_jpeg(dest, 500, 500)
        img = {}
        _inspect_image("main", 0, img, dest, self.report)
        self.assertIn("image_too_small", self._codes("errors"))
        self.assertIn("image_too_small", self._codes("errors")[0])  # sanity

    def test_main_image_height_also_checked(self):
        """宽度够 600 但高度 400 → 仍 image_too_small。要两个维度都 ≥600。"""
        dest = self._dest("main0.jpg")
        _make_jpeg(dest, 600, 400)
        img = {}
        _inspect_image("main", 0, img, dest, self.report)
        self.assertIn("image_too_small", self._codes("errors"))

    def test_main_image_too_large_is_error(self):
        """>5M → image_too_large。target_bytes 模拟尾部填充。"""
        dest = self._dest("main0.jpg")
        _make_jpeg(dest, 800, 800, target_bytes=5 * 1024 * 1024 + 100)
        img = {}
        _inspect_image("main", 0, img, dest, self.report)
        self.assertIn("image_too_large", self._codes("errors"),
                      f"5M+ 应报 too_large,实际 errors:{self.report.errors}")

    def test_main_image_exactly_at_5m_is_ok(self):
        """5M 是上限,等于不算超。"""
        dest = self._dest("main0.jpg")
        _make_jpeg(dest, 600, 600, target_bytes=5 * 1024 * 1024)
        img = {}
        _inspect_image("main", 0, img, dest, self.report)
        self.assertNotIn("image_too_large", self._codes("errors"))

    # ---- 比例: whiteBackground / longPic ----

    def test_white_background_must_be_square(self):
        dest = self._dest("wb.jpg")
        _make_jpeg(dest, 800, 600)
        img = {}
        _inspect_image("whiteBackground", 0, img, dest, self.report)
        self.assertIn("image_aspect_wrong", self._codes("errors"))
        self.assertIn("1:1", self.report.errors[0]["message"])

    def test_white_background_1_1_passes(self):
        dest = self._dest("wb.jpg")
        _make_jpeg(dest, 800, 800)
        img = {}
        _inspect_image("whiteBackground", 0, img, dest, self.report)
        self.assertEqual(self._codes("errors"), [])

    def test_long_pic_3_4_passes(self):
        """900×1200 是 3:4 (w:h = 3:4),应通过。"""
        dest = self._dest("lp.jpg")
        _make_jpeg(dest, 900, 1200)
        img = {}
        _inspect_image("longPic", 0, img, dest, self.report)
        self.assertEqual(self._codes("errors"), [])

    def test_long_pic_4_3_is_rejected(self):
        """1200×900 是 4:3,不是 3:4 → image_aspect_wrong。"""
        dest = self._dest("lp.jpg")
        _make_jpeg(dest, 1200, 900)
        img = {}
        _inspect_image("longPic", 0, img, dest, self.report)
        self.assertIn("image_aspect_wrong", self._codes("errors"))

    # ---- detail / schema 未明: 不硬查,只落字段 ----

    def test_detail_image_no_size_or_aspect_check_even_if_huge(self):
        """detail schema 未明单张上限 → 不报 too_large。字段照落。"""
        dest = self._dest("d0.jpg")
        _make_jpeg(dest, 80, 80, target_bytes=8 * 1024 * 1024)  # 8M,极小像素
        img = {}
        _inspect_image("detail", 0, img, dest, self.report)
        self.assertEqual(self._codes("errors"), [],
                         f"detail 不该报 too_large,实际:{self.report.errors}")
        self.assertEqual(img["width"], 80)
        self.assertEqual(img["height"], 80)
        self.assertGreater(img["bytes"], 8 * 1024 * 1024 - 1024)

    # ---- 失败降级 ----

    def test_corrupted_image_falls_back_to_warning_not_error(self):
        """图文件损坏 → image_inspect_failed warning,不阻断主流程。"""
        dest = self._dest("bad.jpg")
        dest.write_bytes(b"this is not a jpeg")
        img = {}
        _inspect_image("main", 0, img, dest, self.report)
        self.assertEqual(self._codes("errors"), [],
                         f"损坏图不该进 errors,实际:{self.report.errors}")
        self.assertIn("image_inspect_failed", self._codes("warnings"))


class PlatformArtifactFilterTests(unittest.TestCase):
    """1688 详情图里混着平台自己生成的二维码，那不是商品图。

    实测一个火锅勺商品 37 张详情图里有 9 张是 ma.m.1688.com/touch/code/sCode，
    传到抖店等于在商品详情页里放【平台外引流】入口——违规，不是美观问题。
    """

    def _raw(self, urls):
        return {"BaseInfo": {"DetailImage": {"ConfigList": [{"List": urls}]}}}

    def test_1688_qrcode_urls_are_dropped(self):
        raw = self._raw([
            "https://cbu01.alicdn.com/img/ibank/real-product.jpg",
            "http://ma.m.1688.com/touch/code/sCode?type=offer&id=936478689389",
            "https://cbu01.alicdn.com/img/ibank/another.jpg",
        ])
        got = extract_images(raw, "DetailImage", "Detail")
        self.assertEqual(got, [
            "https://cbu01.alicdn.com/img/ibank/real-product.jpg",
            "https://cbu01.alicdn.com/img/ibank/another.jpg",
        ])

    def test_real_product_images_are_untouched(self):
        urls = ["https://cbu01.alicdn.com/img/ibank/a.jpg",
                "https://cbu01.alicdn.com/img/ibank/b.jpg"]
        self.assertEqual(extract_images(self._raw(urls), "DetailImage", "Detail"), urls)


class TitleTests(unittest.TestCase):
    def test_overlong_title_is_trimmed_on_doudian_counting_and_flagged(self):
        long_title = "超可爱" * 15  # 45 chars = 90 by Doudian's count
        result = build_canonical(raw(BaseInfo={**raw()["BaseInfo"], "Title": long_title}), PROFILE, LIMITS)
        self.assertLessEqual(doudian_char_len(result["title"]["text"]), LIMITS["title_max"])
        self.assertIn("title_truncated", codes(result, "risks"))
        # The original must survive for a human to rewrite from.
        self.assertEqual(result["title"]["sourceText"], long_title)

    def test_too_short_title_is_blocking(self):
        result = build_canonical(raw(BaseInfo={**raw()["BaseInfo"], "Title": "玩偶"}), PROFILE, LIMITS)
        self.assertIn("title_too_short", codes(result, "errors"))

    def test_superlative_wording_is_flagged(self):
        result = build_canonical(
            raw(BaseInfo={**raw()["BaseInfo"], "Title": "全网最低价可爱毛绒玩偶挂件"}), PROFILE, LIMITS)
        self.assertIn("title_superlative", codes(result, "risks"))

    def test_brand_ip_keyword_is_flagged(self):
        result = build_canonical(
            raw(BaseInfo={**raw()["BaseInfo"], "Title": "HelloKitty可爱毛绒玩偶挂件"}), PROFILE, LIMITS)
        self.assertIn("title_brand_ip", codes(result, "risks"))

    def test_contact_info_in_title_is_flagged(self):
        result = build_canonical(
            raw(BaseInfo={**raw()["BaseInfo"], "Title": "可爱毛绒玩偶微信:kefu12345"}), PROFILE, LIMITS)
        self.assertIn("title_contact_info", codes(result, "risks"))


class SkuTests(unittest.TestCase):
    def test_invalid_price_sku_is_dropped_with_a_warning(self):
        result = build_canonical(raw(PriceAndStock={
            "SkuProperties": [{"PropertyName": "颜色", "Values": [{"ValueName": "红"}]}],
            "Skus": [
                {"Price": 0, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]},
                {"Price": 7.2, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]},
            ],
        }), PROFILE, LIMITS)
        self.assertEqual(len(result["skus"]), 1)
        self.assertIn("sku_price_invalid", codes(result, "warnings"))

    def test_sku_count_mismatch_against_spec_cartesian_product_is_flagged(self):
        result = build_canonical(raw(PriceAndStock={
            "SkuProperties": [{"PropertyName": "颜色", "Values": [{"ValueName": "红"}, {"ValueName": "蓝"}]}],
            "Skus": [{"Price": 7.2, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]}],
        }), PROFILE, LIMITS)
        self.assertIn("sku_count_mismatch", codes(result, "warnings"))

    def test_markup_is_applied_per_sku_from_its_own_source_price(self):
        result = build_canonical(raw(PriceAndStock={
            "SkuProperties": [{"PropertyName": "颜色", "Values": [{"ValueName": "红"}, {"ValueName": "蓝"}]}],
            "Skus": [
                {"Price": 7.2, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]},
                {"Price": 15.6, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "蓝"}]},
            ],
        }), PROFILE, LIMITS)
        # Per-SKU, not lowest-price-for-all.
        self.assertEqual([s["price"] for s in result["skus"]], [17.2, 25.6])

    def test_margin_floor_violation_is_flagged(self):
        profile = {**PROFILE, "pricing": {**PROFILE["pricing"], "markup": 2.0, "minMarginYuan": 8.0}}
        result = build_canonical(raw(), profile, LIMITS)
        self.assertIn("margin_below_floor", codes(result, "risks"))
        self.assertTrue(result["pricing"]["marginChecked"])


class ProfileTests(unittest.TestCase):
    def test_without_a_profile_the_zero_margin_price_is_called_out(self):
        result = build_canonical(raw(), None, LIMITS)
        self.assertIn("shop_profile_missing", codes(result, "pending"))
        self.assertIn("price_not_marked_up", codes(result, "risks"))
        self.assertEqual(result["skus"][0]["price"], result["skus"][0]["sourcePrice"])

    def test_incomplete_profile_is_blocking(self):
        result = build_canonical(raw(), {"profileId": "x", "listing": {"productType": 0}}, LIMITS)
        self.assertIn("shop_profile_incomplete", codes(result, "errors"))


class PendingTests(unittest.TestCase):
    def test_qualifications_pending_stays_but_stale_category_and_attribute_pending_are_gone(self):
        """`category_leaf_id_unmapped` 和 `attribute_property_ids_unmapped` 曾经在
        build_canonical 无脑写,但上层 LLM/overlay 已经填回,留着就是 stale。

        `qualifications_unchecked` 保留:build_canonical 真的没查资质,这条
        pending 是诚实标注,等外部 book 接入。
        """
        result = build_canonical(raw(), PROFILE, LIMITS)
        pending = codes(result, "pending")
        self.assertNotIn("category_leaf_id_unmapped", pending,
                         "stale: 上层 LLM 已映射 leaf_id,build_canonical 不应再写")
        self.assertNotIn("attribute_property_ids_unmapped", pending,
                         "stale: 上层 overlay 已填 doudianPropertyId,build_canonical 不应再写")
        self.assertIn("qualifications_unchecked", pending,
                      "qualifications_unchecked 应保留:真没查")
        # brand_id_unmapped 应出现(因为 PROFILE.brand.assumeNoBrand 默认 False 且 raw 有"兴盛君之意")
        self.assertIn("brand_id_unmapped", pending)

    def test_assume_no_brand_silences_brand_pending(self):
        """profile.brand.assumeNoBrand=true → 不写 brand_id_unmapped pending,
        brand.doudianBrandId 仍是无品牌 ID (596120136)。
        """
        profile = {**PROFILE, "brand": {**PROFILE["brand"], "assumeNoBrand": True}}
        result = build_canonical(raw(), profile, LIMITS)
        pending = codes(result, "pending")
        self.assertNotIn("brand_id_unmapped", pending)
        self.assertEqual(result["brand"]["doudianBrandId"], LIMITS["no_brand_id"])
        # sourceName 仍记录(用于人工审计),不删
        self.assertEqual(result["brand"].get("sourceName"), "测试牌")

    def test_blocked_capture_page_is_an_error(self):
        result = build_canonical(
            raw(SourceMeta={"captureMethod": "browser-dom", "pageState": "login", "warnings": []}), PROFILE, LIMITS)
        self.assertIn("page_not_product", codes(result, "errors"))


class PricingStrategyTests(unittest.TestCase):
    """`pricing.strategy` 4 种规则。源价用 fixture 默认 7.2 元。"""

    def _profile(self, **pricing):
        return {**PROFILE, "pricing": {**PROFILE["pricing"], **pricing}}

    def test_fixed_amount(self):
        result = build_canonical(raw(), self._profile(strategy="fixed_amount", markup=5.0), LIMITS)
        self.assertEqual(result["skus"][0]["price"], 12.2)  # 7.2 + 5
        self.assertEqual(result["pricing"]["strategy"], "fixed_amount")
        self.assertEqual(result["pricing"]["markup"], 5.0)
        # 落盘字段只留该 strategy 用到的
        self.assertNotIn("markupPercent", result["pricing"])

    def test_old_strategy_name_is_translated_to_fixed_amount(self):
        """round 1 的 source_price_plus_fixed_amount = fixed_amount,迁移期兼容"""
        result = build_canonical(
            raw(),
            self._profile(strategy="source_price_plus_fixed_amount", markup=5.0),
            LIMITS,
        )
        self.assertEqual(result["skus"][0]["price"], 12.2)
        self.assertEqual(result["pricing"]["strategy"], "fixed_amount")

    def test_percentage(self):
        result = build_canonical(
            raw(),
            self._profile(strategy="percentage", markupPercent=50.0),
            LIMITS,
        )
        # 7.2 * 1.5 = 10.8
        self.assertEqual(result["skus"][0]["price"], 10.8)
        self.assertEqual(result["pricing"]["strategy"], "percentage")
        self.assertEqual(result["pricing"]["markupPercent"], 50.0)
        self.assertNotIn("markup", result["pricing"])

    def test_percentage_plus_fixed(self):
        result = build_canonical(
            raw(),
            self._profile(strategy="percentage_plus_fixed", markupPercent=20.0, markupFixed=3.0),
            LIMITS,
        )
        # 7.2 * 1.2 + 3 = 11.64
        self.assertEqual(result["skus"][0]["price"], 11.64)
        self.assertEqual(result["pricing"]["strategy"], "percentage_plus_fixed")
        self.assertEqual(result["pricing"]["markupPercent"], 20.0)
        self.assertEqual(result["pricing"]["markupFixed"], 3.0)

    def test_min_max_clamps_up_when_source_below_floor(self):
        # 把源价改成 80 元,min=100,max=200 → 应被 clamp 上抬到 100
        result = build_canonical(
            raw(PriceAndStock={
                "SkuProperties": [{"PropertyName": "颜色", "Values": [{"ValueName": "红"}]}],
                "Skus": [{"Price": 80.0, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]}],
            }),
            self._profile(strategy="min_max", minPriceYuan=100.0, maxPriceYuan=200.0),
            LIMITS,
        )
        self.assertEqual(result["skus"][0]["price"], 100.0)

    def test_min_max_clamps_down_when_source_above_ceiling(self):
        # 源价 200,min=50,max=100 → 应被 clamp 下压到 100
        result = build_canonical(
            raw(PriceAndStock={
                "SkuProperties": [{"PropertyName": "颜色", "Values": [{"ValueName": "红"}]}],
                "Skus": [{"Price": 200.0, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]}],
            }),
            self._profile(strategy="min_max", minPriceYuan=50.0, maxPriceYuan=100.0),
            LIMITS,
        )
        self.assertEqual(result["skus"][0]["price"], 100.0)

    def test_min_max_with_markup_in_range(self):
        # min=50,max=100,markup=10,source=80 → 80+10=90 在 [50,100] 内,不 clamp
        result = build_canonical(
            raw(PriceAndStock={
                "SkuProperties": [{"PropertyName": "颜色", "Values": [{"ValueName": "红"}]}],
                "Skus": [{"Price": 80.0, "Quantity": 5, "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红"}]}],
            }),
            self._profile(strategy="min_max", minPriceYuan=50.0, maxPriceYuan=100.0, markup=10.0),
            LIMITS,
        )
        self.assertEqual(result["skus"][0]["price"], 90.0)
        # markup 在落盘字段里要保留(可选)
        self.assertEqual(result["pricing"]["markup"], 10.0)

    def test_min_max_inverted_writes_error_not_silent_clamp(self):
        """min > max 必须报错 —— 不静默 clamp,否则拿一个看似合法的反约束价上架"""
        result = build_canonical(
            raw(),
            self._profile(strategy="min_max", minPriceYuan=200.0, maxPriceYuan=100.0),
            LIMITS,
        )
        self.assertIn("pricing_min_max_inverted", codes(result, "errors"))
        # price 应回落到 sourcePrice(不假装算过)
        self.assertEqual(result["skus"][0]["price"], 7.2)

    def test_unknown_strategy_falls_back_with_warning(self):
        """未识别 strategy:不抛,落 warning + 按 fixed_amount 算"""
        result = build_canonical(
            raw(),
            self._profile(strategy="garbage", markup=4.0),
            LIMITS,
        )
        self.assertIn("pricing_strategy_unknown", codes(result, "warnings"))
        self.assertEqual(result["pricing"]["strategy"], "fixed_amount")
        self.assertEqual(result["skus"][0]["price"], 11.2)  # 7.2 + 4


class NormalizeAttributeRoutingTests(unittest.TestCase):
    """`_normalize_raw_input` 必须按抖店 schema 把销售属性从 attributes 分流到
    skuDimensions(specs/spec_prices 路径),而不是让它们走 LLM 属性映射
    (抖店类目 props 表里根本没'颜色/尺码'这种销售属性 → 必落 pending)。
    """

    def _flat_capture(self):
        return {
            "title": "测试商品",
            "offerId": "123",
            "sourceUrl": "https://detail.1688.com/offer/123.html",
            "pageState": "product",
            "attributes": [
                {"Label": "品牌", "Value": "测试牌"},
                {"Label": "材质", "Value": "棉"},
                {"Label": "颜色", "Value": "红,蓝"},
                {"Label": "尺码", "Value": "M,L"},
            ],
            "skuDimensions": ["颜色", "尺码"],
            "skus": [{"Price": 10, "Quantity": 5, "SkuSpec": [
                {"PropertyName": "颜色", "ValueName": "红"},
                {"PropertyName": "尺码", "ValueName": "M"},
            ]}],
            "mainImages": ["https://e.com/m.jpg"],
            "detailImages": ["https://e.com/d.jpg"],
        }

    def test_sales_attrs_redirected_out_of_attributes(self):
        """'颜色'/'尺码' 是 skuDimensions 里出现的 Label,必须从 SourceAttr 剔除"""
        raw = _normalize_raw_input(self._flat_capture())
        labels = [a["Label"] for a in raw["BaseInfo"]["Attr"]["SourceAttr"]]
        self.assertIn("品牌", labels)
        self.assertIn("材质", labels)
        self.assertNotIn("颜色", labels, "颜色是销售属性,SourceAttr 不该再含它")
        self.assertNotIn("尺码", labels, "尺码是销售属性,SourceAttr 不该再含它")

    def test_redirected_record_is_kept(self):
        """剔除的属性值不能丢 —— 留个 RedirectedFromAttributes 供审计"""
        raw = _normalize_raw_input(self._flat_capture())
        redirected = ((raw["BaseInfo"]["Attr"]).get("RedirectedFromAttributes") or [])
        labels = [r["Label"] for r in redirected]
        self.assertEqual(set(labels), {"颜色", "尺码"})
        # 值也保留下来(便于审计)
        color = next(r for r in redirected if r["Label"] == "颜色")
        self.assertEqual(color["Value"], "红,蓝")

    def test_sku_specs_carry_the_redirected_values(self):
        """颜色/尺码 的值要在 SkuProperties 里走通(不被丢失)"""
        raw = _normalize_raw_input(self._flat_capture())
        sku_props = raw["PriceAndStock"]["SkuProperties"]
        prop_names = [p["PropertyName"] for p in sku_props]
        self.assertIn("颜色", prop_names)
        self.assertIn("尺码", prop_names)
        颜色 = next(p for p in sku_props if p["PropertyName"] == "颜色")
        颜色_values = [v["ValueName"] for v in 颜色["Values"]]
        self.assertEqual(颜色_values, ["红"])  # 只有 skus 里实际出现的

    def test_warning_emitted_in_quality_report(self):
        """build_canonical 应在 qualityReport.warnings 写一条 attributes_redirected_to_specs"""
        cap = self._flat_capture()
        result = build_canonical(cap, PROFILE, LIMITS)
        warnings = result["qualityReport"]["warnings"]
        codes = [w["code"] for w in warnings]
        self.assertIn("attributes_redirected_to_specs", codes,
                      f"必须落 warning 告知用户哪些属性被分流,实际 warnings:{warnings}")

    def test_no_dim_no_redirect(self):
        """如果 capture 没给 skuDimensions,attributes 不动(老行为兼容)"""
        cap = self._flat_capture()
        cap["skuDimensions"] = []
        cap["attributes"] = [{"Label": "颜色", "Value": "红"}]  # 没 skuDimensions,但 attributes 里还是有颜色
        raw = _normalize_raw_input(cap)
        labels = [a["Label"] for a in raw["BaseInfo"]["Attr"]["SourceAttr"]]
        self.assertIn("颜色", labels)  # 没 skuDimensions 时不动


class 文案统一清洗Tests(unittest.TestCase):
    """所有对外文案走同一条清洗链，加规则只动 _TEXT_RULES。

    散落的 .replace() 会出现「标题去了空格、规格值没去」这种半边现象；而规格值
    两侧（specs 与 skus.specs）一旦不一致，SKU 数就对不上笛卡尔积，商品直接被拒。
    """

    def test_空格全部去掉包括连续与全角(self):
        self.assertEqual(sanitize_text("2号 肌源植萃舒缓面膜500g"), "2号肌源植萃舒缓面膜500g")
        self.assertEqual(sanitize_text("a  b   c"), "abc")
        self.assertEqual(sanitize_text("全角\u3000空格"), "全角空格")
        self.assertEqual(sanitize_text("制表\t换行\n回车\r"), "制表换行回车")

    def test_非字符串与空值不炸(self):
        self.assertEqual(sanitize_text(None), "")
        self.assertEqual(sanitize_text(123), "123")

    def test_特殊符号统一换成连字符_而不是删掉(self):
        """删掉会撞车 —— 这是这条规则存在的全部理由。

        「…表情款-微笑【欧貂绒】」与「…表情款-微笑【水晶四面弹】」如果删掉方括号，
        会变成同一个值；而 build_canonical 生成 specs 时不去重（只过滤空值），
        重复的规格值会直接发给抖店：同名规格值 + SKU 笛卡尔积错乱，规格图匹配还会
        因「平局无法分辨」整体退化成不配图。换成 `-` 才保住区分度。
        """
        self.assertEqual(sanitize_text("噜噜豚豚-表情款-微笑【欧貂绒】"), "噜噜豚豚-表情款-微笑-欧貂绒")
        self.assertEqual(sanitize_text("噜噜豚豚-表情款-微笑【水晶四面弹】"), "噜噜豚豚-表情款-微笑-水晶四面弹")
        # 汉字 / 字母 / 数字 / 下划线原样保留，被换掉的只有标点与括号类
        self.assertEqual(sanitize_text("中文abc123_下划线"), "中文abc123_下划线")
        self.assertEqual(sanitize_text("100%纯棉"), "100-纯棉")
        # 连续多个符号合并成一个连字符（不是每个符号一个）
        self.assertEqual(sanitize_text("A//B。。C"), "A-B-C")

    def test_替换产生的首尾连字符要去掉(self):
        self.assertEqual(sanitize_text("【纯前缀】值"), "纯前缀-值")
        self.assertEqual(sanitize_text("--已有多余杠--"), "已有多余杠")

    def test_清洗后规格值不撞车(self):
        """只差方括号内材质前缀的两个值，清洗后仍必须是两个不同的值。"""
        cleaned = [sanitize_text(v) for v in
                   ["噜噜豚豚-表情款-微笑【欧貂绒】", "噜噜豚豚-表情款-微笑【水晶四面弹】"]]
        self.assertEqual(len(set(cleaned)), 2, f"清洗后撞车：{cleaned}")

    def test_规格值两侧同口径_否则SKU数对不上笛卡尔积(self):
        """靶子：源站十个规格值里有一个多敲了空格。specs 与 skus 必须同时被清洗。"""
        result = build_canonical(
            raw(
                CommodityImage={"ConfigList": [{"Label": "Main", "List": ["https://e.com/m.jpg"]}]},
                PriceAndStock={
                    "SkuProperties": [{"PropertyName": "产品 规格", "Values": [
                        {"ValueName": "1号 面膜225g"}, {"ValueName": "2号面膜225g"}]}],
                    "Skus": [
                        {"Price": 32, "Quantity": 10,
                         "SkuSpec": [{"PropertyName": "产品 规格", "ValueName": "1号 面膜225g"}]},
                        {"Price": 38, "Quantity": 10,
                         "SkuSpec": [{"PropertyName": "产品 规格", "ValueName": "2号面膜225g"}]},
                    ],
                },
            ),
            PROFILE, LIMITS,
        )
        spec = result["specs"][0]
        self.assertEqual(spec["name"], "产品规格")
        self.assertEqual([v["value"] for v in spec["values"]], ["1号面膜225g", "2号面膜225g"])
        for sku in result["skus"]:
            for kv in sku["specs"]:
                self.assertNotIn(" ", kv["value"], f"skus 侧没清洗：{kv}")
                self.assertNotIn(" ", kv["name"])
        # 两侧同口径 → SKU 数应等于规格组合数，不产生 sku_count_mismatch
        self.assertNotIn("sku_count_mismatch", codes(result, "warnings"))

    def test_标题也走同一条链(self):
        result = build_canonical(
            raw(BaseInfo={"Title": "美容院 专供 补水面膜", "Attr": {"SourceAttr": []}},
                CommodityImage={"ConfigList": [{"Label": "Main", "List": ["https://e.com/m.jpg"]}]}),
            PROFILE, LIMITS,
        )
        self.assertEqual(result["title"]["text"], "美容院专供补水面膜")

    def test_已归一化配置可以再次传入canonical(self):
        config = normalize_config({
            "configId": "test-config",
            "shopProfile": PROFILE,
            "text": {
                "replaceRules": [{
                    "pattern": "某品牌",
                    "replacement": "",
                    "description": "删除占位品牌",
                }],
            },
        }, PROFILE)
        result = build_canonical(raw(), PROFILE, LIMITS, preprocess_config=config)
        self.assertEqual(result["preprocessConfig"]["configId"], "test-config")


if __name__ == "__main__":
    unittest.main()
