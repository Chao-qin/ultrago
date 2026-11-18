#!/usr/bin/env python3
"""侵权与合规检测：一张图或一段文案进去，一份**标注**出来。

标注，不是剔除。检测会误判 —— 水印识别把商品上印着的品牌名当成叠加水印、
文案检测把「适用于华为」这种合法的兼容性描述当成蹭品牌，都是真实会发生的。
剔除是破坏性的：删掉之后原图找不回来，而用户在「检测→剔除→校验失败→请手改」
这条路上看到的是一个**已经被删过的残缺商品**，他不知道原本是什么，也就没法判断
到底是商品有问题还是检测判错了。

所以这里只产出 findings：哪个字段、什么类型、证据是什么、多大把握。删不删、
改不改，由修改层和人来决定。

文本和图片现在走**同一条**通道：本机 LLM 网关（packages/llm）的 OpenAI 端点。

  · 文案 → `product-preprocess/scripts/llm_client.ask_llm`
  · 图片 → 本文件的 `_run_detector`，OpenAI 多模态写法，图走 data: URI

图片这条曾经是本文件自己起 `opencode run --file <图>`。删掉了：网关现在自己
就有 opencode 渠道且支持识图，那条 CLI 路径只剩包袱 —— 每次调用一次进程冷
启动、argv 的 128KB 上限、以及多进程抢 opencode 本地 SQLite 时的锁争用重试
（受管 server 是单进程，那个故障从根上没有了）。

实测（2026-08-29，本机）：一次调用 14-21 秒；同一张合成图上，干净版返回
hasOverlay=false 零误报，带「1688 / 某某旗舰店 / 微信 13800138000」三处叠加的
版本三类全部读出。**没有跑过真实 1688 商品图** —— 合成图证明的是通道与提示词
可用，不是准确率。
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from contextvars import ContextVar
import json
import math
import re
import os
import urllib.error
import urllib.request
import time
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Union
from vision_montage import MontageTask

# 文本通道复用 product-preprocess 的封装。原本是跨 skill 反向 wiring
# (product-projection → product-preprocess/scripts);projection 吞到
# preprocess 下后,parents[1] 就是 preprocess/ 本身,直接指向 scripts/。
# 不再各自包一份 opencode 调用 —— 那样会出现两套超时、两套 JSON 容错、
# 两套模型常量,换模型时只有人记得改的那一套会被改到。
_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
if _SCRIPTS.is_dir():
    sys.path.insert(0, str(_SCRIPTS))
try:
    from llm_client import ask_llm  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — scripts/ 不在时退回本文件的实现
    ask_llm = None  # type: ignore[assignment]
try:
    # 送模型前的压缩。放在 scripts/ 而不是本模块，因为类目那条路（走 llm_client）
    # 要共用同一套策略 —— 两份实现迟早分叉，而分叉的症状是"文案那条图更小、图片
    # 检测那条还是原图"。
    import vision_image  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — 同 ask_llm：拿不到就退回"原样送"
    vision_image = None  # type: ignore[assignment]

# 与 scripts/llm_client.py 同一套开关，别在这里另起一套语义。
LOCAL_HOST = f"http://127.0.0.1:{os.environ.get('BCP_LLM_PORT', '11435')}"
# 上下文窗口不再由调用方传：OpenAI 协议没这个字段，它是渠道配置。视觉调用尤其
# 依赖它 —— 图片本身要占大量 token，窗口不够时指令被挤掉，就只剩「描述这张图」。

# 网关 /v1/models 里的 id。与 llm_client.DEFAULT_MODEL 读同一个环境变量，
# 免得同一条流水线上文案和图片跑在两个模型上还没人知道。默认值必须跟着它一起改
# （test_detect_retry 有一条断言把两者钉在一起）。
MODEL = os.environ.get("BCP_PREPROCESS_LLM_MODEL", "qwen3.5:4b")
# 延迟基本由图的大小决定。2026-09-12 实测（本机 qwen3.5:4b）：512×512 合成图 10.6 秒，
# 2800×1704 / 136KB 的真实主图 86.4 秒（同图 opencode 档 6.9 秒）。
# 现在送出去之前会先过 vision_image.prepare（长边默认 1024 / q85），所以 86 秒那一档
# 已经是历史读数；180 秒留的是排队和大图的余量，不是预期耗时。
# 真撞上超时：先调小 BCP_VISION_MAX_EDGE，其次才是改这个值 —— 超时会按
# TIMEOUT_RETRIES 重试，把 180 抬到 600 等于让最坏情况变成 30 分钟。
TIMEOUT_S = 180
# 超时重试次数与间隔。只对超时生效（见 _run_detector）；间隔给得短是因为
# 拥塞窗口通常只有几秒，等太久不如直接再试。
TIMEOUT_RETRIES = 2
TIMEOUT_RETRY_PAUSE_S = 5
_DETECTION_DEADLINE: ContextVar[float | None] = ContextVar('detection_deadline', default=None)
_DETECTION_REQUEST_TIMEOUT: ContextVar[float | None] = ContextVar('detection_request_timeout', default=None)


@contextmanager
def detection_budget(deadline: float | None, *, request_timeout: float | None = None):
    token = _DETECTION_DEADLINE.set(deadline)
    timeout_token = _DETECTION_REQUEST_TIMEOUT.set(request_timeout)
    try:
        yield
    finally:
        _DETECTION_DEADLINE.reset(token)
        _DETECTION_REQUEST_TIMEOUT.reset(timeout_token)


def _request_timeout() -> float:
    deadline = _DETECTION_DEADLINE.get()
    request_timeout = _DETECTION_REQUEST_TIMEOUT.get() or TIMEOUT_S
    if deadline is None:
        return request_timeout
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise DetectorUnavailable('图片或文案检测阶段预算耗尽，检测未完成')
    return min(request_timeout, remaining)


def _retry_pause():
    time.sleep(min(TIMEOUT_RETRY_PAUSE_S, _request_timeout()))

# 四类侵权风险，与抖店的处罚口径对齐（平台名/他家店铺/联系方式/他人商标）。
RISK_KINDS = ("platform", "shop", "contact", "trademark")

# 提示词要的是英文枚举，模型给回来的常常是中文 —— 实测同一条提示词三次分别返回
# 「平台名」「平台」「platform」。把中文当成"不认识"再归到 trademark，会把一个
# 平台名报成商标侵权，而这两类在抖店那边的处理完全不同。
#
# 对照表而不是"含关键字"：`品牌` 既可能是 trademark 也可能是属性名，模糊匹配在
# 这种地方只会制造新的错分。认不出来的仍然走下面那条明写 detail 的兜底。
KIND_ALIASES = {
    "平台": "platform", "平台名": "platform", "其它平台": "platform", "其他平台": "platform",
    "店铺": "shop", "店铺名": "shop", "他家店铺": "shop", "店铺名称": "shop",
    "联系方式": "contact", "联系": "contact", "电话": "contact", "手机": "contact",
    "微信": "contact", "phone": "contact", "wechat": "contact", "网址": "contact", "url": "contact",
    "商标": "trademark", "品牌": "trademark", "他人商标": "trademark", "brand": "trademark",
}


def normalise_kind(raw: object) -> str | None:
    """模型给的类型 → 四类之一，认不出来返回 None。"""
    if not isinstance(raw, str):
        return None
    k = raw.strip().lower()
    if k in RISK_KINDS:
        return k
    return KIND_ALIASES.get(raw.strip()) or KIND_ALIASES.get(k)


@dataclass
class Finding:
    """一条标注。

    `field` 是 **JSON Pointer**（`/title/text`），不是 JSONPath —— canonical 的
    `qualityReport` 里那批 finding 用的就是 Pointer，两种写法混在同一份文档里
    会让下游的定位代码必须两种都认。"""

    field: str
    kind: str
    evidence: str
    confidence: float
    detail: str = ""

    def __post_init__(self) -> None:
        if self.kind not in RISK_KINDS:
            raise ValueError(f"未知风险类型 {self.kind!r}，允许的是 {RISK_KINDS}")


class DetectorUnavailable(RuntimeError):
    """通道本身不可用（网关没起来、超时、模型没回话）。

    与「检测通过」严格区分：把不可用当成通过，等于在没检查的情况下宣布合规，
    而这正是整条链路最不能出的错。调用方必须让它冒泡，不能 except 掉。"""


ImageInput = Union[bytes, Path]


def _run_detector(prompt: str, image: ImageInput | None = None) -> str:
    """本机 LLM 网关（OpenAI 协议）。图片走 data: URI。

    能不能识图由渠道决定，不由这里决定：opencode 渠道把 data: URI 转成它的
    file part，ollama 渠道把 base64 段还原成 images 字段。网关不会替我们把图
    偷偷丢掉 —— 「视觉信号没送到却当送到了」是「结论看起来有依据其实没有」
    这一类错误，比直接不支持贵得多。

    连不上不重试、超时才重试：前者是确定性故障（网关没起来，再试一百次也一样），
    后者是瞬时拥塞。两者混在一起处理，要么把死故障拖成三倍时长，要么把一次
    可恢复的抖动判成永久失败。
    """
    import base64
    import mimetypes
    content: object = prompt
    if image is not None:
        if isinstance(image, bytes):
            data, mime = image, "image/jpeg"
        else:
            data = image.read_bytes()
            mime = mimetypes.guess_type(image.name)[0] or "image/jpeg"
        # 压的只是**这一份**。上传给抖店的那份在 canonical 的 image_assets 里，
        # 由 build_canonical 单独持有，不经过这里 —— 见 vision_image 的模块注释。
        if vision_image is not None:
            prepared = vision_image.prepare(data, mime)
            vision_image.note_to_stderr(prepared.note)
            data, mime = prepared.data, prepared.mime
        b64 = base64.b64encode(data).decode()
        content = [{"type": "text", "text": prompt},
                   {"type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"}}]
    body = json.dumps({"model": MODEL, "stream": False,
                       "temperature": 0, "reasoning_effort": "none",
                       "messages": [{"role": "user", "content": content}]},
                      ensure_ascii=False).encode()
    last: Exception | None = None
    for attempt in range(TIMEOUT_RETRIES + 1):
        try:
            request_timeout = _request_timeout()
            req = urllib.request.Request(f"{LOCAL_HOST}/v1/chat/completions", data=body,
                                         headers={'Content-Type': 'application/json',
                                                  'X-BCP-Request-Timeout-Ms': str(max(1, math.ceil(request_timeout * 1_000)))})
            with urllib.request.urlopen(req, timeout=request_timeout) as r:
                payload = json.loads(r.read())
            break
        except urllib.error.HTTPError as exc:
            if exc.code == 504:
                exc.close()
                if attempt < TIMEOUT_RETRIES:
                    _retry_pause()
                    continue
                raise DetectorUnavailable(
                    f'LLM 网关连续 {TIMEOUT_RETRIES + 1} 次检测请求超时，没有返回') from exc
            # 网关的报错体会直接说该填什么（`unknown model "x" — available
            # models: …`），原样带出来比一句 "HTTP 404" 强得多。
            detail = ""
            try:
                detail = exc.read().decode(errors="replace")[:400]
            except Exception:  # noqa: BLE001 — 读不到就算了，不能因此换个错误抛出去
                pass
            raise DetectorUnavailable(
                f"LLM 网关拒绝了请求 (HTTP {exc.code}, model={MODEL})：{detail}") from exc
        except urllib.error.URLError as exc:
            raise DetectorUnavailable(
                f"LLM 网关不可达 ({LOCAL_HOST})：{exc}。它由 pnpm start 拉起。") from exc
        except TimeoutError as exc:
            last = exc
            if attempt < TIMEOUT_RETRIES:
                _retry_pause()
                continue
            raise DetectorUnavailable(
                f"LLM 网关连续 {TIMEOUT_RETRIES + 1} 次检测请求超时，没有返回") from last
    choices = (payload or {}).get("choices") or [{}]
    text = (choices[0].get("message") or {}).get("content") or ""
    if not text.strip():
        raise DetectorUnavailable(f"LLM 网关没产出内容, model={MODEL}")
    return text


# 留着不是为了 opencode CLI 那层 ANSI 抬头（那条路已经没了，网关返回的是
# 纯 JSON 文本）—— 是因为模型自己偶尔会在正文里吐转义序列，而一个残留的
# `\x1b[0m` 足以让下面按花括号配平的扫描停在错误的位置。
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _extract_json(raw: str) -> object:
    """从模型输出里取出第一个 JSON 对象或数组。

    要求「只输出 JSON」是提示词的事，拿到什么是另一回事：模型偶尔会加一句
    前言或套一层 ``` 围栏。这里取**最外层的第一个花括号块**，而不是整段
    json.loads —— 后者遇到一句前言就整条失败，而失败会被上层当成
    DetectorUnavailable，把一次可用的检测报成通道故障。"""
    text = _ANSI.sub("", raw)
    starts = [index for index in (text.find("{"), text.find("[")) if index >= 0]
    start = min(starts) if starts else -1
    if start == -1:
        raise DetectorUnavailable(f"模型没有返回 JSON：{text.strip()[:200]}")
    try:
        value, _end = json.JSONDecoder().raw_decode(text[start:])
        return value
    except json.JSONDecodeError as exc:
        raise DetectorUnavailable(f"模型返回的不是合法 JSON：{exc}") from exc


IMAGE_PROMPT = (
    "这张商品图上除了商品本身，有没有叠加的文字或标记（店铺名/品牌/联系方式/平台名/商标水印）？"
    "只输出一行 JSON，不要围栏不要解释："
    '{"hasOverlay":true,"items":[{"text":"看到的文字","kind":"platform|shop|contact|trademark"}]}'
)

BATCH_IMAGE_PROMPT = (
    "这是一张商品图片拼图。每个实际图片格子左上角都有清晰的 SLOT N 标签，标签数字就是 JSON 的 slot。"
    "按标签逐格检查，只检查实际提供的格子；空白格不要返回。商品本身文字不算叠加物，"
    "找出叠加的店铺名、品牌、联系方式、平台名或商标水印。"
    "必须返回 images 数组，并且每个实际 SLOT 恰好返回一项，不能返回旧格式 hasOverlay。"
    "只输出一行 JSON，不要围栏不要解释："
    '{"images":[{"slot":1,"hasOverlay":false,"items":[]},{"slot":2,"hasOverlay":false,"items":[]}]}'
)


def _detect_image_once(image: ImageInput) -> dict:
    data = _extract_json(_run_detector(IMAGE_PROMPT, image=image))
    if not isinstance(data, dict):
        raise DetectorUnavailable("单图检测返回的不是 JSON 对象")
    return data


def detect_image(image: ImageInput, field: str) -> list[Finding]:
    """一张图上的叠加物。`field` 是它在 canonical 里的位置，原样带进 finding。

    畸形输出重试一次。实测并发跑 5 张时出现过一次
    `{"hasOverlay":false,"items":[]` —— 少一个右花括号的截断响应。这是**输出层面
    的瞬时故障**，不是「这张图没法看」：而 DetectorUnavailable 会一路冒泡，让
    collect_findings 把**整个商品**判成检测通道不可用（退出码 2）。一张图的半句
    JSON 废掉一整个商品，代价和成因完全不成比例。

    只重试「拿到了响应但解析不了」这一类；网关连不上、被拒、超时都是环境问题，
    重试只是把同一个失败再跑一遍。
    """
    try:
        data = _detect_image_once(image)
    except DetectorUnavailable as exc:
        if "JSON" not in str(exc) and "花括号" not in str(exc):
            raise
        data = _detect_image_once(image)
    if not data.get("hasOverlay"):
        return []
    out: list[Finding] = []
    for item in data.get("items") or []:
        kind = normalise_kind(item.get("kind"))
        if kind is None:
            # 模型编了个类型名。归到 trademark（最宽的一类）并把原词留在 detail
            # 里，比丢掉这条标注好 —— 它确实看见了什么。
            out.append(
                Finding(field=field, kind="trademark", evidence=str(item.get("text", "")),
                        confidence=0.5, detail=f"模型给的类型 {item.get('kind')!r} 认不出来，暂归商标")
            )
            continue
        out.append(Finding(field=field, kind=kind, evidence=str(item.get("text", "")), confidence=0.8))
    return out


def _batch_findings(data: object, task: MontageTask) -> list[Finding]:
    """Strictly expand a montage response back to source image fields."""
    # qwen3.5:4b returns the requested records as a bare JSON array despite the
    # object example in the prompt. The array has the same slot semantics, so
    # normalise only this equivalent envelope; arbitrary objects still fail.
    if isinstance(data, list):
        data = {"images": data}
    if not isinstance(data, dict) or not isinstance(data.get("images"), list):
        raise DetectorUnavailable("批量图片检测返回缺少 images 数组")
    expected = {slot.slot: slot.field for slot in task.slots}
    seen: set[int] = set()
    findings: list[Finding] = []
    for item in data["images"]:
        if not isinstance(item, dict) or isinstance(item.get("slot"), bool):
            raise DetectorUnavailable("批量图片检测包含非法 slot 结果")
        slot = item.get("slot")
        if isinstance(slot, str) and slot.isdecimal():
            slot = int(slot)
        if not isinstance(slot, int) or slot not in expected or slot in seen:
            raise DetectorUnavailable(f"批量图片检测返回未知或重复 slot: {slot!r}")
        seen.add(slot)
        if not isinstance(item.get("hasOverlay"), bool) or not isinstance(item.get("items"), list):
            raise DetectorUnavailable(f"批量图片检测 slot {slot} 结果结构非法")
        if not item["hasOverlay"]:
            continue
        for finding in item["items"]:
            # The same model commonly omits kind and returns a string list.
            # Keep it as a low-confidence finding for human review rather than
            # silently treating a claimed overlay as clean.
            if isinstance(finding, str):
                findings.append(Finding(
                    field=expected[slot], kind="trademark", evidence=finding, confidence=0.4,
                    detail="模型没有返回风险类型，暂按疑似商标标注，需人工核验",
                ))
                continue
            if not isinstance(finding, dict):
                raise DetectorUnavailable(f"批量图片检测 slot {slot} 的 items 结构非法")
            kind = normalise_kind(finding.get("kind"))
            findings.append(Finding(
                field=expected[slot], kind=kind or "trademark",
                evidence=str(finding.get("text", "")), confidence=0.8,
                detail="" if kind else f"模型给的类型 {finding.get('kind')!r} 认不出来，暂归商标",
            ))
    if seen != set(expected):
        missing = sorted(set(expected) - seen)
        raise DetectorUnavailable(f"批量图片检测缺少 slot: {missing}")
    return findings


def detect_montage(task: MontageTask) -> list[Finding]:
    """Detect all source images represented by one montage task."""
    try:
        data = _extract_json(_run_detector(BATCH_IMAGE_PROMPT, image=task.image))
    except DetectorUnavailable as exc:
        if "JSON" not in str(exc) and "花括号" not in str(exc):
            raise
        data = _extract_json(_run_detector(BATCH_IMAGE_PROMPT, image=task.image))
    return _batch_findings(data, task)


TEXT_PROMPT = (
    "下面是一段电商商品文案。找出其中的：平台名（淘宝/1688/拼多多等）、他家店铺名、"
    "联系方式（微信/QQ/电话/网址）、他人商标品牌。"
    "注意：商品本身的品牌、以及「适用于 XX」这类兼容性说明，不算侵权，不要报。"
    "只输出一行 JSON，不要围栏不要解释："
    '{"items":[{"text":"原文片段","kind":"platform|shop|contact|trademark"}]}\n\n文案：\n'
)


def _as_items_envelope(data: object) -> dict:
    """把模型回的东西归一成 {"items": [...]}。

    提示词要的是 {"items":[...]}，但模型偶尔直接回裸数组 [...] —— 语义一模一样，
    只是少了外壳。实测本地 Ollama 模型就这么回的，而 opencode 那档一直回对象，
    所以这条路从没被触发过，端到端一跑就炸在「文案检测返回的不是对象：list」。

    只接受这两种【等价外壳】，其余仍然判通道不可用：把任意形状都硬塞成空 items，
    等于把「模型答非所问」伪装成「检测通过，无风险」—— 那是这条链路最不能出的错。
    """
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        return {"items": data}
    raise DetectorUnavailable(
        f"文案检测返回的既不是对象也不是数组：{type(data).__name__}")


def detect_text(text: str, field: str) -> list[Finding]:
    if not text.strip():
        return []
    if ask_llm is not None:
        # 实测三次 13.6-16.7s，但尾部会撞上 agent 用工具的那一档；`ask_llm`
        # 默认 60s 在那种时候会超。给到和图片通道同一个预算。
        # 超时同样重试（理由见 _run_detector）：这条路走的是 ask_llm，不经过
        # _run_detector，不在这里补一遍，文案检测就仍是整条链路上唯一没有抗
        # 拥塞能力的一环。
        data = None
        for attempt in range(TIMEOUT_RETRIES + 1):
            try:
                data = ask_llm(TEXT_PROMPT + text, timeout=_request_timeout())
                break
            except RuntimeError as exc:
                # `ask_llm` 超时/解析失败都抛 RuntimeError。翻成本模块的类型，让
                # 「通道坏了」与「检测通过」在调用方那里仍然是两件事。
                if "超时" in str(exc) or "timeout" in str(exc).lower():
                    if attempt < TIMEOUT_RETRIES:
                        _retry_pause()
                        continue
                raise DetectorUnavailable(f"文案检测通道不可用：{exc}") from exc
        data = _as_items_envelope(data)
    else:
        data = _as_items_envelope(_extract_json(_run_detector(TEXT_PROMPT + text)))
    out: list[Finding] = []
    for item in data.get("items") or []:
        kind = normalise_kind(item.get("kind"))
        evidence = str(item.get("text", ""))
        # 模型偶尔会「引用」一段原文里根本没有的话。对不上就降低置信度而不是丢弃,
        # 但要标出来 —— 一条指不到原文的标注,修改层没法用它定位。
        if evidence and evidence not in text:
            out.append(
                Finding(field=field, kind=kind or "trademark", evidence=evidence, confidence=0.3,
                        detail="这段话在原文里找不到，可能是模型转述")
            )
            continue
        out.append(
            Finding(field=field, kind=kind or "trademark", evidence=evidence, confidence=0.8,
                    detail="" if kind else f"模型给的类型 {item.get('kind')!r} 认不出来，暂归商标")
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="对一张图或一段文案做侵权标注")
    ap.add_argument("--image", type=Path, help="图片路径")
    ap.add_argument("--text", help="文案")
    ap.add_argument("--field", required=True, help="它在 canonical 里的 JSON Pointer，如 /images/main/0")
    args = ap.parse_args()
    if bool(args.image) == bool(args.text):
        ap.error("--image 与 --text 二选一")

    try:
        findings = detect_image(args.image, args.field) if args.image else detect_text(args.text, args.field)
    except DetectorUnavailable as exc:
        # 退 2，与仓库其它「工具缺失/不可用」的约定一致 —— 和「检测出问题」
        # 的退 1 分开，因为两者要走完全不同的处理。
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2

    print(json.dumps({"ok": True, "findings": [asdict(f) for f in findings]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
