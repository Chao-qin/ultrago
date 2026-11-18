"""nodes/bcp 的离线测试：不启动 ComfyUI、不联网、不调真实接口。

运行：pnpm --filter @bcp/comfyui check:nodes（用 ComfyUI 的 venv，需先 setup）。
"""
import asyncio
import base64
import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

import torch
from aiohttp import web
from PIL import Image

PKG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(PKG_DIR, "nodes"))

# config_api 在导入时向 ComfyUI 的 PromptServer 注册路由；测试里给一个空的替身
sys.modules["server"] = types.SimpleNamespace(
    PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=web.RouteTableDef()))
)

import bcp.config_api as config_api  # noqa: E402
import bcp.image as image  # noqa: E402
import bcp.llm as llm  # noqa: E402
import bcp.prompt as prompt  # noqa: E402
import bcp.text as text  # noqa: E402


def read(path):
    with open(path) as f:
        return f.read()


def png_b64(w=32, h=16):
    img = Image.new("RGBA", (w, h), (255, 0, 0, 255))
    img.putpixel((0, 0), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


class TempPkg(unittest.TestCase):
    """每个用例一个临时包目录，放假的 .env，绝不读到真实 key。"""

    ENV = "OPENAI_API_BASE=http://fake-image/v1\nOPENAI_API_KEY=sk-image\nTEXT_API_BASE=http://fake-text/v1\nTEXT_API_KEY=sk-text\nTEXT_MODEL=default-model\n"

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, ".env"), "w") as f:
            f.write(self.ENV)
        shutil.copy(os.path.join(PKG_DIR, "flexai_models.json"), self.dir)
        self.patches = [(image, "PKG_DIR", image.PKG_DIR), (llm, "PKG_DIR", llm.PKG_DIR)]
        image.PKG_DIR = llm.PKG_DIR = self.dir

    def tearDown(self):
        for mod, name, value in self.patches:
            setattr(mod, name, value)
        shutil.rmtree(self.dir)


class ImageNodeTest(TempPkg):
    def setUp(self):
        super().setUp()
        self.calls = []
        test = self

        class FakeImages:
            def generate(self, **kw):
                test.calls.append(("generate", kw))
                return self.resp(kw["n"])

            def edit(self, **kw):
                test.calls.append(("edit", kw))
                return self.resp(kw["n"])

            def resp(self, n):
                items = [types.SimpleNamespace(b64_json=png_b64(), url=None) for _ in range(n)]
                path = os.path.join(test.dir, "url.png")
                Image.open(io.BytesIO(base64.b64decode(png_b64()))).save(path)
                items[-1] = types.SimpleNamespace(b64_json=None, url="file://" + path)  # 中转只回链接的情况
                return types.SimpleNamespace(data=items)

        class FakeOpenAI:
            def __init__(self, api_key, base_url):
                test.calls.append(("init", api_key, base_url))
                self.images = FakeImages()

        self.orig_openai, image.OpenAI = image.OpenAI, FakeOpenAI
        self.node = image.BCPOpenAIImage()

    def tearDown(self):
        image.OpenAI = self.orig_openai
        super().tearDown()

    def test_generate_forwards_params_and_decodes_alpha(self):
        imgs, alpha = self.node.run("gpt-image-2.5", "p", "1024x1024", "low", 2, "transparent", 123)
        self.assertEqual(self.calls[0], ("init", "sk-image", "http://fake-image/v1"))
        kind, kw = self.calls[-1]
        self.assertEqual(kind, "generate")
        self.assertEqual(kw, dict(model="gpt-image-2.5", prompt="p", size="1024x1024", quality="low", n=2, background="transparent"))
        self.assertEqual(tuple(imgs.shape), (2, 16, 32, 3))
        self.assertEqual(tuple(alpha.shape), (2, 16, 32))
        # ComfyUI 约定 mask = 1 - alpha：透明像素为 1
        self.assertEqual(float(alpha[0, 0, 0]), 1.0)
        self.assertEqual(float(alpha[0, 0, 1]), 0.0)
        self.assertEqual(float(alpha[1, 0, 0]), 1.0)  # url 分支也解码正确

    def test_edit_sends_every_ref_in_order_with_mask(self):
        a = torch.zeros(2, 16, 32, 3)
        a[1] += 1
        c = torch.full((1, 8, 8, 3), 0.5)
        m = torch.zeros(1, 16, 32)
        m[0, :, :16] = 1
        self.node.run("gpt-image-2", "edit", "auto", "medium", 1, "auto", 0, mask=m, image_1=a, image_3=c)
        kind, kw = self.calls[-1]
        self.assertEqual(kind, "edit")
        self.assertEqual([f[0] for f in kw["image"]], ["image_1.png", "image_2.png", "image_3.png"])
        self.assertEqual([Image.open(io.BytesIO(f[1])).size for f in kw["image"]], [(32, 16), (32, 16), (8, 8)])
        mask = Image.open(io.BytesIO(kw["mask"][1]))
        self.assertEqual((mask.mode, mask.size), ("RGBA", (32, 16)))
        self.assertEqual(mask.getpixel((0, 0))[3], 0, "选中区域应为透明（要重绘）")
        self.assertEqual(mask.getpixel((31, 0))[3], 255)

    def test_mask_without_image_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "image_1"):
            self.node.run("gpt-image-2", "x", "auto", "auto", 1, "auto", 0, mask=torch.zeros(1, 4, 4))

    def test_placeholder_key_is_rejected(self):
        with open(os.path.join(self.dir, ".env"), "w") as f:
            f.write("OPENAI_API_KEY=your_key_here\n")
        with self.assertRaisesRegex(ValueError, "设置 → BCP"):
            self.node.run("gpt-image-2", "x", "auto", "auto", 1, "auto", 0)


class SeedTest(TempPkg):
    """种子让 ComfyUI 每次运行都重新执行：输入不变时它会直接复用上次结果。"""

    def test_nodes_that_call_apis_have_a_randomizable_seed(self):
        for node in (image.BCPOpenAIImage, llm.BCPWeChatArticle):
            seed = node.INPUT_TYPES()["required"].get("seed")
            self.assertIsNotNone(seed, node.__name__)
            self.assertEqual(seed[0], "INT")
            self.assertTrue(seed[1].get("control_after_generate"), node.__name__)


class LLMNodeTest(TempPkg):
    def setUp(self):
        super().setUp()
        self.requests = []
        test = self

        class FakeCompletions:
            def create(self, model, messages):
                test.requests.append((model, messages))
                system = messages[0]["content"]
                if "公众号作者" in system:
                    data = {"title": "居家办公的 3 个提效习惯", "article": "## 一\n正文\n\n【配图1】", "cover": "书桌", "images": ["图一", "图二", "图三"]}
                    content = "<think>先想想 {草稿}</think>\n```json\n" + json.dumps(data, ensure_ascii=False) + "\n```"
                else:
                    skill = "生活场景" if "杯" in messages[1]["content"] else "不存在的技能"
                    content = json.dumps({"skill": skill, "input": "晨光中的马克杯"}, ensure_ascii=False)
                message = types.SimpleNamespace(content=content)
                return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])

        class FakeOpenAI:
            def __init__(self, api_key, base_url):
                test.requests.append(("init", api_key, base_url))
                self.chat = types.SimpleNamespace(completions=FakeCompletions())

        self.orig_openai, llm.OpenAI = llm.OpenAI, FakeOpenAI

    def tearDown(self):
        llm.OpenAI = self.orig_openai
        super().tearDown()

    def test_auto_skill_picks_and_renders(self):
        p, size, skill = prompt.BCPSkill().run(prompt.AUTO, "马克杯", "")
        self.assertEqual((skill, size), ("生活场景", "1536x1536"))
        self.assertIn("晨光中的马克杯", p)
        self.assertIn("拍摄：", p)  # 选中技能的拍摄预设照样生效
        self.assertEqual(self.requests[0], ("init", "sk-text", "http://fake-text/v1"))
        self.assertEqual(self.requests[1][0], "default-model")

    def test_node_model_overrides_default(self):
        prompt.BCPSkill().run(prompt.AUTO, "马克杯", "", model="node-model")
        self.assertEqual(self.requests[1][0], "node-model")

    def test_unknown_skill_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "不存在的技能"):
            prompt.BCPSkill().run(prompt.AUTO, "随便", "")

    def test_article_strips_think_and_fences_and_truncates(self):
        title, article, cover, images = llm.BCPWeChatArticle().run("居家办公", "亲切", 1200, 2, 0)
        self.assertEqual(title, "居家办公的 3 个提效习惯")
        self.assertTrue(article.startswith("# 居家办公的 3 个提效习惯\n\n## 一"))
        self.assertEqual(cover, "书桌")
        self.assertEqual(images, ["图一", "图二"])  # 只是列表输出，其余为单值

    def test_unconfigured_text_model_is_an_error(self):
        with open(os.path.join(self.dir, ".env"), "w") as f:
            f.write("TEXT_API_KEY=your_text_key_here\nTEXT_MODEL=your-model-name\n")
        with self.assertRaisesRegex(ValueError, "设置 → BCP"):
            prompt.BCPSkill().run(prompt.AUTO, "马克杯", "")


class PromptTest(unittest.TestCase):
    SKILL = {"template": "前缀。{{refs}}\n画面：{{input}}", "size": "1x1",
             "shot": {"机位": "平视", "镜头": "85mm", "布光": "柔光箱", "风格": "商业摄影"}}

    def test_render_groups_shot_into_sections(self):
        p, size = prompt.render(self.SKILL, " 杯子 ", "图 1 是产品")
        self.assertEqual(size, "1x1")
        self.assertEqual(p, "前缀。\n参考图说明：图 1 是产品\n画面：杯子\n拍摄：机位 平视；镜头 85mm\n光影：布光 柔光箱\n风格：商业摄影")
        self.assertEqual(prompt.render({"template": "{{input}}", "size": "1x1"}, "", "")[0], "（没有额外描述）")

    def test_spec_overrides_per_dimension_and_appends_extra(self):
        (spec,) = prompt.BCPShotSpec().run("别出现手", 机位=prompt.DEFAULT, 镜头="100mm 微距", 景深="f/2.8", 构图=prompt.DEFAULT,
                                           布光=prompt.DEFAULT, 色调=prompt.DEFAULT, 风格=prompt.DEFAULT)
        p, _ = prompt.render(self.SKILL, "杯子", "", spec)
        self.assertIn("拍摄：机位 平视；镜头 100mm 微距；景深 f/2.8", p)  # 覆盖镜头、新增景深，机位保留预设
        self.assertNotIn("85mm", p)
        self.assertTrue(p.endswith("补充：别出现手"))

    def test_plain_text_spec_is_extra(self):
        self.assertTrue(prompt.render(self.SKILL, "杯子", "", "浅暖灰背景")[0].endswith("补充：浅暖灰背景"))

    def test_skill_uses_batch_line_instead_of_input(self):
        p, size, name = prompt.BCPSkill().run("自由生图", "忽略我", "", batch="一只猫")
        self.assertEqual((p, size, name), ("一只猫", "1536x1536", "自由生图"))

    def test_library_is_consistent(self):
        lib = prompt.load_library()
        known = {d for _, dims in prompt.SECTIONS for d in dims}
        self.assertLessEqual(set(lib["dimensions"]), known)
        names = set()
        for s in lib["skills"]:
            self.assertTrue(s["description"].strip(), s["name"])
            self.assertIn("{{input}}", s["template"], s["name"])
            self.assertLessEqual(set(s.get("shot", {})), known, s["name"])
            w, h = map(int, s["size"].split("x"))
            self.assertEqual((w % 16, h % 16), (0, 0), s["name"])
            self.assertTrue(1 / 3 <= w / h <= 3, s["name"])
            self.assertNotIn(s["name"], names)
            names.add(s["name"])
        self.assertNotIn(prompt.AUTO, names)

    def test_batch_lines(self):
        self.assertEqual(prompt.BCPBatchLines().run("a\n\n  b  \n"), (["a", "b"],))
        with self.assertRaises(ValueError):
            prompt.BCPBatchLines().run(" \n ")


class TitleOverlayTest(unittest.TestCase):
    def test_wrap_keeps_punctuation_off_line_start(self):
        font = text.ImageFont.truetype(text.cjk_font(), 40)
        lines = text.wrap("夏天必备的三个降温好物，第二行", font, font.getlength("夏天必备的三个降温好物")).splitlines()
        self.assertEqual(lines, ["夏天必备的三个降温好物，", "第二行"])

    def test_overlay_draws_and_keeps_shape(self):
        imgs = torch.zeros(2, 64, 128, 3)
        (out,) = text.BCPTitleOverlay().run(imgs, "标题", 20.0, "#ffffff", "top", True)
        self.assertEqual(tuple(out.shape), (2, 64, 128, 3))
        self.assertGreater(float(out[0].max()), 0.9)


class ConfigApiTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.orig, config_api.ENV_FILE = config_api.ENV_FILE, os.path.join(self.dir, ".env")
        with open(config_api.ENV_FILE, "w") as f:
            f.write("# 注释保留\nOPENAI_API_BASE=https://img/v1\nOPENAI_API_KEY=sk-secret-abcd\nTEXT_API_KEY=your_text_key_here\nTEXT_MODEL=your-model-name\n")

    def tearDown(self):
        config_api.ENV_FILE = self.orig
        shutil.rmtree(self.dir)

    def get(self):
        return json.loads(asyncio.run(config_api.get_config(None)).text)

    def post(self, body):
        async def call():
            async def body_json():
                return body
            return await config_api.set_config(types.SimpleNamespace(json=body_json))
        resp = asyncio.run(call())
        return resp.status, json.loads(resp.text)

    def test_get_masks_keys_and_hides_placeholders(self):
        cfg = self.get()
        self.assertEqual(cfg["image_key"], "已配置（…abcd）")
        self.assertNotIn("sk-secret", json.dumps(cfg))
        self.assertEqual((cfg["text_key"], cfg["text_model"], cfg["text_base"]), ("未配置", "", ""))

    def test_post_writes_env_keeps_comments_and_mode(self):
        status, _ = self.post({"text_key": " sk-new-9999 ", "text_model": "m1"})
        self.assertEqual(status, 200)
        content = read(config_api.ENV_FILE)
        self.assertIn("TEXT_API_KEY=sk-new-9999\n", content)
        self.assertIn("TEXT_MODEL=m1\n", content)
        self.assertIn("# 注释保留", content)
        self.assertEqual(os.stat(config_api.ENV_FILE).st_mode & 0o777, 0o600)
        self.assertEqual(self.get()["text_key"], "已配置（…9999）")

    def test_unknown_field_is_rejected_without_writing(self):
        before = read(config_api.ENV_FILE)
        status, data = self.post({"text_model": "x", "PATH": "/evil"})
        self.assertEqual(status, 400)
        self.assertIn("PATH", data["error"])
        self.assertEqual(read(config_api.ENV_FILE), before)


if __name__ == "__main__":
    unittest.main()
