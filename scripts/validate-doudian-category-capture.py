"""校验抖店类目采集的三份产物 —— 交叉对账 + 自洽检查。

    python3 scripts/validate-doudian-category-capture.py

三份出自 resource/playbooks/doudian-category-schema.json 的【同一次爬取、同一个快照】：
    reports/doudian-category-tree.json
    reports/doudian-category-properties.json
    reports/doudian-category-qualification.json

**为什么这份校验值得单独存在。** 2026-09-03 之前类目树由另一本 book 单独采，属性由一个
手动脚本采 —— 两份快照取自不同时刻，属性里的 cid 完全可能在树里找不到，而没有任何东西
在检查这件事。合并成一次快照之后，"三份对得上"才第一次成为可验证的事实，下面第 3 项就是它。

检查项：
  1. 三份是不是同一次采集（capturedAt 相同）—— 不同就说明有人只重跑了其中一份
  2. data 是不是全集：条数 == 叶子数，且 ok + failed == 条数（失败的类目也必须在里面）
  3. 与类目树交叉对账：每个 cid 都在树里、且都是叶子；树的叶子也都在两份数据里
  4. collection.ok=false 的条目 payload 必须为 null，且带 error / reason（否则「没采到」
     和「采到了是空的」在数据里分不出来）
  5. 失败清单与 data 里 collection.ok=false 的集合一一对应
  6. 字段无损抽查：属性项该有的 rules / placeholder / additions.diy_type 等是否还在
     —— 这几个正是旧口径丢掉的，回归时第一个会消失

退出码：0 全通过；1 有检查未通过。
"""
import json
import os
import sys
from collections import Counter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 与消费方走同一条路径解析规则（明文优先、回退 .gz），否则校验的和实际读的可能不是同一份。
sys.path.insert(0, os.path.join(BASE, ".claude/skills/product-preprocess/scripts"))
from category_capture import _load as load_capture  # noqa: E402
FAIL = []


def check(ok: bool, label: str, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{('  — ' + detail) if detail and not ok else ''}")
    if not ok:
        FAIL.append(label)


def load(name):
    return load_capture(f"{BASE}/reports/{name}")


tree = load("doudian-category-tree.json")
flat = tree["flat"]
tree_ids = {n["id"] for n in flat}
leaves = {n["id"] for n in flat if n.get("is_leaf")}

print(f"=== 类目树 ===\n  节点 {len(flat)} · 叶子 {len(leaves)} · capturedAt {tree['capturedAt']}")
check(len(flat) == tree["stats"]["total"], "flat 条数与 stats.total 一致")
check(len(leaves) == tree["stats"]["leaves"], "叶子数与 stats.leaves 一致")
# 旧口径把节点压成 5 元组，这三个字段是那次丢掉的。少一个就说明采集器又退回去了。
missing_fields = [k for k in ("enable", "industry_status", "extra") if k not in flat[0]]
check(not missing_fields, "节点保留了 enable / industry_status / extra", f"缺 {missing_fields}")

for name, payload_key in (
    ("doudian-category-properties.json", "category_properties"),
    ("doudian-category-qualification.json", "qualification"),
):
    doc = load(name)
    data = doc["data"]
    st = doc["stats"]
    ok_ids = {c for c, v in data.items() if v["collection"]["ok"]}
    bad_ids = {c for c, v in data.items() if not v["collection"]["ok"]}
    print(f"\n=== {name} ===\n  条数 {len(data)} · ok {len(ok_ids)} · 未采到 {len(bad_ids)} · capturedAt {doc['capturedAt']}")

    check(doc["capturedAt"] == tree["capturedAt"], "与类目树是同一次采集",
          f"{doc['capturedAt']} vs {tree['capturedAt']}")
    check(len(data) == st["leaves"] == len(leaves), "data 是全集（条数 == 叶子数）",
          f"data {len(data)} / stats {st['leaves']} / tree {len(leaves)}")
    check(len(ok_ids) == st["ok"] and len(bad_ids) == st["failed"], "ok / failed 与 stats 相符")
    check(st["ok"] + st["failed"] == st["leaves"], "ok + failed == leaves")

    strays = [c for c in data if int(c) not in tree_ids]
    nonleaf = [c for c in data if int(c) not in leaves]
    uncovered = [i for i in leaves if str(i) not in data]
    check(not strays, "没有树外的 cid", f"{len(strays)} 个，例 {strays[:3]}")
    check(not nonleaf, "没有非叶子的 cid", f"{len(nonleaf)} 个，例 {nonleaf[:3]}")
    check(not uncovered, "树里的叶子全部覆盖", f"漏 {len(uncovered)} 个，例 {uncovered[:3]}")

    # 没采到的条目：payload 必须是 null，且必须说清楚为什么 —— 否则下游没法把
    # 「不知道」和「没有要求」分开，而这两者的后果完全不同。
    bad_shape = [c for c in bad_ids if data[c].get(payload_key) is not None]
    bad_reason = [c for c in bad_ids if not data[c]["collection"].get("error") or not data[c]["collection"].get("reason")]
    check(not bad_shape, "未采到的条目 payload 为 null", f"{len(bad_shape)} 个不是")
    check(not bad_reason, "未采到的条目都带 error 与 reason", f"{len(bad_reason)} 个没带")

    fail_ids = {str(f["cid"]) for f in doc["failures"]}
    check(fail_ids == bad_ids, "failures 清单与 collection.ok=false 一一对应",
          f"failures {len(fail_ids)} vs data {len(bad_ids)}")
    if doc["failures"]:
        kinds = Counter(f["err"][:40] for f in doc["failures"])
        print(f"  未采到的原因分布: {dict(kinds)}")

    # path 与树对齐：两份数据即便同一次采集，path 是各自拼的，对不上就说明拼错了。
    tree_path = {n["id"]: n["path"] for n in flat}
    bad_path = [c for c in data if tree_path.get(int(c)) != data[c]["path"]]
    check(not bad_path, "path 与类目树一致", f"{len(bad_path)} 条不一致，例 {bad_path[:3]}")

    if payload_key == "category_properties":
        # 字段无损抽查。这几个字段是 2026-09-03 之前被丢掉的，回归时它们第一个消失。
        n_items = n_rules = n_ph = n_diy = n_optadd = 0
        for v in data.values():
            for it in ((v.get("category_properties") or {}).get("items") or []):
                n_items += 1
                n_rules += bool(it.get("rules"))
                n_ph += "placeholder" in it
                n_diy += (it.get("additions") or {}).get("diy_type") is not None
                n_optadd += any("additions" in o for o in (it.get("options") or []))
        print(f"  属性项 {n_items}")
        check(n_items > 40000, "属性项数量在预期量级", f"只有 {n_items}")
        check(n_ph == n_items, "placeholder 全量保留（多选上限「最多选N项」在里面）", f"{n_ph}/{n_items}")
        check(n_diy == n_items, "additions.diy_type 全量保留（投影判自定义值靠它）", f"{n_diy}/{n_items}")
        check(n_rules > 0, "rules 保留", f"{n_rules}/{n_items}")
        check(n_optadd > 0, "options[].additions 保留", f"{n_optadd}/{n_items}")
    else:
        # 资质的实际用途：哪些类目有「必填且不可隐藏」的资质 —— 那是发布必挂的硬门槛。
        hard = {}
        for c, v in data.items():
            for i in ((v.get("qualification") or {}).get("items") or []):
                if i.get("required") and not i.get("hidden") and i.get("available") is not False:
                    hard.setdefault(c, []).append(i.get("label"))
        kinds = Counter(lbl for lbls in hard.values() for lbl in lbls)
        print(f"  有必填资质的叶子类目: {len(hard)} / {len(ok_ids)}   最常见: {dict(kinds.most_common(5))}")
        check(len(hard) > 0, "至少识别出一批必填资质类目（否则这份数据没有阻断价值）")

print("\n" + ("全部通过" if not FAIL else f"{len(FAIL)} 项未通过: " + "; ".join(FAIL)))
sys.exit(1 if FAIL else 0)
