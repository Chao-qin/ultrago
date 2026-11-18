#!/usr/bin/env python3
"""llm_client 的请求形状回归。

不真发请求 —— monkeypatch urllib.request.urlopen，检查发出去的 body。测的是
「我们自己还负责的那部分」：打对端点、用对模型名、把参数放对位置。模型答得
好不好、网关路由对不对，都不是这一层的事，也不该在这里断言。

这个文件曾经大半在测 opencode CLI 通道的 SQLite 锁争用重试。那条通道删了
（网关自己就有 opencode 渠道，且是单个受管 server 进程，不存在多进程抢库），
那些断言随之删除 —— 留着测一段不存在的代码，比没有测试更糟。

跑:python3 .claude/skills/product-preprocess/scripts/test_llm_client.py
"""
from __future__ import annotations

import json as _json
import sys
import urllib.error
import urllib.request as _ureq
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_client  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f" — {detail}"))
    if not cond:
        FAILURES.append(name)


class _FakeResp:
    def __init__(self, payload):
        self._b = _json.dumps(payload).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_captured: dict = {}


def _fake_urlopen(req, timeout=None):
    _captured["body"] = _json.loads(req.data.decode())
    _captured["url"] = req.full_url
    return _FakeResp({"choices": [{"message": {"content": '{"ok":1}'}}]})


def _send(**kw) -> dict:
    """跑一次 ask_llm，把它实际发出去的 body 交回来。"""
    _captured.clear()
    orig = _ureq.urlopen
    _ureq.urlopen = _fake_urlopen
    try:
        llm_client.ask_llm("随便什么提示词", **kw)
    finally:
        _ureq.urlopen = orig
    return _captured.get("body") or {}


print("请求形状")

# 上下文窗口的教训还在，但**守卫搬家了**：OpenAI 协议里没有这个字段（窗口是模型
# 属性，不是请求参数），现在归网关的渠道配置管，断言落在
# packages/llm/src/adapters/ollama.test.ts 与 gateway.test.ts。
# 这一侧只剩我们自己还负责的这几条。
body = _send()
check("打的是 OpenAI 端点", str(_captured.get("url", "")).endswith("/v1/chat/completions"),
      f"url={_captured.get('url')}")
check("temperature 仍为 0", body.get("temperature") == 0, f"body={body}")
check("关掉推理链", body.get("reasoning_effort") == "none", f"body={body}")
check("不夹带 Ollama 的 options", "options" not in body, f"body={body}")

print("模型名")

# 这条钉的是一次真实事故：以前这里发的是 LOCAL_CHANNEL="local" —— 网关早期给
# 本机后端起的渠道别名。渠道 id 后来改成模型名本身，"local" 随之消失，而这行
# 没跟着改，于是每一发都是 404 unknown model，整条流水线的 LLM 调用静静地全废。
# 没有任何测试挡住它，因为当时的断言写的正是 `model == "local"` —— 它忠实地
# 守住了一个已经不存在的契约。
check("model 用的是 DEFAULT_MODEL", body.get("model") == llm_client.DEFAULT_MODEL,
      f"model={body.get('model')} DEFAULT_MODEL={llm_client.DEFAULT_MODEL}")
check("不再是那个已经不存在的 local 别名", body.get("model") != "local", f"model={body.get('model')}")
check("调用方能覆盖模型", _send(model="gpt-5.6-terra").get("model") == "gpt-5.6-terra")

print("多模态")

# 图片这条以前完全没有断言，而它是 detect.py 识图的唯一通道。
vision = _send(images=["QUJD"])
content = (vision.get("messages") or [{}])[0].get("content")
check("有图时 content 变成 parts 数组", isinstance(content, list), f"content={type(content).__name__}")
if isinstance(content, list):
    kinds = [p.get("type") for p in content]
    check("文本在前、图在后", kinds == ["text", "image_url"], f"kinds={kinds}")
    url = (content[1].get("image_url") or {}).get("url", "")
    check("图走 data: URI", url.startswith("data:image/") and url.endswith("QUJD"), f"url={url[:40]}")
# 无图时不能凭空造出 parts 数组 —— 纯文本请求要保持纯文本。
check("无图时 content 仍是字符串",
      isinstance((_send().get("messages") or [{}])[0].get("content"), str))

print("报错可读性")

# 404 unknown model 那次之所以难查，是因为异常里只有 "HTTP Error 404"，
# 而网关的响应体里明明写着该填什么。把它带出来。
def _raise_404(req, timeout=None):
    raise urllib.error.HTTPError(
        req.full_url, 404, "Not Found", {},
        __import__("io").BytesIO(b'{"error":{"message":"unknown model \\"local\\" '
                                 b'\\u2014 available models: qwen3.5:4b"}}'))


_orig = _ureq.urlopen
_ureq.urlopen = _raise_404
try:
    llm_client.ask_llm("x")
    check("网关拒绝时把响应体带出来", False, "没抛")
except RuntimeError as exc:
    check("网关拒绝时把响应体带出来",
          "404" in str(exc) and "available models" in str(exc), f"e={exc}")
finally:
    _ureq.urlopen = _orig

print("默认模型是否真的存在（需要网关在跑）")

# 上面那些断言只能证明"我们发的是 DEFAULT_MODEL"，证明不了"网关认得它"——
# 而这次的事故恰恰发生在后者。所以这里去问一次真实的 /v1/models。
# 网关没起时明确说跳过，不静默通过：一条不知道有没有跑的断言等于没有断言。
try:
    with _ureq.urlopen(f"{llm_client.LOCAL_HOST}/v1/models", timeout=5) as r:
        served = [m.get("id") for m in (_json.loads(r.read()) or {}).get("data", [])]
except Exception as exc:  # noqa: BLE001
    print(f"  skip  网关没起（{type(exc).__name__}），这条没跑 —— 要验它先 pnpm start")
else:
    check("DEFAULT_MODEL 在网关的 /v1/models 里", llm_client.DEFAULT_MODEL in served,
          f"DEFAULT_MODEL={llm_client.DEFAULT_MODEL} served={served}")

print("全部通过" if not FAILURES else f"{len(FAILURES)} 条失败：{'、'.join(FAILURES)}")
sys.exit(1 if FAILURES else 0)
