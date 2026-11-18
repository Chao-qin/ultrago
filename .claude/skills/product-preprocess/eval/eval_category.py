#!/usr/bin/env python3
"""类目匹配评测。

两段式穷举召回之后,「召回率」不再是一个有信息量的指标 —— 候选是**穷举**的
(48 个一级 → 该级下全部叶子),正确答案必然在里面,恒为 100%。所以这里改测
真正会错的两处,分开报:

  一级命中  第一段选对了没有。选错一级,第二段就在完全无关的叶子里挑,
            而那种错误看起来跟正常结果一模一样(有 id、有路径)。
  叶子准确  最终选中的是不是正确叶子。

两者分开才知道该改哪一段:一级对、叶子错 → 改第二段的提示或投票;
一级就错 → 问题在第一段,改第二段没用。

**都需要调 LLM,且都是抽样观测**:同一输入两次跑可能不同。单跑一轮报出来的
数字不能当确定值 —— 用 --rounds N 多跑几轮看分布。

跑:
    eval_category.py                      # 单轮
    eval_category.py --rounds 3           # 三轮,报每轮和汇总
    BCP_CATEGORY_VOTES=1 eval_category.py --rounds 3   # 关投票做对照
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import time
from pathlib import Path

_SKILL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SKILL))
sys.path.insert(0, str(_SKILL / "scripts"))

from build_doudian_product import load_category_indexes, resolve_category  # noqa: E402

_REPO = _SKILL.parent.parent.parent
TREE = _REPO / "reports" / "doudian-category-tree.json"
PROPS = _REPO / "reports" / "doudian-category-properties.json"
CASES = Path(__file__).resolve().parent / "category-cases.json"


def _raw_for(case: dict) -> dict:
    """评测输入还原成 resolve_category 吃的形状。

    直接用 fixture 里冻结的 title/sourceAttributes,不回读源文件 —— 源文件会被
    后续流程改写(canonical 会被 overlay 合并),评测输入必须是不动的。
    """
    return {"BaseInfo": {
        "Title": case["title"],
        "Attr": {"SourceAttr": [{"Label": a["name"], "Value": a["value"]}
                                for a in case.get("sourceAttributes") or []]},
    }}


def main() -> int:
    ap = argparse.ArgumentParser(description="类目匹配评测")
    ap.add_argument("--rounds", type=int, default=1, help="跑几轮(LLM 非确定,单轮不可信)")
    args = ap.parse_args()

    data = json.loads(CASES.read_text("utf-8"))
    cases = data["cases"]
    leaves, props_by_leaf = load_category_indexes(TREE, PROPS)
    paths = {lid: (n.get("path") or n.get("name")) for lid, n in props_by_leaf.items()}

    votes = os.environ.get("BCP_CATEGORY_VOTES", "3")
    print(f"评测集 {len(cases)} 例（排除 {len(data.get('excluded') or [])} 个多品类歧义商品）")
    print(f"BCP_CATEGORY_VOTES={votes}  rounds={args.rounds}\n")

    tally = collections.Counter()
    per_case = collections.defaultdict(list)
    started = time.monotonic()

    for r in range(1, args.rounds + 1):
        leaf_hits = head_hits = 0
        print(f"── 第 {r} 轮 ──")
        for c in cases:
            want, want_path = c["expectedLeafId"], c["expectedLeafPath"]
            want_head = (want_path or "").split("/")[0]
            got_res = resolve_category(_raw_for(c), leaves, no_llm=False, leaf_paths=paths)
            got = got_res["doudianLeafId"] if got_res else None
            got_path = paths.get(str(got)) if got else None
            got_head = (got_path or "").split("/")[0]

            leaf_ok, head_ok = got == want, got_head == want_head
            leaf_hits += leaf_ok
            head_hits += head_ok
            per_case[c["id"]].append(leaf_ok)
            print(f"   {'✅' if leaf_ok else '❌'} {c['id']:<20} 一级{'✓' if head_ok else '✗'} → {got_path}")
        tally["leaf"] += leaf_hits
        tally["head"] += head_hits
        tally["total"] += len(cases)
        print(f"   本轮 一级 {head_hits}/{len(cases)}  叶子 {leaf_hits}/{len(cases)}\n")

    n = tally["total"]
    elapsed = time.monotonic() - started
    print("═══ 汇总 ═══")
    print(f"一级命中  {tally['head']}/{n} = {tally['head']/n:.0%}")
    print(f"叶子准确  {tally['leaf']}/{n} = {tally['leaf']/n:.0%}")
    print(f"耗时      {elapsed:.0f}s  （{elapsed/max(1,n):.0f}s/例）")
    unstable = [k for k, v in per_case.items() if len(set(v)) > 1]
    if unstable:
        # 逐例稳定性单独点名:整体准确率掩盖「某一例每轮翻烧饼」这种情况,
        # 而那正是该加投票 / 该补上下文的信号。
        print(f"不稳定用例（多轮结果不一致）: {', '.join(unstable)}")
    else:
        print("所有用例多轮结果一致")
    return 0 if tally["leaf"] == n else 1


if __name__ == "__main__":
    raise SystemExit(main())
