"""抖店类目采集产物的读取适配层 —— 所有消费方的唯一入口。

**为什么存在这个模块。**
2026-09-03 采集口径从「挑 10 个字段 + options 压成二元组」改成【原样保留抖店返回的结构】，
产物形状随之变了两处：

    旧: { "<叶子id>": { name, path, props: [ {id, name, required, ..., options: [[vid, vname], ...]} ] } }
    新: { source, endpoint, capturedAt, stats, legend, failures, kind,
          data: { "<叶子id>": { name, path, collection, category_properties: <getSchema 原样> } } }

新结构里 items 用 `label`（不是 `name`），options 是 `[{value_id, value_name, additions}]`（不是二元组）。

而 `build_doudian_product.py` 一个文件里就有 25+ 处按 `o[0]` / `o[1]` 读 options、十几处读
`p["name"]`。逐处改风险极高、收益为零 —— 那些逻辑本身没有错，错的只是数据到达它们之前的形状。
所以适配放在【唯一的加载点】：本模块把新形状归一回旧的内存形状，调用点一行不用动；
同时把未经加工的原始项挂在 `raw` 上，让新需求（rules / placeholder / diy_type / options 的
additions）可以直接取，不必再改一次形状。

**同时读得懂旧形状**：测试 fixture 与历史产物都是旧的，`load_props_capture` 两种都认，
按结构判别而不是按文件名 —— 判据是「顶层有没有 data + kind」。

**collection.ok 不能被归一化掉**：ok=true 时 payload 为 null 表示抖店确实没下发；
ok=false 时 null 只表示没采到。归一化后仍逐条保留 `collection`，下游要区分「无要求」和
「不知道」时有据可依。旧形状没有这个字段，读旧文件时补 `{"ok": True}` —— 旧采集把失败的
类目整条丢掉了，所以留在文件里的确实都是采到的。
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any


def resolve_capture_path(path: str | Path) -> Path:
    """给一个 `.json` 路径，返回实际该读的文件（`.json` 或 `.json.gz`）。

    产物进 git 时是 gzip 的：属性 122MB 超过 GitHub 单文件 100 MiB 的硬上限，压后 13.3MB
    （资质 44MB → 0.6MB，类目树 2.5MB → 0.2MB，合计 177MB → 14.1MB）。

    **谁优先**：明文 `.json` 存在就用它 —— 它是采集 book 刚写出来的新鲜产物，压缩是之后
    单独一步（`pnpm reports:compress`，压完会删掉明文）。所以「两个都在」只是压缩前的
    过渡态，此时用新鲜的那份才对。新克隆的仓库里只有 `.gz`，走回退分支。
    """
    p = Path(path)
    if p.exists():
        return p
    gz = p.with_suffix(p.suffix + ".gz")
    if gz.exists():
        return gz
    raise FileNotFoundError(f"{p} 与 {gz} 都不存在 —— 先跑采集 book，或从仓库取回 .gz")


def load_capture_json(path: str | Path) -> Any:
    """读一份采集产物的 JSON，`.json` 与 `.json.gz` 都认。

    类目树也走这里：它和属性/资质是同一次采集的三份产物，压缩策略必须一致 ——
    只让其中两份支持 .gz，第三份就会在只有 .gz 的克隆里 FileNotFoundError。
    """
    real = resolve_capture_path(path)
    opener = gzip.open if real.suffix == ".gz" else open
    with opener(real, "rt", encoding="utf-8") as f:
        return json.load(f)


_load = load_capture_json  # 内部别名，保留旧调用点


def is_new_capture(doc: Any) -> bool:
    """新形状的判据：顶层同时有 data 与 kind。

    不按文件名判 —— 同一个路径在迁移前后装的是两种东西，按名字判等于假设「文件没被换过」。
    """
    return isinstance(doc, dict) and isinstance(doc.get("data"), dict) and "kind" in doc


def normalize_prop_item(item: dict) -> dict:
    """把 getSchema 原样的一个属性项归一成旧的内存形状，并挂上 raw。

    字段对应关系（旧 → 新）:
        name        ← label            ← 迁移最容易踩的一处
        options     ← [{value_id, value_name}] 压回 [vid, vname] 二元组
        ui/ptype/important/group ← additions.{ui_type, property_type, important_type, prop_group.name}
    """
    add = item.get("additions") or {}
    group = add.get("prop_group") or {}
    options = item.get("options") or []
    return {
        "id": str(item.get("id")) if item.get("id") is not None else None,
        "name": item.get("label") or "",
        "required": bool(item.get("required")),
        "hidden": bool(item.get("hidden")),
        "ui": add.get("ui_type") or "",
        "ptype": add.get("property_type") if add.get("property_type") is not None else "",
        "important": add.get("important_type") or 0,
        "group": group.get("name") or "",
        "optionCount": len(options),
        "options": [[o.get("value_id"), o.get("value_name")] for o in options],
        # 原始项。新增字段（rules / placeholder / required_tips / available / disabled /
        # additions.diy_type / options[].additions）都在这里，不必再改一次归一化形状。
        "raw": item,
    }


def normalize_props_entry(entry: dict) -> dict:
    """一个叶子类目的属性条目：新形状 → 旧的内存形状（+ collection + raw）。"""
    if "props" in entry:  # 已经是旧形状
        out = dict(entry)
        out.setdefault("collection", {"ok": True})
        return out
    cp = entry.get("category_properties") or {}
    return {
        "name": entry.get("name"),
        "path": entry.get("path"),
        "collection": entry.get("collection") or {"ok": True},
        "props": [normalize_prop_item(i) for i in (cp.get("items") or [])],
        "raw": cp or None,
    }


def load_props_capture(path: str | Path) -> dict[str, dict]:
    """读属性采集产物，返回 {str(叶子id) → {name, path, collection, props[], raw}}。

    新旧两种形状都认。返回值的 props / options 形状与 2026-09-03 之前完全一致，
    所以 build_doudian_product / validate_doudian_rules 等既有调用点无需改动。
    """
    doc = _load(path)
    if not is_new_capture(doc):
        return {k: normalize_props_entry(v) for k, v in doc.items()}
    return {cid: normalize_props_entry(e) for cid, e in doc["data"].items()}


def load_qualification_capture(path: str | Path) -> dict[str, dict]:
    """读资质采集产物，返回 {str(叶子id) → {name, path, collection, qualification}}。

    资质是 2026-09-03 才开始采的，没有旧形状要兼容，所以原样返回、不做归一化 ——
    没有任何既有调用点依赖某个特定形状，凭空造一层映射只会多一处要维护的假设。
    """
    doc = _load(path)
    data = doc["data"] if is_new_capture(doc) else doc
    return {
        cid: {
            "name": e.get("name"),
            "path": e.get("path"),
            "collection": e.get("collection") or {"ok": True},
            "qualification": e.get("qualification"),
        }
        for cid, e in data.items()
    }


def blocking_qualifications(entry: dict) -> list[dict]:
    """该类目【必须提供且我们提供不了】的资质项。

    判据是 required 且没被隐藏、且可用 —— 三个条件缺一不可：抖店会下发一批 required=false
    的可选资质（赠品资质、报关单等），把它们也算进来会把 3% 的阻断面积放大成一大片。

    2026-09-03 实测：4236 个可采类目里 139 个命中（134 个要「包装标签图」、6 个要「质检报告」）。
    这些类目我们出不了证件图，发布必挂，应在预处理阶段就阻断，而不是等抖店退回。

    entry 未采集成功时返回空列表 —— 但那【不代表没有要求】，调用方必须先看 collection.ok，
    否则会把「不知道」当成「没有」。
    """
    ql = entry.get("qualification") or {}
    return [
        i
        for i in (ql.get("items") or [])
        if i.get("required") and not i.get("hidden") and i.get("available") is not False
    ]


def is_spu_category(entry: dict) -> bool:
    """该叶子类目是否为【标品】—— 发布第一页要求关联平台标品库里的 SPU。

    抖店在标品类目的发布第一页会多出一段「选择标品 / 当前类目为标准化商品，需填写标品信息」，
    其中【品牌】和【产品名称】都是必填。不填，第一页就过不去，而「保存草稿」按钮在第二页 ——
    失败于是伪装成「找不到保存草稿按钮」，与真因隔着一整页。这就是本判据存在的理由：
    让人在预处理阶段就知道这个商品会走到标品分支。

    **不代表发不出去。** 2026-09-04 在消毒湿巾类目实测走通了：品牌选「无品牌」（抖店自己
    给的正式选项，页面原话「可选无品牌」），产品名称是 auto-complete、接受自由文本，
    填叶子类目名即可，下一步通过。发布 book 第 14 步「标品门」已固化这条路。
    唯一不可碰的是标品候选行：点中一行，抖店会把该 SPU 的整套资质预填进来，包括别人
    公司的「消毒品卫生许可证编号」——那是借证发布。

    2026-09-04 实测：4275 个类目里 353 个命中（8.3%），样例为坚果炒货 / 童鞋 / 饮料。

    **为什么是 `support_spu_product` 而不是名字更像的 `must_spu`**：实测那个真正渲染出
    标品区块的类目 `must_spu` 反而是 False，非标品类目也是 False，它区分不了。
    正判据的页面级验证：同父的 消毒湿巾(True) 渲染标品区块、私护湿巾(False) 不渲染。
    即便如此，这条判据仍按【报告】用 —— 到底渲不渲由抖店当场决定，book 的门开在 DOM 上。

    entry 未采集成功时返回 False —— 但那是「不知道」不是「不是标品」，调用方必须先看
    collection.ok，同 blocking_qualifications 的约定。
    """
    additions = ((entry.get("raw") or {}).get("additions")) or {}
    return additions.get("support_spu_product") is True
