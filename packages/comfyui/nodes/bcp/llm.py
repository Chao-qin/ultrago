"""文本模型：技能节点的「AI 自动选择」和公众号文章节点。

文本模型与出图分开配置，读 packages/comfyui/.env 里的 TEXT_API_BASE / TEXT_API_KEY / TEXT_MODEL
（可在 设置 → BCP 里填写），每次执行都重新读，改完不用重启。节点上的 model 不为空时覆盖 TEXT_MODEL。接口按 OpenAI 兼容的 chat.completions 调用。
"""
import json
import os
import re

from dotenv import dotenv_values
from openai import OpenAI

from .image import SEED_TIP

PKG_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..")


def chat_json(system, user, model=""):
    env = dotenv_values(os.path.join(PKG_DIR, ".env"))
    key, model = env.get("TEXT_API_KEY") or "", model.strip() or env.get("TEXT_MODEL") or ""
    if not key or key.startswith("your_") or not model:
        raise ValueError("还没配置文本模型：在 设置 → BCP 里填写接口地址、API Key 和默认模型")
    client = OpenAI(api_key=key, base_url=env.get("TEXT_API_BASE") or None)
    resp = client.chat.completions.create(model=model, messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
    text = re.sub(r"<think>.*?</think>", "", resp.choices[0].message.content or "", flags=re.S)
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"文本模型没有返回 JSON：{text[:300]}")
    return json.loads(match.group(0))


def pick_skill(skills, description, refs_note, model=""):
    """技能节点选「AI 自动选择」时调用：按技能说明挑一个技能，并把描述扩写成具体画面。返回 (技能, 扩写后的描述)。"""
    system = (
        "你是出图助手。根据用户描述从技能列表中选出最合适的一个技能，并把描述改写成更具体的画面描述"
        "（主体、动作、环境、细节），不要改变用户的意图。机位、镜头、景深、布光、色调由技能预设，不要写进描述。"
        '只输出 JSON：{"skill": "技能名", "input": "改写后的描述"}'
    )
    user = "技能列表：\n" + "\n".join(f"- {s['name']}：{s['description']}" for s in skills)
    user += f"\n\n参考图：{refs_note.strip() or '没有参考图'}\n用户描述：{description.strip()}"
    picked = chat_json(system, user, model)
    skill = next((s for s in skills if s["name"] == picked.get("skill")), None)
    if skill is None:
        raise ValueError(f"文本模型选了不存在的技能：{picked.get('skill')}")
    return skill, picked.get("input") or description


class BCPWeChatArticle:
    """按主题写一篇公众号文章：标题、Markdown 正文（带【配图N】占位）、封面和每张配图的画面描述。"""

    CATEGORY = "bcp"
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("title", "article", "cover", "images")
    OUTPUT_IS_LIST = (False, False, False, True)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "topic": ("STRING", {"multiline": True, "default": "", "tooltip": "文章主题和要点，越具体越好"}),
                "tone": ("STRING", {"default": "专业、亲切、口语化", "tooltip": "文章口吻"}),
                "words": ("INT", {"default": 1500, "min": 300, "max": 5000, "step": 100, "tooltip": "正文大约字数"}),
                "images": ("INT", {"default": 3, "min": 1, "max": 6, "tooltip": "正文配图张数"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF, "control_after_generate": True,
                                 "tooltip": SEED_TIP}),
            },
            "optional": {"model": ("STRING", {"default": "", "tooltip": "留空使用 设置 → BCP 里的默认模型"})},
        }

    def run(self, topic, tone, words, images, seed, model=""):
        system = (
            "你是微信公众号作者。根据用户给的主题写一篇公众号文章，并为封面和正文配图写画面描述。要求：\n"
            "1. 标题不超过 30 个字，有吸引力但不要标题党。\n"
            f"2. 正文用 Markdown，约 {words} 字，口吻：{tone}；用小标题分节，不要重复写文章标题。\n"
            f"3. 正文中在合适的位置插入 {images} 个配图占位，依次写作【配图1】【配图2】……，每个占位单独一行。\n"
            "4. cover 是封面的画面描述，主体放在画面正中间。\n"
            f"5. images 是 {images} 条配图的画面描述，与占位一一对应。\n"
            "6. 所有画面描述都要具体（主体、场景、光线、构图），画面里不要出现文字。\n"
            '只输出 JSON：{"title": "", "article": "", "cover": "", "images": [""]}'
        )
        data = chat_json(system, topic.strip(), model)
        prompts = [p for p in data.get("images", []) if isinstance(p, str) and p.strip()][:images]
        if not data.get("article") or not data.get("cover") or not prompts:
            raise ValueError(f"文本模型返回的内容不完整：{json.dumps(data, ensure_ascii=False)[:300]}")
        title = data.get("title", "").strip()
        return (title, f"# {title}\n\n{data['article'].strip()}\n", data["cover"], prompts)
