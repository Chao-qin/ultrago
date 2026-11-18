#!/usr/bin/env python3
"""LLM 调用封装 — product-preprocess 流水线用

只有一条通道：本机 LLM 网关（packages/llm）的 OpenAI 协议端点。
所有 resolve_category / resolve_attributes / resolve_values 的"模型决策"
都走这里,以便:

  - 集中超时控制(避免某个 mapping 卡住整条流水线)
  - 集中 JSON 解析容错(LLM 偶尔包 ```json ... ```、偶尔裸 JSON)
  - 单点切换模型(改 DEFAULT_MODEL 或 --model,值就是网关 /v1/models 里的 id)
  - 测试可 monkeypatch(不真发请求,跑得快、CI 友好)

曾经还有第二条通道：直接 `subprocess.run(["opencode", "run", ...])`。它连同
那套 SQLite 锁争用退避重试一起删掉了 —— 网关现在自己就有 opencode 渠道，
而且那个 opencode 是**单个受管 server 进程**(scripts/opencode.sh)，多个调用方
并发时不再有多进程抢同一个 SQLite 库这回事，重试要防的故障从根上没有了。
顺带没了的还有 argv 的 128KB 提示词上限和每次调用一次的进程冷启动。

用法:

    from llm_client import ask_llm

    ans = ask_llm("挑最匹配的叶子", context={"candidates": [...]})
    # ans == {"picked": "家居服套装", "reason": "..."}

CLI 调试:

    python3 llm_client.py "用一句话介绍自己"
"""
from __future__ import annotations

import base64
import binascii
import json
import math
import os
import re
import urllib.error
import urllib.request
import sys
from typing import Any

try:
    # 同目录。与 projection/detect.py 共用同一套"送模型前压缩"策略 ——
    # 两份实现迟早分叉，症状会是"类目那条送缩略图、图片检测那条送原图"。
    import vision_image  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — 拿不到就退回"原样送"
    vision_image = None  # type: ignore[assignment]

# 本机 LLM 网关（packages/llm）。它只讲 OpenAI 协议，背后是本地 Ollama /
# LM Studio 还是某个云厂商由渠道表决定，这里不关心也不该关心。
LOCAL_HOST = f"http://127.0.0.1:{os.environ.get('BCP_LLM_PORT', '11435')}"

# 默认模型 —— 直接写网关 /v1/models 里的 id。
#
# 这里曾经有个 LOCAL_CHANNEL="local"：那是网关早期给本机后端起的渠道别名。
# 渠道 id 后来改成模型名本身，"local" 随之消失，而这行没跟着改，于是每一发
# 都是 404 unknown model —— 整条流水线的 LLM 调用静静地全废了。教训是别再
# 引入"稳定别名"这种间接层：它坏掉时不会报错在定义处，只会报错在调用处。
#
# 2026-09-12 换回本机 qwen3.5:4b。这条线曾经选 opencode/mimo-v2.5-free，依据是
# 2026-09-02 的一次实测（qwen 单次 152 秒、首次冷启动撞 300 秒超时，是 opencode
# 档 13-24 秒的 7 倍，且把提示词里举例的「淘宝/1688/拼多多」当成商品文案抽出来）。
# **那条结论已过期**：模型常驻（BCP_LLM_KEEP_ALIVE=-1）后同机（M4/16G）重测，
#   · 类目候选 30 条 / 314 字符：qwen3.5:4b 4.9s  vs  opencode 33.4s，两者都选对
#   · 属性候选 225 条 / 2800 字符：qwen3.5:4b 19.2s
# 也就是说**文本侧**现在本机档快一档，还省掉网络与免费档限流那一路不确定性；
# opencode 33 秒的稳态反而成了瓶颈。（9-02 那条质量抱怨本次没有复测，别再当结论引用。）
#
# **视觉侧是反的，这是这次切换已知的代价**：同一张 2800×1704 / 136KB 的真实主图，
# 本机档 86.4s，opencode 档 6.9s（512×512 合成图则是 10.6s vs 4.0s）。带图的两条路
# 是「类目顶层带图」（每商品 1 次，见 build_doudian_product._first_main_image_b64）和
# 「图片风险检测」（projection/detect.py，每张图 1 次）。
# 注意 2026-09-12 起这两条路**都先过 vision_image.prepare 压缩**（长边默认 1024 /
# q85），所以上面 86.4s 是"未压缩时代"的读数，不再是当前的预期值。
# 若图片检测仍然成为瓶颈，把 BCP_PREPROCESS_LLM_MODEL 指向 opencode 档即可（视觉+
# 文本一起换），或调小 BCP_VISION_MAX_EDGE。
#
# 回退不需改代码：BCP_PREPROCESS_LLM_MODEL=opencode/mimo-v2.5-free —— 但注意这个
# 环境变量**只在终端直跑时有效**，console flow 里跑脚本不继承它（白名单见
# packages/console/src/flows/flow-runner.service.ts:125）。console 那条路认的是
# 下面这个默认值。
#
# 更早的教训：这里曾经有个 LOCAL_CHANNEL="local"，那是网关早期给本机后端起的渠道
# 别名。渠道 id 后来改成模型名本身，"local" 随之消失，而这行没跟着改，于是每一发
# 都是 404 unknown model —— 整条流水线的 LLM 调用静静地全废了。教训是别再引入
# "稳定别名"这种间接层：它坏掉时不会报错在定义处，只会报错在调用处。
DEFAULT_MODEL = os.environ.get("BCP_PREPROCESS_LLM_MODEL", "qwen3.5:4b")

# 单次调用超时。实测 2026-08-29(opencode/mimo-v2.5-free 免费档):单次稳态 18-24s,
# 且**几乎不随 prompt 大小变化** —— 空 prompt 17-19s、20 条候选 20.6s、77 条 17.9s、
# 226 条 24.0s,瓶颈是进程启动 + 排队 + 首 token,不是 token 数。但连续多次调用会
# 被限流,实测出现过一个商品 7 次调用整批 >60s。
# 原来的 60s 只留了稳态 3 倍余量,限流一来整轮属性映射全部失败(fail-closed 落 pending,
# 商品的属性等于白跑一趟)。放宽到 240s:宁可单次多等,也别让一次波动废掉整个商品。
# 换付费档模型时可以调回更小的值(BCP_LLM_TIMEOUT 覆盖)。
DEFAULT_TIMEOUT = int(os.environ.get("BCP_LLM_TIMEOUT", "240"))


def _compressed_b64(b64: str) -> str:
    """一张图的 base64 先压小再编码回去；任何一步不成就原样返回。

    只改"要发给模型的那份"，不改调用方手里的字节 —— 上游那份往往是同一批
    image_assets，还要拿去上传给抖店（见 vision_image 模块注释）。
    """
    if vision_image is None:
        return b64
    try:
        raw = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError):
        # 不是合法 base64（测试桩、或上游给了坏数据）：原样送，让网关去报它的错。
        return b64
    prepared = vision_image.prepare(raw, "image/jpeg")
    vision_image.note_to_stderr(prepared.note)
    if not prepared.meta.get("recompressed"):
        # 没重编码就不要动原始 base64：省一次编解码，也让"小图逐字节透传"这条
        # 契约对断言可见。
        return b64
    return base64.b64encode(prepared.data).decode()


def _ask_gateway(full_prompt: str, timeout: int, images: list[str] | None = None,
                 model: str = DEFAULT_MODEL) -> str:
    """向本机 LLM 网关要一段文本。images 是 base64（不带 data: 前缀），供视觉调用。

    只做一件事：把提示词发出去、把回复文本拿回来。

    reasoning_effort="none"：有些模型默认会吐思考过程，那些文字会混进 JSON 提取。
      这是 OpenAI 协议里表达「别推理」的写法，ollama adapter 会把它翻成 think=false，
      不认这个字段的渠道会忽略它。
    temperature=0：类目/属性判断要的是可复现，不是多样性。

    上下文窗口不在这里传了，也**传不了**——OpenAI 协议没有这个字段（窗口是模型
    属性，不是请求参数）。它现在是渠道配置的一部分：packages/llm 的本机 Ollama
    渠道带 numCtx，ollama adapter 落成 /api/chat 的 options.num_ctx。

    这一条不能丢，教训还在：不给足窗口时 Ollama 走服务端默认（实测约 4k），提示词
    是「指令在前、数据在后」，被截掉的正好是开头的指令，于是模型只看见一坨 JSON，
    回一段「您提供的数据看起来是一个 JSON 数组片段……」而不是答案。实测（属性值
    映射，产地 225 个候选 / 9048 字符）：不给窗口 → 稳定失败；16384 → 稳定返回
    {"picks":[...]}。要调只能调 BCP_LLM_NUM_CTX（网关侧读它），不是调这里。
    """
    content: object = full_prompt
    if images:
        # OpenAI 的多模态写法：content 变成 parts 数组，图片走 data: URI。
        # ollama adapter 会把 base64 段扒出来还原成它要的 images 字段。
        #
        # 顺带修掉一个老毛病：这里写死 image/jpeg，而调用方给的 base64 可能是
        # PNG/WebP。压过之后标签就是真的（我们输出 JPEG）；没压（已足够小或压
        # 不动）时保持原标签 —— 与压缩前逐字节一致，既有断言不受影响。
        content = [{"type": "text", "text": full_prompt}] + [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{_compressed_b64(b64)}"}}
            for b64 in images
        ]
    body = json.dumps({
        "model": model,
        "stream": False,
        "temperature": 0,
        "reasoning_effort": "none",
        "messages": [{"role": "user", "content": content}],
    }, ensure_ascii=False).encode()
    req = urllib.request.Request(
        f"{LOCAL_HOST}/v1/chat/completions", data=body,
        headers={'Content-Type': 'application/json',
                 'X-BCP-Request-Timeout-Ms': str(max(1, math.ceil(timeout * 1_000)))})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 504:
            e.close()
            raise RuntimeError(f'LLM 网关超时 (HTTP 504), model={model}') from e
        # 网关的报错体是有用的（比如 `unknown model "x" — available models: …`
        # 会直接告诉你该填什么），原样带出来比一句 "HTTP 404" 强。
        detail = ""
        try:
            detail = e.read().decode(errors="replace")[:400]
        except Exception:  # noqa: BLE001 — 读不到就算了，不能因此换个错误抛出去
            pass
        raise RuntimeError(f"LLM 网关拒绝了请求 (HTTP {e.code}, model={model})：{detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"LLM 网关不可达 ({LOCAL_HOST})：{e}。它由 pnpm start 拉起。") from e
    except TimeoutError as e:
        raise RuntimeError(f"LLM 网关超时 (>{timeout}s), model={model}") from e
    choices = (payload or {}).get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content") or ""
    if not text.strip():
        raise RuntimeError(f"LLM 网关没产出内容, model={model}")
    return text.strip()


def ask_llm(
    prompt: str,
    *,
    context: Any = None,
    model: str = DEFAULT_MODEL,
    timeout: int = DEFAULT_TIMEOUT,
    expect_json: bool = True,
    images: list[str] | None = None,
) -> Any:
    """向本机 LLM 网关发问。

    prompt:    直接给模型的问题/指令
    context:   结构化上下文,会被 JSON 序列化后贴进 prompt 末尾,
               用 ```json ... ``` 包裹,模型可直接读
    model:     网关 /v1/models 里的 id;默认 opencode/mimo-v2.5-free
    timeout:   秒;超时抛 RuntimeError,不静默重试
    expect_json: True 时尝试从输出提取 JSON(支持 ```json ... ``` 与裸 JSON),
                 失败抛 RuntimeError;False 时返回原始字符串
    images:      base64 图片(不带 data: 前缀),供视觉调用。走 OpenAI 的多模态
                 写法,能不能识图由渠道决定 —— 网关不会替你把图偷偷丢掉。

    返回:JSON dict/list(str/dict 都可能,看你 prompt 怎么写)
    """
    stdin_payload = json.dumps(context, ensure_ascii=False) if context is not None else ""

    full_prompt = prompt
    if stdin_payload:
        # 把上下文嵌进 prompt 末尾,用 ```json 块标记,模型见到结构化数据更稳
        full_prompt = f"{prompt}\n\n```json\n{stdin_payload}\n```"

    answer = _ask_gateway(full_prompt, timeout, images, model)
    return _extract_json(answer) if expect_json else answer


_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)


def _extract_json(text: str) -> Any:
    """从 LLM 文本输出提取 JSON。

    顺序:
      1. 找 ```json ... ``` 包裹的块(优先,稳)
      2. 整段当 JSON 解析(次优)
      3. 兜底:从文本里抠第一个 { ... } 或 [ ... ](危险,可能解析错)
      4. 失败抛 RuntimeError,把原文带回去便于 debug
    """
    # 1
    m = _JSON_BLOCK_RE.search(text)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass

    # 2
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 3:第一个大括号块
    m2 = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if m2:
        try:
            return json.loads(m2.group(1))
        except json.JSONDecodeError:
            pass

    raise RuntimeError(f"LLM 输出无法解析为 JSON,原文:\n{text[:800]}")


# --------------------------------------------------------------------------
# CLI 调试入口
# --------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 llm_client.py <prompt> [--model provider/model]", file=sys.stderr)
        sys.exit(2)
    prompt = sys.argv[1]
    model = DEFAULT_MODEL
    if "--model" in sys.argv:
        i = sys.argv.index("--model")
        model = sys.argv[i + 1]
    try:
        result = ask_llm(prompt, model=model, expect_json=False)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    print(result)
