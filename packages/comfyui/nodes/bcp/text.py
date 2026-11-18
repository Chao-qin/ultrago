"""中文标题叠加。

内置的 TextOverlay 用 PIL 默认字体，没有中文字形（中文全部渲染成同一个方框），
而且按空格断行，中文句子不会换行。这里用系统中文字体，按字断行。
"""
import subprocess

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

# 不能出现在行首的标点：遇到时留在上一行末尾
NO_LINE_START = set("，。、！？；：）」』》,.!?;:)")


def cjk_font():
    path = subprocess.run(["fc-match", "-f", "%{file}", "sans-serif:lang=zh-cn"], capture_output=True, text=True).stdout
    if not path or "dejavu" in path.lower():
        raise RuntimeError("系统里没有中文字体，先安装：apt install fonts-wqy-zenhei")
    return path


def wrap(text, font, max_width):
    lines = []
    for para in text.splitlines() or [""]:
        line = ""
        for ch in para:
            if line and ch not in NO_LINE_START and font.getlength(line + ch) > max_width:
                lines.append(line)
                line = ""
            line += ch
        lines.append(line)
    return "\n".join(lines)


class BCPTitleOverlay:
    CATEGORY = "bcp"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "text": ("STRING", {"multiline": True, "default": ""}),
                "font_size": ("FLOAT", {"default": 8.0, "min": 1.0, "max": 30.0, "step": 0.5, "tooltip": "字号，占图片宽度的百分比"}),
                "color": ("STRING", {"default": "#ffffff"}),
                "position": (["top", "center", "bottom"],),
                "outline": ("BOOLEAN", {"default": True, "tooltip": "加黑色描边，浅色背景上也看得清"}),
            }
        }

    def run(self, images, text, font_size, color, position, outline):
        font_path = cjk_font()
        out = []
        for frame in images:
            img = Image.fromarray(np.clip(frame.cpu().numpy() * 255 + 0.5, 0, 255).astype(np.uint8))
            w, h = img.size
            font = ImageFont.truetype(font_path, max(8, round(w * font_size / 100)))
            stroke = max(1, font.size // 12) if outline else 0
            block = wrap(text.strip(), font, w * 0.9)
            draw = ImageDraw.Draw(img)
            _, top, _, bottom = draw.multiline_textbbox((0, 0), block, font=font, stroke_width=stroke, align="center")
            margin = h * 0.05
            y = {"top": margin, "center": (h - bottom) / 2, "bottom": h - margin - bottom}[position] - top
            draw.multiline_text((w / 2, y), block, font=font, fill=color, anchor="ma", align="center",
                                stroke_width=stroke, stroke_fill="black")
            out.append(torch.from_numpy(np.asarray(img, dtype=np.float32) / 255))
        return (torch.stack(out),)
