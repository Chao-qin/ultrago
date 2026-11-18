"""_run_detector 的重试语义与请求形状。

背景：文案检测在同一个商品上几分钟内成功 1 次、超时 2 次，而每次失败都废掉一整轮
5-10 分钟的预处理（图片早已下载裁剪完，炸在最后的投影阶段）。健康调用实测 13-17 秒，
180 秒不返回是瞬时拥塞，不是这台机器坏了。

这个文件曾经大半在测 `_run_opencode`（subprocess 起 CLI）。那条通道删了——网关
自己就有 opencode 渠道且支持识图，CLI 只剩包袱。重试语义搬到了网关这条路上，
断言跟着搬；分派测试整组删除，因为已经没有第二条通道可分派了。
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from projection import detect


def _resp(payload):
    class _R:
        def read(self):
            import json as _json
            return _json.dumps(payload).encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    return _R()


def _ok_payload(content="{}"):
    return {"choices": [{"message": {"content": content}}]}


class TimeoutRetryTests(unittest.TestCase):
    """超时重试、其余不重试。两类失败性质不同，混在一起处理必然错一边。"""

    def test_超时会重试且第二次成功就采纳(self):
        import urllib.request as _ureq
        calls = []

        def flaky(req, timeout=None):
            calls.append(1)
            if len(calls) == 1:
                raise TimeoutError()
            return _resp(_ok_payload("ok"))

        with mock.patch.object(_ureq, "urlopen", flaky), \
             mock.patch.object(detect.time, "sleep", lambda _: None):
            self.assertEqual(detect._run_detector("p"), "ok")
        self.assertEqual(len(calls), 2, "第一次超时后必须再试一次")

    def test_一直超时最终仍然抛通道不可用(self):
        import urllib.request as _ureq

        def always_timeout(req, timeout=None):
            raise TimeoutError()

        with mock.patch.object(_ureq, "urlopen", always_timeout), \
             mock.patch.object(detect.time, "sleep", lambda _: None):
            with self.assertRaises(detect.DetectorUnavailable) as ctx:
                detect._run_detector("p")
        # 不能把「通道不可用」吞成「检测通过」——那等于没检查就宣布合规。
        self.assertIn("没有返回", str(ctx.exception))

    def test_网关连不上不重试(self):
        """确定性故障：网关没起来，再试一百次也一样，重试只是浪费 3 分钟。"""
        import urllib.error
        import urllib.request as _ureq
        calls = []

        def refused(req, timeout=None):
            calls.append(1)
            raise urllib.error.URLError("Connection refused")

        with mock.patch.object(_ureq, "urlopen", refused), \
             mock.patch.object(detect.time, "sleep", lambda _: None):
            with self.assertRaises(detect.DetectorUnavailable):
                detect._run_detector("p")
        self.assertEqual(len(calls), 1)

    def test_网关拒绝时把响应体带出来(self):
        """404 unknown model 那次之所以难查，就是因为异常里只有一句 HTTP 404。

        网关的响应体里明明写着该填什么（`available models: …`），不带出来等于
        把一条自解释的错误压成一个数字。
        """
        import io
        import urllib.error
        import urllib.request as _ureq

        def rejected(req, timeout=None):
            raise urllib.error.HTTPError(
                req.full_url, 404, "Not Found", {},
                io.BytesIO(b'{"error":{"message":"unknown model - available models: qwen3.5:4b"}}'))

        with mock.patch.object(_ureq, "urlopen", rejected), \
             mock.patch.object(detect.time, "sleep", lambda _: None):
            with self.assertRaises(detect.DetectorUnavailable) as ctx:
                detect._run_detector("p")
        self.assertIn("404", str(ctx.exception))
        self.assertIn("available models", str(ctx.exception))


class VisionRequestTests(unittest.TestCase):
    """视觉调用的请求形状 —— 识图是这条流水线上唯一读图的地方，形状错了就变成纯文本判图。"""

    def _capture(self, prompt, image):
        import json as _json
        import urllib.request as _ureq
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["body"] = _json.loads(req.data.decode())
            captured["url"] = req.full_url
            return _resp(_ok_payload())

        with mock.patch.object(_ureq, "urlopen", fake_urlopen):
            detect._run_detector(prompt, image)
        return captured

    def test_内存图片作为_data_uri_送出(self):
        """图片走 OpenAI 的多模态写法：content 变 parts 数组、图走 data: URI。

        断言的是【我们发出去的形状】，不是上游收到的形状 —— 网关背后 opencode
        渠道把它转成 file part、ollama 渠道还原成 images 字段，那是渠道的事。
        """
        import base64
        captured = self._capture("判一下", b"image-bytes")

        self.assertTrue(captured["url"].endswith("/v1/chat/completions"), captured["url"])
        parts = captured["body"]["messages"][0]["content"]
        b64 = base64.b64encode(b"image-bytes").decode()
        self.assertEqual(parts[0], {"type": "text", "text": "判一下"})
        self.assertEqual(parts[1]["image_url"]["url"], f"data:image/jpeg;base64,{b64}")

    def test_大图在送出前被压到长边上限(self):
        """图片检测这条路真的压了 —— 不是只有类目那条（走 llm_client）压。

        两条带图的路各有一套 urllib 实现，压缩必须落在**两个**边界上；只改一处
        的症状是"图片检测还是原图、慢十倍"，而它不会报错，只是慢。
        具体策略与阈值见 scripts/vision_image.py 与 scripts/test_vision_image.py。
        """
        import base64
        import io

        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (2400, 1600), (9, 9, 9)).save(buf, "JPEG")
        captured = self._capture("判一下", buf.getvalue())

        url = captured["body"]["messages"][0]["content"][1]["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/jpeg;base64,"), url[:40])
        with Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))) as im:
            self.assertEqual(max(im.size), 1024, f"送出尺寸 {im.size} 超过长边上限")

    def test_内存图片不落盘(self):
        """严格内存链路：调用方给的是 bytes，就不该有任何一步把它写到磁盘上。

        以前这条是「opencode 通道明确拒绝内存图片」——CLI 只能吃路径，所以那边
        要么落盘要么拒绝，选了拒绝。现在没有 CLI 了，bytes 直接进 data: URI，
        从「拒绝」变成「支持」。
        """
        captured = self._capture("判一下", b"image-bytes")
        parts = captured["body"]["messages"][0]["content"]
        self.assertEqual(len(parts), 2)

    def test_文件路径按扩展名给_mime(self):
        """一律写 image/jpeg 会把 png 喂错类型。"""
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.png"
            p.write_bytes(b"\x89PNG\r\n\x1a\n")
            captured = self._capture("判一下", p)
        url = captured["body"]["messages"][0]["content"][1]["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/png;base64,"), url[:40])

    def test_无图时_content_仍是字符串(self):
        captured = self._capture("只有文字", None)
        self.assertIsInstance(captured["body"]["messages"][0]["content"], str)


class RequestShapeTests(unittest.TestCase):
    """历史上这里钉的是「必须显式传 num_ctx」—— Ollama 不传就走服务端默认（实测约 4k）
    并静默截断，图片本身吃掉大量 token，指令被挤掉后模型只会「描述这张图」而不是按
    schema 判侵权。那个教训没有失效，但**守卫搬家了**：上下文窗口是 OpenAI 协议里
    不存在的字段（窗口是模型属性），现在由网关的渠道配置负责，断言在
    packages/llm/src/adapters/ollama.test.ts 与 gateway.test.ts 里。

    这一侧只剩下我们自己还负责的东西。
    """

    def test_请求形状(self):
        import json as _json
        import urllib.request as _ureq
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["body"] = _json.loads(req.data.decode())
            return _resp(_ok_payload())

        with mock.patch.object(_ureq, "urlopen", fake_urlopen):
            detect._run_detector("判一下这张图", None)

        body = captured.get("body") or {}
        # 这条钉的是一次真实事故：以前这里发的是 LOCAL_CHANNEL="local"，那是网关
        # 早期的渠道别名。渠道 id 改成模型名之后 "local" 消失，而这行没跟着改，
        # 于是每一发都 404 —— 而当时的断言写的正是 `model == "local"`，它忠实地
        # 守住了一个已经不存在的契约。
        self.assertEqual(body.get("model"), detect.MODEL)
        self.assertNotEqual(body.get("model"), "local", "别再引入渠道别名这种间接层")
        self.assertEqual(body.get("temperature"), 0, "类目/侵权判断要可复现")
        self.assertEqual(body.get("reasoning_effort"), "none", "推理链会混进 JSON 提取")
        self.assertNotIn("options", body, "options 是 Ollama 的形状，不该出现在 OpenAI 请求里")

    def test_文案与图片跑在同一个模型上(self):
        """两边读同一个环境变量。分叉了不会报错，只会让同一条流水线的两半悄悄
        跑在不同模型上，而结果差异会被归因到提示词。"""
        sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
        import llm_client
        self.assertEqual(detect.MODEL, llm_client.DEFAULT_MODEL)


class ItemsEnvelopeTests(unittest.TestCase):
    """{"items":[...]} 与裸 [...] 是等价外壳，其余一律判通道不可用。

    真实事故：切到本地模型后端到端第一次跑就炸在「文案检测返回的不是对象：list」——
    模型把 items 数组直接回出来了，语义一模一样只是少了外壳。opencode 那档一直回
    对象，所以这条路从没被触发过。
    """

    def test_对象原样通过(self):
        self.assertEqual(detect._as_items_envelope({"items": [1]}), {"items": [1]})

    def test_裸数组当作items(self):
        self.assertEqual(detect._as_items_envelope([{"text": "x"}]), {"items": [{"text": "x"}]})

    def test_其余形状判通道不可用而不是当成无风险(self):
        """把任意形状硬塞成空 items，等于把「答非所问」伪装成「检测通过」。"""
        for bad in ("字符串", 42, None, True):
            with self.assertRaises(detect.DetectorUnavailable):
                detect._as_items_envelope(bad)


if __name__ == "__main__":
    unittest.main()
