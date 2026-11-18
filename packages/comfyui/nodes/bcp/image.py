"""OpenAI 兼容出图节点：直接调 images.generate / images.edit。

相比 FlexAI 多开放了画质、张数、透明背景、蒙版，并且所有参考图都会发出去
（FlexAI 改图只用第一张）。接口地址和 key 读 packages/comfyui/.env（与 FlexAI 共用，可在 设置 → BCP 里填写），
每次执行都重新读；模型下拉框与 FlexAI 共用 flexai_models.json。
"""
import base64
import io
import json
import os
import urllib.request

import numpy as np
import torch
from dotenv import dotenv_values
from openai import OpenAI
from PIL import Image

PKG_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..")
MAX_REFS = 8
# 种子不发给接口：ComfyUI 输入不变时直接复用上次结果，靠它每次运行换值才会重新出图
SEED_TIP = "不发给接口。每次运行自动换值，让 ComfyUI 重新出图；想复用上次结果就把下面的控制改成 fixed"


def image_models():
    with open(os.path.join(PKG_DIR, "flexai_models.json"), encoding="utf-8") as f:
        return json.load(f)["flexai_image_models"]


def to_pil(frame):
    return Image.fromarray(np.clip(frame.cpu().numpy() * 255 + 0.5, 0, 255).astype(np.uint8))


def png(img, name):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return (name, buf.getvalue(), "image/png")


def mask_png(mask, size):
    """ComfyUI 的 MASK 是 1 = 选中；OpenAI 要的是透明（alpha 0）= 要重绘的区域。"""
    m = mask[0] if mask.ndim == 3 else mask
    alpha = Image.fromarray(np.clip((1 - m.cpu().numpy()) * 255 + 0.5, 0, 255).astype(np.uint8), "L").resize(size)
    img = Image.new("RGBA", size, (255, 255, 255, 255))
    img.putalpha(alpha)
    return png(img, "mask.png")


def decode(item):
    if item.b64_json:
        data = base64.b64decode(item.b64_json)
    else:
        with urllib.request.urlopen(item.url, timeout=120) as r:
            data = r.read()
    return Image.open(io.BytesIO(data)).convert("RGBA")


class BCPOpenAIImage:
    CATEGORY = "bcp"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("images", "alpha")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (image_models(),),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "size": ("STRING", {"default": "auto", "tooltip": "宽x高，如 1536x1024，宽高需为 16 的倍数；auto 由模型决定"}),
                "quality": (["auto", "low", "medium", "high", "xhigh", "max"], {"default": "medium", "tooltip": "画质越高越贵；xhigh / max 只有 gpt-image-2.5 系列支持"}),
                "n": ("INT", {"default": 1, "min": 1, "max": 4, "tooltip": "一次出几张，每张单独计费"}),
                "background": (["auto", "opaque", "transparent"], {"tooltip": "transparent 出透明底，保存前接 JoinImageWithAlpha"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True,
                                 "tooltip": SEED_TIP}),
            },
            "optional": {
                **{f"image_{i}": ("IMAGE",) for i in range(1, MAX_REFS + 1)},
                "mask": ("MASK", {"tooltip": "选中区域会被重绘，作用在 image_1 上"}),
            },
        }

    def run(self, model, prompt, size, quality, n, background, seed, mask=None, **images):
        env = dotenv_values(os.path.join(PKG_DIR, ".env"))
        key = env.get("OPENAI_API_KEY") or ""
        if not key or key.startswith("your_key"):
            raise ValueError("还没配置出图接口：在 设置 → BCP 里填写接口地址和 API Key")
        client = OpenAI(api_key=key, base_url=env.get("OPENAI_API_BASE") or None)
        params = dict(model=model, prompt=prompt, size=size, quality=quality, n=n, background=background)

        refs = [to_pil(frame) for i in range(1, MAX_REFS + 1) if images.get(f"image_{i}") is not None for frame in images[f"image_{i}"]]
        if refs:
            if mask is not None:
                params["mask"] = mask_png(mask, refs[0].size)
            resp = client.images.edit(image=[png(img, f"image_{i}.png") for i, img in enumerate(refs, 1)], **params)
        else:
            if mask is not None:
                raise ValueError("接了蒙版就必须接 image_1：蒙版作用在第一张参考图上")
            resp = client.images.generate(**params)

        arr = np.stack([np.asarray(decode(item), dtype=np.float32) / 255 for item in resp.data])
        return (torch.from_numpy(arr[..., :3]), torch.from_numpy(1 - arr[..., 3]))
