#!/usr/bin/env python3
"""修改层：人来填、人来判，每一步都当场按抖店规则校验。

投影层告诉你哪里不行，这一层是你动手改的地方。改完立刻重新判定，不用等到发布
才知道还差什么。

**决定存在 canonical 之外。** `qualityReport` 的 schema 是
`additionalProperties: false`，四个桶之外加不了，finding 里也加不了「已确认」
字段。可以去改那份 schema，但不该改 —— 商品是商品，谁批准了什么是审计数据。
混在一起之后「这个商品长什么样」和「谁放行了它」就分不开了，而这两个问题在出事
的时候是分开问的。

所以决定是一份独立的列表，判定读 canonical + decisions。canonical 始终严格合规，
拿去发布的那份和审批记录没有耦合。

三条会出错的地方，这里都当场拦住：

  1. **填一个不在候选里的值** —— 拒绝。抖店发布时照样会拒，等到那时候才知道
     更贵。实测这份抓取里 9078 个有候选的必填属性**没有一个是残缺列表**
     （optionCount 都等于实际条数），所以候选当白名单是安全的。没有候选的
     3665 个是自由文本，只查非空。
  2. **确认一条不存在的风险** —— 拒绝。指向空气的批准意味着有人签了字，而签的
     那件事不在这份商品里。八成是改完文案之后决定过期了。
  3. **改完文案，旧风险还挂着** —— 证据已经不在字段里的风险自动作废。否则你
     把「淘宝」从标题删掉之后，那条风险还在，而清掉它要重跑一次 15 秒的模型。
     证据还在的则留着 —— 这一条不需要模型也判得了。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from project import _pointer_get, project, verdict as base_verdict  # noqa: E402
from category_capture import normalize_props_entry  # noqa: E402

# 决定的三种形态。`op` 之外的字段各不相同，见下面的校验。
OPS = ("set_attribute", "set_field", "accept_risk")


class Rejected(ValueError):
    """一个改不动的决定。带上原因 —— 「校验失败」四个字帮不了填表的人。"""


def _prop_by_name(props: dict, name: str) -> dict | None:
    for p in props.get("props") or []:
        if p.get("name") == name:
            return p
    return None


def editable_fields(canonical: dict, props: dict | None) -> list[dict]:
    """现在需要人动手的地方，带上候选。

    有候选就给候选 —— 一个必填属性有 10 个合法取值时，给输入框而不是给下拉，
    等于把「填错」变成默认路径。
    """
    out: list[dict] = []
    if props is None:
        return out
    have = {a.get("sourceName"): a for a in canonical.get("attributes") or []}
    for p in props.get("props") or []:
        if not p.get("required") or p.get("hidden"):
            continue
        name = p.get("name") or ""
        current = have.get(name)
        filled = bool(current and str(current.get("rawValue") or "").strip())
        if filled:
            continue
        options = [o[1] for o in (p.get("options") or []) if isinstance(o, (list, tuple)) and len(o) >= 2]
        out.append(
            {
                "name": name,
                "propertyId": p.get("id"),
                "multi": bool(p.get("multi")),
                # 空列表 = 自由文本，不是"没有合法值"。这两件事在 UI 上要长得
                # 完全不一样。
                "options": options,
                "freeText": not options,
                "hint": f"抖店类目「{props.get('name', '?')}」必填",
            }
        )
    return out


def _apply_set_attribute(canonical: dict, decision: dict, props: dict | None) -> None:
    name = decision.get("name")
    values = decision.get("values")
    if not name or not isinstance(values, list) or not values:
        raise Rejected("set_attribute 要有 name 和非空的 values")
    if props is None:
        raise Rejected(f"没有类目属性表，无法确认「{name}」是不是这个类目的合法属性")
    prop = _prop_by_name(props, name)
    if prop is None:
        raise Rejected(f"类目「{props.get('name', '?')}」没有「{name}」这个属性 —— 填了抖店也不认")
    legal = {o[1] for o in (prop.get("options") or []) if isinstance(o, (list, tuple)) and len(o) >= 2}
    if legal:
        bad = [v for v in values if v not in legal]
        if bad:
            # 列出候选而不是只说"不合法"：人填错的时候需要的是那张表，不是判决。
            preview = "、".join(sorted(legal)[:8]) + ("…" if len(legal) > 8 else "")
            raise Rejected(f"「{name}」不接受 {bad}；候选是：{preview}")
    if not prop.get("multi") and len(values) > 1:
        raise Rejected(f"「{name}」是单选，给了 {len(values)} 个值")

    attrs = canonical.setdefault("attributes", [])
    for a in attrs:
        if a.get("sourceName") == name:
            a["rawValue"] = "、".join(values)
            a["values"] = list(values)
            return
    attrs.append({"sourceName": name, "rawValue": "、".join(values), "values": list(values)})


def _apply_set_field(canonical: dict, decision: dict) -> None:
    pointer = decision.get("pointer") or ""
    if not pointer.startswith("/"):
        raise Rejected(f"pointer 要是 JSON Pointer，给的是 {pointer!r}")
    if "value" not in decision:
        raise Rejected("set_field 要有 value")
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.lstrip("/").split("/")]
    cur: Any = canonical
    for key in parts[:-1]:
        if isinstance(cur, list):
            if not key.isdigit() or int(key) >= len(cur):
                raise Rejected(f"{pointer} 指不到，{key} 越界")
            cur = cur[int(key)]
        elif isinstance(cur, dict):
            if key not in cur:
                raise Rejected(f"{pointer} 指不到，没有 {key}")
            cur = cur[key]
        else:
            raise Rejected(f"{pointer} 指不到")
    last = parts[-1]
    if isinstance(cur, list):
        if not last.isdigit() or int(last) >= len(cur):
            raise Rejected(f"{pointer} 指不到，{last} 越界")
        cur[int(last)] = decision["value"]
    elif isinstance(cur, dict):
        cur[last] = decision["value"]
    else:
        raise Rejected(f"{pointer} 指不到")


def drop_stale_risks(canonical: dict) -> list[dict]:
    """证据已经不在字段里的风险，作废。

    改完文案之后旧风险还挂着，清它就得重跑一次 15 秒的模型。但"这段文字还在不在
    这个字段里"是纯字符串比对，不需要模型 —— 所以能判的就当场判掉。

    只作废**能确认已经消失**的：字段读不到（或不是字符串）时一律保留，因为读不到
    不代表干净。返回被作废的那些，让调用方能说清楚发生了什么。"""
    report = canonical.get("qualityReport") or {}
    kept: list[dict] = []
    dropped: list[dict] = []
    for r in report.get("risks") or []:
        evidence, field = r.get("evidence"), r.get("field")
        target = _pointer_get(canonical, field) if field else None
        if evidence and isinstance(target, str) and evidence not in target:
            dropped.append(r)
            continue
        kept.append(r)
    report["risks"] = kept
    canonical["qualityReport"] = report
    return dropped


def apply_decisions(
    canonical: dict, decisions: list[dict], props: dict | None
) -> tuple[dict, list[dict], list[dict]]:
    """按顺序应用，返回 (改过的 canonical, 生效的决定, 被拒的决定+原因)。

    被拒的**不中止**其余决定：一次填十个属性错了一个，不该把另外九个也退回去。
    但被拒的要原样带回来，不能静默吞掉 —— 那等于告诉人"填好了"而其实没填上。"""
    out = json.loads(json.dumps(canonical))
    accepted: list[dict] = []
    rejected: list[dict] = []

    for d in decisions:
        op = d.get("op")
        try:
            if op == "set_attribute":
                _apply_set_attribute(out, d, props)
            elif op == "set_field":
                _apply_set_field(out, d)
            elif op == "accept_risk":
                # 只校验它指得到东西，不改 canonical —— 确认存在别处。
                risks = (out.get("qualityReport") or {}).get("risks") or []
                if not any(r.get("field") == d.get("field") and r.get("evidence") == d.get("evidence") for r in risks):
                    raise Rejected(
                        f"要确认的风险不存在：{d.get('field')} 上没有 {d.get('evidence')!r}。"
                        "八成是改完文案之后这条决定过期了"
                    )
                if not str(d.get("note") or "").strip():
                    # 一条没有理由的批准，事后没人能复核它对不对。
                    raise Rejected("accept_risk 要写 note —— 为什么它不是侵权")
            else:
                raise Rejected(f"不认识的 op {op!r}，只有 {OPS}")
        except Rejected as exc:
            rejected.append({**d, "rejected": str(exc)})
            continue
        accepted.append(d)

    drop_stale_risks(out)
    return out, accepted, rejected


def verdict(canonical: dict, accepted: list[dict]) -> dict:
    """判定，把已确认的风险扣掉。

    这是 `needs_human` 通向 `ready` 的唯一一条路：风险要么被改掉（证据消失，
    上面那条规则作废它），要么被人明确确认。没有第三种 —— 一个有未确认风险的
    商品不该因为没人管就自动变成可发布。"""
    acked = {(d.get("field"), d.get("evidence")) for d in accepted if d.get("op") == "accept_risk"}
    shadow = json.loads(json.dumps(canonical))
    report = shadow.setdefault("qualityReport", {})
    report["risks"] = [r for r in (report.get("risks") or []) if (r.get("field"), r.get("evidence")) not in acked]
    v = base_verdict(shadow)
    if acked:
        v["acknowledged"] = len(acked)
    return v


def main() -> int:
    ap = argparse.ArgumentParser(description="按决定修改商品，并当场重新判定")
    ap.add_argument("--canonical", type=Path, required=True)
    ap.add_argument("--category-props", type=Path)
    ap.add_argument("--decisions", type=Path, help="决定列表 JSON；不给就只列出待办")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    canonical = json.loads(args.canonical.read_text("utf-8"))
    props = normalize_props_entry(json.loads(args.category_props.read_text("utf-8"))) if args.category_props else None

    if args.decisions is None:
        print(json.dumps({"todo": editable_fields(canonical, props), "verdict": base_verdict(canonical)},
                         ensure_ascii=False, indent=2))
        return 0

    decisions = json.loads(args.decisions.read_text("utf-8"))
    edited, accepted, rejected = apply_decisions(canonical, decisions, props)
    # 改完重新走一遍投影：属性填上了，pending 就该少一条。不重跑模型
    # （findings 传空），因为这一趟没有新的图片或文案要看。
    reprojected = project(edited, props, [])
    result = {
        "ok": not rejected,
        "verdict": verdict(reprojected, accepted),
        "accepted": len(accepted),
        "rejected": rejected,
        "canonical": reprojected,
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text + "\n", "utf-8")
        print(json.dumps({k: v for k, v in result.items() if k != "canonical"}, ensure_ascii=False))
    else:
        print(text)
    # 有被拒的就退 1 —— 调用方不该在没看拒绝原因的情况下当成功继续。
    return 1 if rejected else 0


if __name__ == "__main__":
    sys.exit(main())
