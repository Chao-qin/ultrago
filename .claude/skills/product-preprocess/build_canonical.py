"""raw.json (+ shop-profile.json) → canonical.json

The mapper between what a source platform gives us and what Doudian will
actually accept. It is deliberately the ONLY place that knows both shapes.

Two rules this file exists to enforce:

1. Every numeric constraint is READ FROM the canonical schema, never restated
   here. A threshold copied into code is a threshold that will silently drift
   from the contract it is supposed to enforce. If the schema can't be read, we
   exit 2 rather than fall back to a guess.

   The schema now comes from the console registry over HTTP
   (GET /api/schemas/by-name/canonical-product), not from a file beside this
   script. The registry is the source of truth; a bundled copy would be a
   second version of the contract, which is the drift this rule exists to
   prevent. `--console-url` / $CONSOLE_URL point it elsewhere.

2. Nothing is silently dropped or trimmed. When the source has 22 main images
   and Doudian takes 5, the 17 that don't make it are recorded in
   images.removed with a reason. A caller must be able to see what happened.
"""
from __future__ import annotations

import argparse
import copy
import io
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from preprocess import BRAND_RISK_KEYWORDS, check_brand_risk, load_json, save_json
from preprocess_config import apply_regex_rules, audit_config, normalize_config, select_image_urls
from execution_budget import announce_work

CONSOLE_URL = os.environ.get("CONSOLE_URL", "http://127.0.0.1:8790")
CANONICAL_SCHEMA_NAME = "canonical-product"

# Absolute superlatives banned by Article 9 of the PRC Advertising Law
# (《广告法》第九条：不得使用"国家级""最高级""最佳"等用语).
#
# THIS IS A MINIMAL SEED SET, NOT A COMPLIANCE WORD LIST. It covers the terms
# named in the statute plus their most common variants. Real platform review
# uses lists running to hundreds of entries that also shift over time. Treat a
# clean result here as "no obvious violation", never as "cleared for listing" —
# extend SUPERLATIVE_TERMS from your own compliance source.
SUPERLATIVE_TERMS = [
    "国家级", "最高级", "最佳", "最好", "最优", "最强", "最大", "最小",
    "最新", "最先进", "最低价", "最便宜", "最热", "最流行", "最受欢迎",
    "第一品牌", "全国第一", "世界第一", "全球第一", "销量第一", "排名第一",
    "独一无二", "绝无仅有", "史上最", "顶级", "极品", "无敌",
    "百分百", "100%正品", "永久", "绝对",
]

CONTACT_PATTERNS = [
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "疑似手机号"),
    (re.compile(r"(微信|weixin|wechat|vx|薇信)\s*[:：]?\s*[a-zA-Z0-9_-]{5,}", re.I), "疑似微信号"),
    (re.compile(r"(?<!\d)[1-9]\d{5,10}(?!\d)\s*(qq|QQ)"), "疑似 QQ 号"),
]


# --------------------------------------------------------------------------
# Constraints, read from the schema — see rule 1 in the module docstring.
# --------------------------------------------------------------------------

def fetch_schema(name=CANONICAL_SCHEMA_NAME, base_url=None, version=None):
    """Fetch a registered schema document from the console registry.

    Omitting `version` yields whichever version is active — the registry's own
    default, so a pinned pipeline and an unpinned one disagree visibly rather
    than silently.

    Fails loudly (exit 2) rather than falling back to any bundled copy: a
    fallback would BE a second version of the contract, which is exactly the
    drift this module refuses to allow.
    """
    base = (base_url or CONSOLE_URL).rstrip("/")
    url = f"{base}/api/schemas/by-name/{quote(name)}"
    if version is not None:
        url += f"?version={version}"
    try:
        with urlopen(url, timeout=10) as res:
            row = json.loads(res.read().decode("utf-8"))
        # The registry stores the document verbatim as text, so it needs a
        # second parse — `row` is the registration, `row["jsonSchema"]` is the
        # contract.
        return json.loads(row["jsonSchema"])
    except (HTTPError, URLError, OSError, KeyError, ValueError) as e:
        print(f"FATAL: cannot fetch schema '{name}' from {base}: {e}", file=sys.stderr)
        print("The mapper refuses to run on guessed limits. Is the console running?", file=sys.stderr)
        raise SystemExit(2)


def load_constraints(schema):
    """Pull every threshold the mapper enforces out of the canonical schema.

    Takes an already-parsed document: where it came from (the registry, a test
    fixture) is the caller's business, which keeps this pure and directly
    testable without a running console.

    Fails loudly (exit 2) rather than defaulting: a mapper running on guessed
    limits would produce data that passes our checks and fails Doudian's, which
    is worse than not running.
    """
    try:
        props = schema["properties"]
        images = props["images"]["properties"]
        title = props["title"]["properties"]["text"]
        return {
            "title_min": title["minLength"],
            "title_max": title["maxLength"],
            "main_max": images["main"]["maxItems"],
            "detail_max": images["detail"]["maxItems"],
            "total_max": props["images"]["x-doudian-total-max"],
            "no_brand_id": props["brand"]["properties"]["doudianBrandId"]["default"],
        }
    except (KeyError, TypeError) as e:
        print(f"FATAL: the canonical schema is missing a constraint the mapper needs: {e}", file=sys.stderr)
        print("The mapper refuses to run on guessed limits.", file=sys.stderr)
        raise SystemExit(2)


def doudian_char_len(text):
    """Doudian counts a CJK character as 2 and an ASCII character as 1.

    `len()` is wrong here and wrong in the direction that hurts: a 40-character
    Chinese title is 80 by Doudian's count and gets rejected, while our check
    said 40 and waved it through.
    """
    return sum(2 if ord(c) > 0x7F else 1 for c in str(text or ""))


# --------------------------------------------------------------------------
# Findings
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# 文案统一清洗
# --------------------------------------------------------------------------

# 所有对外文案(标题/规格名/规格值)走同一条清洗链。加规则只动这张表,不要在各处
# 散落 .replace() —— 散落的清洗会出现「标题去了空格、规格值没去」这种半边现象,
# 而规格值两侧(specs 与 skus.specs)一旦不一致,SKU 数就对不上笛卡尔积。
#
# 每条规则写清楚【为什么】,否则后人只能看到一个正则,不敢删也不敢改。
_TEXT_RULES: list[tuple[re.Pattern, str, str]] = [
    (
        re.compile(r"\s+"),
        "",
        "空格(含连续空格、制表符、换行、全角空格 U+3000)。1688 卖家手填规格值时"
        "经常多敲空格 —— 实测面膜那件商品十个规格值里有一个是"
        "「2号 肌源植萃舒缓面膜500g…」,其余九个没有空格,纯属手滑。"
        "空格还会让字面匹配失效:抖店那侧按值名逐字匹配规格图,多一个空格就对不上。",
    ),
    (
        re.compile(r"[^\w]+"),
        "-",
        "特殊符号统一换成连字符。关键是【不能删】—— 实测「噜噜豚豚-表情款-微笑【欧貂绒】」"
        "与「噜噜豚豚-表情款-微笑【水晶四面弹】」删掉方括号后会变成同一个值,而本文件生成"
        "specs 时不去重(只过滤空值),重复的规格值会直接发给抖店:同名规格值 + SKU 笛卡尔积"
        "错乱,规格图匹配还会因「平局无法分辨」整体退化成不配图。换成 `-` 保住了区分度,"
        "「…微笑-欧貂绒」与「…微笑-水晶四面弹」仍然互不相同。"
        "\\w 在 Python 3 默认按 Unicode 匹配,所以汉字/字母/数字/下划线都保留,"
        "被换成 `-` 的是标点与括号类;连续的多个符号合并成一个 `-`。"
        "注意这条同样作用于标题与规格名 —— 标题里的逗号、句号也会变成 `-`。",
    ),
    (
        re.compile(r"^-+|-+$"),
        "",
        "去掉替换后落在首尾的连字符:「【纯前缀】值」应得「纯前缀-值」,"
        "而不是「-纯前缀-值」。",
    ),
]


def sanitize_text(value) -> str:
    """把一段对外文案过一遍清洗链。非字符串原样转字符串再处理。"""
    out = str(value or "")
    for pattern, repl, _ in _TEXT_RULES:
        out = pattern.sub(repl, out)
    return out


def finding(code, message, field=None, evidence=None):
    out = {"code": code, "message": message}
    if field:
        out["field"] = field
    if evidence:
        out["evidence"] = evidence
    return out


class Report:
    """Collects findings into the four buckets canonical.schema.json defines.

    `pending` is distinct from `risk` on purpose: a risk is something we looked
    at and judged, a pending is something we could not compute at all. Merging
    them would let "we never checked the category" read as "the category is
    fine".
    """

    def __init__(self):
        self.errors, self.risks, self.warnings, self.pending = [], [], [], []

    def as_dict(self):
        return {
            "errors": self.errors,
            "risks": self.risks,
            "warnings": self.warnings,
            "pending": self.pending,
        }


# --------------------------------------------------------------------------
# Field extraction
# --------------------------------------------------------------------------

# 1688 详情图里混着平台自己生成的图，它们不是商品内容:
#   ma.m.1688.com/touch/code/sCode?...  —— 指回 1688 商品页的二维码
# 实测一个火锅勺商品 37 张详情图里有 9 张是这个。把它们上传到抖店等于在商品详情页
# 里放【平台外引流】入口 —— 那是实打实的违规,不是美观问题。
# 判据放在 URL 上而不是内容上:这些端点是动态生成器(路径里带 code/sCode),
# 与 CDN 上的静态商品图在 URL 形态上就不同,不需要下载就能分辨。
_PLATFORM_ARTIFACT_PATTERNS = (
    "/touch/code/scode",   # 1688 商品二维码
    "/code/qrcode",
)


def _is_platform_artifact(url: str) -> bool:
    """URL 是否是平台生成物(二维码等)而非商品图片。"""
    return any(p in (url or "").lower() for p in _PLATFORM_ARTIFACT_PATTERNS)


def extract_images(raw, key, label):
    """Flatten CommodityImage/DetailImage's ConfigList-of-lists into URLs.

    Reads from BOTH the legacy top-level `raw[key]` and the 1688-shape
    `raw["BaseInfo"][key]`, because the two callers have used both over the
    history of this file: the canonical 1688 raw shape keeps these under
    BaseInfo, while a number of mid-pipeline docs (and the
    `_normalize_raw_input` adapter that flattens the snatcher output) put
    them at the top. Pick whichever is populated.
    """
    out = []
    sources = [raw.get(key) or {}, (raw.get("BaseInfo") or {}).get(key) or {}]
    for container in sources:
        for config in container.get("ConfigList") or []:
            for url in config.get("List") or []:
                if url and url not in out and not _is_platform_artifact(url):
                    out.append(url)
    return out


def extract_spec_images(raw):
    """Return every first-dimension spec image in source order.

    `spec_pic` is projected from the first SKU dimension and shares Doudian's
    50-image aggregate limit with `pic` and `description`. Unlike detail images,
    spec images must stay aligned with their spec values, so this function does
    not deduplicate or truncate them.
    """
    sku_properties = (raw.get("PriceAndStock") or {}).get("SkuProperties") or []
    if not sku_properties:
        return []
    return [
        value.get("ImgUrl") or value.get("imageUrl")
        for value in (sku_properties[0].get("Values") or [])
        if value.get("ImgUrl") or value.get("imageUrl")
    ]


def build_title(raw, limits, report, preprocess_config=None):
    original_title = str((raw.get("BaseInfo") or {}).get("Title") or "")
    source_title = sanitize_text(original_title)
    if preprocess_config:
        source_title = apply_regex_rules(
            source_title, preprocess_config["text"].get("compiledReplaceRules", [])
        )
    length = doudian_char_len(source_title)

    if not source_title:
        report.errors.append(finding("title_missing", "来源标题为空，无法生成商品", "/title/text"))
        return {"text": "", "sourceText": original_title}

    text = source_title
    if length > limits["title_max"]:
        # Trim on Doudian's counting rule, not len(). Recorded as a risk, not a
        # silent fix — a machine-truncated title usually needs a human rewrite.
        kept, used = [], 0
        for ch in source_title:
            w = 2 if ord(ch) > 0x7F else 1
            if used + w > limits["title_max"]:
                break
            kept.append(ch)
            used += w
        text = "".join(kept)
        report.risks.append(finding(
            "title_truncated",
            f"标题按抖店口径为 {length} 字符，超出上限 {limits['title_max']}，已截断至 {used} 字符，建议人工改写",
            "/title/text",
            f"原标题: {source_title}",
        ))
    elif length < limits["title_min"]:
        report.errors.append(finding(
            "title_too_short",
            f"标题按抖店口径仅 {length} 字符，低于下限 {limits['title_min']}",
            "/title/text",
            source_title,
        ))

    hits = [t for t in SUPERLATIVE_TERMS if t in text]
    if hits:
        report.risks.append(finding(
            "title_superlative",
            f"标题含广告法绝对化用语 {hits}，需改写后才能上架",
            "/title/text",
            "、".join(hits),
        ))

    for pattern, desc in CONTACT_PATTERNS:
        m = pattern.search(text)
        if m:
            report.risks.append(finding(
                "title_contact_info", f"标题含{desc}", "/title/text", m.group(0)))

    brand_hits = check_brand_risk(text)
    if brand_hits:
        report.risks.append(finding(
            "title_brand_ip",
            f"标题含品牌/IP 词 {brand_hits}，需确认授权",
            "/title/text",
            "、".join(brand_hits),
        ))

    return {"text": text, "sourceText": original_title}


# PIPE-5 image download — see build_images() below. Keep the limit aligned with
# `browser_upload_file` (25MB) so projection's per-image opencode call is never
# given a giant blob it can't fit through its own model.
_MAX_IMG_BYTES = 25 * 1024 * 1024
_DL_TIMEOUT_S = 30
_IMG_EXTS = ("jpg", "jpeg", "png", "webp")


def _download_image_bytes(url: str, timeout: int = _DL_TIMEOUT_S) -> tuple[bytes | None, str | None]:
    """Fetch an image into memory. Product preprocessing never materializes image files."""
    announce_work('image-download', timeout * 3 + 2)
    last_err: str | None = None
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://detail.1688.com/",
        "Accept": "image/*",
    })
    for delay in (0.0, 0.5, 1.5):
        if delay:
            time.sleep(delay)
        try:
            with urlopen(req, timeout=timeout) as res:
                cl = res.headers.get("Content-Length")
                if cl and cl.isdigit() and int(cl) > _MAX_IMG_BYTES:
                    return None, f"图片过大({cl} bytes>{_MAX_IMG_BYTES})"
                chunks: list[bytes] = []
                total = 0
                while chunk := res.read(64 * 1024):
                    total += len(chunk)
                    if total > _MAX_IMG_BYTES:
                        return None, f"图片过大(>{_MAX_IMG_BYTES} bytes)"
                    chunks.append(chunk)
                return b"".join(chunks), None
        except (HTTPError, URLError, OSError, TimeoutError) as exc:
            last_err = f"{type(exc).__name__}: {exc}"
    return None, last_err


# Doudian 图片硬约束(按角色)。schema 未明示的字节/像素上限,**不编**:
# - detail 图(描述图)单张上限:canonical.schema.json 没规定。保守估计沿用
#   main 的 5M,但代码不强制 —— 这一行注释就是给后来人看的警告,
#   schema 扩了 x-doudian-detail-max-bytes 之后再来这里补。
# - whiteBackground / longPic / mainThreeToFour 的具体像素下限:
#   schema 没说,只说了比例(1:1 / 3:4)。像素下限保守沿用 main 的 ≥600x600,
#   待官方文档/真实 addV2 调用证伪再调整。
MIN_IMG_DIM = 600
MAX_IMG_BYTES_PER_IMAGE = 5 * 1024 * 1024
ASPECT_TOLERANCE = 0.01  # 比例校验的相对容差(1%)


def _inspect_image(role: str, idx: int, img: dict, dest: Path, report):
    """读取本地图片文件,把 width/height/bytes 落进 img dict,并按 role 校验
    抖店硬约束。失败/缺 PIL 走 warning,不阻断主流程。

    校验规则(以 canonical.schema.json / doudian-addv2.schema.json 为准):

    | role              | 像素        | 字节     | 比例 |
    |-------------------|-------------|----------|------|
    | main              | ≥600x600    | ≤5M      | -    |
    | mainThreeToFour   | ≥600x600*   | ≤5M      | -    |
    | whiteBackground   | -           | -        | 1:1  |
    | longPic           | -           | -        | 3:4  |
    | detail            | schema 未明 | schema 未明 | -    |

    * 保守沿用,未证实
    detail 不做硬检查 —— schema 没写,check 比不 check 危险。
    """
    try:
        from PIL import Image  # 运行时按需引入;不在 requirements.txt 硬绑
    except ImportError:
        report.warnings.append(finding(
            "image_inspect_unavailable",
            "Pillow 未安装,跳过图片尺寸/比例校验 —— 至少需要 `pip install Pillow`",
            f"/images/{role}/{idx}",
        ))
        return

    try:
        with Image.open(dest) as im:
            im.verify()  # 校验文件能解码(捕捉损坏图)
        with Image.open(dest) as im:
            w, h = im.size
    except Exception as e:
        report.warnings.append(finding(
            "image_inspect_failed",
            f"{role} 图 {idx} 读图失败:{type(e).__name__}: {e}",
            f"/images/{role}/{idx}",
        ))
        return

    sz = dest.stat().st_size
    img["width"] = w
    img["height"] = h
    img["bytes"] = sz

    field = f"/images/{role}/{idx}"

    # 体积 —— main / mainThreeToFour 显式 ≤5M;其他角色 schema 未写,不报
    if role in ("main", "mainThreeToFour") and sz > MAX_IMG_BYTES_PER_IMAGE:
        report.errors.append(finding(
            "image_too_large",
            f"{role} 图 {idx} {sz/1024/1024:.1f}M 超过 5M 上限",
            field,
        ))

    # 像素下限 —— main 显式 ≥600;mainThreeToFour 保守沿用
    if role in ("main", "mainThreeToFour"):
        if w < MIN_IMG_DIM or h < MIN_IMG_DIM:
            report.errors.append(finding(
                "image_too_small",
                f"{role} 图 {idx} {w}×{h} 不足 {MIN_IMG_DIM}×{MIN_IMG_DIM}",
                field,
            ))

    if role == "whiteBackground" and w != h:
        report.errors.append(finding("image_aspect_wrong", f"白底图必须 1:1,实际 {w}×{h}", field))
    elif role == "longPic" and (h == 0 or abs(h * 3 - w * 4) > w * ASPECT_TOLERANCE):
        report.errors.append(finding("image_aspect_wrong", f"3:4 长图比例不符,实际 {w}×{h}(要求 3:4)", field))


def _inspect_image_bytes(role: str, idx: int, img: dict, data: bytes, report) -> None:
    """Inspect decoded image bytes without allocating a local asset path."""
    try:
        from PIL import Image
    except ImportError:
        report.warnings.append(finding(
            "image_inspect_unavailable",
            "Pillow 未安装,跳过图片尺寸/比例校验 —— 至少需要 `pip install Pillow`",
            f"/images/{role}/{idx}",
        ))
        return
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
    except Exception as exc:
        report.warnings.append(finding(
            "image_inspect_failed",
            f"{role} 图 {idx} 读图失败:{type(exc).__name__}: {exc}",
            f"/images/{role}/{idx}",
        ))
        return

    img["width"] = w
    img["height"] = h
    img["bytes"] = len(data)
    field = f"/images/{role}/{idx}"
    if role in ("main", "mainThreeToFour") and len(data) > MAX_IMG_BYTES_PER_IMAGE:
        report.errors.append(finding("image_too_large", f"{role} 图 {idx} {len(data)/1024/1024:.1f}M 超过 5M 上限", field))
    if role in ("main", "mainThreeToFour") and (w < MIN_IMG_DIM or h < MIN_IMG_DIM):
        report.errors.append(finding("image_too_small", f"{role} 图 {idx} {w}×{h} 不足 {MIN_IMG_DIM}×{MIN_IMG_DIM}", field))
    if role == "whiteBackground" and w != h:
        report.errors.append(finding("image_aspect_wrong", f"白底图必须 1:1,实际 {w}×{h}", field))
    elif role == "longPic" and (h == 0 or abs(h * 3 - w * 4) > w * ASPECT_TOLERANCE):
        report.errors.append(finding("image_aspect_wrong", f"3:4 长图比例不符,实际 {w}×{h}(要求 3:4)", field))


def _crop_square_bytes(source: bytes, label: str = "主图") -> tuple[bytes | None, str | None]:
    """Return a JPEG square derivative in memory, retaining the source bytes untouched."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(source)) as im:
            im.load()
            side = min(im.width, im.height)
            left = (im.width - side) // 2
            top = (im.height - side) // 2
            out = io.BytesIO()
            im.crop((left, top, left + side, top + side)).convert("RGB").save(
                out, format="JPEG", quality=92, optimize=True,
            )
            return out.getvalue(), None
    except (ImportError, AttributeError, ValueError, OSError) as exc:
        return None, f"{label}裁剪失败:{type(exc).__name__}: {exc}"


def materialize_spec_images_memory(specs: list, image_assets: dict[str, bytes], report, crop: bool = True) -> None:
    """Download and square-crop SKU images in memory for CDN upload."""
    for si, spec in enumerate(specs):
        for vi, value in enumerate(spec.get("values") or []):
            url = value.get("imageUrl")
            if not url:
                continue
            field = f"/specs/{si}/values/{vi}"
            data, err = _download_image_bytes(url)
            if err is not None or data is None:
                report.warnings.append(finding("spec_image_download_failed", err or "空图片", field))
                value.pop("imageUrl", None)
                continue
            if crop:
                cropped, crop_err = _crop_square_bytes(data, "规格图")
                if cropped is not None:
                    data = cropped
                else:
                    report.warnings.append(finding("spec_image_crop_failed", f"{crop_err}，将使用原始规格图", field))
            value["sourceImageUrl"] = url
            image_assets[field] = data

def drop_spec_images_if_over_total(specs: list, raw, limits, report) -> int:
    """主图 + 规格图已经超过抖店图片总量上限时，整组丢弃规格图。返回丢弃张数。

    三类图里只有规格图还能让：主图必填且已按 main_max 裁过，详情图在这种情况下
    早已被让到 0 张仍然不够（免钉胶实测：主图 5 + 规格图 53 = 58 > 50，详情图
    容量算出来是 -8）。规格图在抖店是选填，所以它是唯一能让的一类。

    **只能整组让，不能裁一部分**：spec_pic 是位置绑定的逗号串（第 i 张图 = 主规格
    第 i 个取值的图），裁掉尾部会让缺口之后的每张图整体前移一位，挂到别的规格值
    身上且全程不报错。同一条约束在 build_addv2 里也写着。

    放在 materialize_spec_images 之前：先决定丢，就不必白下载 53 张图。
    """
    with_image = [v for s in specs for v in (s.get("values") or []) if v.get("imageUrl")]
    if not with_image:
        return 0
    main_count = min(len(extract_images(raw, "CommodityImage", "Main")), limits["main_max"])
    if main_count + len(with_image) <= limits["total_max"]:
        return 0
    for value in with_image:
        value.pop("imageUrl", None)
    report.warnings.append(finding(
        "spec_images_dropped_over_total",
        f"主图 {main_count} 张 + 规格图 {len(with_image)} 张超过抖店图片总量上限 "
        f"{limits['total_max']} 张。规格图是选填且按位置绑定规格值（裁一部分会整组错位），"
        f"已整组丢弃，腾出的额度留给详情图。要保留规格图需减少规格值数量。",
        "/specs",
    ))
    return len(with_image)


def build_images(
    raw,
    limits,
    report,
    image_assets: dict[str, bytes] | None = None,
    crop_main_images: bool = True,
    spec_image_count: int | None = None,
    preprocess_config: dict | None = None,
):
    main_urls = extract_images(raw, "CommodityImage", "Main")
    detail_urls = extract_images(raw, "DetailImage", "Detail")
    removed = []
    if preprocess_config:
        image_config = preprocess_config["images"]
        seed = image_config.get("seed")
        source_main, source_detail = main_urls, detail_urls
        selected_main = select_image_urls(source_main, image_config["main"], seed)
        selected_detail = select_image_urls(source_detail, image_config["detail"], seed)
        removed.extend({"url": url, "reason": "配置选择裁剪", "detectedBy": "product-preprocess-config"}
                       for url in source_main if url not in selected_main)
        removed.extend({"url": url, "reason": "配置选择裁剪", "detectedBy": "product-preprocess-config"}
                       for url in source_detail if url not in selected_detail)
        main_urls, detail_urls = selected_main, selected_detail
    # 规格图占的额度以【canonical 的 specs 实际还剩多少张】为准,不是 raw 里有多少。
    # drop_spec_images_if_over_total 可能已经整组丢过了 —— 那时还按 raw 计数,会把
    # 已经腾出来的额度继续算作被占用,详情图白白被裁掉。
    spec_image_urls = extract_spec_images(raw)
    spec_image_slots = len(spec_image_urls) if spec_image_count is None else spec_image_count
    if not main_urls:
        report.errors.append(finding("main_images_missing", "无任何主图，商品无法上架", "/images/main"))

    # Doudian accepts at most the schema limit for carousel images. Keep the
    # source order, crop only the overflow, and retain every removed URL for
    # audit so the choice is reversible.
    if len(main_urls) > limits["main_max"]:
        for url in main_urls[limits["main_max"]:]:
            removed.append({
                "url": url,
                "reason": f"超出抖店主图上限 {limits['main_max']} 张",
                "detectedBy": "build_canonical",
            })
        report.warnings.append(finding(
            "main_images_over_limit",
            f"来源有 {len(main_urls)} 张主图，抖店上限 {limits['main_max']} 张，"
            f"已保留前 {limits['main_max']} 张；若首图不是最佳展示图需人工调整顺序",
            "/images/main",
        ))
        main_urls = main_urls[:limits["main_max"]]

    if len(detail_urls) > limits["detail_max"]:
        for url in detail_urls[limits["detail_max"]:]:
            removed.append({
                "url": url,
                "reason": f"超出详情图上限 {limits['detail_max']} 张",
                "detectedBy": "build_canonical",
            })
        detail_urls = detail_urls[:limits["detail_max"]]

    # Reserve the exact number of spec images before trimming details. Spec
    # images are emitted from `specs` and must not be removed or re-ordered.
    detail_capacity = limits["total_max"] - len(main_urls) - spec_image_slots
    if detail_capacity < 0:
        report.errors.append(finding(
            "images_total_over_limit",
            f"主图 {len(main_urls)} 张 + 规格图 {spec_image_slots} 张已超过抖店图片总量上限 "
            f"{limits['total_max']} 张，主图和规格图不能自动裁剪",
            "/images",
        ))
        detail_capacity = 0

    allowed_detail = min(limits["detail_max"], detail_capacity)
    total_before_detail_trim = len(main_urls) + len(detail_urls) + spec_image_slots
    if len(detail_urls) > allowed_detail:
        overflow = len(detail_urls) - allowed_detail
        for url in detail_urls[allowed_detail:]:
            removed.append({
                "url": url,
                "reason": f"超出抖店图片总量上限 {limits['total_max']} 张",
                "detectedBy": "build_canonical",
            })
        detail_urls = detail_urls[:allowed_detail]
        report.warnings.append(finding(
            "images_total_over_limit",
            f"图片总数 {total_before_detail_trim} 超出抖店上限 {limits['total_max']}，"
            f"已从详情图尾部裁掉 {overflow} 张（主图和规格图保留）",
            "/images",
        ))

    if not detail_urls:
        report.warnings.append(finding("detail_images_missing", "无详情图，抖店的商品描述必填", "/images/detail"))

    # `checked: false` is load-bearing — it says "not yet inspected", not
    # "clean". The watermark pass flips it.
    #
    # `image_assets` is an ephemeral in-memory handoff to projection/upload.
    # Canonical itself remains JSON-only and never exposes a local path.
    def to_image(url: str, role: str, idx: int) -> dict:
        img: dict = {"url": url, "sourceUrl": url, "checked": False}
        if image_assets is None:
            return img
        data, err = _download_image_bytes(url)
        if err is None and data is not None:
            inspect_data = data
            if role == "main" and crop_main_images:
                cropped, crop_err = _crop_square_bytes(data)
                if crop_err is None and cropped is not None:
                    inspect_data = cropped
                    report.warnings.append(finding(
                        "main_image_cropped",
                        f"主图 {idx} 已生成中心 1:1 裁剪图",
                        f"/images/{role}/{idx}",
                    ))
                else:
                    report.warnings.append(finding(
                        "main_image_crop_failed",
                        f"{crop_err}，将使用原始主图",
                        f"/images/{role}/{idx}",
                    ))
            image_assets[f"/images/{role}/{idx}"] = inspect_data
            _inspect_image_bytes(role, idx, img, inspect_data, report)
        else:
            img["downloadError"] = err
            report.warnings.append(finding(
                "image_download_failed",
                f"{role} 图 {idx} 下载失败:{err}",
                f"/images/{role}/{idx}",
            ))
        return img

    images = {
        "main":   [to_image(u, "main",   i) for i, u in enumerate(main_urls)],
        "detail": [to_image(u, "detail", i) for i, u in enumerate(detail_urls)],
    }
    if removed:
        images["removed"] = removed
    return images


def build_specs_and_skus(raw, report, preprocess_config=None):
    price_stock = raw.get("PriceAndStock") or {}

    # 文案清洗放在这里而不是只放 _normalize_raw_input:后者只覆盖【扁平采集】这条路,
    # 而 raw 也可能本来就是 1688 形态(测试与手工输入)。specs 与 skus 两侧必须同口径 ——
    # 差一个空格就对不上笛卡尔积,商品被抖店直接拒。
    specs = []
    for prop in price_stock.get("SkuProperties") or []:
        name = sanitize_text(prop.get("PropertyName"))
        if preprocess_config:
            name = apply_regex_rules(name, preprocess_config["text"].get("compiledReplaceRules", []))
        if not name:
            continue
        values = []
        for v in prop.get("Values") or []:
            value_name = sanitize_text(v.get("ValueName"))
            if preprocess_config:
                value_name = apply_regex_rules(value_name, preprocess_config["text"].get("compiledReplaceRules", []))
            if not value_name:
                continue
            entry = {"value": value_name}
            if v.get("ImgUrl"):
                entry["imageUrl"] = v["ImgUrl"]
            values.append(entry)
        if values:
            specs.append({"name": name, "values": values})

    skus = []
    for sku in price_stock.get("Skus") or []:
        price = sku.get("Price")
        if not isinstance(price, (int, float)) or price <= 0:
            report.warnings.append(finding(
                "sku_price_invalid",
                f"SKU 来源价非法（{price!r}），已剔除该 SKU",
                "/skus",
                json.dumps(sku.get("SkuSpec"), ensure_ascii=False),
            ))
            continue
        entry = {
            "specs": [
                 {"name": apply_regex_rules(sanitize_text(s.get("PropertyName")), preprocess_config["text"].get("compiledReplaceRules", [])) if preprocess_config else sanitize_text(s.get("PropertyName")),
                  "value": apply_regex_rules(sanitize_text(s.get("ValueName")), preprocess_config["text"].get("compiledReplaceRules", [])) if preprocess_config else sanitize_text(s.get("ValueName"))}
                for s in sku.get("SkuSpec") or []
                if s.get("PropertyName") and s.get("ValueName")
            ],
            "price": round(float(price), 2),
            "sourcePrice": round(float(price), 2),
            "stock": int(sku.get("Quantity") or 0),
        }
        if sku.get("OuterID"):
            entry["merchantCode"] = sku["OuterID"]
        skus.append(entry)

    if not skus:
        report.errors.append(finding("skus_missing", "无任何有效 SKU", "/skus"))

    # Doudian rejects a product whose SKU count doesn't equal the cartesian
    # product of its spec dimensions.
    if specs and skus:
        expected = 1
        for s in specs:
            expected *= len(s["values"])
        if len(skus) != expected:
            report.warnings.append(finding(
                "sku_count_mismatch",
                f"SKU 数 {len(skus)} 与规格组合数 {expected} 不一致，抖店会拒绝",
                "/skus",
            ))
    return specs, skus


def build_attributes(raw, report):
    attributes = []
    for attr in ((raw.get("BaseInfo") or {}).get("Attr") or {}).get("SourceAttr") or []:
        label, value = attr.get("Label"), attr.get("Value")
        if not label or not value:
            continue
        attributes.append({
            "sourceName": label,
            "rawValue": value,
            "values": [v.strip() for v in re.split(r"[,，、]", str(value)) if v.strip()],
            "doudianPropertyId": None,
        })
    # 不在这里写 `attribute_property_ids_unmapped` pending —— 上层
    # `build_doudian_product.apply_attribute_overlay` 会用 LLM 决策填回
    # `doudianPropertyId`,那时候再判断"还有几个没填上"。在这里写是 stale:
    # 实测 17 个属性 LLM 全映射成功,但这条 pending 仍然会出现。
    return attributes


def build_brand(raw, limits, report, profile=None):
    """构造 brand 字段。

    `profile.brand.assumeNoBrand=true` → 这个店铺所有商品都按"无品牌"上架,
    即使来源声明了品牌名也直接用 `limits["no_brand_id"]`,不写
    `brand_id_unmapped` pending(因为运营已明确表态)。
    """
    source_name = ""
    for attr in ((raw.get("BaseInfo") or {}).get("Attr") or {}).get("SourceAttr") or []:
        if attr.get("Label") in ("品牌", "brand", "Brand"):
            source_name = (attr.get("Value") or "").strip()
            break

    assume_no_brand = bool((profile or {}).get("brand", {}).get("assumeNoBrand"))
    brand = {"doudianBrandId": limits["no_brand_id"]}
    if source_name:
        brand["sourceName"] = source_name
    # "无" is 1688's own placeholder for "no brand", so it maps to Doudian's
    # no-brand id rather than being treated as a real brand needing lookup.
    if source_name and source_name not in ("无", "无品牌", "其他", "其它") and not assume_no_brand:
        report.pending.append(finding(
            "brand_id_unmapped",
            f"来源品牌「{source_name}」未映射到抖店 standard_brand_id（需查 /brand/list），"
            f"当前回落到无品牌 ID {limits['no_brand_id']}，若确有品牌需人工确认授权",
            "/brand/doudianBrandId",
            source_name,
        ))
    return brand


def _compute_sku_price(source: float, strategy: str, cfg: dict, report) -> float:
    """按 4 种 strategy 之一算单个 SKU 的售价。min > max 直接写 errors(不静默 clamp)。"""
    if strategy == "fixed_amount":
        return source + float(cfg.get("markup", 10.0))
    if strategy == "percentage":
        return source * (1 + float(cfg["markupPercent"]) / 100)
    if strategy == "percentage_plus_fixed":
        return source * (1 + float(cfg["markupPercent"]) / 100) + float(cfg["markupFixed"])
    if strategy == "min_max":
        base = source + float(cfg.get("markup", 0))
        lo = float(cfg["minPriceYuan"])
        hi = float(cfg["maxPriceYuan"])
        if lo > hi:
            # 不静默 clamp —— 边界反了就是配错,让人来修;否则下游会拿一个
            # 看似合法其实违反约束的价格去上架。
            report.errors.append(finding(
                "pricing_min_max_inverted",
                f"minPriceYuan ({lo}) > maxPriceYuan ({hi}),边界反了,无法 clamp",
                "/pricing",
            ))
            return source  # 退回 sourcePrice,不改也不假装算过
        return max(lo, min(base, hi))
    # 不该到这里:strategy 在调用前已经被 normalize 成已知集合之一
    return source


def apply_profile(canonical, profile, report):
    """Merge the shop-level fields that raw.json cannot possibly supply."""
    if not profile:
        report.pending.append(finding(
            "shop_profile_missing",
            "未提供 shop-profile，抖店必填的 product_type / reduce_type / freight_id / mobile / commit 全部缺失",
            "/listing",
        ))
        # Without a profile there is no markup, so `price` still equals the
        # source purchase price. That is a zero-margin listing, and it looks
        # like a normal price unless we say so out loud.
        if canonical["skus"]:
            report.risks.append(finding(
                "price_not_marked_up",
                f"{len(canonical['skus'])} 个 SKU 的售价仍等于来源采购价（未应用任何加价策略），按此上架即零毛利",
                "/pricing",
            ))
        return

    listing = dict(profile.get("listing") or {})
    if listing:
        canonical["listing"] = listing
    shipping = dict(profile.get("shipping") or {})
    shipping.pop("defaultWeightGram", None)
    if shipping:
        canonical["shipping"] = shipping
    if profile.get("afterSale"):
        canonical["afterSale"] = dict(profile["afterSale"])
    if (profile.get("brand") or {}).get("defaultDoudianBrandId"):
        canonical["brand"]["doudianBrandId"] = profile["brand"]["defaultDoudianBrandId"]

    pricing_cfg = profile.get("pricing") or {}
    strategy = pricing_cfg.get("strategy", "fixed_amount")
    # 兼容 round 1 配置名:老 shop-profile.json 里 strategy 写成
    # "source_price_plus_fixed_amount",语义与 fixed_amount 相同,翻译掉就丢。
    if strategy == "source_price_plus_fixed_amount":
        strategy = "fixed_amount"

    known_strategies = ("fixed_amount", "percentage", "percentage_plus_fixed", "min_max")
    if strategy not in known_strategies:
        # 配错或迁移期:不抛,但要明写出来,不然 pricing 走的是哪个语义没人能查
        report.warnings.append(finding(
            "pricing_strategy_unknown",
            f"pricing.strategy {strategy!r} 不识别,回落到 fixed_amount",
            "/pricing",
        ))
        strategy = "fixed_amount"

    pricing_record: dict = {"strategy": strategy, "currency": "CNY"}

    for sku in canonical["skus"]:
        sku["price"] = round(_compute_sku_price(sku["sourcePrice"], strategy, pricing_cfg, report), 2)

    # 落盘字段按 strategy 取 —— 只留该策略实际用到的,审计回看时不会看到一堆 None
    if strategy == "fixed_amount":
        pricing_record["markup"] = float(pricing_cfg.get("markup", 10.0))
    elif strategy == "percentage":
        pricing_record["markupPercent"] = float(pricing_cfg["markupPercent"])
    elif strategy == "percentage_plus_fixed":
        pricing_record["markupPercent"] = float(pricing_cfg["markupPercent"])
        pricing_record["markupFixed"] = float(pricing_cfg["markupFixed"])
    elif strategy == "min_max":
        pricing_record["minPriceYuan"] = float(pricing_cfg["minPriceYuan"])
        pricing_record["maxPriceYuan"] = float(pricing_cfg["maxPriceYuan"])
        if "markup" in pricing_cfg:
            pricing_record["markup"] = float(pricing_cfg["markup"])

    pricing_record["marginChecked"] = False
    canonical["pricing"] = pricing_record

    min_margin = pricing_cfg.get("minMarginYuan")
    if min_margin is not None:
        thin = [s for s in canonical["skus"] if s["price"] - s["sourcePrice"] < min_margin]
        canonical["pricing"]["marginChecked"] = True
        if thin:
            report.risks.append(finding(
                "margin_below_floor",
                f"{len(thin)} 个 SKU 加价后毛利低于下限 {min_margin} 元",
                "/pricing",
            ))

    for required, path in (("productType", "listing"), ("reduceType", "listing"),
                           ("serviceMobile", "listing"), ("freightTemplateId", "shipping")):
        if canonical.get(path, {}).get(required) is None:
            report.errors.append(finding(
                "shop_profile_incomplete",
                f"shop-profile 缺少抖店必填项 {path}.{required}",
                f"/{path}/{required}",
            ))


# --------------------------------------------------------------------------

def _normalize_raw_input(raw: dict) -> dict:
    """把采集端的扁平格式({title, attributes[], skus[], mainImages[], detailImages[],
    skuDimensions[], skuImages[]})统一成 1688 raw 形状(BaseInfo / PriceAndStock /
    CommodityImage.ConfigList[].List[])。已是 1688 raw 形状直接返回(直通)。

    这是脚本唯一接受两种入参的地方;extract_images / build_title /
    build_specs_and_skus / build_attributes / build_brand 内部都按 1688 raw 读,
    不动它们,避免双契约漂移。

    入参判据:顶层有 `title`/`skus`/`attributes` 而无 `BaseInfo` → 扁平格式。
    """
    if not isinstance(raw, dict):
        return raw
    if "BaseInfo" in raw and "PriceAndStock" in raw:
        return raw  # 已是 1688 raw

    if "title" not in raw or "skus" not in raw or "attributes" not in raw:
        return raw  # 既不是 1688 raw 也不是扁平格式,留给后续函数自己报错

    title = (raw.get("title") or "").strip()
    attributes = raw.get("attributes") or []
    skus = raw.get("skus") or []
    main_images = raw.get("mainImages") or []
    detail_images = raw.get("detailImages") or []
    sku_dimensions = raw.get("skuDimensions") or []
    sku_images = raw.get("skuImages") or []

    # 主图 / 详情图:扁平格式直接是 URL 列表;raw 形状是
    # {ConfigList: [{List: [url, ...]}, ...]},List 内部去重
    def to_config_list(urls):
        seen = []
        for u in urls:
            if u and u not in seen:
                seen.append(u)
        return {"ConfigList": [{"List": seen}]}

    # SkuProperties:扁平格式只有维度名(skuDimensions:["颜色","尺码"]),值要从 skus 里聚合;
    # 规格图(skuImages)按 propertyName+valueName 匹配回填
    value_names_by_dim: dict[str, set[str]] = {d: set() for d in sku_dimensions}
    for sku in skus:
        for sp in (sku.get("SkuSpec") or []):
            dim = sanitize_text(sp.get("PropertyName"))
            val = sanitize_text(sp.get("ValueName"))
            if dim in value_names_by_dim and val:
                value_names_by_dim[dim].add(val)

    img_url_by_dim_val: dict[tuple[str, str], str] = {}
    for img in sku_images:
        k = (sanitize_text(img.get("propertyName")), sanitize_text(img.get("valueName")))
        if k[0] and k[1] and img.get("imageUrl"):
            img_url_by_dim_val[k] = img["imageUrl"]

    sku_properties = []
    for dim in sku_dimensions:
        values = []
        for val in sorted(value_names_by_dim.get(dim) or []):
            entry = {"ValueName": val}
            img_url = img_url_by_dim_val.get((dim, val))
            if img_url:
                entry["ImgUrl"] = img_url
            values.append(entry)
        if values:
            sku_properties.append({"PropertyName": dim, "Values": values})

    # 防御性分流:1688 book 把'颜色/尺码'等销售属性塞进 attributes 数组;
    # 抖店 schema 里销售属性只能走 specs/spec_prices,不在 product_format_new
    # 类目 props 表里(类目只含商品属性:品牌/材质/风格)。如果 capture 同时给了
    # skuDimensions 和 attributes,前者出现过的 Label 必须从 attributes 里剔除
    # —— 不剔除的话这些项会被 resolve_attributes 当商品属性喂给 LLM,top-5
    # 全空 → 整条 source 属性不进 overlay_attrs → 落 pending「attribute_property_ids_unmapped」。
    # 修在 normalize 端而不是 capture 端,因为 1688 book 也不该承担抖店 schema 的知识。
    dim_set = {(d or "").strip() for d in sku_dimensions if d}
    redirected: list[tuple[str, str]] = []
    if dim_set:
        kept_attrs = []
        for a in attributes:
            label = (a.get("Label") or "").strip()
            if label and label in dim_set:
                redirected.append((label, (a.get("Value") or "").strip()))
                continue
            kept_attrs.append(a)
        attributes = kept_attrs

    return {
        "BaseInfo": {
            "Title": title,
            "CategoryName": "",
            "Attr": {
                "SourceAttr": [
                    {"Label": a.get("Label", ""), "Value": a.get("Value", "")}
                    for a in attributes
                ],
                # 分流记录:给 build_quality_report / 审计用。SourceAttr 里这些 Label 不再出现,
                # 实际值已由 SkuProperties 路径承载(specs 走 SkuSpec,值在 skus 里聚合)。
                "RedirectedFromAttributes": [
                    {"Label": lab, "Value": val, "Destination": "skuDimensions"}
                    for lab, val in redirected
                ],
            },
            "CommodityImage": to_config_list(main_images),
            "DetailImage": to_config_list(detail_images),
        },
        "PriceAndStock": {
            "SkuProperties": sku_properties,
            "Skus": [
                {
                    "Price": s.get("Price", 0),
                    "Quantity": s.get("Quantity", 0),
                    "SkuSpec": [
                        {"PropertyName": sanitize_text(sp.get("PropertyName")),
                         "ValueName": sanitize_text(sp.get("ValueName"))}
                        for sp in (s.get("SkuSpec") or [])
                    ],
                }
                for s in skus
            ],
        },
        # 透传 — SourceID / sourceUrl 给溯源;captureMeta 给报告
        "SourceID": raw.get("offerId") or raw.get("SourceID") or "",
        "sourceUrl": raw.get("sourceUrl") or "",
        "SourceMeta": {
            "pageState": raw.get("pageState") or "product",
            "captureMethod": (raw.get("captureMeta") or {}).get("captureMethod") or "1688-offer-snatch",
            "warnings": (raw.get("captureMeta") or {}).get("warnings") or [],
        },
    }


def build_canonical(
    raw,
    profile,
    limits,
    image_assets: dict[str, bytes] | None = None,
    crop_main_images: bool = True,
    preprocess_config: dict | None = None,
):
    """raw → canonical。

    `image_assets` 给出时,图片下载、裁剪和 inspect 全在内存完成，供调用方继续
    视觉检测和上传；canonical 不保存字节或本地路径。
    """
    raw = _normalize_raw_input(raw)
    report = Report()
    # The orchestration entry point may already normalize the policy before
    # handing it here. Keep the compiled regex objects in that case instead of
    # feeding the internal-only field back through public input validation.
    preprocess_config = (
        copy.deepcopy(preprocess_config)
        if preprocess_config is not None and "compiledReplaceRules" in ((preprocess_config.get("text") or {}))
        else normalize_config(preprocess_config, profile) if preprocess_config is not None else None
    )

    # 防御性分流记录:capture 把销售属性(颜色/尺码)同时塞进了 attributes 和
    # skuDimensions,normalize 把它从 SourceAttr 剔除了。落一条 warning 让
    # 用户知道这些属性被分流,而不是静默丢 — 用户可能在某次迭代里意外丢了
    # 颜色/尺码的真实信息,但 skuDimensions 路径会把它带进 specs/spec_prices。
    redirected = ((raw.get("BaseInfo") or {}).get("Attr") or {}).get("RedirectedFromAttributes") or []
    if redirected:
        report.warnings.append(finding(
            "attributes_redirected_to_specs",
            f"{len(redirected)} 个 source 属性被识别为销售属性,从 attributes 分流到 specs/spec_prices: "
            + ", ".join(f"「{r['Label']}」" for r in redirected[:5])
            + (" ..." if len(redirected) > 5 else ""),
            "/attributes",
        ))

    source_id = str(raw.get("SourceID") or "").strip()
    if not source_id:
        report.errors.append(finding("source_id_missing", "缺少 SourceID，无法查重与溯源", "/source/sourceId"))

    meta = raw.get("SourceMeta") or {}
    page_state = meta.get("pageState")
    if page_state and page_state != "product":
        report.errors.append(finding(
            "page_not_product", f"采集页面状态为 {page_state}，不是商品页（可能被登录墙或风控拦截）", "/source"))

    specs, skus = build_specs_and_skus(raw, report, preprocess_config)
    drop_spec_images_if_over_total(specs, raw, limits, report)
    spec_image_count = sum(
        1 for s in specs for v in (s.get("values") or []) if v.get("imageUrl")
    )
    if image_assets is not None:
        materialize_spec_images_memory(specs, image_assets, report, crop=crop_main_images)
    canonical = {
        "schemaVersion": 1,
        "source": {
            "platform": "1688",
            "sourceId": source_id,
            "sourceUrl": raw.get("sourceUrl") or "",
            "captureMethod": meta.get("captureMethod") or "unknown",
        },
            "title": build_title(raw, limits, report, preprocess_config),
        "category": {
            "sourceName": ((raw.get("BaseInfo") or {}).get("CategoryName") or ""),
            "doudianLeafId": None,
            "categoryProps": [],
        },
        "brand": build_brand(raw, limits, report, profile),
        "attributes": build_attributes(raw, report),
        "images": build_images(
            raw, limits, report, image_assets, crop_main_images=crop_main_images,
            spec_image_count=spec_image_count,
            preprocess_config=preprocess_config,
        ),
        "skus": skus,
        "listing": {},
        "qualityReport": {},
    }
    if preprocess_config:
        canonical["preprocessConfig"] = audit_config(preprocess_config)
    if specs:
        canonical["specs"] = specs

    # 不写 `category_leaf_id_unmapped` pending —— 上层
    # `build_doudian_product.resolve_category` 用 LLM 决策填 doudianLeafId,
    # 在这里写就是 stale:实测 leaf_id=1000009593 已映射成功但仍然报。
    # qualifications_unchecked 保留:它代表真没查,需要外部 book 接入
    # /product/qualificationConfig,留 pending 是诚实标注而非噪音。
    report.pending.append(finding(
        "qualifications_unchecked",
        "类目资质未查（依赖类目，需查 /product/qualificationConfig）；空的资质列表不代表不需要资质",
        "/qualifications",
    ))

    for w in meta.get("warnings") or []:
        report.warnings.append(finding("capture_warning", str(w), "/source"))

    apply_profile(canonical, profile, report)
    canonical["qualityReport"] = report.as_dict()
    return canonical


def main():
    parser = argparse.ArgumentParser(description="raw.json (+ shop-profile.json) → canonical.json")
    parser.add_argument("raw", help="path to raw.json")
    parser.add_argument("--profile", help="path to shop-profile.json")
    parser.add_argument("--out", help="output path (default: canonical.json beside raw.json)")
    parser.add_argument("--console-url", default=CONSOLE_URL,
                        help=f"console base URL holding the schema registry (default: {CONSOLE_URL}, $CONSOLE_URL)")
    parser.add_argument("--schema-version", type=int, default=None,
                        help="pin the canonical schema version (default: whichever is active)")
    args = parser.parse_args()

    limits = load_constraints(fetch_schema(base_url=args.console_url, version=args.schema_version))
    raw_path = Path(args.raw)
    raw = load_json(raw_path)
    profile = load_json(Path(args.profile)) if args.profile else None

    canonical = build_canonical(raw, profile, limits)
    out_path = Path(args.out) if args.out else raw_path.parent / "canonical.json"
    save_json(out_path, canonical)

    r = canonical["qualityReport"]
    print(f"→ {out_path}")
    print(f"  errors={len(r['errors'])} risks={len(r['risks'])} "
          f"warnings={len(r['warnings'])} pending={len(r['pending'])}")
    for bucket in ("errors", "risks"):
        for f in r[bucket]:
            print(f"  [{bucket[:-1]}] {f['code']}: {f['message']}")
    # Exit 1 on blocking errors so a pipeline stops here rather than carrying a
    # broken product forward. Risks and pendings do NOT block — they are for the
    # human at the form.
    return 1 if r["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
