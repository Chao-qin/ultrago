#!/usr/bin/env python3
"""vision_image 的压缩策略回归。不碰网络、不碰磁盘（图全在内存里造）。

守的是三件事，顺序就是它们出错的代价从大到小：

  1. **绝不丢图**。压不动（坏字节 / 没装 Pillow / 编码报错）必须原样送出 —— 上游
     拿不到图会退化成"没检查却标成检查过"，那比慢一点严重得多。
  2. **不该压的别压**。已经够小的图逐字节透传：一次无收益的重编码就是白掉一次画质，
     而且会让"小图透传"这条既有契约（既有断言依赖它）悄悄失效。
  3. **该压的压到位**。长边、透明区垫白、EXIF 方向这三条，错了都会让模型看错东西。

跑（需要 Pillow；缺了会打印跳过而不是失败）：
    python3 .claude/skills/product-preprocess/scripts/test_vision_image.py
"""
from __future__ import annotations

import base64
import io
import os
import random
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vision_image  # noqa: E402

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("跳过：这台解释器没有 Pillow（pip install Pillow）")
    sys.exit(0)

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f" — {detail}"))
    if not cond:
        FAILURES.append(name)


@contextmanager
def env(**kv):
    """临时改环境变量。config() 每次调用现读，所以不必重新 import。"""
    old = {k: os.environ.get(k) for k in kv}
    os.environ.update({k: str(v) for k, v in kv.items()})
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def noise_jpeg(w: int, h: int, quality: int = 92) -> bytes:
    """造一张"照片样"的 JPEG。纯色图会被 JPEG 压到几百字节，测不出任何东西。"""
    rnd = random.Random(42)
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256))
    out = io.BytesIO()
    im.save(out, format="JPEG", quality=quality)
    return out.getvalue()


def noise_png(w: int, h: int) -> bytes:
    """噪声 PNG：纯色 PNG 会压到几千字节，测不出"字节超限"这条路径。"""
    rnd = random.Random(7)
    im = Image.new("RGB", (w, h))
    im.putdata([(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)) for _ in range(w * h)])
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def png_rgba(w: int, h: int, alpha_region: bool = True) -> bytes:
    im = Image.new("RGBA", (w, h), (200, 30, 30, 255))
    if alpha_region:
        for y in range(h // 2):
            for x in range(w // 2):
                im.putpixel((x, y), (0, 0, 0, 0))  # 左上四分之一全透明
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


def dims(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as im:
        return im.size


print("大图 / 小图")
with env(BCP_VISION_MAX_EDGE=1024, BCP_VISION_MAX_BYTES=512 * 1024):
    big = noise_jpeg(2400, 1600)
    p = vision_image.prepare(big, "image/jpeg")
    check("大图被重编码", p.meta["recompressed"] is True, str(p.meta))
    check("长边落到上限", max(dims(p.data)) == 1024, f"sent={p.meta.get('sentSize')}")
    check("字节变小", len(p.data) < len(big), f"{len(big)} -> {len(p.data)}")
    check("输出是 JPEG", p.mime == "image/jpeg" and p.data[:2] == b"\xff\xd8", p.mime)
    check("原始尺寸记录的是原图", p.meta["originalSize"] == "2400x1600", str(p.meta))

    small = noise_jpeg(800, 800, quality=70)
    p2 = vision_image.prepare(small, "image/jpeg")
    check("已够小的图逐字节透传", p2.data == small and p2.meta.get("skipped") == "already-small", str(p2.meta))
    check("透传时不改 mime", p2.mime == "image/jpeg", p2.mime)
    check("透传时没有 note", p2.note is None, str(p2.note))

print("长边约束的两种极端")
with env(BCP_VISION_MAX_EDGE=1024):
    wide = noise_jpeg(3200, 400)
    pw = vision_image.prepare(wide, "image/jpeg")
    check("超宽图长边压到上限", max(dims(pw.data)) == 1024, pw.meta.get("sentSize"))
    check("超宽图比例没变", dims(pw.data) == (1024, 128), str(dims(pw.data)))

    tall = noise_jpeg(750, 3000)
    pt = vision_image.prepare(tall, "image/jpeg")
    check("细长详情图压到上限", dims(pt.data) == (256, 1024), str(dims(pt.data)))

print("透明区必须垫白底")
with env(BCP_VISION_MAX_EDGE=256):
    rgba = png_rgba(512, 512)
    pr = vision_image.prepare(rgba, "image/png")
    check("RGBA 被转成 JPEG", pr.mime == "image/jpeg" and pr.meta["recompressed"], str(pr.meta))
    with Image.open(io.BytesIO(pr.data)) as im:
        corner = im.convert("RGB").getpixel((2, 2))
    check("透明区变成白色而不是黑色", all(c > 235 for c in corner), f"corner={corner}")

print("EXIF 方向")
with env(BCP_VISION_MAX_EDGE=1024):
    im = Image.new("RGB", (1600, 800), (10, 120, 200))
    exif = Image.Exif()
    exif[274] = 6  # 顺时针 90°，拍出来的尺寸其实是 800x1600
    buf = io.BytesIO()
    im.save(buf, format="JPEG", exif=exif.tobytes())
    pe = vision_image.prepare(buf.getvalue(), "image/jpeg")
    check("按 EXIF 摆正后再缩", dims(pe.data) == (512, 1024), str(dims(pe.data)))

print("字节超限但尺寸合格")
with env(BCP_VISION_MAX_EDGE=1024, BCP_VISION_MAX_BYTES=8 * 1024):
    png = noise_png(800, 800)
    pb = vision_image.prepare(png, "image/png")
    check("只为省字节也重编码", pb.meta["recompressed"] is True, f"{len(png)}B {pb.meta}")
    check("尺寸不动", dims(pb.data) == (800, 800), str(dims(pb.data)))
    check("确实更小", len(pb.data) < len(png), f"{len(png)} -> {len(pb.data)}")

print("fail-open")
with env(BCP_VISION_MAX_EDGE=1024):
    junk = b"image-bytes"
    pj = vision_image.prepare(junk, "image/jpeg")
    check("坏字节原样返回", pj.data == junk, pj.data[:20].hex())
    check("坏字节给出原因", bool(pj.note) and pj.meta.get("skipped") == "error", str(pj.meta))
    check("坏字节不改 mime", pj.mime == "image/jpeg", pj.mime)

print("开关与覆盖")
with env(BCP_VISION_COMPRESS=0):
    big = noise_jpeg(2400, 1600)
    pd = vision_image.prepare(big, "image/jpeg")
    check("关闭时原样送出", pd.data == big and pd.meta.get("skipped") == "BCP_VISION_COMPRESS=0", str(pd.meta))

with env(BCP_VISION_MAX_EDGE=512, BCP_VISION_JPEG_QUALITY=60):
    big = noise_jpeg(2400, 1600)
    pc = vision_image.prepare(big, "image/jpeg")
    check("max_edge 可覆盖", max(dims(pc.data)) == 512, str(dims(pc.data)))

print("llm_client 的边界（类目顶层那条路）")
import llm_client  # noqa: E402

with env(BCP_VISION_MAX_EDGE=1024):
    big = noise_jpeg(2400, 1600)
    b64 = base64.b64encode(big).decode()
    out = llm_client._compressed_b64(b64)
    check("大图 base64 被换小", len(out) < len(b64), f"{len(b64)} -> {len(out)}")
    check("换小后仍是合法 base64 且长边 1024",
          max(dims(base64.b64decode(out))) == 1024)

    small = noise_jpeg(800, 800, quality=70)
    sb64 = base64.b64encode(small).decode()
    check("小图 base64 原样透传", llm_client._compressed_b64(sb64) == sb64)
    check("坏 base64 不炸", llm_client._compressed_b64("QUJD") == "QUJD")

print()
if FAILURES:
    print(f"{len(FAILURES)} 项失败：" + ", ".join(FAILURES))
    sys.exit(1)
print("全部通过")
