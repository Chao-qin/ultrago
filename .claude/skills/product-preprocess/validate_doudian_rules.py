#!/usr/bin/env python3
"""canonical.json / final.json → 抖店发布前硬约束校验报告

PIPE-6。canonical.schema.json 已经把几条抖店硬约束写进了字段约束
（title.text 的 minLength/maxLength、images 的 x-doudian-total-max、
skus[].price 的 multipleOf），但**没有任何东西执行它们** —— schema 是
声明，声明不会自己跑。这个文件就是执行者。

三条设计约束，每条都是为了防一种具体的错法：

1. 阈值一律从 schema 注册表读，不在本文件里重述。
   与 build_canonical.py 的规则 1 同源：抄进代码的阈值就是会和契约漂移
   的阈值。读不到 schema 就 exit 2，不猜。

2. 判定是三值的：pass / fail / **unknown**，unknown 绝不折叠成 pass。
   这是本仓库反复吃过亏的地方 —— canonical.schema.json 里
   「checked: false 表示【未检测】，不表示干净」「未探测时省略 —— 省略
   表示未知，不表示合格」说的是同一件事。PIPE-5 那个「检查过的被剔光、
   没检查的全留下」就是 unknown 被当成 pass 的后果。没有类目属性数据时
   规则 7 报 unknown，不报 pass。

3. 退出码区分「没问题」和「没检查」：
     0 = 全部 pass
     1 = 有 fail（阻断，别发布）
     3 = 无 fail 但有 unknown（**没验完**，别当成绿灯）
     2 = 校验器自己跑不起来（拿不到 schema）
   把 3 和 0 分开，是为了让调用方不能靠 `if rc == 0` 就宣称合格。

用法:
    python3 validate_doudian_rules.py <canonical.json|final.json> \\
        [--category-properties reports/doudian-category-properties.json] \\
        [--category-id 1000001531] [--json]

规则 7 需要类目属性数据（--category-properties）和一个叶子类目 id 才能判定。
canonical 的 category.doudianLeafId 本期恒为 null（schema 自己标了「本期
未实现映射」），final.json 根本没有这个字段，所以不传 --category-id 时
规则 7 一定是 unknown —— 这是如实反映现状，不是校验器的缺陷。
"""

import argparse
import json
import sys
from pathlib import Path

# 复用 build_canonical 的既有实现，不另起炉灶：
#   doudian_char_len —— 抖店口径字符数（汉字算 2）。重写一份就是第二个真相。
#   fetch_schema     —— 从 console 注册表取契约，含 exit 2 的失败语义。
from build_canonical import doudian_char_len, fetch_schema

# 类目采集产物的读取适配层。规则 7 只关心 props[*].required / name，形状归一在这里做，
# 规则本身不必知道抖店改过一次下发口径。
sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
from category_capture import load_props_capture  # noqa: E402

PASS, FAIL, UNKNOWN = "pass", "fail", "unknown"

# 类目属性表里品牌槽位的属性名(与 projection/project.py 的同名常量同义)。
BRAND_PROP_NAME = "品牌"


# --------------------------------------------------------------------------
# 阈值：全部来自 schema，见模块头规则 1
# --------------------------------------------------------------------------

def load_rule_limits(schema):
    """把 7 条规则要用的阈值从 canonical schema 里抽出来。

    接收已解析的文档，来源（注册表 / 测试 fixture）由调用方决定，
    这样这个函数是纯的、不需要跑着 console 就能测。

    缺任何一个阈值就 exit 2：拿猜来的上限做校验，会产出「我们这边过了、
    抖店那边挂了」的数据，比不跑更糟。
    """
    try:
        props = schema["properties"]
        images = props["images"]["properties"]
        title = props["title"]["properties"]["text"]
        price = props["skus"]["items"]["properties"]["price"]
        return {
            "title_min": title["minLength"],
            "title_max": title["maxLength"],
            "main_max": images["main"]["maxItems"],
            "detail_min": images["detail"]["minItems"],
            "total_max": props["images"]["x-doudian-total-max"],
            "price_step": price["multipleOf"],
        }
    except (KeyError, TypeError) as e:
        print(f"FATAL: canonical schema 缺少校验器需要的约束: {e}", file=sys.stderr)
        print("校验器拒绝用猜来的阈值运行。", file=sys.stderr)
        raise SystemExit(2)


# --------------------------------------------------------------------------
# 形状适配
# --------------------------------------------------------------------------

def extract_facts(doc):
    """把 canonical.json 或 final.json 归一成 7 条规则要用的事实。

    两种形状同时存在于仓库里：canonical.json 是契约主产物，final.json 是
    过渡产物（run_pipeline.py 里写明「等下游都改读 canonical 之后删掉」）。
    实测 products/ 下 3 个商品目前**只有** final.json，所以只认 canonical
    的校验器等于一个都跑不了。适配层只做字段搬运，不做任何补值。
    """
    is_canonical = "schemaVersion" in doc and isinstance(doc.get("title"), dict)

    if is_canonical:
        title = (doc.get("title") or {}).get("text") or ""
        images = doc.get("images") or {}
        main = [i.get("url") for i in (images.get("main") or [])]
        detail = [i.get("url") for i in (images.get("detail") or [])]
        removed = images.get("removed") or []
        dims = [
            {"name": s.get("name"), "values": s.get("values") or []}
            for s in (doc.get("specs") or [])
        ]
        prices = [s.get("price") for s in (doc.get("skus") or [])]
        sku_count = len(doc.get("skus") or [])
        leaf_id = (doc.get("category") or {}).get("doudianLeafId")
        # canonical 只有 doudianPropertyId，没有 value id —— 那正是 PIPE-2。
        mapped_props = [
            str(a["doudianPropertyId"])
            for a in (doc.get("attributes") or [])
            if a.get("doudianPropertyId") is not None
        ]
    else:
        title = doc.get("title") or ""
        images = doc.get("images") or {}
        main = list(images.get("main") or [])
        detail = list(images.get("detail") or [])
        removed = doc.get("removedImages") or []
        dims = [
            {"name": p.get("sourceName"), "values": p.get("values") or []}
            for p in (doc.get("skuProperties") or [])
        ]
        # final.json 的售价在 pricing.skuPrices[].final；skuTable.rows 里的
        # 是 sourcePrice（采购价），拿它校验会验错对象。
        prices = [p.get("final") for p in ((doc.get("pricing") or {}).get("skuPrices") or [])]
        sku_count = len((doc.get("skuTable") or {}).get("rows") or [])
        leaf_id = None  # final.json 没有类目 id 字段，只有类目名字符串
        mapped_props = []

    # spec_pic 只来自主规格（第一维）的规格图，与 addV2 的 spec_pic 口径一致。
    spec_pics = [
        v.get("imageUrl")
        for v in (dims[0]["values"] if dims else [])
        if isinstance(v, dict) and v.get("imageUrl")
    ]

    return {
        "shape": "canonical" if is_canonical else "final",
        "title": title,
        "main": main,
        "detail": detail,
        "spec_pics": spec_pics,
        "removed": removed,
        "dims": dims,
        "prices": [p for p in prices if p is not None],
        "sku_count": sku_count,
        "leaf_id": leaf_id,
        "mapped_props": mapped_props,
        # 品牌不在 attributes[] 里,所以永远进不了 mapped_props。它由 shop-profile 给,
        # 落在 canonical.brand.doudianBrandId,投影成 addV2 顶层的 standard_brand_id。
        # 规则 7 要单独认这条通道,否则任何必填含「品牌」的类目都会假 FAIL(exit 1 阻断发布)。
        "brand_id": (doc.get("brand") or {}).get("doudianBrandId") if is_canonical else None,
    }


# --------------------------------------------------------------------------
# 7 条规则
# --------------------------------------------------------------------------

def _r(rule, name, status, detail):
    return {"rule": rule, "name": name, "status": status, "detail": detail}


def rule_1_description_required(f, limits):
    """详情图剔空后 description 必填无解。"""
    n, need = len(f["detail"]), limits["detail_min"]
    if n >= need:
        return _r(1, "description 必填", PASS, f"详情图 {n} 张")
    # 空和空得有原因是两回事。PIPE-5 的第 1 个后果就是这里只静默变成 []，
    # 让「被侵权判定剔光」和「压根没采到」长得一模一样。
    if f["removed"]:
        reasons = sorted({str(r.get("reason", "")).split("（")[0] for r in f["removed"] if r.get("reason")})
        return _r(1, "description 必填", FAIL,
                  f"详情图 0 张，但 removed 里有 {len(f['removed'])} 条剔除记录"
                  f"（原因: {', '.join(reasons) or '未注明'}）—— 是被剔光，不是没采到")
    return _r(1, "description 必填", FAIL, f"详情图 {n} 张 < 必需 {need} 张，且无剔除记录（疑似未采集到）")


def rule_2_pic_limit(f, limits):
    """pic 最多 5 张。"""
    n, cap = len(f["main"]), limits["main_max"]
    if n == 0:
        return _r(2, f"pic ≤ {cap}", FAIL, "主图 0 张（pic 是必填项）")
    if n <= cap:
        return _r(2, f"pic ≤ {cap}", PASS, f"主图 {n} 张")
    return _r(2, f"pic ≤ {cap}", FAIL, f"主图 {n} 张，超 {n - cap} 张")


def rule_3_title_length(f, limits):
    """标题按抖店口径 ≤60 字符（汉字算 2）。"""
    w = doudian_char_len(f["title"])
    lo, hi = limits["title_min"], limits["title_max"]
    naive = len(f["title"])
    if w < lo:
        return _r(3, f"标题 {lo}-{hi} 字符", FAIL, f"抖店口径 {w} < {lo}")
    if w > hi:
        return _r(3, f"标题 {lo}-{hi} 字符", FAIL,
                  f"抖店口径 {w} > {hi}，超 {w - hi}（len() 只报 {naive}，会漏掉）")
    return _r(3, f"标题 {lo}-{hi} 字符", PASS,
              f"抖店口径 {w}/{hi}（余 {hi - w}）；len() = {naive}，两者不可混用")


def rule_4_total_images(f, limits):
    """pic + description + spec_pic ≤ 50 跨字段总数。"""
    a, b, c = len(f["main"]), len(f["detail"]), len(f["spec_pics"])
    total, cap = a + b + c, limits["total_max"]
    breakdown = f"pic {a} + description {b} + spec_pic {c} = {total}"
    if total <= cap:
        return _r(4, f"图片合计 ≤ {cap}", PASS, f"{breakdown} ≤ {cap}")
    return _r(4, f"图片合计 ≤ {cap}", FAIL, f"{breakdown} > {cap}，超 {total - cap} 张")


def rule_5_sku_matches_combinations(f, _limits):
    """SKU 数必须 == 规格组合数。"""
    if not f["dims"]:
        return _r(5, "SKU 数 == 规格组合数", UNKNOWN, "无规格维度，无法计算组合数")
    combos = 1
    for d in f["dims"]:
        combos *= len(d["values"])
    shape = " × ".join(f"{d['name']}({len(d['values'])})" for d in f["dims"])
    if f["sku_count"] == combos:
        return _r(5, "SKU 数 == 规格组合数", PASS, f"{f['sku_count']} == {shape} = {combos}")
    return _r(5, "SKU 数 == 规格组合数", FAIL, f"SKU {f['sku_count']} != {shape} = {combos}")


def rule_6_price_integer_cents(f, limits):
    """价格 ×100 必须为整数分。"""
    if not f["prices"]:
        return _r(6, "价格 ×100 为整数分", UNKNOWN, "没有价格数据")
    bad = []
    for p in f["prices"]:
        cents = p * 100
        # 二进制浮点让 14.5*100 = 1449.9999...，直接 is_integer() 会误报。
        # 判据是「离最近的整数分有多远」，容差远小于一分钱。
        if abs(cents - round(cents)) > 1e-6:
            bad.append(p)
    if bad:
        return _r(6, "价格 ×100 为整数分", FAIL,
                  f"{len(bad)} 个价格转分后不是整数: {bad[:5]}（markup 用小数就会命中）")
    return _r(6, "价格 ×100 为整数分", PASS,
              f"{len(f['prices'])} 个价格全部为整数分（步长 {limits['price_step']}）")


def rule_7_required_category_props(f, _limits, cat_props, category_id):
    """类目必填属性未覆盖则发布被拒。"""
    cid = category_id or f["leaf_id"]
    if cid is None:
        return _r(7, "类目必填属性已覆盖", UNKNOWN,
                  "没有叶子类目 id（canonical.category.doudianLeafId 本期恒为 null，"
                  "final.json 无此字段）—— 未检查，不等于通过")
    if cat_props is None:
        return _r(7, "类目必填属性已覆盖", UNKNOWN,
                  f"未提供类目属性数据（--category-properties），无法判定类目 {cid} 要哪些必填项")
    entry = cat_props.get(str(cid))
    if entry is None:
        return _r(7, "类目必填属性已覆盖", UNKNOWN, f"类目属性数据里没有类目 {cid}")

    required = [p for p in (entry.get("props") or []) if p.get("required")]
    have = set(f["mapped_props"])
    # 品牌槽位由 brand.doudianBrandId 满足(见 _flatten 的 brand_id 注释)。品牌的
    # property_id 逐类目不同,名字是稳定的,所以按名字认槽 —— 这是类目数据给得出的唯一稳定键。
    if f.get("brand_id"):
        have |= {str(p["id"]) for p in required if (p.get("name") or "") == BRAND_PROP_NAME}
    missing = [p for p in required if str(p.get("id")) not in have]
    where = f"{entry.get('name')}（{cid}）必填 {len(required)} 项"
    if not required:
        return _r(7, "类目必填属性已覆盖", PASS, f"{entry.get('name')}（{cid}）无必填属性")
    if not have:
        # 一个都没映射，和「映射了但漏了几个」是不同的失败，要说清楚是能力缺口。
        return _r(7, "类目必填属性已覆盖", UNKNOWN,
                  f"{where}: {', '.join(p['name'] for p in required)}；"
                  f"但本商品一个属性都未映射到 property_id（PIPE-2：canonical 无处存 value id）")
    if missing:
        return _r(7, "类目必填属性已覆盖", FAIL,
                  f"{where}，缺 {len(missing)} 项: {', '.join(p['name'] for p in missing)}")
    return _r(7, "类目必填属性已覆盖", PASS, f"{where}，全部已映射")


def validate(doc, limits, cat_props=None, category_id=None):
    """跑完 7 条规则，返回结构化报告。纯函数，不读文件不打印。"""
    f = extract_facts(doc)
    results = [
        rule_1_description_required(f, limits),
        rule_2_pic_limit(f, limits),
        rule_3_title_length(f, limits),
        rule_4_total_images(f, limits),
        rule_5_sku_matches_combinations(f, limits),
        rule_6_price_integer_cents(f, limits),
        rule_7_required_category_props(f, limits, cat_props, category_id),
    ]
    counts = {s: sum(1 for r in results if r["status"] == s) for s in (PASS, FAIL, UNKNOWN)}
    return {"shape": f["shape"], "results": results, "counts": counts}


def exit_code(report):
    """0 全过 / 1 有 fail / 3 没 fail 但有 unknown（= 没验完，不是绿灯）。"""
    if report["counts"][FAIL]:
        return 1
    return 3 if report["counts"][UNKNOWN] else 0


def main():
    parser = argparse.ArgumentParser(description="抖店发布前 7 条硬约束校验（PIPE-6）")
    parser.add_argument("product", help="canonical.json 或 final.json 路径")
    parser.add_argument("--category-properties",
                        help="doudian-category-properties 数据路径，规则 7 需要")
    parser.add_argument("--category-id", type=int,
                        help="叶子类目 id；canonical 里为 null / final.json 无此字段时用它补")
    parser.add_argument("--console-url", default=None,
                        help="schema 注册表所在 console（默认 $CONSOLE_URL 或 127.0.0.1:8790）")
    parser.add_argument("--schema-version", type=int, default=None,
                        help="锁定 canonical schema 版本（默认取当前生效版本）")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而非文本")
    args = parser.parse_args()

    limits = load_rule_limits(fetch_schema(base_url=args.console_url, version=args.schema_version))
    doc = json.loads(Path(args.product).read_text(encoding="utf-8"))
    # 走适配层：2026-09-03 采集口径改为原样保留后，文件顶层多了 data 一层、属性项用
    # label 而不是 name。规则 7 读的是 entry["props"][*]["required"]/["name"]，适配层把
    # 新形状归一回那个形状，所以规则本身一行不用动；旧文件也照读。
    cat_props = (
        load_props_capture(Path(args.category_properties))
        if args.category_properties else None
    )

    report = validate(doc, limits, cat_props, args.category_id)
    rc = exit_code(report)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return rc

    mark = {PASS: "✓", FAIL: "✗", UNKNOWN: "?"}
    print(f"→ {args.product}  [{report['shape']}]")
    for r in report["results"]:
        print(f"  {mark[r['status']]} 规则{r['rule']} {r['name']}: {r['detail']}")
    c = report["counts"]
    print(f"  合计 pass={c[PASS]} fail={c[FAIL]} unknown={c[UNKNOWN]}  → exit {rc}")
    if rc == 3:
        print("  注意：exit 3 = 没有失败项，但有未检查项。不要当作通过。")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
