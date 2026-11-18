#!/usr/bin/env python3
"""1688 商品清洗、类目属性映射和合规检测，返回 canonical 与发布条件。

商品图片在内存中处理并上传图床；商品数据只返回 JSON，不自动保存中间文件。
"""
from __future__ import annotations

import argparse
import collections
import copy
from contextlib import contextmanager, nullcontext
import functools
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

_SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SKILL_ROOT))

# projection 已吞到本 skill 下(rprojection/projection/),导入前缀同步。
# 原本反向 wiring (product-projection/ 反向 import preprocess/scripts/) 的
# 复杂度不再需要 —— 都在同一棵 sys.path 树下。
_PROJECTION_ROOT = _SKILL_ROOT / "projection"
if _PROJECTION_ROOT.is_dir():
    sys.path.insert(0, str(_PROJECTION_ROOT))

from preprocess import load_json
from category_capture import (
    blocking_qualifications,
    is_spu_category,
    load_capture_json,
    load_props_capture,
    load_qualification_capture,
)
from build_canonical import (build_canonical, fetch_schema, load_constraints, finding,
                             extract_images, _download_image_bytes, doudian_char_len)
from preprocess_config import normalize_config
from canonical_overlay import apply_attribute_overlay, deep_merge
from validate_doudian_rules import load_rule_limits, validate as validate_publication
from llm_client import ask_llm
from phase_timings import PhaseTimings
from execution_budget import announce_work

# module 名与函数名冲突,这里 alias 为 _project_canonical
from projection.project import (  # noqa: E402
    project as _project_canonical, collect_findings, mark_checked_images, verdict, BRAND_PROP_NAME,
    publication_readiness,
)
from projection.detect import DetectorUnavailable  # noqa: E402

_REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_TREE = _REPO_ROOT / "reports" / "doudian-category-tree.json"
DEFAULT_PROPS = _REPO_ROOT / "reports" / "doudian-category-properties.json"
# 资质快照。category_capture.blocking_qualifications 早就写好了「我们出不了证件图、
# 发布必挂、应在预处理阶段就阻断」，但主流程【从来没加载过这份数据，也从没调用它】
# —— 一条定义完整却零调用的死防线。2026-09-04 接线。
DEFAULT_QUALIFICATION = _REPO_ROOT / "reports" / "doudian-category-qualification.json"

# 送进 LLM 的 options 候选池上限。属性表实测:25132 个带 options 的属性条目,
# 中位数 8 项、p90 92、p99 255,仅 174 条超过 300。超限的几乎全是「型号」
# (最大 6162 项)这类 SKU 编码枚举,本来就不靠语义匹配,按字符重合截断不丢信息。
# 300 以内一律**全量**送 LLM,不做 overlap 预筛 —— 见 _resolve_value 的说明。
LLM_OPTION_LIMIT = 300
# 字符召回保留多少候选。只在降级路径生效(正常走两段式穷举),从 5 提到 20 是因为
# 这个分数排不准 —— 实测正确答案排第 4,再窄一点就直接漏了。
CATEGORY_TOP_K = 20
# 类目决策独立采样几次取多数。**默认 1(不投票)**,依据是实测而非直觉:
#
#   eval/eval_category.py --rounds 3(2026-08-31,3 用例 × 3 轮 = 9 次观测)
#     votes=1   一级 9/9  叶子 9/9  三轮全一致   458s(51s/例)
#     votes=3   一级 9/9  叶子 9/9  三轮全一致   967s(107s/例)
#   → 准确率完全相同,代价 2.1 倍。
#
# 投票本是对方差的正确工具,加它的起因也是真的:改上下文之前,同一件睡衣连跑三轮
# 出现过 ✅✅❌。但后来 votes=1 也三轮全稳 —— 真正消掉方差的是**上下文质量**
# (两段式穷举召回 + 全部来源属性 + 候选带全路径),不是采样次数。为不确定的收益
# 付确定的代价不划算,所以默认关掉,机制留着。
#
# **这个结论的证据很薄**:n=9,且 3 个用例里 2 个同类(都是睡衣)。它分辨不出
# 89% 和 100%。评测集扩大后应该重跑这个 A/B 再定。遇到类目摇摆的商品,
# 用 BCP_CATEGORY_VOTES=3 打开。
CATEGORY_VOTES = int(os.environ.get("BCP_CATEGORY_VOTES", "1"))
# LLM_VALUE_WORKERS 已删除:属性名/值映射改为整批一次调用(见 _resolve_selected_*),
# 不再有并发,也就不再有 opencode 本地 SQLite 的 `database is locked` 竞争。
DEFAULT_LLM_BUDGET_S = int(os.environ['BCP_LLM_BUDGET']) if os.environ.get('BCP_LLM_BUDGET') else None
DEFAULT_LLM_CALL_TIMEOUT_S = int(os.environ.get("BCP_LLM_TIMEOUT", "240"))
_LLM_DEADLINE: float | None = None


@contextmanager
def llm_budget(seconds: int | float | None):
    """Install a nested product-level deadline for all mapping calls."""
    global _LLM_DEADLINE
    previous = _LLM_DEADLINE
    _LLM_DEADLINE = None if seconds is None else time.monotonic() + seconds
    try:
        yield
    finally:
        _LLM_DEADLINE = previous


def _model_for(tier: str) -> str | None:
    """决策档位 → 模型名。None 表示用 llm_client 的默认档。

    分层的依据是**杠杆**,不是难度:
      strong  类目决策。每商品 1 次,但一错全错 —— 属性映射、必填校验、发布全都
              建在它选的类目上,而且错得像模像样(有 id、有路径),人工很难发现。
      default 属性名 / 属性值 / 必填推断。每商品十几次,且错了会被 pending 标出来
              交人工,损失有界。

    默认两档同模型 —— 本机实测(2026-08-31)只有 opencode 自家免费档可用
    (deepseek 请求错误 / minimax 报错 / openai 超时 / mimo-pro 余额不足),而在
    没有 A/B 证据的情况下换模型只是换一种猜。机制先留好,用
    `BCP_LLM_MODEL_STRONG` 指定强档,再用 eval/eval_category.py 实测再定。
    """
    if tier == "strong":
        return os.environ.get("BCP_LLM_MODEL_STRONG") or None
    return None


def _ask_llm(prompt: str, *, context=None, tier: str = "default",
             images: list[str] | None = None):
    """Call the real client with the remaining product budget."""
    kwargs = {"context": context}
    model = _model_for(tier)
    if model:
        kwargs["model"] = model
    # 只有真给了图才进 kwargs：没有图时调用形状与从前逐字节相同，
    # 既有断言与假客户端都不受影响。
    if images:
        kwargs["images"] = images

    timeout = DEFAULT_LLM_CALL_TIMEOUT_S
    if _LLM_DEADLINE is not None:
        remaining = math.ceil(_LLM_DEADLINE - time.monotonic())
        if remaining <= 0:
            raise RuntimeError("LLM budget exhausted")
        timeout = min(timeout, remaining)
    announce_work('llm-mapping', timeout)
    try:
        return ask_llm(prompt, timeout=timeout, **kwargs)
    except TypeError as exc:
        # Existing unit-test fakes predate the optional timeout keyword. Keep
        # them usable without weakening the real client's deadline behavior.
        if "unexpected keyword argument 'timeout'" not in str(exc):
            raise
        return ask_llm(prompt, **kwargs)


def _with_llm_budget(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        seconds = kwargs.pop("llm_budget_seconds", DEFAULT_LLM_BUDGET_S)
        timings = PhaseTimings(clock=kwargs.pop('_phase_clock', None))
        kwargs['_phase_timings'] = timings
        if seconds is None:
            seconds = DEFAULT_LLM_BUDGET_S
        try:
            if kwargs.get("no_llm", False):
                result = function(*args, **kwargs)
            else:
                with llm_budget(seconds):
                    result = function(*args, **kwargs)
        except Exception as exc:
            timings.finish_stage('failed')
            try:
                exc.phase_timings = timings.snapshot()
            except Exception:
                pass
            raise
        timings.finish_stage()
        result['phase_timings'] = timings.snapshot()
        return result

    return wrapped


# --------------------------------------------------------------------------
# 索引加载
# --------------------------------------------------------------------------

def load_category_indexes(tree_path: Path, props_path: Path):
    """leaves: dict[类目名 → [(leaf_id, level, parent_cid), ...]]
    props_by_leaf: dict[str(leaf_id) → {name, path, props[]}]
    """
    # 类目树同样走适配层：三份产物同一次采集、同一套压缩策略，只让属性支持 .gz
    # 会在「只有 .gz」的克隆里把树读崩。
    tree = load_capture_json(tree_path)
    leaves: dict[str, list[tuple[int, int, int]]] = {}

    def walk(node):
        if node.get("is_leaf"):
            leaves.setdefault(node["name"], []).append(
                (node["id"], node.get("level") or 0, node.get("parent_cid") or 0)
            )
        for c in node.get("children") or []:
            walk(c)

    for root in tree.get("tree") or []:
        walk(root)

    # 走适配层而不是 load_json：2026-09-03 采集口径改为原样保留后，文件顶层多了
    # source/stats/data 一层，items 用 label、options 是对象数组。适配层把它归一回
    # 本文件下游一直在用的形状（props[] + options 二元组），所以这一行之后的 25+ 处
    # 调用点一行都不用动；新增字段挂在每项的 raw 上，要用直接取。旧形状也照读。
    props_by_leaf = load_props_capture(props_path)
    # 第三个返回值是【嵌套的原始树】：类目层级的权威来源。切 path 字符串建树
    # 对 18% 的叶子是错的（名字里本来就有斜杠），详见 _category_tree_from_nodes。
    return leaves, props_by_leaf, (tree.get("tree") or [])


# token_overlap_score 已删除(2026-08-31)。
#
# 它名为 token,实为**字符集 Jaccard**:`len(set(a) & set(b)) / len(set(a) | set(b))`。
# 对中文商品文本几乎没有语义 —— 实测一件近视镜片商品,正确类目「成品眼镜片」得分
# 0.107 排第 4,而榜首是靠「3」「6」「0」三个字符命中的「360全景/SVC」(0.129)。
#
# 更根本的原因:1688 和抖店的类目 / 属性名 / 属性值本来就不是 1:1 对应,这正是
# 整条链路要用 LLM 做语义匹配的前提。再用字符重合度去卡候选、排序、甚至当准入
# 门槛(旧代码第 576 行就是),等于在语义匹配的上游重新引入一个「两边用词字面重合」
# 的错误假设 —— 赌输了,后面语义再强也救不回来。
#
# 各调用点的去向:
#   类目召回      → resolve_category 两段式穷举(48 个一级 → 该级下全部叶子)
#   属性名排序     → 只按 required 排,候选全量交 LLM
#   属性名准入门槛  → 删除(它本就违背 SKILL.md「只用于排序、不当准入门槛」)
#   options>300 截断 → 不再截断猜测,直接不匹配并落 pending(见 _llm_pick_value)


# --------------------------------------------------------------------------
# 类目匹配
# --------------------------------------------------------------------------

def _source_attributes(raw) -> list[dict]:
    """全部来源属性(名 + 值),原样带给类目决策。**不筛选**。

    这里曾经是一个「品类关键词白名单」,只抽 label 等于「产品类别」的那一条。
    那是把信号想窄了:1688 的属性表是**按类目下发**的,所以**属性名的集合本身
    就是类目指纹** —— 出现「领型 / 袖长 / 裤长 / 尺码」基本锁定服装,出现
    「折射率 / 镜片材质 / 镜片颜色」基本锁定镜片,根本不用看标题。而白名单只
    覆盖到 6 个已采商品里的 1 个,其余全是空手。

    反过来,标题是 SEO 关键词堆砌,多个品类词并存是常态(「挂件卡包茶碗纸袋」
    「玩偶手办车载摆件公仔」),恰恰是**最不可信**的那个信号 —— 而它此前是唯一
    信号。实测一个近视镜片商品因此被选进「防蓝光镜」(成品眼镜)类目。

    值也一并给:材质=PVC / 陶瓷 / 帆布 这类值在标题歧义时是决定性的。
    """
    attrs = ((raw.get("BaseInfo") or {}).get("Attr") or {}).get("SourceAttr") or []
    out = []
    for a in attrs:
        name = str(a.get("Label") or "").strip()
        if not name:
            continue
        out.append({"name": name, "value": str(a.get("Value") or "").strip()})
    return out


def _top_level_index(leaf_paths: dict) -> dict[str, list[tuple[int, str]]]:
    """一级类目名 → [(leaf_id, 全路径)]。两段式召回的分桶。"""
    buckets: dict[str, list[tuple[int, str]]] = {}
    for lid, path in leaf_paths.items():
        head = (path or "").split("/")[0].strip()
        if not head:
            continue
        buckets.setdefault(head, []).append((int(lid), path))
    return buckets


def _exact_leaf_match(raw: dict, leaf_paths: dict,
                      leaf_names: dict | None = None) -> tuple[int, str] | None:
    """Find one unambiguous leaf name written verbatim in the source data.

    The raw-1688-offer contract has no source category field, so the first LLM
    stage has to classify from a noisy title and attribute set. A unique,
    sufficiently specific leaf phrase in that source text is stronger evidence
    than an LLM preference for a broad neighboring top-level category. Only the
    single longest match is trusted; ties or short generic names remain an LLM
    decision.
    """
    base = raw.get("BaseInfo") or {}
    parts = [
        str(base.get("Title") or "").strip(),
        str(base.get("CategoryName") or "").strip(),
    ]
    parts.extend(
        f"{item['name']} {item['value']}"
        for item in _source_attributes(raw)
    )
    text = " ".join(part for part in parts if part)

    matches = []
    for leaf_id, path in leaf_paths.items():
        # 名字优先取权威值。从 path 切末段对那 771 个名字带斜杠的叶子是错的：
        # 「T恤/Polo衫」会被切成「Polo衫」，于是真名从不参与匹配，反倒是一个
        # 片段在匹配 —— 匹配到的东西和它声称匹配的东西不是一回事。
        leaf_name = str((leaf_names or {}).get(str(leaf_id)) or "").strip() \
            or (path or "").rsplit("/", 1)[-1].strip()
        if len(leaf_name) < 3 or leaf_name not in text:
            continue
        matches.append((len(leaf_name), int(leaf_id), path, leaf_name))

    if not matches:
        return None
    longest = max(item[0] for item in matches)
    strongest = [item for item in matches if item[0] == longest]
    if len(strongest) != 1:
        return None
    _, leaf_id, path, _ = strongest[0]
    return leaf_id, path


_CATEGORY_JUDGEMENT_RULES = (
    "怎么判断:\n"
    "1. **source_attributes 的「属性名集合」是最强信号**。1688 的属性表按类目下发,"
    "卖家被要求填哪些字段基本就暴露了品类;属性值(材质等)在标题歧义时是决定性的。\n"
    "2. title 是 SEO 关键词堆砌,常有多个品类词并存,可信度低于属性。"
    "功能、卖点、规格、适用人群、风格都是修饰词,不是品类。\n"
    "3. 部件/配件与成品是不同类目 —— 只卖其中一个部件时,不要选整机/成品类目。\n"
    "4. 若给了「文本里疑似出现的类目名」,那只是**一条线索**:某个抖店类目名恰好"
    "逐字出现在标题或属性里。它不是判决 —— 标题常把相邻品类词一起堆上去"
    "(女装 T 恤的标题里出现「打底衫」是常事)。与属性证据冲突时以属性为准,"
    "一致时可以更笃定。\n"
)


# 一级最多试几次。给 2 是因为真正的歧义几乎都是二选一(吹风机:个人护理 vs 家用电器),
# 试到第三个通常说明这件商品本来就不该自动定类目。
# 逐级下钻 + 回退的总调用上限。层深最多 6,留出回退余量;超过通常说明
# 这件商品的类目本来就有歧义,该交人工而不是继续烧调用。
MAX_CATEGORY_CALLS = 14
# 回退次数只限制调用成本，不能把模型的否定意见变成认可。
MAX_BACKTRACK_ROUNDS = 3
# 精确命中捷径的贴切校验票数。要求全票通过：单票时实测出现过同一输入
# 先 false 后 true 的抖动，而放行一个错类目的代价远大于多一次调用。
SHORTCUT_VERIFY_VOTES = 2
# 捷径校验最多借走剩余 LLM 预算的多少，以及至少要有多少秒才值得一试。
# 逐级下钻是权威，必须拿到大头。
SHORTCUT_VERIFY_BUDGET_SHARE = 0.25
SHORTCUT_VERIFY_MIN_S = 30


def _pick_top_level(prompt: str, ctx: dict, buckets: dict, tried: list[str]) -> str | None:
    """选一个还没试过的一级类目。选不出来返回 None —— 不猜。

    猜错一级会让二段在完全无关的叶子里选,而那种错误看起来跟正常结果一模一样
    (有 id、有路径),比不映射难发现得多。
    """
    avail = {k: v for k, v in buckets.items() if k not in tried}
    if not avail:
        return None
    ctx = {**ctx, "top_level_categories": sorted(avail)}
    if tried:
        ctx["already_ruled_out"] = tried
    try:
        d = _ask_llm(prompt, context=ctx, tier="strong")
        cand = str((d or {}).get("picked") or "").strip()
    except (RuntimeError, KeyError, ValueError):
        return None
    if cand not in avail:
        return None
    tried.append(cand)
    return cand


def _leaf_path_segments(roots: list | None, leaf_id: int) -> list[str] | None:
    """顺着嵌套类目树走到 leaf_id，返回真实的分段名列表。

    与 _category_tree_from_nodes 同源：类目层级的权威来源是父子结构，不是把名字
    用 "/" 拼起来的那个字符串。按 "/" 反切会把「T恤/Polo衫」这类名字劈成两段，
    多出一层根本不存在的层级 —— 而这份 doudianPath 是发布时点类目的依据。
    """
    if not roots or leaf_id is None:
        return None

    def walk(node: dict, trail: list[str]) -> list[str] | None:
        name = str(node.get("name") or "").strip()
        here = trail + [name] if name else trail
        if node.get("is_leaf") and node.get("id") is not None and int(node["id"]) == leaf_id:
            return here
        for child in node.get("children") or []:
            found = walk(child, here)
            if found:
                return found
        return None

    for r in roots:
        found = walk(r, [])
        if found:
            return found
    return None


def _category_tree_from_nodes(roots: list | None) -> dict | None:
    """用类目树文件里的【嵌套父子结构】建前缀树，而不是切 path 字符串。

    抖店有 771 个叶子的名字本身带斜杠（「T恤/Polo衫」「针织衫/毛衣/羊毛衫」
    「鲨鱼裤/打底裤」…），占全部叶子的 18%。按 "/" 切 path 会把这类名字劈成
    多层：实测一件女式圆领长袖 T 恤走到「服装/女装/T恤」后，下一层候选变成
    「Polo衫」，模型正确地判「这不是 Polo 衫」→ fits=false → 一路回退到顶层放弃。
    模型没错，是我们把它放到了一个不存在的层级上。

    节点形状与 _category_tree 一致，便于两条路互换。
    """
    if not roots:
        return None
    root: dict = {"children": {}, "leaf_id": None}

    def add(node: dict, parent: dict) -> None:
        name = str(node.get("name") or "").strip()
        if not name:
            return
        cur = parent["children"].setdefault(name, {"children": {}, "leaf_id": None})
        if node.get("is_leaf") and node.get("id") is not None:
            cur["leaf_id"] = int(node["id"])
        for child in node.get("children") or []:
            add(child, cur)

    for r in roots:
        add(r, root)
    return root


def _category_tree(leaf_paths: dict) -> dict:
    """把 {leaf_id: "一级/二级/.../末级"} 建成前缀树。

    节点形状: {"children": {名字: 节点}, "leaf_id": int|None}
    末级节点 children 为空、leaf_id 有值。同名中间节点在不同分支下互不干扰,
    因为树是按路径逐段建的。
    """
    root: dict = {"children": {}, "leaf_id": None}
    for lid, path in (leaf_paths or {}).items():
        segs = [x.strip() for x in (path or "").split("/") if x.strip()]
        if not segs:
            continue
        node = root
        for seg in segs:
            node = node["children"].setdefault(seg, {"children": {}, "leaf_id": None})
        node["leaf_id"] = int(lid)
    return root


def _match_candidate(picked: str, avail: list[str]) -> str | None:
    """把模型回的名字对回候选集里的原名；对不上返回 None。

    以前是 `if name not in avail: continue` —— 精确字符串相等。中文模型在中英混排
    时习惯加空格，实测本地模型回 "T 恤/Polo 衫"，而候选是 "T恤/Polo衫"：**它选对了**，
    却因为两个空格被判成「没有有效候选」，触发回退、把正确的男装分支排除掉，
    然后一路走到「特殊服装/其他特殊服装」。判断没错，是匹配把答案丢了。

    所以先精确比，再退到「去掉所有空白后相等」。只放宽空白这一档：再松就会把
    「汤勺」和「漏勺」这种真正不同的候选也混起来，那是另一类错误。
    """
    picked = (picked or "").strip()
    if not picked:
        return None
    if picked in avail:
        return picked
    squash = lambda x: "".join(str(x).split())
    target = squash(picked)
    for cand in avail:
        if squash(cand) == target:
            return cand
    return None


def _pick_child(product: dict, trail: list[str], node: dict, excluded: set[str],
                votes: int, tried_paths: list[str] | None = None,
                images: list[str] | None = None,
                ) -> tuple[str | None, str, bool, int | None]:
    """在 node 的直接子节点里选一个。返回 (名字|None, 理由, 是否贴切, 建议退回层数)。

    第四个返回值只在 fits=False 时有意义:模型自己指出该退回到第几层重选
    (0 = 顶层)。None 表示它没表态,调用方按「退一层」处理。加它是因为实测
    吹风机那轮:模型在第 3 层明说「候选列表中无对应电器类目」—— 它已经知道整条
    分支都错了,而系统只退一层,于是在错分支里换了条路,最后落进兜底叶子。

    只给【同一层的兄弟节点】,不给全路径 —— 这是逐级下钻相对「一次性丢 326 条
    全路径」的全部意义:候选集小且同质,模型只需回答一个问题(往哪走),不用同时
    理解层级结构。已排除的分支显式告知,免得它反复推荐同一个。
    """
    avail = sorted(k for k in node["children"] if k not in excluded)
    if not avail:
        return None, "该层候选已全部排除", False, None
    # 【不做】「独苗不问」的省调用优化:候选只有一个时,要问的也不是「选哪个」,
    # 而是「这一个到底合不合适」——跳过它就等于在单子节点链路上永久关掉回退能力,
    # 而那恰恰是最需要回退的形状(实测吹风机进了「个人护理」后被一路顺到叶子,
    # 中间每层都只有一条路可走,没有任何一层有机会说「不对」)。
    # 一个候选时模型只需回答 fits,调用很便宜;真实类目树里单子节点也少见。
    ctx = {**product,
           "已确定的上级类目": " / ".join(trail) if trail else "(顶层)",
           "candidates": avail}
    if excluded:
        ctx["已排除"] = sorted(excluded)
    if tried_paths:
        # 已经走到底但被判不合适的完整路径。不给它,模型会在几条错分支之间来回绕,
        # 每次都觉得"这条还没试过"。
        ctx["已试过且不合适的完整路径"] = tried_paths[-6:]
    prompt = (
        f"这件 1688 商品在抖店类目树里,下一层应该走哪个分支?"
        f"当前位置: {' / '.join(trail) if trail else '(顶层)'}。从 candidates 里选一个。\n"
        + _CATEGORY_JUDGEMENT_RULES
        + "5. 若 candidates 里没有能容纳这件商品的分支,仍选最接近的,但把 fits 置为 false"
          "—— 那表示上一层可能就走错了,系统会回退换一条路。\n"
        + "6. fits=false 时再填 backTo:你认为该退回到第几层重选。0=退回顶层重选一级类目,"
          "1=退回第 1 层,以此类推;拿不准填 null(系统按退一层处理)。"
          "「已确定的上级类目」里用 / 分隔的段数就是当前深度 —— 若你判断连一级都选错了,"
          "就填 0。\n"
        + '只输出 JSON: {"picked": "<候选名>", "fits": true|false, "backTo": <整数或 null>,'
          ' "reason": "<一句话>"}'
    )
    tally: dict[str, int] = {}
    reasons: dict[str, str] = {}
    fits: dict[str, bool] = {}
    back_votes: list[int] = []
    call_errors: list[str] = []
    for _ in range(max(1, votes)):
        try:
            d = _ask_llm(prompt, context=ctx, tier="strong", images=images)
            name = _match_candidate(str((d or {}).get("picked") or ""), avail)
            if name is None:
                continue
            tally[name] = tally.get(name, 0) + 1
            reasons.setdefault(name, str(d.get("reason", "")))
            # 缺 fits 字段按 True:没表态不等于否定。
            fits[name] = fits.get(name, True) and bool(d.get("fits", True))
            # backTo 只在模型说 fits=false 时才有意义;它是「退到第几层」的建议。
            # 超出当前深度的值不采信 —— 退得比现在还深没有意义。
            bt = d.get("backTo")
            if not bool(d.get("fits", True)) and isinstance(bt, (int, float)):
                bt = int(bt)
                if 0 <= bt <= len(trail):
                    back_votes.append(bt)
        except (RuntimeError, KeyError, ValueError, TypeError) as exc:
            # 别静默吞：预算耗尽 / 通道挂了 / 模型答得不对，三件事长得一模一样时，
            # 放弃诊断只会说「模型没有给出有效候选」，把人引向调提示词而不是查预算。
            call_errors.append(f"{type(exc).__name__}: {exc}")
            continue
    if not tally:
        why = "；".join(dict.fromkeys(call_errors)) if call_errors else "模型返回的候选不在候选集里"
        return None, f"没有拿到有效候选（{why}）", False, None
    best = max(tally, key=lambda k: tally[k])
    # 取最浅的建议:几票分歧时,退得更远是更保守的选择 —— 退多了还能重新往下走,
    # 退少了会继续困在错分支里(吹风机那轮就是只退一层没退出「个人护理」)。
    back_to = min(back_votes) if back_votes else None
    return best, reasons.get(best, ""), fits.get(best, True), back_to


def _llm_budget_remaining() -> float | None:
    """当前商品级 LLM 预算还剩多少秒；没设预算时返回 None。"""
    if _LLM_DEADLINE is None:
        return None
    return max(0.0, _LLM_DEADLINE - time.monotonic())


def _verify_leaf_fits(product: dict, path: str) -> tuple[bool, str]:
    """校验「来源文本里出现的叶子名」这条捷径给出的类目是否真的容得下这件商品。

    与逐级下钻用同一套判断规则和同一个结构化回执，区别只是候选集为 1：
    问的不是「选哪个」，而是「这一个到底合不合适」。模型没表态时按通过处理——
    没回答不等于否定，否则一次调用抖动就把本来正确的捷径废掉。
    """
    prompt = (
        f"这件 1688 商品是否属于抖店类目【{path}】?\n"
        + _CATEGORY_JUDGEMENT_RULES
        + "4. 只要该类目在【适用人群/性别/成品与部件】等任一维度与商品明显不符,"
          "就把 fits 置为 false —— 名字对得上不等于类目对得上。\n"
        + '只输出 JSON: {"fits": true|false, "reason": "<一句话>"}'
    )
    # 两票一致才放行。实测同一件商品、同一个候选，单次调用先判 false 再判 true ——
    # 一次抖动就能把一个错类目送进下游（错类目 → 错属性表 → 整条链路跟着错）。
    # 反过来，正确的捷径两次都会通过，代价只是多一次调用，仍比走完整逐级便宜。
    # 显式总时限下，捷径校验必须给后续下钻保留时间；动态模式由各次调用单独限时。
    remaining = _llm_budget_remaining()
    if remaining is not None:
        share = max(SHORTCUT_VERIFY_MIN_S, remaining * SHORTCUT_VERIFY_BUDGET_SHARE)
        if share >= remaining:
            return False, "剩余 LLM 预算不足以校验捷径，落回逐级下钻"
    else:
        share = None
    votes: list[tuple[bool, str]] = []
    for _ in range(SHORTCUT_VERIFY_VOTES):
        try:
            if share is None:
                d = _ask_llm(prompt, context={**product, "候选类目": path}, tier="strong")
            else:
                with llm_budget(share):
                    d = _ask_llm(prompt, context={**product, "候选类目": path}, tier="strong")
        except (RuntimeError, KeyError, ValueError, TypeError) as exc:
            # 借来的那段用完了 → 当作没校验过，落回下钻（外层预算未动）。
            return False, f"捷径校验未完成({exc})，落回逐级下钻"
        votes.append((bool((d or {}).get("fits", True)), str((d or {}).get("reason", ""))))
        if not votes[-1][0]:
            return False, votes[-1][1]          # 有一票否决就够，不必再问
    return True, votes[-1][1] if votes else ""


def _category_giveup(why: str, trail: list[str], calls: int,
                     excluded: dict[str, set[str]], reason_at: dict[str, str]) -> None:
    """逐级下钻放弃时把过程打出来。

    以前这里直接 return None，调用方只看到「类目未映射」——走到了哪一层、
    排除了哪些分支、模型每层说了什么，全都没有。而这恰恰是唯一能判断
    「是商品本来就没有合适类目」还是「判断逻辑有问题」的信息。
    """
    print(f"  类目逐级下钻放弃：{why}（走到 {'/'.join(trail) or '(顶层)'}，"
          f"共 {calls} 次调用）", file=sys.stderr)
    for key in sorted(excluded):
        print(f"    在「{key or '(顶层)'}」排除了：{sorted(excluded[key])}", file=sys.stderr)
    for key in sorted(reason_at):
        if reason_at[key]:
            print(f"    「{key or '(顶层)'}」的理由：{reason_at[key][:80]}", file=sys.stderr)


def _first_main_image_b64(raw) -> list[str] | None:
    """取第一张主图并 base64，供类目顶层判断带图推理用；任何一步不成就返回 None。

    为什么是「第一张」而不是全部：顶层要回答的是「这是个什么东西」，一张正面主图
    足够；多带几张只是把同一个答案重复送进去，成本却线性涨。

    为什么允许失败就退回纯文本：带图是**增强**不是前提。图取不到时类目决策必须
    照旧能跑完 —— 上游 1688 的图床偶发 403/超时是常态，让它拖垮整条链路是把
    「锦上添花」变成「单点故障」。失败会打一行到 stderr，不静默。

    复用 build_canonical 的 extract_images / _download_image_bytes：那两个函数已经
    处理了 1688 raw 的两种形状（顶层 key 与 BaseInfo 下）与防盗链头，另写一份就是
    第二套要维护的假设。
    """
    try:
        urls = extract_images(raw, "CommodityImage", "Main")
    except Exception as exc:                       # noqa: BLE001 —— 取图不该炸主流程
        print(f"  类目带图：主图列表读取失败({exc})，本次纯文本推理", file=sys.stderr)
        return None
    if not urls:
        return None
    data, err = _download_image_bytes(urls[0])
    if not data:
        print(f"  类目带图：主图下载失败({err})，本次纯文本推理", file=sys.stderr)
        return None
    import base64
    return [base64.b64encode(data).decode()]


def resolve_category(raw, leaves, no_llm: bool, leaf_paths: dict | None = None,
                     tree_roots: list | None = None,
                     leaf_names: dict | None = None) -> dict | None:
    """返回 {"doudianLeafId": int, "_reason": str} 或 None。

    **两段式穷举召回**,给了 leaf_paths 且开着 LLM 时走这条:

        一段 先在全部 48 个一级类目里选(名字拼起来才 232 字符,一次全给)
        二段 再在选中一级下的全部叶子里选(中位 57 个,最大 326,路径总长 5601 字符)

    这样候选集合是**穷举**的,不存在「正确答案没进候选」——1688 和抖店的类目
    本来就不是 1:1,用字符重合度去卡候选等于在赌两个平台的用词字面重合。赌输了
    (实测正确答案排第 4)后面语义再强也救不回来。两次调用换召回率从「看运气」
    变成结构性的 100%。

    `no_llm` 或拿不到 leaf_paths 时返回 **None**(不映射类目),不猜。类目匹配本质
    是跨平台语义匹配,没有 LLM 就没有可用信号 —— 旧实现在这里用字符重合度取榜首,
    而那个榜首实测是靠「3」「6」「0」三个字符命中的无关类目。返回 None 会让
    build_addv2 按既定规则拒绝产出(类目为 null 是阻断条件),这比发一个错类目安全。
    """
    base = raw.get("BaseInfo") or {}
    src_cat = (base.get("CategoryName") or "").strip()
    title = (base.get("Title") or "").strip()
    src_attrs = _source_attributes(raw)

    if not (src_cat or title):
        return None
    if no_llm or not leaf_paths:
        return None

    product = {"title": title, "source_category": src_cat or None,
               "source_attributes": src_attrs}

    # 「来源文本里出现了某个叶子类目的名字」只是一条【启发式线索】,不是判决。
    # 它无视其余全部证据:实测一件女装长袖 T 恤(标题「长袖T恤女…内搭打底衫」)
    # 因为字面出现「打底衫」被直接拍进【服装/男装/打底衫】——而抖店压根没有女装
    # 打底衫这个叶子,正解是【服装/女装/T恤/Polo衫】。捷径 return 在逐级下钻之前,
    # 于是「先判一级、再判二级、直到末级」这套流程一次都没跑。
    # 所以捷径只当【候选】:过一次和逐级下钻同一套的 fits 校验,不通过就落回逐级。
    # 【2026-09-03 改】捷径不再短路逐级下钻，降级成喂给模型的一条线索。
    #
    # 原实现命中并过 fits 校验就直接 return，逐级下钻一次都不跑。问题不在校验够不够
    # 严，在【它凭什么排在模型判断前面】：命中判据是「叶子名逐字出现在源文本里」，
    # 而源文本的大头是 1688 的 SEO 标题 —— 那是关键词堆砌，不是品类声明。
    #
    # 更糟的是它用【字符长度】当证据强度：len>=3 才参赛、最长者胜。这两条在实测
    # 判据集上主动选择了错误答案 —— 女装长袖 T 恤的标题里有「打底衫」(3 字，过门槛
    # 且最长)，于是被拍进【服装/男装/打底衫】；而正解叶子「T恤/Polo衫」里的「T恤」
    # 只有 2 字，连参赛资格都没有。字符长度不是语义特异性。
    #
    # 现在把命中结果作为 `文本里疑似出现的类目名` 放进 product，让模型在逐级下钻的
    # 每一层自己权衡它和属性、标题的关系。线索仍然有用（垃圾桶、一体机这类叶子名与
    # 商品名同词的场景，模型看到它会更笃定），但不再有否决权。
    hint = _exact_leaf_match(raw, leaf_paths, leaf_names)
    if hint is not None:
        product["文本里疑似出现的类目名"] = hint[1]
        print(f"  文本里疑似出现类目「{hint[1]}」，作为线索交给逐级下钻权衡（不再短路）",
              file=sys.stderr)

    # 逐级下钻:每层只在【同一层的兄弟节点】里选一个,一直走到末级。
    #
    # 上一版是「一级 → 该一级下的全部叶子」两段式,中间层被跳过。那样一次要在最多
    # 326 条全路径里挑,模型既要理解层级又要选叶子;更要命的是**一级选错就没有回头
    # 路** —— 吹风机就是这么被放进「个人护理/洗护美用具/焗油用具」的,二段的模型
    # 明确写了「候选均为个人护理类目，无吹风机专属叶子」,但那时已经没法回到一级了。
    #
    # 逐级下钻让每层都能回退:某层报 fits=false,就把这条分支在【它的父节点】上排除
    # 再选一次;一层的候选全排除完就再往上退一层。调用次数与两段式同量级(3-6 层
    # vs 1+3 票),但每次的候选集从「326 条全路径」缩到「几个兄弟节点名」。
    # 有权威嵌套结构就用它；没有才退回切 path（见 _category_tree_from_nodes）
    tree = _category_tree_from_nodes(tree_roots) or _category_tree(leaf_paths)
    # 顶层那一次调用要带的图。取一次、只取一张，后面每层都不再带（见循环里的说明）。
    top_image = _first_main_image_b64(raw)
    if top_image:
        print("  类目带图：顶层判断附带 1 张主图", file=sys.stderr)
    excluded: dict[str, set[str]] = {}   # 路径 → 该节点下已排除的子节点名
    trail: list[str] = []
    tried_paths: list[str] = []          # 已走到底但被判不合适的完整路径
    node = tree
    calls = 0
    backtracks = 0                       # 已回退轮数,到上限就收手接受当前选择
    reason_at: dict[str, str] = {}
    doubt = False

    def _reseat(depth: int):
        """把 trail 截到 depth 层并重新定位 node。"""
        nonlocal node
        del trail[depth:]
        node = tree
        for seg in trail:
            node = node["children"][seg]

    while calls < MAX_CATEGORY_CALLS:
        if not node["children"]:
            break                        # 到末级
        key = "/".join(trail)
        # 【只在顶层带图】三例误判(毛绒公仔→DIY配件 / 妈咪包→待产用品 / 平板→视频转换器)
        # 都是**在顶层那一步就偏了**，后面每一级都只是在错误子树里挑最优；而顶层选完
        # 之后，分辨细分靠的是功率/材质/尺寸这些属性，文本信号反而比图片强。
        #
        # 所以图片只送一次：一张主图 × 一次顶层调用。每层都带图是 3-8 次视觉调用，
        # 覆盖面没有增加，成本翻好几倍 —— 而本机的视觉推理不便宜。
        #
        # 为什么图片在这里是强信号：喂给模型的文本大头是 1688 的 SEO 标题
        #（「跨境」「批发」「新款」「厂家直销」堆一起），那正是把它带偏的东西；
        # 图片没有这层噪声，一眼就是毛绒玩偶 / 背包 / 平板。
        name, why, fits, back_to = _pick_child(
            product, trail, node, excluded.get(key, set()), CATEGORY_VOTES, tried_paths,
            images=(top_image if not trail else None))
        calls += 1
        model_fits = fits
        print(f'  类目判断[{calls}] {"/".join(trail) or "顶层"} → {name}，'
              f'fits={fits}：{why}', file=sys.stderr, flush=True)
        # 【兜底叶子存疑】名字以「其他」开头的末级叶子对任何商品都答得出「勉强算」，
        # 它的 fits=true 不携带信息 —— 是错误分支的吸收态。第一次撞上不直接收下，
        # 当作 fits=false 触发一次回退；回退过还是回到这里就认了(见 backtracks 上限)。
        #
        # 【一度被我误撤，实测数据要求装回】撤掉它时只盯着「三个误判跳出兜底叶子后
        # 仍然不对」，没注意 trash-bin 本来就是靠它救回来的：垃圾桶那件商品会落进
        # 「居家日用/收纳整理工具/其他收纳整理工具」，④ 拒收并回退才找到正确的
        # 「家装建材/垃圾处理/垃圾桶」。3 轮实测：有 ④ 叶子 6/11，无 ④ 稳定 5/11。
        if (name is not None and fits and backtracks < MAX_BACKTRACK_ROUNDS
                and name.startswith("其他")
                and not (node["children"].get(name) or {}).get("children")):
            fits = False
            why = f"{why}（落在兜底叶子「{name}」，先回退确认有没有更贴切的分支）"
            if back_to is None:
                back_to = max(0, len(trail) - 1)
        if name is None or not fits:
            # 走不下去 / 模型说这层没有能容纳它的分支 —— 回退一层,并在父节点把
            # 刚才那条分支排掉,免得原地打转。退到顶层还不行就放弃(返回 None)。
            if name is not None:
                excluded.setdefault(key, set()).add(name)
                reason_at[key] = why
            # 【顶层也要能回退】原实现在顶层遇到 fits=false 时「接受并标存疑」——
            # 不排除、不重选。于是一级选错就永远出不来：模型在第 3 层喊「候选列表中
            # 无对应电器类目」，系统最多退到顶层，然后把同一个错一级再收下一次。
            # 只要还有没试过的一级，就排掉它换一个再问。
            # 注意：上面那个 block 已经把 name 加进 excluded[key] 了(顶层 key 就是 "")，
            # 这里不能再 +1，否则最后一个可选一级永远轮不到 —— 实测断言当场变红。
            if not trail and name is not None and len(excluded.get("", set())) < len(tree["children"]):
                excluded.setdefault("", set()).add(name)
                reason_at[""] = why
                backtracks += 1
                continue
            if not trail:
                if name is None:
                    # 带上 _pick_child 给的真实原因：写死一句「没有有效候选」会把
                    # 「预算耗尽」「通道挂了」都说成模型的问题，把人引去调提示词。
                    _category_giveup(f"顶层拿不到候选 —— {why}", trail, calls, excluded, reason_at)
                    return None
                if not model_fits:
                    _category_giveup(f'顶层候选均不适合 —— {why}', trail, calls, excluded, reason_at)
                    return None
                # 顶层已无更好选择:接受它,但把存疑抬进 reason。
                doubt = True
                trail.append(name)
                node = node["children"][name]
                continue
            # 【回退到哪一层由模型定】原实现写死退一层。实测吹风机那轮:模型在第 3 层
            # 明说「候选列表中无对应电器类目」—— 它已经知道整条分支都错了,而系统只退
            # 一层,于是在错分支里换了条路,最后落进兜底叶子「其他洗护美用具」。
            backtracks += 1
            if name is not None:
                tried_paths.append("/".join(trail + [name]))
            # name 为 None 时没有「模型认可过的选择」可收手 —— 那是候选被排空或通道
            # 出错，只能继续回退 / 放弃。少了这个判据会 node["children"][None] 抛
            # KeyError（实测判据集第 4 例当场炸）。
            if name is not None and backtracks >= MAX_BACKTRACK_ROUNDS:
                if not model_fits:
                    _category_giveup(f'回退次数耗尽，候选被否定 —— {why}',
                                     trail, calls, excluded, reason_at)
                    return None
                # 【收手】退够了还没找到更好的,就在模型已经认可过的里面选一个,
                # 而不是继续烧调用最后返回 None —— 返回 None 会让 addv2 整个阻断,
                # 商品发不出去;带存疑标记的类目至少是个可人工复核的产出。
                doubt = True
                trail.append(name)
                node = node["children"][name]
                continue
            # 模型没表态时，退的深度随回退轮数递增(1 层 → 2 层 → …直到顶层)。
            # 固定退一层会在同一个错分支里反复横跳 —— 吹风机那轮就是退到「个人护理」
            # 后换了条路又落进兜底叶子，而正解在另一个一级下面。
            depth = back_to if back_to is not None else max(0, len(trail) - backtracks)
            back = trail[depth] if depth < len(trail) else None
            _reseat(depth)
            if back is not None:
                excluded.setdefault("/".join(trail), set()).add(back)
            continue
        trail.append(name)
        reason_at["/".join(trail)] = why
        node = node["children"][name]

    leaf_id = node.get("leaf_id")
    if leaf_id is None:
        _category_giveup(
            "调用预算用尽" if calls >= MAX_CATEGORY_CALLS else "停在了没有 leaf_id 的节点",
            trail, calls, excluded, reason_at)
        return None
    path = "/".join(trail)
    tail = reason_at.get(path, "")
    mark = "⚠ 类目存疑（模型自认无贴切分支）: " if doubt else ""
    return {"doudianLeafId": int(leaf_id),
            "_reason": f"{mark}LLM[逐级: {path}，{calls} 次调用]: {tail}"}


# --------------------------------------------------------------------------
# 属性匹配
# --------------------------------------------------------------------------

def _llm_pick_property(src_name: str, candidates: list[dict], src_value: str = ""):
    """LLM 从 candidates 里挑语义对应的抖店属性。

    返回 (prop | None, error | None)。两种 None 语义不同,必须区分:
      - (None, None)  LLM 看过了,判定没有语义对应项 → 该 source 属性不映射
      - (None, "...")  LLM 通道本身失败(超时 / opencode 不可用)→ 同样不映射,
                       但原因是基础设施而非语义,落 finding 时要写清楚
    旧实现在这两种情况下都回落 candidates[0],于是「上市年份季节」被盲采成
    「适用年龄」(只共享一个「年」字)—— 静默错映射比不映射伤害大,不再回落。
    """
    ctx = {
        "source_attribute_name": src_name,
        "source_value": src_value or None,
        "candidates": [
            {"property_id": p["id"], "name": p["name"],
             "required": bool(p.get("required")),
             "options_count": len(p.get("options") or []),
             # 候选属性的取值样例。**属性名相近时,取值才是决定性的**:实测
             # 「镜片功能=抗辐射,抗紫外线,防蓝光」被选进了「镜片镀膜」
             # (紫晶膜/黄金膜/蓝膜…),而正确的「镜片分类」的 options 里就摆着
             # 「抗辐射」—— 与来源值逐字相同。只给属性名,模型看不到这个铁证。
             # 截断到前 12 个:属性名判定只需要看出「这一栏大概装什么」,
             # 全量 options 是下一层(_llm_pick_value)的事,在这里灌满会稀释信号。
             "options_sample": [o[1] for o in (p.get("options") or [])[:12]]}
            for p in candidates
        ],
    }
    prompt = (
        "从 candidates 里挑出与 source_attribute_name 语义对应的抖店商品属性。\n"
        "判断依据:\n"
        "1. 名字相近时,比对 options_sample 与 source_value —— 来源值能落进哪个候选的"
        "取值域,哪个就是对的。取值域比名字可靠得多。\n"
        "2. candidates 是按字符重合度召回的,可能全都不对(例如「上市年份季节」与"
        "「适用年龄」只共享一个「年」字,并不对应)。\n"
        "3. 没有语义对应项时返回 null,不要勉强选一个。\n"
        "只输出 JSON: {\"picked_property_id\": <id 或 null>, \"reason\": \"<一句话>\"}"
    )
    try:
        decision = _ask_llm(prompt, context=ctx)
    except (RuntimeError, KeyError, ValueError) as exc:
        return None, (str(exc) or exc.__class__.__name__)

    picked = decision.get("picked_property_id") if isinstance(decision, dict) else None
    if picked is None:
        return None, None
    # LLM 幻觉出候选外的 id 等同于没选中,不去全表兜底
    return next((p for p in candidates if str(p["id"]) == str(picked)), None), None


def _llm_pick_value(src_value: str, options: list):
    """LLM 从 options 里挑语义等价的属性值;没有等价项返回 None。

    返回 (option | None, error | None),error 语义同 _llm_pick_property。
    """
    # 超限的枚举不做截断猜测。原实现按字符重合度排序后砍到 300 —— 那个排序没有
    # 语义(见文件头 token_overlap_score 的删除说明),砍完剩下的 300 个未必包含
    # 正确项,模型再从里面挑就是在一个已经错了的集合里选。实测超限的几乎全是
    # 「型号」这类 SKU 编码枚举(最大 6162 项),本来就不靠语义匹配;完全相等的那条
    # 路径在 _resolve_value 里已经先走过了。到这里还没命中就如实不匹配,落 pending。
    if len(options) > LLM_OPTION_LIMIT:
        return None, None

    pool = options
    ctx = {
        "source_value": src_value,
        "candidates": [{"value_id": o[0], "name": o[1]} for o in pool],
    }
    # "宁可 null" 是硬要求,不是客套:SKILL.md 记着实测把「帆布」选成「毛绒」的
    # 教训：没有等价项就留空并交人工兜底，选错则是**看不见**的错值。
    prompt = (
        "从 candidates 里挑出与 source_value 语义等价的抖店属性值。"
        "同义词、语序不同、表述差异都算等价(如「动漫卡通」与「卡通动漫」);"
        "仅仅是同类或近似但并不等价的(如「帆布」与「毛绒」都是材质,但不是同一种)"
        "一律返回 null。留空会交人工补,选错则是静默错值,代价大得多。"
        "只输出 JSON: {\"picked_value_id\": <id 或 null>, \"reason\": \"<一句话>\"}"
    )
    try:
        decision = _ask_llm(prompt, context=ctx)
    except (RuntimeError, KeyError, ValueError) as exc:
        return None, (str(exc) or exc.__class__.__name__)

    picked = decision.get("picked_value_id") if isinstance(decision, dict) else None
    if picked is None:
        return None, None
    return next((o for o in pool if str(o[0]) == str(picked)), None), None


def _resolve_value(src_value: str, options: list, no_llm: bool):
    """src_value → (option | None, matched_by)。

    matched_by ∈ exact | llm | llm_error | mixed | none,
    进 attributes.doudian.json 供人工审核时区分"匹配出来的"和"模型挑的"。
    """
    exact = [o for o in options if o[1] == src_value]
    if exact:
        return exact[0], "exact"

    if no_llm:
        # 离线 / CI 路径只接受完全相等值，不对相似值做猜测。
        return None, "none"

    # 所有非完全相等值都交给 LLM，从完整真实 options 中选择语义等价项。
    # 不做字符子串预筛，避免把语义等价但字符零重合的值提前过滤掉。
    picked, err = _llm_pick_value(src_value, options)
    if err:
        return None, "llm_error"
    return (picked, "llm") if picked else (None, "none")


def _source_values(src_value: str, prop: dict) -> list[str]:
    """按抖店属性类型拆分来源值；单选属性保留原始字符串。"""
    if prop.get("multi") or prop.get("ui") == "multi_select":
        return [v.strip() for v in re.split(r"[,，]", src_value) if v.strip()]
    return [src_value]


def _resolve_attribute_values(src_value: str, prop: dict, no_llm: bool):
    """Resolve one source property's values and preserve source order.

    抖店属性分两类,处理方式相反:

      **枚举属性**(有 options,占 57.4%)——值必须从 options 里取。取不到就留空
      交人工,**不许**自己造一个 diyType=1 混进去(SKILL.md 的硬规矩:枚举里
      没有等价项还硬塞,等于往商品里写一个看不见的错值)。

      **自由文本属性**(无 options,占 42.6% —— 型号 / 货号 / 尺寸 / 生产企业名称
      这类)——**没有枚举可匹配**,来源值本身就是答案,原样写成 diyType=1。

    这里原本对两类一视同仁:`if not options: return [], [], source_values, []`,
    把自由文本属性的值全部当成「匹配失败」,落 pending 说「不在抖店真实选项中,
    已留空」—— 那句话在没有选项的属性上根本不成立,而真实的来源值就这么丢了。
    实测这件镜片商品的「货号=班格利环焦镜片」「镜片颜色=透明无色」都是这么没的。

    diyType=1 的值没有抖店 value_id,build_addv2.project_product_format_new 已经
    有既定处置(落 pending_di、不进 addv2、提示去后台申请 value_id),这里只负责
    如实产出,不重复那套逻辑。
    """
    options = prop.get("options") or []
    source_values = _source_values(src_value, prop) if src_value else []
    if not options:
        # value_match 的第一位是 value_id;自由文本没有,置 None 交下游按 diy 处理。
        return ([((None, sv), sv) for sv in source_values],
                ["diy"] * len(source_values), [], [])

    value_matches = []
    matched_methods = []
    unmatched_values = []
    unmatched_methods = []
    for source_value in source_values:
        value_match, matched_by = _resolve_value(source_value, options, no_llm)
        if value_match is None:
            unmatched_values.append(source_value)
            unmatched_methods.append(matched_by)
        else:
            value_matches.append((value_match, source_value))
            matched_methods.append(matched_by)
    return value_matches, matched_methods, unmatched_values, unmatched_methods


def _batch_pick_values(items: list[dict]):
    """一次调用解决所有待定属性值。items 每项 {key, prop_name, src_value, options}。

    返回 ({key: option|None}, error|None)。error 非空表示**通道**失败(所有项都没
    结果),与「模型看过了、判定无等价项」严格分开 —— 后者是数据结论,前者是基础
    设施问题,落 finding 时的措辞和排查方向都不同。
    """
    if not items:
        return {}, None

    ctx = {
        "items": [
            {"key": it["key"], "property": it["prop_name"], "source_value": it["src_value"],
             "candidates": [{"value_id": o[0], "name": o[1]} for o in it["options"]]}
            for it in items
        ]
    }
    # 「宁可 null」是硬要求,不是客套:SKILL.md 记着实测把「帆布」选成「毛绒」的
    # 教训 —— 没有等价项就留空并交人工兜底,选错则是**看不见**的错值。
    prompt = (
        "为 items 里的**每一项**,从它自己的 candidates 里挑出与 source_value 语义等价的值。\n"
        "同义词、语序不同、表述差异都算等价(如「动漫卡通」与「卡通动漫」);\n"
        "仅仅是同类或近似但并不等价的(如「帆布」与「毛绒」都是材质,但不是同一种)"
        "一律给 null。留空会交人工补,选错则是静默错值,代价大得多。\n"
        "只能从**该项自己的** candidates 里挑,不要跨项取值。\n"
        '只输出 JSON: {"picks": [{"key": "<原样回填>", "picked_value_id": <id 或 null>}]},'
        "每一项都要有。"
    )
    try:
        decision = _ask_llm(prompt, context=ctx)
    except (RuntimeError, KeyError, ValueError) as exc:
        return {}, (str(exc) or exc.__class__.__name__)

    by_key = {it["key"]: it for it in items}
    out: dict[str, tuple | None] = {it["key"]: None for it in items}
    for pick in (decision or {}).get("picks") or []:
        key = str(pick.get("key") or "")
        item = by_key.get(key)
        if item is None:
            continue
        picked = pick.get("picked_value_id")
        if picked is None:
            continue
        # 幻觉出候选外的 id 等同于没选中,不做全表兜底
        out[key] = next((o for o in item["options"] if str(o[0]) == str(picked)), None)
    return out, None


def _resolve_selected_values(selected: list[dict], no_llm: bool):
    """全部属性值一次调用解决,返回与 selected 同序的四元组列表。

    调用次数:M → 1(M = 需要模型判断的值个数)。完全相等的值在本地直接命中,
    根本不进批;超过 LLM_OPTION_LIMIT 的巨型枚举也不进批(见 _llm_pick_value)。

    和属性名批处理同理,这里去掉 ThreadPoolExecutor 是为了根治 opencode 本地
    SQLite 的 `database is locked` —— 那是并发写造成的,串行就不存在。
    """
    if no_llm:
        return [
            _resolve_attribute_values(item["src_value"], item["prop"], no_llm)
            for item in selected
        ]

    # 一轮:本地定完全相等,剩下的攒批。
    plans: list[list[dict]] = []
    batch: list[dict] = []
    for ai, item in enumerate(selected):
        prop = item["prop"]
        options = prop.get("options") or []
        src_value = item["src_value"]
        source_values = _source_values(src_value, prop) if src_value else []
        steps: list[dict] = []
        for vi, sv in enumerate(source_values):
            if not options:
                steps.append({"kind": "diy", "src": sv})
                continue
            exact = [o for o in options if o[1] == sv]
            if exact:
                steps.append({"kind": "exact", "src": sv, "option": exact[0]})
            elif len(options) > LLM_OPTION_LIMIT:
                steps.append({"kind": "oversize", "src": sv})
            else:
                key = f"{ai}:{vi}"
                steps.append({"kind": "llm", "src": sv, "key": key})
                batch.append({"key": key, "prop_name": prop.get("name") or "",
                              "src_value": sv, "options": options})
        plans.append(steps)

    picks, err = _batch_pick_values(batch)

    # 二轮:按原顺序组装,保持四元组契约不变。
    results = []
    for steps in plans:
        value_matches, matched_methods, unmatched_values, unmatched_methods = [], [], [], []
        for st in steps:
            if st["kind"] == "diy":
                value_matches.append(((None, st["src"]), st["src"]))
                matched_methods.append("diy")
            elif st["kind"] == "exact":
                value_matches.append((st["option"], st["src"]))
                matched_methods.append("exact")
            elif st["kind"] == "oversize":
                unmatched_values.append(st["src"])
                unmatched_methods.append("none")
            elif err:
                unmatched_values.append(st["src"])
                unmatched_methods.append("llm_error")
            else:
                opt = picks.get(st["key"])
                if opt is None:
                    unmatched_values.append(st["src"])
                    unmatched_methods.append("none")
                else:
                    value_matches.append((opt, st["src"]))
                    matched_methods.append("llm")
        results.append((value_matches, matched_methods, unmatched_values, unmatched_methods))
    return results


def _resolve_selected_properties(queries: list[dict]):
    """一次调用完成**全部**属性名映射,返回与 queries 同序的 [(prop|None, error|None)]。

    原实现是每个来源属性一次调用、最多 3 路并发。两个问题:

      1. **并发抢锁**。opencode 把会话状态存在本地 SQLite,多进程同时写就报
         `database is locked`,而失败会被 fail-closed 当成「无语义对应」落进
         pending —— 一条真实可映射的属性就这么白丢(实测中过)。串行批处理直接
         消灭这个竞争,不需要靠重试兜。
      2. **各判各的会撞车**。每次调用只看一个来源属性,两个来源属性可能挑中同一个
         抖店属性,只能事后发现冲突再拿剩余候选重试一轮 —— 又是额外调用。一次给
         全,模型自己就能把它当成分配问题来做。

    调用次数:N → 1。
    """
    if not queries:
        return []

    # 候选池取所有 query 的并集(各 query 的 ranked 只差在已被 exact 占用的那些)。
    pool: dict[str, dict] = {}
    for q in queries:
        for p in q["ranked"]:
            pool.setdefault(str(p.get("id")), p)
    candidates = sorted(pool.values(), key=lambda p: -int(p.get("required") or 0))

    ctx = {
        "source_attributes": [
            {"index": i, "name": q["src_name"], "value": q.get("src_value") or None}
            for i, q in enumerate(queries)
        ],
        "candidates": [
            {"property_id": p["id"], "name": p["name"],
             "required": bool(p.get("required")),
             "options_count": len(p.get("options") or []),
             "options_sample": [o[1] for o in (p.get("options") or [])[:12]]}
            for p in candidates
        ],
    }
    prompt = (
        "为 source_attributes 里的**每一条**,从 candidates 里挑出语义对应的抖店属性。\n"
        "判断依据:\n"
        "1. 名字相近时,比对 options_sample 与该条的 value —— 来源值能落进哪个候选的"
        "取值域,哪个就是对的。取值域比名字可靠得多。\n"
        "2. 一个 candidate 最多被一条来源属性占用,不要把同一个 property_id 分给多条。\n"
        "3. 没有语义对应项就给 null,不要勉强凑(跨平台用词不同,本来就有对不上的)。\n"
        '只输出 JSON: {"mappings": [{"index": <int>, "picked_property_id": <id 或 null>,'
        ' "reason": "<一句话>"}]},每条 source_attributes 都要有一项。'
    )
    try:
        decision = _ask_llm(prompt, context=ctx)
    except (RuntimeError, KeyError, ValueError) as exc:
        err = str(exc) or exc.__class__.__name__
        return [(None, err) for _ in queries]

    by_index: dict[int, str] = {}
    for m in (decision or {}).get("mappings") or []:
        try:
            idx = int(m.get("index"))
        except (TypeError, ValueError):
            continue
        pid = m.get("picked_property_id")
        if pid is not None and 0 <= idx < len(queries):
            by_index[idx] = str(pid)

    # 冲突兜底:模型仍可能把同一个 property 分给两条。按来源顺序先到先得 ——
    # 与旧实现的仲裁口径一致,且是确定性的,不再为此多花一次调用。
    taken: set[str] = set()
    out: list[tuple] = []
    for i, q in enumerate(queries):
        pid = by_index.get(i)
        allowed = {str(p.get("id")) for p in q["ranked"]}
        if pid is None or pid in taken or pid not in allowed:
            out.append((None, None))  # 无对应 / 被占 / 幻觉 id → 都按「不映射」处理
            continue
        taken.add(pid)
        out.append((pool[pid], None))
    return out


def _select_properties(source_attrs: list[dict], props: list[dict], no_llm: bool):
    """Select properties while keeping deterministic source order and uniqueness."""
    selected_by_source: dict[int, dict] = {}
    unresolved_by_source: dict[int, list[dict]] = {}

    def add_unresolved(source_index: int, item: dict):
        unresolved_by_source.setdefault(source_index, []).append(item)

    if no_llm:
        used_property_ids: set[str] = set()
        for source_index, src in enumerate(source_attrs):
            src_name = (src.get("Label") or "").strip()
            if not src_name:
                continue
            available = [p for p in props if str(p.get("id")) not in used_property_ids]
            if not available:
                add_unresolved(source_index, finding(
                    "attribute_name_unmapped",
                    f"来源属性「{src_name}」无可用抖店属性(该类目属性已被前面的来源属性占满),未映射",
                    "/attributes",
                    src_name,
                ))
                continue
            # 离线路径**只接受完全同名**。原实现按字符重合度取榜首,那是在没有语义
            # 信号的情况下硬猜 —— 「上市年份季节」曾因此被采成「适用年龄」(只共享
            # 一个「年」字)。SKILL.md 对 --no-llm 的策略本就是「只接受完全相等值,
            # 相似值和歧义值留空,不做字符串猜测」,这里现在与之一致。
            exact = [p for p in available if (p.get("name") or "") == src_name]
            if not exact:
                add_unresolved(source_index, finding(
                    "attribute_name_unmapped",
                    f"来源属性「{src_name}」在该类目里没有完全同名的属性;"
                    f"离线路径(--no-llm)不做语义匹配,未映射",
                    "/attributes",
                    src_name,
                ))
                continue
            prop = exact[0]
            used_property_ids.add(str(prop.get("id")))
            selected_by_source[source_index] = {
                "source_index": source_index,
                "src_name": src_name,
                "src_value": (src.get("Value") or "").strip(),
                "prop": prop,
            }
        return [selected_by_source[index] for index in sorted(selected_by_source)], unresolved_by_source

    # Exact names are deterministic and reserve every same-named property before
    # LLM queries start, so a later exact match cannot lose to an earlier guess.
    source_names = {
        (src.get("Label") or "").strip()
        for src in source_attrs
        if (src.get("Label") or "").strip()
    }
    exact_property_ids = {
        str(prop.get("id"))
        for prop in props
        if (prop.get("name") or "") in source_names
    }
    reserved: set[str] = set()
    queries: list[dict] = []

    for source_index, src in enumerate(source_attrs):
        src_name = (src.get("Label") or "").strip()
        if not src_name:
            continue
        exact = [
            prop for prop in props
            if (prop.get("name") or "") == src_name
            and str(prop.get("id")) not in reserved
        ]
        if exact:
            prop = exact[0]
            reserved.add(str(prop.get("id")))
            selected_by_source[source_index] = {
                "source_index": source_index,
                "src_name": src_name,
                "src_value": (src.get("Value") or "").strip(),
                "prop": prop,
            }
            continue

        available = [
            prop for prop in props
            if str(prop.get("id")) not in reserved
            and str(prop.get("id")) not in exact_property_ids
        ]
        if not available:
            add_unresolved(source_index, finding(
                "attribute_name_unmapped",
                f"来源属性「{src_name}」无可用抖店属性(该类目属性已被前面的来源属性占满),未映射",
                "/attributes",
                src_name,
            ))
            continue
        # 候选**全量**交给 LLM,顺序只按 required 排(必填在前,便于模型优先考虑)。
        # 这里原本还按字符重合度排序并**过滤掉零重合项** —— 那是个隐藏的准入门槛,
        # 与 SKILL.md「字符重合只用于排序、不当准入门槛」直接矛盾:一个与抖店属性名
        # 一个字都不重合的来源属性(跨平台用词不同太常见了),根本没机会被模型看到。
        ranked = sorted(available, key=lambda p: -int(p.get("required") or 0))
        queries.append({
            "source_index": source_index,
            "src_name": src_name,
            "src_value": (src.get("Value") or "").strip(),
            "ranked": ranked,
        })

    decisions = _resolve_selected_properties(queries)
    for query, (prop, err) in zip(queries, decisions):
        source_index = query["source_index"]
        if prop is not None and str(prop.get("id")) in reserved:
            remaining = [candidate for candidate in query["ranked"]
                         if str(candidate.get("id")) not in reserved]
            prop, retry_error = (_llm_pick_property(query["src_name"], remaining,
                                                    query.get("src_value", ""))
                                 if remaining else (None, None))
            err = retry_error or err
        if prop is None:
            # 两种情况长得像,性质相反,所以给不同的 code:
            #   err 有值 → LLM 通道失败,**没查清楚** → 仍按 attribute_name_unmapped 挡住
            #   err 为空 → LLM 明确判定该类目没有对应属性,**查清楚了确实没有**
            # 后者不是"待补"的事项:没有任何人补得上它 —— 抖店这个叶子类目就是没有
            # 这一项(实测 1688 给 15 个属性,DIY饰品套装只有 4 个)。独立 code 让
            # verdict 能只豁免这一种;共用一个 code 会让「没查」和「查了没有」在结果
            # 里长得一样,而放过前者就是假装检查过。
            add_unresolved(source_index, finding(
                "attribute_name_unmapped" if err else "attribute_name_no_counterpart",
                (f"来源属性「{query['src_name']}」的 LLM 映射通道失败({err}),未映射"
                 if err else
                 f"来源属性「{query['src_name']}」在该类目属性里没有语义对应项(LLM 判定),未映射"),
                "/attributes",
                query["src_name"],
            ))
            continue
        reserved.add(str(prop.get("id")))
        selected_by_source[source_index] = {
            "source_index": source_index,
            "src_name": query["src_name"],
            "src_value": query["src_value"],
            "prop": prop,
        }

    return [selected_by_source[index] for index in sorted(selected_by_source)], unresolved_by_source


def _matched_by(matched: list[str], unmatched: list[str]) -> str:
    """为审计补丁汇总逐值匹配结果。"""
    methods = [m for m in matched if m]
    if not methods:
        return "llm_error" if "llm_error" in unmatched else "none"
    if not unmatched and len(set(methods)) == 1:
        return methods[0]
    return "mixed"


def resolve_attributes(raw, leaf_id, props_by_leaf, no_llm: bool):
    """返回 (overlay_attrs, doudian_values_records, unresolved):
      overlay_attrs: [ {sourceName, doudianPropertyId}, ... ] — 进 canonical overlay
      doudian_values_records: [ {sourceName, doudianPropertyId, doudianValues[]}, ... ]
                             — 落 doudian_values 补丁(PIPE-2 之后合入 canonical)
      unresolved:    [ finding, ... ] — 属性名或属性值未映射的 finding。旧实现在这里
                     直接 `continue`,属性静默消失、无任何记录;现在交调用方合进
                     canonical.qualityReport.pending。
    """
    if leaf_id is None:
        return [], [], []

    leaf_data = props_by_leaf.get(str(leaf_id))
    if not leaf_data:
        return [], [], []

    props = leaf_data.get("props") or []
    source_attrs = ((raw.get("BaseInfo") or {}).get("Attr") or {}).get("SourceAttr") or []

    selected, unresolved_by_source = _select_properties(source_attrs, props, no_llm)

    def add_unresolved(source_index: int, item: dict):
        unresolved_by_source.setdefault(source_index, []).append(item)

    overlay_attrs = []
    doudian_values_records = []
    for item, value_result in zip(selected, _resolve_selected_values(selected, no_llm)):
        src_name = item["src_name"]
        src_value = item["src_value"]
        prop = item["prop"]
        source_values = _source_values(src_value, prop) if src_value else []
        (value_matches, matched_methods,
         unmatched_values, unmatched_methods) = value_result

        # overlay_attrs 同步带 doudianValues(从 value_match 复制):
        # project_product_format_new 要求属性同时有 property_id 和 value_id。
        # 没把 doudianValues 合进 canonical 的旧实现永远产出 None,缺类目必填属性
        # 被抖店拒。attributes.doudian.json 补丁文件仍是独立产物(给用户审核),
        # 这两件事不冲突:一个进 addv2,一个给人工看。
        attr_entry: dict = {
            "sourceName": src_name,
            # 类目属性数据里 id 是字符串("1687"),canonical.schema 声明的是 integer。
            # 同一个 dict 里 valueId 已经 int() 过,property_id 却透传字符串 —— 于是
            # 这份 canonical 过不了自己的契约,而没人跑校验所以一直没暴露。
            "doudianPropertyId": int(prop["id"]),
            "doudianValues": [
                {
                    # valueId=None ⇒ 自由文本属性的自定义值(见 _resolve_attribute_values)。
                    # 下游 project_product_format_new 据此落 pending_di、不进 addv2。
                    "valueId": None if value_match[0] is None else int(value_match[0]),
                    "name": value_match[1],
                    "diyType": 1 if value_match[0] is None else 0,
                    "sourceValue": source_value,
                }
                for value_match, source_value in value_matches
            ],
        }
        overlay_attrs.append(attr_entry)

        if src_value:
            # matchedBy 只落在这份人工审核补丁里,不进 canonical。
            doudian_values_records.append({
                "sourceName": src_name,
                # 类目属性数据里 id 是字符串("1687"),canonical.schema 声明的是 integer。
            # 同一个 dict 里 valueId 已经 int() 过,property_id 却透传字符串 —— 于是
            # 这份 canonical 过不了自己的契约,而没人跑校验所以一直没暴露。
            "doudianPropertyId": int(prop["id"]),
                "matchedBy": _matched_by(matched_methods, unmatched_methods),
                "doudianValues": attr_entry["doudianValues"],
            })
            # 「模型看过了、判定无等价项」与「通道根本没跑成」两件事产物长得一样
            # (都是 doudianValues 空),但排查方向相反 —— 前者去补 overlay,后者去查
            # LLM 通道。matchedBy 一直分得清,给人看的这句话却一律说成前者。
            # 实测撞上:羽毛球拍 4 个属性全是 llm_error(「产地」225 个候选把本地模型
            # 顶崩了),pending 里却写着「不在抖店真实选项中」—— 模型压根没看过,
            # 而「广东省汕头市」对应的「中国大陆」就在候选里。
            for unmatched_value, unmatched_method in zip(unmatched_values, unmatched_methods):
                if unmatched_method == "llm_error":
                    add_unresolved(item["source_index"], finding(
                        "attribute_value_channel_failed",
                        f"来源属性「{src_name}」的值「{unmatched_value}」未能判定:"
                        f"LLM 通道调用失败,**不代表抖店没有等价选项**。"
                        f"该属性有 {len(prop.get('options') or [])} 个候选,先查通道再下结论",
                        "/attributes",
                        unmatched_value,
                    ))
                else:
                    add_unresolved(item["source_index"], finding(
                        "attribute_value_unmapped",
                        f"来源属性「{src_name}」的值「{unmatched_value}」不在抖店真实选项中,已留空",
                        "/attributes",
                        unmatched_value,
                    ))

    unresolved = [
        item
        for source_index in sorted(unresolved_by_source)
        for item in unresolved_by_source[source_index]
    ]
    return overlay_attrs, doudian_values_records, unresolved


# --------------------------------------------------------------------------
# 必填属性自动填写
# --------------------------------------------------------------------------

def _product_context(raw: dict, leaf_data: dict) -> dict:
    """喂给 LLM 的商品事实。全部取自采集数据本身,不含任何推断。

    没映射上的 source 属性照样收进来 —— 「风格=清新甜美」映射不到抖店属性,
    不代表它对推断别的属性没用。
    """
    base = raw.get("BaseInfo") or {}
    source_attrs = ((base.get("Attr") or {}).get("SourceAttr") or [])
    sku_props = ((raw.get("PriceAndStock") or {}).get("SkuProperties") or [])
    return {
        "category": leaf_data.get("name") or "",
        "title": (base.get("Title") or "").strip(),
        "source_attributes": [
            {"name": (a.get("Label") or "").strip(), "value": (a.get("Value") or "").strip()}
            for a in source_attrs if (a.get("Label") or "").strip()
        ],
        "sku_dimensions": [
            {"name": sp.get("PropertyName") or "",
             "values": [v.get("ValueName") for v in (sp.get("Values") or []) if v.get("ValueName")]}
            for sp in sku_props if sp.get("PropertyName")
        ],
    }


def _llm_default_required(prop: dict, context: dict):
    """严格推断放弃之后的兜底:从枚举里选一个与【已确定信息】最自洽的值。
    → (option | None, evidence | None, why | None)

    与 _llm_infer_required 的分工是两个不同的问题：
      前者问「商品信息里有没有明确依据」——没有就放弃；
      本函数问「这个属性填错了要不要紧」——要紧的仍然放弃。

    判断交给模型，代码里**不写死任何属性名单**。类目属性表 4275 个叶子、上万条属性，
    白名单既写不全也会过期；而「填错了会不会让买家觉得货不对板」本来就是语义判断，
    不是可枚举的集合。模型答不上来时仍然返回 None，与严格那一步的失败路径合流。

    产出必须与严格推断【区分记账】：调用方落 required_attribute_defaulted 而不是
    required_attribute_inferred，补丁里 matchedBy="llm_default"。同样是模型给的值，
    但一个有商品依据、一个只有自洽性，人工复核时要能一眼分开。
    """
    options = prop.get("options") or []
    if len(options) > LLM_OPTION_LIMIT:
        return None, None, None

    ctx = {**context,
           "target_property": prop.get("name"),
           "candidates": [{"value_id": o[0], "name": o[1]} for o in options]}
    prompt = (
        "抖店这个类目要求必填属性 target_property，来源商品数据里没有对应项，"
        "上一轮「按明确依据推断」也已经放弃。现在只问两件事。\n"
        "第一，这个属性填错了要不要紧？会让买家觉得【货不对板】的、或者能被量化成商品"
        "价值的（材质成分、净含量、规格尺寸、功效、安全与适用人群等），一律返回 null —— "
        "这类属性宁可空着被拦下，也不能靠自洽性凑。反过来，只影响平台筛选与归类、"
        "填得不完美买家也不会觉得拿到的东西不是他买的那个（风格、图案分类、上市季节这类），"
        "才可以继续。\n"
        "第二，如果确实不要紧，就从 candidates 里选一个与【已确定的信息】最自洽的值："
        "标题、来源属性、规格维度都算。多个候选同样自洽时选覆盖面最广、最不排他的那个；"
        "仍然分不清就返回 null。\n"
        "不要为了凑满必填项而放宽第一问的判断：填错的属性比空着更难在审核时被发现。\n"
        "只输出 JSON: {\"low_stakes\": <true/false>, \"why\": \"<为什么要紧/不要紧>\", "
        "\"picked_value_id\": <id 或 null>, \"evidence\": \"<自洽性依据>\"}"
    )
    try:
        decision = _ask_llm(prompt, context=ctx)
    except (RuntimeError, KeyError, ValueError):
        return None, None, None
    if not isinstance(decision, dict) or not decision.get("low_stakes"):
        return None, None, (decision or {}).get("why") if isinstance(decision, dict) else None

    picked = decision.get("picked_value_id")
    if picked is None:
        return None, None, decision.get("why")
    hit = next((o for o in options if str(o[0]) == str(picked)), None)
    if hit is None:
        return None, None, decision.get("why")
    return hit, decision.get("evidence"), decision.get("why")


def _llm_infer_required(prop: dict, context: dict):
    """从商品信息推断一个必填属性的值。→ (option | None, evidence | None)。"""
    options = prop.get("options") or []
    # 同 _llm_pick_value:超限枚举不截断猜测。这里是**推断**必填值,比匹配更容易
    # 编造,在一个可能已经不含正确项的池子里挑就更不该做。
    if len(options) > LLM_OPTION_LIMIT:
        return None, None

    pool = options
    ctx = {**context,
           "target_property": prop.get("name"),
           "candidates": [{"value_id": o[0], "name": o[1]} for o in pool]}
    prompt = (
        "抖店这个类目要求必填属性 target_property,但来源商品数据里没有对应项。"
        "请只依据上面给出的商品信息(标题 / 已有属性 / 规格维度),从 candidates 里选一个值。"
        "商品信息里有明确依据才选;依据不足、或只能靠类目常识猜测的,返回 null。"
        "注意 candidates 是平台的标准化说法,而标题是商家的口语写法,同一件事在两边"
        "常常字面不同 —— 你判断它们指的是不是同一件事,只要是,就算明确依据,"
        "不要因为字面对不上就返回 null。但若有两个及以上候选都说得通,仍然返回 null:"
        "分不清是哪一个时,空着交人工优于挑一个。"
        "不要为了凑满必填项而挑一个看起来合理的 —— 填错的属性比空着更难在审核时被发现,"
        "空着还会被后续流程标出来交人工,填错则直接混进商品里。"
        "evidence 必须引用商品信息里的具体片段,不能是泛泛而谈。"
        "只输出 JSON: {\"picked_value_id\": <id 或 null>, \"evidence\": \"<依据片段>\"}"
    )
    try:
        decision = _ask_llm(prompt, context=ctx)
    except (RuntimeError, KeyError, ValueError):
        return None, None

    picked = decision.get("picked_value_id") if isinstance(decision, dict) else None
    if picked is None:
        return None, None
    match = next((o for o in pool if str(o[0]) == str(picked)), None)
    if match is None:
        return None, None
    return match, (decision.get("evidence") or "").strip()


def fill_required_attributes(raw, leaf_data, covered_ids: set, no_llm: bool):
    """给来源侧没有对应项的类目必填属性推断值。

    返回 (extra_overlay, extra_records, notes):
      extra_overlay: 追加进 canonical.attributes 的完整属性项(apply_attribute_overlay
                     对来源侧不存在的 sourceName 走追加,见其 docstring)
      extra_records: attributes.doudian.json 补丁,matchedBy="llm_inferred"
      notes:         finding 列表,进 qualityReport.warnings —— 推断出来的值必须
                     在总账里可见,否则人工只看 canonical 无法区分"采到的"和"推断的"

    **只填有 options 的必填属性**。这不是偷懒,是这个功能能不能存在的前提:
    projection/project.py 的 missing_required_attributes 立过规矩 ——「只做匹配不做
    生成,一个属性编得越像真的越难在审核时被发现」。从固定枚举里选,模型输出被结构
    约束死,编不出枚举外的东西;而无 options 的必填属性实测 top 榜是「生产企业名称」
    「统一社会信用代码」「CCC证书编号」「备案/批准文号」这类**只能由商家提供**的字段
    (占必填条目 28.8%),让模型写这些就是在造假证。
    """
    if no_llm:
        return [], [], []

    gaps = [p for p in (leaf_data.get("props") or [])
            if p.get("required") and not p.get("hidden")
            and str(p.get("id")) not in covered_ids
            and (p.get("options") or [])]
    if not gaps:
        return [], [], []

    context = _product_context(raw, leaf_data)
    extra_overlay, extra_records, notes = [], [], []

    for prop in gaps:
        match, evidence = _llm_infer_required(prop, context)
        defaulted = False
        if match is None:
            # 严格推断放弃之后再问一次「这个属性填错了要不要紧」。要紧的仍然放弃,
            # 两步的失败路径在这里合流。分两步而不是把两个问题塞进一个提示词:
            # 「有没有依据」和「要不要紧」是不同的判断，混在一起时模型会拿"不要紧"
            # 去补"没依据"，正是这个功能最该防的事。
            match, evidence, _why = _llm_default_required(prop, context)
            defaulted = match is not None
        if match is None:
            # 推断不出来不落 finding:projection 层的 missing_required_attributes
            # 已经在报这一条了,这里再落一遍就是双份账。
            continue

        name = prop.get("name") or ""
        extra_overlay.append({
            "sourceName": name,
            # rawValue / values 是 canonical.schema 对 attributes 项的 required 字段,
            # 且 projection 的 _attribute_index 正是读它们判"填没填" —— 缺了的话
            # 属性追加进去了,必填检测却仍报缺失。
            "rawValue": match[1],
            "values": [match[1]],
            # 类目属性数据里 id 是字符串("1687"),canonical.schema 声明的是 integer。
            # 同一个 dict 里 valueId 已经 int() 过,property_id 却透传字符串 —— 于是
            # 这份 canonical 过不了自己的契约,而没人跑校验所以一直没暴露。
            "doudianPropertyId": int(prop["id"]),
            "doudianValues": [{
                "valueId": int(match[0]), "name": match[1],
                "diyType": 0, "sourceValue": match[1],
            }],
        })
        extra_records.append({
            "sourceName": name,
            # 类目属性数据里 id 是字符串("1687"),canonical.schema 声明的是 integer。
            # 同一个 dict 里 valueId 已经 int() 过,property_id 却透传字符串 —— 于是
            # 这份 canonical 过不了自己的契约,而没人跑校验所以一直没暴露。
            "doudianPropertyId": int(prop["id"]),
            "matchedBy": "llm_default" if defaulted else "llm_inferred",
            "evidence": evidence,
            "doudianValues": [{
                "valueId": int(match[0]), "name": match[1],
                "diyType": 0, "sourceValue": match[1],
            }],
        })
        # 两种来源分开记账：一个有商品依据，一个只有自洽性。同样是模型给的值，
        # 人工复核时要能一眼分开先看哪一条。
        notes.append(finding(
            "required_attribute_defaulted" if defaulted else "required_attribute_inferred",
            (f"必填属性「{name}」来源数据里没有、也没有明确依据，按【与已确定信息自洽】"
             f"兜底选了「{match[1]}」（模型判定该属性填错不致货不对板）,请人工确认"
             if defaulted else
             f"必填属性「{name}」来源数据里没有,按商品信息推断为「{match[1]}」,请人工确认"),
            "/attributes",
            evidence or f"property_id={prop['id']}",
        ))

    return extra_overlay, extra_records, notes


# --------------------------------------------------------------------------
# 核心 API(纯函数,不写文件)
# --------------------------------------------------------------------------

def prune_orphan_spec_values(canonical: dict) -> list[str]:
    """剔除无效 SKU 后，把没有任何 SKU 引用的规格值一并删掉。

    质量红线会剔掉无库存 / 无价格的 SKU，但规格维度是独立结构——不同步清理就留下
    「有值、没 SKU」的孤儿。下游规则 5（SKU 数 == 规格组合数）拿孤儿算笛卡尔积，
    必然对不上，整个商品被阻断（实测工控机：剔 14 个 SKU 后 6×15=90 vs 75）。
    孤儿值本身也确实发不出去——抖店按规格组合生成 SKU 行，那些行没有价格库存可填。

    返回被剔除的「维度=值」清单，供上层记进 qualityReport。
    """
    used: dict[str, set] = {}
    for sku in canonical.get("skus") or []:
        for sp in sku.get("specs") or []:
            used.setdefault(sp.get("name"), set()).add(sp.get("value"))
    pruned: list[str] = []
    for spec in canonical.get("specs") or []:
        keep = used.get(spec.get("name"), set())
        before = spec.get("values") or []
        spec["values"] = [v for v in before if v.get("value") in keep]
        pruned += [
            f"{spec.get('name')}={v.get('value')}"
            for v in before if v.get("value") not in keep
        ]
    return pruned


def apply_ai_text_policy(canonical, config, ask_fn=None):
    """Apply enabled outward-text cleanup while retaining source fields."""
    text_config = (config or {}).get("text") or {}
    cleanup = bool(text_config.get("removeSensitiveByAi") or text_config.get("removeBrandByAi"))
    short_title = bool(text_config.get("enableAiShortTitle"))
    if not cleanup and not short_title:
        return
    ask_fn = ask_fn or _ask_llm
    requested = (["title", "specs"] if cleanup else []) + (["shortTitle"] if short_title else [])
    context = {
        "title": (canonical.get("title") or {}).get("text", ""),
        "specs": canonical.get("specs") or [],
        "remove_sensitive": bool(text_config.get("removeSensitiveByAi")),
        "remove_brand": bool(text_config.get("removeBrandByAi")),
        "requested_fields": requested,
    }
    prompt = (
        "按配置清洗商品对外文案。只处理标题、规格名/规格值和短标题，"
        "不要修改品牌字段、来源字段或未请求字段。保留商品事实，不要臆造规格。"
        "只返回 JSON object，键必须是 requested_fields 中的键。"
    )
    try:
        response = ask_fn(prompt, context=context)
        if not isinstance(response, dict) or any(key not in response for key in requested):
            raise ValueError("AI 返回格式无效或缺少请求字段")
        if cleanup:
            if not isinstance(response["title"], str) or not response["title"].strip():
                raise ValueError("AI 返回的 title 不是非空字符串")
            returned_specs = response["specs"]
            original_specs = canonical.get("specs") or []
            if not isinstance(returned_specs, list) or len(returned_specs) != len(original_specs):
                raise ValueError("AI 返回的 specs 结构与原商品不一致")
            for spec in returned_specs:
                if not isinstance(spec, dict) or not isinstance(spec.get("name"), str) or not isinstance(spec.get("values"), list):
                    raise ValueError("AI 返回的 specs 项格式无效")
                if any(not isinstance(value, str) for value in spec["values"]):
                    raise ValueError("AI 返回的规格值必须是字符串")
            canonical["title"]["text"] = response["title"].strip()
            for target, source in zip(original_specs, returned_specs):
                if len(target.get("values") or []) != len(source["values"]):
                    raise ValueError("AI 返回的规格值数量与原商品不一致")
                target["name"] = source["name"].strip()
                for value, new_value in zip(target["values"], source["values"]):
                    value["value"] = new_value.strip()
            for sku in canonical.get("skus") or []:
                for sku_spec in sku.get("specs") or []:
                    for original, rewritten in zip(original_specs, returned_specs):
                        if sku_spec.get("name") != original.get("name"):
                            continue
                        for old_value, new_value in zip(original.get("values") or [], rewritten.get("values") or []):
                            if sku_spec.get("value") == old_value.get("value"):
                                sku_spec["name"] = rewritten["name"].strip()
                                sku_spec["value"] = new_value.strip()
                                break
                        break
            title_len = doudian_char_len(canonical["title"]["text"])
            if title_len < 8 or title_len > 60:
                raise ValueError("AI 返回的 title 不满足抖店 8-60 字符约束")
        if short_title:
            value = response["shortTitle"]
            if not isinstance(value, str) or not 0 < len(value.strip()) <= 20:
                raise ValueError("AI 返回的 shortTitle 必须是 1-20 个字符")
            canonical["title"]["shortName"] = value.strip()
    except Exception as exc:
        raise ValueError(f"AI 文案策略失败: {exc}") from exc


@_with_llm_budget
def build_doudian_product(
    raw: dict,
    *,
    tree_path: str | Path = DEFAULT_TREE,
    props_path: str | Path = DEFAULT_PROPS,
    profile: dict | None = None,
    no_llm: bool = False,
    schema: dict | None = None,
    leaves: dict | None = None,
    props_by_leaf: dict | None = None,
    console_url: str | None = None,
    no_project: bool = False,
    download_images: bool = True,
    category_leaf_id: int | None = None,
    crop_main_images: bool = True,
    config: dict | None = None,
    _phase_timings: PhaseTimings | None = None,
) -> dict:
    """raw 商品 → canonical 与发布条件，不保存商品中间文件。

    入参:
      raw:               1688 raw.json 解析后的 dict
      tree_path:         类目树 JSON 路径(若 leaves 已传则忽略)
      props_path:        属性表 JSON 路径(若 props_by_leaf 已传则忽略)
      profile:           shop-profile dict(为 None 则不加价、不填店铺必填项)
      no_llm:            True 跳过 LLM，不猜类目；只保留可确定的本地转换
      schema:            已解析的 canonical schema(若 None 自动从 console 拉)
      leaves:            预构建的类目名索引(测试可注入,跳过 tree_path)
      props_by_leaf:     预构建的属性表索引(测试可注入,跳过 props_path)
      console_url:       console base URL(默认 CONSOLE_URL 环境变量)
      no_project:        True 跳过 projection；图片仍会作为内存资产上传。
      llm_budget_seconds: 可选的显式总时限；默认按实际工作分配，BCP_LLM_BUDGET 可设置总时限。
       download_images:   True 时把图片下载、裁剪、检测和上传全部留在内存；False 时
                           跳过图片资产链路。
        crop_main_images:   True 时为每张主图生成中心 1:1 内存裁剪副本。

    返回 dict:
      {
        "canonical":          dict,
        "publication":        dict,
        "removed_sku_count":  int,          # SKILL.md 质量红线剔除的 SKU 数
        "projection_verdict": dict | None,  # {"status": ready|needs_human|blocked, ...}
        "projection_error":   str | None,   # DetectorUnavailable 时的简短原因
        "phase_timings":      dict,          # 外层耗时和已观测阶段，不含未执行阶段
      }

    抛出:
      FileNotFoundError: tree_path / props_path 不存在
      RuntimeError:      schema 获取、图片处理或上传失败
    """
    # profile=None 是【签名与文档都承诺过】的合法入参(见上面 profile 那一行),
    # 且不是理论情况:CLI 不传 --shop-profile、preprocess_wrapper.default_profile()
    # 在文件不存在时都会送进来一个 None,而缺 profile 有既定产物 —— build_canonical
    # 的 shop_profile_missing(pending) / shop_profile_incomplete(error)。
    #
    # 归一化【只做一次、就在入口】,而不是在每个使用点写 (profile or {})：后者是把
    # 同一个假设散到 N 处,加第 N+1 处时必漏 —— 这次就是这么漏的(品牌那段是后加的,
    # 直接写了 profile.get("brand"),于是不带 --shop-profile 跑必崩 AttributeError,
    # 而崩的位置离「你没给 profile」这个真因隔着一整个函数)。
    timings = _phase_timings or PhaseTimings()
    timings.start_stage('data_preparation')
    profile = profile or {}
    normalized_config = (
        copy.deepcopy(config)
        if config is not None and "compiledReplaceRules" in ((config.get("text") or {}))
        else normalize_config(config, profile) if config is not None else None
    )
    if normalized_config is not None:
        profile = normalized_config.get("shopProfile") or profile
        profile = {**profile, "pricing": {
            **(profile.get("pricing") or {}),
            **(normalized_config.get("pricing") or {}),
        }}
    # [2/4] 类目索引(可选注入,跳过文件)
    if leaves is None or props_by_leaf is None:
        leaves, props_by_leaf, tree_roots = load_category_indexes(Path(tree_path), Path(props_path))
    else:
        # 同样走适配层：注入了 leaves/props 但仍要读树时，这条路径也得认 .json.gz，
        # 否则「只有 .gz」的克隆里它会 FileNotFoundError —— 而上面那条分支已经认了，
        # 一个函数里两条读法不一致正是最难查的那种 bug。
        tree_roots = None
        if tree_path:
            candidate = Path(tree_path)
            if candidate.exists() or candidate.with_suffix(candidate.suffix + ".gz").exists():
                tree_roots = (load_capture_json(candidate) or {}).get("tree")

    # [1/4] schema / limits(可选注入,跳过 console)
    if schema is None:
        schema = fetch_schema(base_url=console_url) if console_url else fetch_schema()
    limits = {**load_constraints(schema), **load_rule_limits(schema)}

    # [3/4] mapping
    timings.start_stage('category_attribute_mapping')
    leaf_paths = {lid: (n.get("path") or n.get("name"))
                  for lid, n in (props_by_leaf or {}).items()}
    leaf_names = {lid: n.get("name") for lid, n in (props_by_leaf or {}).items()}
    if category_leaf_id is not None:
        # 【外部指定类目】优先于 LLM 猜测。用途:抖店自己会判类目 —— 保存草稿时它会
        # 直接告诉你「商品类目填写有误,建议修改为 X」,那是平台的权威判定,比我们猜准。
        # 实测 p27 换药弯盘盒:我们猜「个人护理/洗护美用具/棉签/棉棒/棉包」,抖店说
        # 应该是「餐饮厨具/一次性餐桌用品/一次性碗/碟/盘」。
        #
        # 放在 resolve_attributes 【之前】是关键:属性匹配是按 leaf_id 去类目属性表里
        # 取候选的,换了类目属性就得整套重匹配。放这里天然做到,不需要新机制。
        cat = {"doudianLeafId": int(category_leaf_id),
               "_reason": "外部指定（抖店判定优先于本地猜测）"}
        print(f"  类目由外部指定: {leaf_paths.get(str(category_leaf_id)) or category_leaf_id}",
              file=sys.stderr)
    else:
        cat = resolve_category(raw, leaves, no_llm=no_llm, leaf_paths=leaf_paths,
                               tree_roots=tree_roots, leaf_names=leaf_names)
    leaf_id = cat["doudianLeafId"] if cat else None
    overlay_attrs, _value_records, unresolved_attrs = resolve_attributes(
        raw, leaf_id, props_by_leaf, no_llm=no_llm)

    # 来源侧没有对应项的类目必填属性 → 按商品信息推断(只填有 options 的)
    inferred_notes: list[dict] = []
    # 阻断级 finding：canonical 此刻还没构造，先攒着，建好后落进 qualityReport.errors。
    blocking_errors: list[dict] = []
    qualification_checked = False
    # 风险级 finding：同样先攒着，落进 qualityReport.risks。
    # 与 blocking_errors 的分界是「这条能不能替平台判死」——判不死的只报风险，
    # 让发布流程在运行时给最终答案（见标品门的注释）。
    risk_notes: list[dict] = []
    if leaf_id is not None and (leaf_data := props_by_leaf.get(str(leaf_id))):
        covered = {str(a["doudianPropertyId"]) for a in overlay_attrs
                   if a.get("doudianPropertyId") is not None}
        # 品牌由 shop-profile 决定(brand.defaultDoudianBrandId),不经 overlay_attrs,
        # 所以不会出现在 covered 里。不显式排掉的话它会落进补空池 —— 而品牌槽位是有
        # options 的,模型会从一串**真实他人品牌**里挑一个填上(实测该类目的候选含
        # 「梅赛德斯-奔驰」「任天堂」)。那是编品牌,触 SKILL.md「必填属性一个都不编」红线。
        if (profile.get("brand") or {}).get("defaultDoudianBrandId"):
            covered |= {str(p["id"]) for p in (leaf_data.get("props") or [])
                        if (p.get("name") or "") == BRAND_PROP_NAME}
        extra_overlay, _extra_records, inferred_notes = fill_required_attributes(
            raw, leaf_data, covered, no_llm=no_llm)
        overlay_attrs = overlay_attrs + extra_overlay

        # 品牌:一处决定,两个列表同步。
        #
        # canonical 把品牌建模成【独立顶层字段】brand.doudianBrandId —— 这对抖店 API
        # 是对的(standard_brand_id 不是普通属性),但发布【表单】上品牌就是一个必填
        # 属性控件,消费方只读 attributes。这道缝要在这里接上,不能留给下游打补丁。
        #
        # 两种缺口都要堵,它们的表现完全不同:
        #   a) attributes 里根本没有品牌项(源页没「品牌」这行) → 补一项
        #   b) 有品牌项但 doudianValues 是空的(真品牌在抖店品牌库查不到) → 退化
        # (b) 比 (a) 更阴:属性在、值不在,发布照样报「该项为必填」,却更难发现。
        #
        # 退化不是「编品牌」:标成无品牌是**放弃**品牌主张,不是伪造一个;从候选里
        # 挑一个真实他人品牌才是 SKILL.md 的红线。但真品牌货标无品牌在授权层面有
        # 后果,所以 finding 必须写明放弃了哪个名字。
        brand_prop = next((p for p in (leaf_data.get("props") or [])
                           if (p.get("name") or "") == BRAND_PROP_NAME), None)
        if brand_prop:
            bid = int(brand_prop["id"])
            src_brand = ""
            for attr in _source_attributes(raw):
                if attr.get("name") in ("品牌", "brand", "Brand"):
                    src_brand = (attr.get("value") or "").strip()
                    break
            # 「无」是 1688 自己的无品牌占位符,判断与 build_brand 保持一致。
            no_brand = (not src_brand or src_brand in ("无", "无品牌", "其他", "其它")
                        or bool((profile.get("brand") or {}).get("assumeNoBrand")))
            # 「无品牌」在多数类目里是**官方候选值**而不是自由文本：本类目
            # (DIY饰品套装 1000001874) 的品牌槽位有 11 个 options，其中就有
            # ['596120136', '无品牌'] —— 正是 shop-profile 的 defaultDoudianBrandId。
            #
            # 下面三处此前一律写死 valueId=None / diyType=1。后果不是"少个 id"：
            # build_addv2.project_product_format_new 要求 property_id 与 value_id
            # 两者俱全，valueId 为空的值被踢进 pending_di，于是 product_format_new
            # 整个投影不出 → projectionVerdict=needs_human → Flow 的 ready 分支不
            # 放行，商品发不出去（实测 FlowRun 13a7c88a…，15 条属性只有品牌映射上
            # 了，而它的 valueId 是空的）。
            #
            # 取值沿用 _resolve_value 的约定：options 是 [id, name] 二元组，按 name
            # 精确匹配。查不到才退回自由文本形态 —— 有些类目的品牌槽位确实是
            # ui:search / optionCount=0，那时 diyType=1 是唯一能填的形状。
            #
            # 这不放宽「必填属性一个都不编」的红线：编品牌指的是从候选里挑一个**他人
            # 品牌**；「无品牌」是放弃品牌主张，用它的官方 id 恰恰是正确填法。
            no_brand_option = next((o for o in (brand_prop.get("options") or [])
                                    if len(o) > 1 and o[1] == "无品牌"), None)
            no_brand_value = {
                "name": "无品牌",
                "valueId": int(no_brand_option[0]) if no_brand_option else None,
                "diyType": 0 if no_brand_option else 1,
            }
            entry = next((a for a in overlay_attrs
                          if a.get("doudianPropertyId") == bid), None)
            degraded = False
            if entry is None:
                overlay_attrs = overlay_attrs + [{
                    "sourceName": BRAND_PROP_NAME,
                    "rawValue": "无品牌",
                    "values": ["无品牌"],
                    "doudianPropertyId": bid,
                    # 同一条不变量:补出来的品牌项也只能是「无品牌」。原来这里写
                    # `"无品牌" if no_brand else src_brand`,源站有真品牌时会把它当
                    # diyType=1 自定义值填进去 —— 那是未授权声明他人品牌。
                    "doudianValues": [{**no_brand_value,
                                       "sourceValue": src_brand or "无品牌"}],
                }]
            elif not entry.get("doudianValues") or not any(
                    v.get("valueId") is not None for v in entry["doudianValues"]):
                # 两种都要退化:
                #   值是空的 —— 真品牌在抖店品牌库里查不到
                #   值全是 diyType=1(valueId 为空)—— 没匹配上官方品牌,却把【源站品牌名】
                #     当自由文本留着了。实测撞上:换药弯盘盒改用抖店类目
                #     「一次性碗/碟/盘」后,该类目品牌字段是 ui=select 但 optionCount=0,
                #     于是品牌被当成自由文本属性,doudianValues 装着「妙其灵」而不为空,
                #     原来那条 `not doudianValues` 判据整个失效 —— 发布页上试图把源站
                #     品牌填进品牌下拉(saw:[] 里一个选项都没有)。
                # 不变量:品牌只能是【抖店品牌库匹配到的官方品牌】或【无品牌】。
                # 一个 valueId 为空、名字又不是「无品牌」的值,等于未授权声明他人品牌。
                entry["doudianValues"] = [{**no_brand_value,
                                           "sourceValue": src_brand or "无品牌"}]
                degraded = bool(src_brand) and not no_brand
            if degraded:
                inferred_notes.append(finding(
                    "brand_degraded_to_no_brand",
                    f"来源品牌「{src_brand}」在抖店品牌库里没有匹配项，已按运营决定退化为"
                    f"「无品牌」——真品牌货标无品牌在授权层面有后果，需人工确认",
                    "/attributes", src_brand))
            elif entry is None:
                inferred_notes.append(finding(
                    "brand_projected_as_attribute",
                    f"品牌「{'无品牌' if no_brand else src_brand}」已同时投影为类目属性"
                    f"（发布表单把品牌当必填属性控件，而 canonical.brand 是独立字段）",
                    "/attributes"))

        # 必填属性的覆盖率账。存在的理由:品牌是这个类目的必填项,却因为
        # `ui:search`(没有静态 options)被 fill_required_attributes 明确排除 ——
        # 它本该由 build_brand 供给,但 brand 是 canonical 的【独立顶层字段】,
        # 而发布链路只消费 attributes。两个模型之间的缝没人接,产出的 canonical
        # 一路绿灯却注定发不出去,发布时只报「该项为必填，请输入」。
        # 这里不替谁填值(编必填属性是红线),只把「谁没有来源」如实记进总账。
        covered_after = covered | {str(a["doudianPropertyId"]) for a in extra_overlay
                                   if a.get("doudianPropertyId") is not None}
        uncovered = [p for p in (leaf_data.get("props") or [])
                     if p.get("required") and not p.get("hidden")
                     and str(p.get("id")) not in covered_after]
        # 【品牌门】必填的品牌属性却一个候选都没有 = 本店在该类目发不了,重试无用。
        # 抖店的原话(2026-09-03 从发布页下拉里直接读到):
        #   「暂无可选品牌 / 当前类目不支持发布无品牌商品,请申请品牌资质,
        #     或在已有品牌下新增所属类目」
        # 这不是加载慢也不是控件形态问题 —— 那个下拉带着 select-dropdown-empty 类名,
        # 输入、等网络静默都试过,候选恒为零。
        #
        # 判据来自本店会话抓下来的类目属性表,所以 optionCount 反映的就是【本店视角】:
        # 4236 个有数据的叶子里,223 个品牌必填且零候选、4011 个候选含「无品牌」——
        # 界限干净,且「必填零候选」这个形态只在品牌上出现过,不是噪声。
        #
        # 落 error 而不是 warning:verdict 据此判 blocked,商品不会白跑一轮 3 分钟的发布。
        brand_gate = next(
            (p for p in (leaf_data.get("props") or [])
             if (p.get("name") or "") == BRAND_PROP_NAME
             and p.get("required") and not p.get("hidden")
             and not (p.get("options") or [])),
            None)
        if brand_gate is not None:
            blocking_errors.append(finding(
                "brand_gated_category",
                f"本店在类目「{leaf_data.get('path') or leaf_id}」无法发布："
                f"品牌为必填但一个候选都没有 —— 抖店明示「当前类目不支持发布无品牌商品，"
                f"请申请品牌资质，或在已有品牌下新增所属类目」。重试无用，"
                f"需要补品牌资质或换类目。",
                "/category",
            ))

        # 【标品门】发布第一页在标品类目会多出「选择标品 / 当前类目为标准化商品，
        # 需填写标品信息」，品牌与产品名称都是必填。
        #
        # 这里【只报事实，不阻断】—— 2026-09-04 两次修正，方向相反，都记下来免得再绕：
        #
        #   第一次判 blocked，理由是「品牌+产品名称都是 ecom-g-select，只能关联平台
        #   标品库，填不了」。过严：同一轮跑批里电吹风（同为标品）草稿正常存下来了。
        #
        #   第二次仍写着「本流水线填不了」，只是降成了 risk。这句话本身是错的 ——
        #   当天在消毒湿巾类目实测走通了一条不借任何人东西的路：
        #     品牌   → 选「无品牌」（抖店自己给的正式选项，页面原话「可选无品牌」，
        #              对 1688 白牌货就是正确答案）
        #     产品名称 → auto-complete，接受自由文本，填叶子类目名即可
        #   下一步通过、进入第二页。发布 book 第 14 步「标品门」已经把这条路固化。
        #
        # 所以现在的分工是：本函数只负责让人知道「这个商品会走到标品分支」，
        # 到底填不填得上由 book 在运行时回答 —— 它看得见 DOM，这里看不见。
        # 判据用 support_spu_product：同父的消毒湿巾 True / 私护湿巾 False，
        # 实测页面行为与之一致（前者渲染标品区块、后者没有）。
        if is_spu_category(leaf_data):
            risk_notes.append(finding(
                "spu_category_needs_platform_spu",
                f"类目「{leaf_data.get('path') or leaf_id}」是标品类目：发布第一页会要求"
                f"填标品信息（品牌 + 产品名称，都是下拉/联想控件）。发布 book 的「标品门」"
                f"会在运行时处理：品牌优先用本商品品牌，店铺品牌库里没有就选「无品牌」；"
                f"产品名称填叶子类目名。这里只作提示，不阻断 —— 真被拦住时由发布流程报。",
                "/category",
            ))

        # 【资质门】category_capture.blocking_qualifications 早就写好了，注释原话
        # 「这些类目我们出不了证件图，发布必挂，应在预处理阶段就阻断，而不是等抖店退回」
        # —— 但主流程从来没加载过资质数据、也从没调用它，是一条零调用的死防线。
        # 2026-09-04 接线。
        #
        # 严格遵守它 docstring 里的约定：entry 未采集成功时返回空列表，而那是「不知道」
        # 不是「没有」—— 所以必须先看 collection.ok，否则会把「没采到」当成「没要求」，
        # 静默放行一批其实发不出去的类目。
        try:
            _qual = load_qualification_capture(DEFAULT_QUALIFICATION)
        except (OSError, ValueError, KeyError):
            _qual = {}
        _qentry = _qual.get(str(leaf_id))
        if _qentry is None:
            blocking_errors.append(finding(
                "qualification_unknown",
                f"类目「{leaf_data.get('path') or leaf_id}」的资质要求未知："
                f"资质快照里没有这个类目。空的资质列表不代表不需要资质 —— "
                f"在不知道要交什么证件的情况下发布，被退回是必然的。",
                "/qualifications",
            ))
        elif (_qentry.get("collection") or {}).get("ok") is False:
            blocking_errors.append(finding(
                "qualification_unknown",
                f"类目「{leaf_data.get('path') or leaf_id}」的资质【未采集成功】："
                f"{(_qentry.get('collection') or {}).get('error') or '原因未记录'}。"
                f"这不代表它没有资质要求，只代表我们不知道 —— 拒绝在不知情下发布。",
                "/qualifications",
            ))
        else:
            qualification_checked = True
            _blocking = blocking_qualifications(_qentry)
            if _blocking:
                _names = "、".join(
                    str(q.get("label") or q.get("name") or q.get("id")) for q in _blocking[:5]
                )
                blocking_errors.append(finding(
                    "qualification_required",
                    f"类目「{leaf_data.get('path') or leaf_id}」有 {len(_blocking)} 项必填资质"
                    f"（{_names}）。本流水线出不了证件图，发布必被退回 —— "
                    f"需要人工补资质或改用无资质要求的类目。",
                    "/qualifications",
                ))

        for prop in uncovered:
            name = prop.get("name") or f"id={prop.get('id')}"
            # 品牌有 canonical.brand 兜底,只是需要下游把它投影进发布入参,
            # 与「真的没有任何来源」不是一回事,说法要分开。
            if name == BRAND_PROP_NAME:
                inferred_notes.append(finding(
                    "required_attr_from_brand_field",
                    f"必填属性「{name}」在 attributes 里没有来源，值来自 canonical.brand"
                    f"（发布入参需要把它投影成属性项，否则发布会被必填校验拦下）",
                    "/attributes",
                ))
            else:
                inferred_notes.append(finding(
                    "required_attr_uncovered",
                    f"必填属性「{name}」没有任何来源，也无法从枚举推断"
                    f"（{'无 options，通常只能由商家提供' if not (prop.get('options') or []) else '有 options 但未命中'}）"
                    f"——发布会被必填校验拦下",
                    "/attributes",
                ))

    overlay: dict = {}
    if cat:
        overlay["category"] = {"doudianLeafId": cat["doudianLeafId"]}
        # doudianPath 是 schema 里声明了却从没人填的字段。类目属性数据每条都带着
        # 全路径("运动休闲用品/游泳/女士分体泳衣"),解析器日志也一直在打它 ——
        # 不落盘的话,下游凡是需要类目【名字】的场景都得拿 leafId 再去反查一遍树。
        # 而发布页的类目选择器只能按名字点:没有名字,leafId 再准也点不进去。
        leaf_meta = props_by_leaf.get(str(cat["doudianLeafId"])) or {}
        # The publish book needs the platform's property names and widget types,
        # but not the full category capture (notably its potentially huge options).
        # Project exactly the selected leaf's metadata into canonical so its IDs
        # cannot be joined against a different category at publish time.
        overlay["category"]["categoryProps"] = [
            {
                "id": prop["id"],
                "name": prop["name"],
                "ui": prop.get("ui") or "unknown",
                "required": bool(prop.get("required")),
            }
            for prop in (leaf_meta.get("props") or [])
        ]
        if leaf_meta.get("path"):
            # 不能按 "/" 切 path：771 个叶子的名字自带斜杠（「T恤/Polo衫」），
            # 切出来会多一层假层级，而 doudianPath 正是发布 book 点类目用的路径。
            # 有权威嵌套树就顺着树取真实分段；没有才退回切字符串。
            segs = _leaf_path_segments(tree_roots, int(cat["doudianLeafId"]))
            overlay["category"]["doudianPath"] = segs or [
                s for s in leaf_meta["path"].split("/") if s]
    if overlay_attrs:
        overlay["attributes"] = overlay_attrs

    # [4/4] canonical + overlay 合并 + SKU 剔除 + addv2 投影
    image_assets: dict[str, bytes] | None = {} if download_images else None
    image_scope = timings.stage('llm_image_work') if download_images else nullcontext()
    with image_scope:
        canonical = build_canonical(
            raw,
            profile,
            limits,
            image_assets=image_assets,
            crop_main_images=crop_main_images,
            preprocess_config=normalized_config,
        )

    if qualification_checked:
        # build_canonical runs before this function knows the selected leaf and
        # therefore marks qualifications as unchecked. A successful lookup above
        # supersedes that initialization, including when it found blocking items.
        qr = canonical.setdefault("qualityReport",
                                  {"errors": [], "risks": [], "warnings": [], "pending": []})
        qr["pending"] = [
            item for item in (qr.get("pending") or [])
            if not (isinstance(item, dict) and item.get("code") == "qualifications_unchecked")
        ]

    if "category" in overlay:
        canonical["category"] = deep_merge(canonical.get("category") or {}, overlay["category"])
    if "attributes" in overlay:
        canonical["attributes"] = apply_attribute_overlay(canonical, overlay["attributes"])

    if normalized_config and any((normalized_config.get("text") or {}).get(key)
                                 for key in ("removeSensitiveByAi", "removeBrandByAi", "enableAiShortTitle")):
        try:
            apply_ai_text_policy(canonical, normalized_config)
        except ValueError as exc:
            qr = canonical.setdefault("qualityReport", {"errors": [], "risks": [], "warnings": [], "pending": []})
            qr.setdefault("errors", []).append(finding("preprocess_ai_failed", str(exc), "/title/text"))

    # 属性名没映射上的 source 属性进 pending —— 它们此前是静默 `continue` 掉的,
    # 产物里没有任何痕迹,人工兜底时无从得知"少了什么"。
    # 推断出来的必填属性进 warnings —— 不阻断,但必须在总账里和"采到的"区分开。
    if blocking_errors:
        qr = canonical.setdefault("qualityReport",
                                  {"errors": [], "risks": [], "warnings": [], "pending": []})
        qr.setdefault("errors", []).extend(blocking_errors)
    if risk_notes:
        qr = canonical.setdefault("qualityReport",
                                  {"errors": [], "risks": [], "warnings": [], "pending": []})
        qr.setdefault("risks", []).extend(risk_notes)
    if unresolved_attrs or inferred_notes:
        qr = canonical.setdefault("qualityReport",
                                  {"errors": [], "risks": [], "warnings": [], "pending": []})
        if unresolved_attrs:
            # 「源站的值抖店没有」是过程记账,不是发布阻塞项 —— 不填就是了。能不能发布
            # 看的是**抖店的必填有没有填上**,那由 missing_required_attributes 独立判定
            # (且它的覆盖判据已对齐"投影得出去":property_id + 非空 valueId)。把过程
            # 记账也算进 pending,等于拿过程当结果:一个非必填属性在抖店没有等价选项,
            # 商品就永远停在 needs_human。
            #
            # 只降级 attribute_value_unmapped 这一种 —— 它是「查清楚了,抖店确实没有
            # 这个值」。attribute_value_channel_failed(通道失败)和 attribute_name_*
            # 全部继续留在 pending:那些是「没查清楚」,降级它们等于假装检查过。
            settled = [f for f in unresolved_attrs if f.get("code") == "attribute_value_unmapped"]
            still_open = [f for f in unresolved_attrs if f.get("code") != "attribute_value_unmapped"]
            if settled:
                qr.setdefault("warnings", []).extend(settled)
            if still_open:
                qr.setdefault("pending", []).extend(still_open)
        if inferred_notes:
            qr.setdefault("warnings", []).extend(inferred_notes)

    skus_before = len(canonical.get("skus") or [])
    drop_zero_stock = not normalized_config or normalized_config["sku"].get("dropZeroStock", True)
    canonical["skus"] = [
        s for s in (canonical.get("skus") or [])
        if ((s.get("stock") or 0) > 0 or not drop_zero_stock)
        and (s.get("sourcePrice") or 0) > 0
    ]
    removed = skus_before - len(canonical["skus"])
    # 【剔空门】逐条剔 SKU 是对的（价格为 0 / 库存为 0 的那条确实不能发），但剔完
    # 一条不剩时此前【没有任何处理】—— 质量红线里有「图片全部不可用 → 剔除整个商品」，
    # 却没有对应的「SKU 全被剔光 → 剔除整个商品」，于是一个 skus:[] 的商品照样
    # 判成 needs_human 往下走。
    #
    # 2026-09-04 实测（平板学习机）：source 的 SKU 价格/库存全不合格被剔光，
    # canonical.skus 为空、规格「颜色」0 个值，errors 却是 0，verdict 只报
    # needs_human。发布跑到第 20 步「生成 SKU 导入表」时拿 0 行数据去注入，
    # 失败信息是一段 evalCheck 正则，与真因（这个商品根本没有可卖的 SKU）
    # 隔着 20 步。白跑一轮 3 分钟。
    #
    # 落 error 而不是 warning：没有 SKU 的商品在抖店不可能发布，verdict 应判 blocked。
    if not canonical.get("skus"):
        qr = canonical.setdefault("qualityReport",
                                  {"errors": [], "risks": [], "warnings": [], "pending": []})
        qr.setdefault("errors", []).append(finding(
            "no_publishable_sku",
            f"没有任何可发布的 SKU：来源 {skus_before} 条全部被质量红线剔除"
            f"（价格为 0/负数 或 库存为 0）。没有 SKU 的商品在抖店发不出去，"
            f"重试无用 —— 需要换商品或回源头核对价格库存。",
            "/skus",
        ))
    orphans = prune_orphan_spec_values(canonical)
    # build_canonical 在剔 SKU / 清孤儿之【前】就算过一次 sku_count_mismatch。清理之后
    # 那条告警可能已经不成立，留着就是一条和最终产物自相矛盾的日志——下次谁看见都会去追鬼。
    # 这里按清理后的真实数字重判：成立就改写数字，不成立就撤掉。
    _qr = canonical.get("qualityReport") or {}
    _warns = _qr.get("warnings") or []
    if any(isinstance(w, dict) and w.get("code") == "sku_count_mismatch" for w in _warns):
        _combos = 1
        for _spec in canonical.get("specs") or []:
            _combos *= len(_spec.get("values") or [])
        _n = len(canonical.get("skus") or [])
        _qr["warnings"] = [
            w for w in _warns
            if not (isinstance(w, dict) and w.get("code") == "sku_count_mismatch")
        ]
        if canonical.get("specs") and _combos != _n:
            _qr["warnings"].append({
                "code": "sku_count_mismatch",
                "message": f"SKU 数 {_n} 与规格组合数 {_combos} 不一致，抖店会拒绝",
                "field": "/skus",
            })
    if orphans:
        qr = canonical.setdefault("qualityReport",
                                  {"errors": [], "risks": [], "warnings": [], "pending": []})
        # 和同一个桶里其余条目一样落成 finding 对象。此前这里 append 的是裸字符串,
        # 于是 warnings 里混着 dict 和 str —— 任何按 `w["code"]` 过滤/计数的读取方
        # 要么当场崩,要么静默漏掉它(而它恰恰是「SKU 被剔掉之后规格少了几个」这条
        # 最需要人看见的账)。实测撞上:软水壶那轮 8 条 warning 里 7 dict 1 str。
        qr.setdefault("warnings", []).append({
            "code": "orphan_spec_values_pruned",
            "message": "剔除无 SKU 引用的规格值 %d 个: %s%s"
                       % (len(orphans), "、".join(orphans[:8]), "…" if len(orphans) > 8 else ""),
            "field": "/specs",
        })

    if not no_project or leaf_id is not None:
        timings.start_stage('projection_validation')
    findings: list = []
    projection_error: str | None = None
    detection_complete = False
    if not no_project:
        try:
            with timings.stage('llm_image_work'):
                print('  开始图片与文案检测', file=sys.stderr, flush=True)
                findings = collect_findings(canonical, image_assets, no_llm, deadline=_LLM_DEADLINE)
        except DetectorUnavailable as exc:
            projection_error = str(exc)
        else:
            mark_checked_images(canonical, image_assets, findings, no_llm)
            detection_complete = not no_llm and all(
                f'/images/{role}/{index}' in (image_assets or {})
                for role in ('main', 'detail')
                for index, _image in enumerate((canonical.get('images') or {}).get(role) or [])
            )

    projection_verdict: dict | None = None
    if leaf_id is not None and not no_project and projection_error is None:
        leaf_props = props_by_leaf.get(str(leaf_id))
        canonical = _project_canonical(canonical, leaf_props, findings)
        projection_verdict = verdict(canonical)

    if image_assets and projection_error is None:
        with timings.stage('llm_image_work'):
            upload_canonical_images(
                canonical,
                image_assets,
                console_url or os.environ.get("CONSOLE_URL", "http://127.0.0.1:8790"),
            )

    timings.start_stage('result_assembly')
    return {
        'publication': publication_readiness(
            canonical, props_by_leaf.get(str(leaf_id)),
            validate_publication(canonical, limits, props_by_leaf, leaf_id),
            detection_complete=detection_complete,
        ),
        "canonical": canonical,
        "removed_sku_count": removed,
        "projection_verdict": projection_verdict,
        "projection_error": projection_error,
    }


def upload_canonical_images(canonical: dict, image_assets: dict[str, bytes], console_url: str) -> dict[str, int]:
    """Upload in-memory preprocessed images as raw bytes and replace only CDN URLs."""
    pending: list[tuple[str, bytes, dict]] = []
    for role in ("main", "detail"):
        for index, image in enumerate((canonical.get("images") or {}).get(role) or []):
            if not isinstance(image, dict) or image.get("url") != image.get("sourceUrl"):
                continue
            data = image_assets.get(f"/images/{role}/{index}")
            if data is None:
                continue
            pending.append((role, data, image))

    for spec_index, spec in enumerate(canonical.get("specs") or []):
        for value_index, value in enumerate(spec.get("values") or []):
            source_url = value.get("sourceImageUrl")
            data = image_assets.get(f"/specs/{spec_index}/values/{value_index}")
            if isinstance(source_url, str) and data is not None:
                pending.append(("spec", data, value))

    uploaded = 0
    for role, data, image in pending:
        announce_work('image-upload', (len(pending) - uploaded) * 60)
        source_url = image.get("sourceUrl") or image.get("sourceImageUrl")
        filename = f"{role}-{uploaded}{_image_extension(source_url)}"
        request = Request(
            f"{console_url.rstrip('/')}/api/files/upload?filename={quote(filename)}&subDir=products",
            data=data,
            method="POST",
            headers={"Content-Type": "application/octet-stream"},
        )
        try:
            with urlopen(request, timeout=60) as response:
                result = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError) as exc:
            raise RuntimeError(f"图床上传失败: {exc}") from exc
        cdn_url = result.get("cdn_url")
        if not isinstance(cdn_url, str) or not cdn_url:
            raise RuntimeError(f"图床上传失败: {result.get('error') or '图床未返回 cdn_url'}")
        if role == "spec":
            image["imageUrl"] = cdn_url
        else:
            image["url"] = cdn_url
        uploaded += 1

    missing: list[str] = []
    for role in ("main", "detail"):
        for index, image in enumerate((canonical.get("images") or {}).get(role) or []):
            if image.get("url") == image.get("sourceUrl"):
                missing.append(f"{role}[{index}]")
    for spec_index, spec in enumerate(canonical.get("specs") or []):
        for value_index, value in enumerate(spec.get("values") or []):
            source_url = value.get("sourceImageUrl")
            if source_url and value.get("imageUrl") == source_url:
                missing.append(f"spec[{spec_index}].values[{value_index}]")
    if missing:
        raise RuntimeError(f"图床上传失败: 以下预处理图片未获得 CDN URL: {', '.join(missing)}")
    return {"uploaded": uploaded, "skipped": len(pending) - uploaded}


def _image_extension(url: object) -> str:
    match = re.search(r"\.(jpg|jpeg|png|webp)(?:\?|$)", str(url or ""), re.I)
    return f".{match.group(1).lower()}" if match else ".jpg"


def _cli():
    p = argparse.ArgumentParser(description='raw 商品 → canonical 与发布条件（JSON stdout）')
    p.add_argument("--capture", required=True, type=Path,
                   help="采集结果文件路径(原 raw.json 角色);不再走隐式约定,文件名由调用方定")
    p.add_argument("--category-tree", default=str(DEFAULT_TREE))
    p.add_argument("--category-properties", default=str(DEFAULT_PROPS))
    p.add_argument("--shop-profile", required=True, help="path to a local shop profile JSON")
    p.add_argument('--stdout', action='store_true', help='返回 JSON（默认行为）')
    p.add_argument("--no-llm", action="store_true", help="跳过 LLM,纯 token overlap + null 兜底")
    p.add_argument("--no-project", action="store_true",
                   help="跳过 product-projection 合规检测(图仍会下载,留给手工二次跑)")
    p.add_argument("--category-leaf-id", type=int, default=None,
                   help="外部指定抖店叶子类目 id,跳过 LLM 类目判断。"
                        "用于采纳抖店自己的类目判定(它在保存草稿时会给建议)")
    p.add_argument("--no-main-image-crop", action="store_true",
                    help="不生成主图中心 1:1 裁剪副本(默认生成)")
    args = p.parse_args()

    capture_path = Path(args.capture)
    if not capture_path.exists():
        print(f"ERROR: {capture_path} 不存在", file=sys.stderr)
        sys.exit(2)

    raw = load_json(capture_path)
    # 入口契约:扁平采集格式;内部 1688 raw 由 _normalize_raw_input 转
    from build_canonical import _normalize_raw_input
    raw = _normalize_raw_input(raw)
    profile = load_json(Path(args.shop_profile))

    result = build_doudian_product(
        raw,
        tree_path=args.category_tree,
        props_path=args.category_properties,
        profile=profile,
        no_llm=args.no_llm,
        no_project=args.no_project,
        download_images=True,
        crop_main_images=not args.no_main_image_crop,
        category_leaf_id=args.category_leaf_id,
    )

    if result["removed_sku_count"]:
        print(f"  ⚠ 剔除 {result['removed_sku_count']} 个无效 SKU", file=sys.stderr)
    from preprocess_wrapper import build_output, exit_code_for_result
    print(json.dumps(build_output(result), ensure_ascii=False))
    return exit_code_for_result(result)


if __name__ == "__main__":
    sys.exit(_cli())
