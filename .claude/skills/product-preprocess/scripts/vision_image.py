#!/usr/bin/env python3
"""送模型前把图压小 —— 只压「给 LLM 看的那一份」。

为什么单独一个模块，而不是塞进 build_canonical 的裁剪里：
`image_assets` 里那份字节是**上传给抖店的**（`upload_canonical_images` 直接读它），
在里面顺手缩小会把上架图一起毁了，还可能让主图跌破抖店 600px 下限。所以那份字节
一个字都不动，压缩只发生在**送网关的边界**上 —— 也就是本模块的两个调用点：
`scripts/llm_client._ask_gateway`（走它的是类目顶层判断）和
`projection/detect._run_detector`（图片风险检测）。这样"发出去的图"与"上传的图"
是两个东西，而且后者不变。

为什么必须压：视觉延迟基本随像素数走。实测 2026-09-12（M4/16G，qwen3.5:4b 常驻，
同一张 2800×1704 / 136KB 的图，只改本模块的 max_edge）：

    原图 2800×1704 / 136KB → 86.4s
    1024 长边 / 47KB       →  9.5s     ← 默认
    768  长边 / 28KB       →  6.0s
    512  长边 / 12KB       →  3.5s

默认取 1024 而不是更小：这条检测要读的是图上叠加的小字（店铺名/联系方式/商标），
像素砍得越狠越可能把"有"看成"没有"，而漏报正是这道门存在的理由。要更快就往下调
一档，但**换档之后必须拿带水印的真实商品图复验一次**，别只看耗时。

代价说清楚：**降分辨率有可能让细小的水印/联系方式变得认不出来**，而这条检测的存在
意义正是"别在不干净的时候判干净"。所以默认值偏保守（长边 1024、q85），而不是一压
到底；真要更省时间就调 `BCP_VISION_MAX_EDGE`，但上线前请拿带水印的真实商品图验收
一次，确认"该报的还报得出来"。

三个开关（默认值就是 console 路径实际会用的值 —— console 跑脚本时只转发一份白名单
环境变量，见 packages/console/src/flows/flow-runner.service.ts 的 SCRIPT_ENV_ALLOWLIST，
所以这些变量只在终端直跑时能覆盖）：

    BCP_VISION_MAX_EDGE    默认 1024   长边上限（px），只在超限时才缩，不放大
    BCP_VISION_JPEG_QUALITY 默认 85    重编码质量
    BCP_VISION_MAX_BYTES   默认 524288 字节上限（512KB），超了也要重编码
    BCP_VISION_COMPRESS    设为 0 完全关闭（逃生舱，回到"原样送"）

失败一律 fail-open：没装 Pillow、字节不是合法图片、编码报错 —— 都把**原始字节原样
返回**并附一条原因，绝不因为"压不了"就把图丢掉。上游拿不到图会变成"没检查却标成
检查过"，那比慢一点严重得多。
"""
from __future__ import annotations

import io
import os
import sys
from typing import NamedTuple

DEFAULT_MAX_EDGE = 1024
DEFAULT_JPEG_QUALITY = 85
DEFAULT_MAX_BYTES = 512 * 1024


class Prepared(NamedTuple):
    """压好的字节 + 它的 mime + 这次到底做了什么。

    调用方只需要 data/mime；`note` 是给 stderr 的一条人话，`meta` 留给断言与后续
    观测（真实送出去的尺寸/字节在这里，不在 canonical 里 —— canonical 描述的是
    上架件，不是模型输入）。
    """

    data: bytes
    mime: str
    note: str | None
    meta: dict


def config() -> dict:
    """现读现用（不缓存）。

    缓存看似更"一致"，但代价是测试与 CLI 没法在不重启进程的情况下改这个策略，而
    这几个值本来也不是每张图都会变的。生产里没人在跑批中途改环境变量，所以这里的
    实际行为与"读一次"没有区别。"""
    def _int(name: str, default: int) -> int:
        raw = os.environ.get(name)
        try:
            value = int(raw) if raw not in (None, "") else default
        except ValueError:
            print(f"  [vision] {name}={raw!r} 不是整数，用默认 {default}", file=sys.stderr)
            return default
        return value if value > 0 else default

    return {
        "enabled": os.environ.get("BCP_VISION_COMPRESS", "1") != "0",
        "max_edge": _int("BCP_VISION_MAX_EDGE", DEFAULT_MAX_EDGE),
        "quality": min(95, max(40, _int("BCP_VISION_JPEG_QUALITY", DEFAULT_JPEG_QUALITY))),
        "max_bytes": _int("BCP_VISION_MAX_BYTES", DEFAULT_MAX_BYTES),
    }


def _load_pillow():
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None, None
    return Image, ImageOps


def _flatten_to_rgb(Image, im):
    """透明通道必须垫白底，不能直接 convert("RGB")。

    后者等价于垫黑：一张带 alpha 的 PNG（1688 主图常见）直接转 RGB 会把透明区
    变成纯黑块，模型看到的是"图上糊了一大片黑"，比压小本身严重得多。
    """
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.split()[-1])
        return canvas
    return im.convert("RGB")


def prepare(data: bytes, mime: str = "image/jpeg") -> Prepared:
    """把一份图片字节压到"能送给模型"的尺寸。**永不抛错、永不丢图。**"""
    cfg = config()
    meta = {"originalBytes": len(data), "recompressed": False, "mime": mime}
    if not cfg["enabled"]:
        return Prepared(data, mime, None, {**meta, "skipped": "BCP_VISION_COMPRESS=0"})

    Image, ImageOps = _load_pillow()
    if Image is None:
        return Prepared(data, mime, "没有 Pillow，图片原样送出", {**meta, "skipped": "no-pillow"})

    try:
        with Image.open(io.BytesIO(data)) as im:
            src_w, src_h = im.size
            meta["originalSize"] = f"{src_w}x{src_h}"

            # 判定一律用**原图**尺寸。draft 会把解码结果缩到 1/2、1/4、1/8，先看
            # 它就等于拿解码后的尺寸做判断，那会把"原图超大但 draft 后刚好合格"
            # 误判成"本来就够小"。
            if max(src_w, src_h) <= cfg["max_edge"] and len(data) <= cfg["max_bytes"]:
                return Prepared(data, mime, None, {**meta, "skipped": "already-small"})

            # draft 让 JPEG 解码器直接吐缩略图，跳过全尺寸解码（4000px 的详情图省
            # 几百毫秒）。**只在原图至少两倍于目标时才用** —— 否则 1/2 会一次缩掉
            # 一半，1100px 的图会被压成 550px，比我们要的小一半，白白损失水印细节。
            if max(src_w, src_h) >= cfg["max_edge"] * 2:
                im.draft("RGB", (cfg["max_edge"], cfg["max_edge"]))
            # 必须在 draft 之后、读像素之前摆正：带 EXIF 方向的手机图不摆正就是躺着的。
            im = ImageOps.exif_transpose(im) or im
            im.load()
            width, height = im.size

            im = _flatten_to_rgb(Image, im)
            if max(width, height) > cfg["max_edge"]:
                im.thumbnail((cfg["max_edge"], cfg["max_edge"]), Image.LANCZOS)
            sent_w, sent_h = im.size
            out = io.BytesIO()
            im.save(out, format="JPEG", quality=cfg["quality"], optimize=True)
        payload = out.getvalue()
    except Exception as exc:  # noqa: BLE001 —— 压不了就原样送，绝不因此丢图
        return Prepared(
            data, mime,
            f"压缩失败({type(exc).__name__}: {exc})，图片原样送出",
            {**meta, "skipped": "error"},
        )

    # 只有"尺寸本来就合格、纯为省字节才压"的那种，赢了才换。尺寸超限时必须换成
    # 缩过的 —— 慢的根源是像素数，不是字节数，这时"字节更大"不构成留下原图的理由。
    resized = (sent_w, sent_h) != (width, height)
    if not resized and len(payload) >= len(data):
        return Prepared(data, mime, None, {**meta, "skipped": "no-gain"})

    after = f"{sent_w}x{sent_h}"
    meta.update({"recompressed": True, "sentBytes": len(payload), "sentSize": after})
    return Prepared(
        payload, "image/jpeg",
        f"送模型前压缩 {meta['originalSize']}/{len(data) // 1024}KB → {after}/{len(payload) // 1024}KB (q{cfg['quality']})",
        meta,
    )


def note_to_stderr(note: str | None) -> None:
    """非静默：压了、没压成、跳过了，都要在流水线日志里留一行。"""
    if note:
        print(f"  [vision] {note}", file=sys.stderr)
