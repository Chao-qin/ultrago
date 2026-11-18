"""技能 / 拍摄规格 / 批量描述节点，内容来自 packages/comfyui/prompt_library.json。

每次读取界面节点定义和每次执行都重新读文件：改完 JSON 刷新浏览器即可，不用重启。
技能 = 画面模板（{{input}} 为描述，{{refs}} 为参考图说明，沿用 lumen-studio 的写法）
     + shot：按用途预设的拍摄维度（机位、镜头、景深……）。拍摄规格节点按维度覆盖这些预设。
"""
import json
import os

from .llm import pick_skill

LIBRARY_FILE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "prompt_library.json")
DEFAULT = "默认"
AUTO = "AI 自动选择"
# 提示词里按这三段输出拍摄维度；prompt_library.json 的 dimensions 只能用这里的名字
SECTIONS = (("拍摄", ("机位", "镜头", "景深", "构图")), ("光影", ("布光", "色调")), ("风格", ("风格",)))


def load_library():
    with open(LIBRARY_FILE, encoding="utf-8") as f:
        return json.load(f)


def parse_spec(spec):
    """拍摄规格节点输出 JSON；直接接一段文字（如统一风格描述）时当作补充。"""
    if not spec:
        return {}, ""
    try:
        data = json.loads(spec)
    except ValueError:
        return {}, spec.strip()
    return data.get("overrides", {}), data.get("extra", "").strip()


def render(skill, input, refs_note, spec=""):
    """按技能模板和拍摄维度拼出提示词，返回 (prompt, size)。"""
    overrides, extra = parse_spec(spec)
    shot = {**skill.get("shot", {}), **overrides}
    refs = f"\n参考图说明：{refs_note.strip()}" if refs_note.strip() else ""
    lines = [skill["template"].replace("{{input}}", input.strip() or "（没有额外描述）").replace("{{refs}}", refs).strip()]
    for title, dims in SECTIONS:
        parts = [f"{d} {shot[d]}" if title != "风格" else shot[d] for d in dims if shot.get(d)]
        if parts:
            lines.append(f"{title}：" + "；".join(parts))
    if extra:
        lines.append(f"补充：{extra}")
    return ("\n".join(lines), skill["size"])


class BCPShotSpec:
    """每个拍摄维度一个下拉框：「默认」沿用技能的预设，选了别的就覆盖这一项。"""

    CATEGORY = "bcp"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("spec",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        dims = load_library()["dimensions"]
        required = {name: ([DEFAULT, *options],) for name, options in dims.items()}
        required["extra"] = ("STRING", {"multiline": True, "default": "", "tooltip": "补充要求，原样附在提示词最后"})
        return {"required": required}

    def run(self, extra, **picked):
        overrides = {k: v for k, v in picked.items() if v != DEFAULT}
        return (json.dumps({"overrides": overrides, "extra": extra}, ensure_ascii=False),)


class BCPSkill:
    """选技能套模板，输出提示词、技能的尺寸和实际用的技能名。选「AI 自动选择」时由文本模型挑技能并扩写描述。"""

    CATEGORY = "bcp"
    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "size", "skill")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        names = [s["name"] for s in load_library()["skills"]]
        return {
            "required": {
                "skill": ([AUTO, *names], {"default": names[0]}),
                "input": ("STRING", {"multiline": True, "default": ""}),
                "refs_note": ("STRING", {"default": "", "tooltip": "参考图说明，如：图 1 是产品，图 2 是背景"}),
            },
            "optional": {
                "spec": ("STRING", {"forceInput": True, "tooltip": "接拍摄规格节点；也可以直接接一段文字作为补充"}),
                "batch": ("STRING", {"forceInput": True, "tooltip": "接批量描述节点：每行各出一次，替代上面的 input"}),
                "model": ("STRING", {"default": "", "tooltip": "AI 自动选择用的文本模型，留空用 设置 → BCP 里的默认模型"}),
            },
        }

    def run(self, skill, input, refs_note, spec="", batch=None, model=""):
        skills = load_library()["skills"]
        text = batch if batch is not None else input
        if skill == AUTO:
            chosen, text = pick_skill(skills, text, refs_note, model)
        else:
            chosen = next(s for s in skills if s["name"] == skill)
        return (*render(chosen, text, refs_note, spec), chosen["name"])


class BCPBatchLines:
    """每行一条描述，输出为列表：下游节点会按行各执行一次。"""

    CATEGORY = "bcp"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("lines",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {"multiline": True, "default": ""})}}

    def run(self, text):
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            raise ValueError("批量描述为空：每行写一条描述")
        return (lines,)
