#!/usr/bin/env python3
"""投影层的纯函数回归。

不碰模型：检测通道慢（一次 14-21 秒）且是外部服务，把它绑进单测会让这套断言
既慢又不稳。findings 直接构造注入，测的是"拿到标注之后做什么"——那才是这一层
自己的逻辑，也是唯一会出错的部分。

跑：python3 .claude/skills/product-projection/test_project.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from detect import Finding, normalise_kind  # noqa: E402
from project import (  # noqa: E402
    missing_required_attributes, project, verdict, _pointer_get, collect_findings,
    mark_checked_images,
)

FAILURES: list[str] = []


def check(name: str, cond, detail: str = "") -> None:
    """`cond` 可以是布尔，也可以是一个返回布尔的函数。

    传函数的那种是为了让**取值本身**也在保护之内：断言写成
    `out["risks"][0]["evidence"] == "淘宝"` 时，如果上一条防线塌了、risks 是
    空的，这一行会 IndexError 把整个脚本带走 —— 于是屏幕上是一条堆栈，而不是
    "这三条具名检查挂了"。变异检验时这个区别很要命：崩溃告诉你出事了，具名失败
    告诉你出的是哪件事。"""
    try:
        ok = cond() if callable(cond) else cond
    except Exception as exc:  # noqa: BLE001 — 取值失败就是失败，不该炸掉整轮
        print(f"  FAIL {name} — 取值时抛了 {type(exc).__name__}: {exc}")
        FAILURES.append(name)
        return
    if ok:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))
        FAILURES.append(name)


def base_canonical() -> dict:
    return {
        "schemaVersion": 1,
        "title": {"text": "车载摆件"},
        "category": {"doudianLeafId": 1000000082},
        # 映射成功的属性一定带 doudianPropertyId —— 覆盖判据看的就是它。
        # 早期 fixture 只给 sourceName,恰好与抖店属性名同名才"通过",
        # 掩盖了「材质→镜架材质」这类改了名就误报缺失的真 bug。
        "attributes": [{"sourceName": "材质", "rawValue": "ABS", "values": ["ABS"],
                        "doudianPropertyId": "1688"}],
        "qualityReport": {"errors": [], "risks": [], "warnings": [], "pending": []},
    }


PROPS = {
    "cid": "1000000082",
    "name": "集成电路（IC）",
    "props": [
        {"id": "1687", "name": "品牌", "required": True},
        {"id": "1688", "name": "材质", "required": True},
        {"id": "1689", "name": "产地", "required": False},
        {"id": "1690", "name": "隐藏必填", "required": True, "hidden": True},
    ],
}


# ── 标注，不剔除 ──────────────────────────────────────────────────────────

print("标注")
found = [Finding(field="/title/text", kind="platform", evidence="淘宝", confidence=0.8)]
out = project(base_canonical(), PROPS, found)
check("风险进 risks 而不是 errors", len(out["qualityReport"]["risks"]) == 1 and not out["qualityReport"]["errors"],
      json.dumps(out["qualityReport"], ensure_ascii=False))
check("原文一个字没删", out["title"]["text"] == "车载摆件")
check("证据带上了，修改层才定位得到", lambda: out["qualityReport"]["risks"][0]["evidence"] == "淘宝")
check("field 是 JSON Pointer", lambda: out["qualityReport"]["risks"][0]["field"] == "/title/text")
check("code 是稳定的 snake_case", lambda: out["qualityReport"]["risks"][0]["code"] == "infringing_platform_mention")

src = base_canonical()
project(src, PROPS, found)
check("输入那份没被就地改", src["qualityReport"]["risks"] == [],
      "调用方手里的原始数据必须还是原始的，否则没法对比标注前后")

dup = project(base_canonical(), PROPS, found + found)
check("同一条标注不重复计数", len(dup["qualityReport"]["risks"]) == 1,
      f"{len(dup['qualityReport']['risks'])} 条")


# ── 与上游正则的重复 ─────────────────────────────────────────────────────

print("不跟上游重复报")
# build_canonical 有一套联系方式正则，把标题里的手机号记成 title_contact_info。
# 模型再看一遍同一句话，把同一个号记成 infringing_contact_info。code 不同、
# 字段和证据相同 —— 按 code 去重收不住，一个手机号会在 risks 里出现两次，而判定
# 是按条数报给人看的。
upstream = base_canonical()
upstream["qualityReport"]["risks"] = [
    {"code": "title_contact_info", "message": "标题含疑似手机号", "field": "/title/text", "evidence": "13800138000"}
]
same = [Finding(field="/title/text", kind="contact", evidence="13800138000", confidence=0.8)]
merged = project(upstream, PROPS, same)["qualityReport"]["risks"]
check("同一字段同一证据只留一条", len(merged) == 1, json.dumps(merged, ensure_ascii=False))
check("留下的是上游那条（确定、免费、可复现）", lambda: merged[0]["code"] == "title_contact_info")

# 不同证据仍然各留各的
other = [Finding(field="/title/text", kind="platform", evidence="淘宝", confidence=0.8)]
both = project(upstream, PROPS, same + other)["qualityReport"]["risks"]
check("不同证据不会被吃掉", len(both) == 2, json.dumps(both, ensure_ascii=False))

# 没有 evidence 的条目按 code 区分,否则会被吃成一条
noev = base_canonical()
noev["qualityReport"]["pending"] = [
    {"code": "brand_id_unmapped", "message": "a", "field": "/brand"},
    {"code": "qualifications_unchecked", "message": "b", "field": "/brand"},
]
kept = project(noev, PROPS, [])["qualityReport"]["pending"]
check("没有证据的两条不同问题不会被合并",
      len([e for e in kept if e["code"] in ("brand_id_unmapped", "qualifications_unchecked")]) == 2,
      json.dumps(kept, ensure_ascii=False))


# ── 必填属性：匹配，不生成 ────────────────────────────────────────────────

print("必填属性")
gaps = missing_required_attributes(base_canonical(), PROPS)
codes = [g["message"] for g in gaps]
check("缺的必填被报出来", any("品牌" in m for m in codes), str(codes))
check("有的必填不报", not any("材质" in m for m in codes), str(codes))
check("非必填不报", not any("产地" in m for m in codes), str(codes))
check("隐藏的必填不报（后台自己不显示，填不了）", not any("隐藏必填" in m for m in codes), str(codes))
check("缺口带 property_id，人填的时候要对得上", lambda: "1687" in gaps[0]["evidence"], str(gaps))

empty = base_canonical()
empty["attributes"] = [{"sourceName": "品牌", "rawValue": "  ", "values": [" "],
                        "doudianPropertyId": "1687"}]
check("空白值不算填了", any("品牌" in g["message"] for g in missing_required_attributes(empty, PROPS)))

# ── 覆盖判据是 property_id，不是名字 ──────────────────────────────────────
# 真实场景:1688 的「材质」映射到抖店的「镜架材质」(id 1951)。按名字比对会把这条
# 报成缺失,尽管它已经映射好、会被投影进 product_format_new。
renamed = base_canonical()
renamed["attributes"] = [{"sourceName": "材质", "rawValue": "树脂", "values": ["树脂"],
                          "doudianPropertyId": "1688"},
                         {"sourceName": "镜片功能", "rawValue": "防紫外线",
                          "values": ["防紫外线"], "doudianPropertyId": "1687"}]
renamed_msgs = [g["message"] for g in missing_required_attributes(renamed, PROPS)]
check("来源名与抖店名不同但 property_id 命中 → 算覆盖",
      renamed_msgs == [], str(renamed_msgs))

# 反向:名字对上了、property_id 没映射上 —— 投影时进不了 product_format_new,
# 不能当成已填静默放行(漏报比误报危险)。
name_only = base_canonical()
name_only["attributes"] = [{"sourceName": "品牌", "rawValue": "某某", "values": ["某某"]},
                           {"sourceName": "材质", "rawValue": "ABS", "values": ["ABS"],
                            "doudianPropertyId": "1688"}]
name_only_msgs = [g["message"] for g in missing_required_attributes(name_only, PROPS)]
check("名字对上但无 property_id → 仍然报，且说明是没映射上",
      len(name_only_msgs) == 1 and "没有映射到 property_id" in name_only_msgs[0],
      str(name_only_msgs))

# 品牌不走 attributes[],由 shop-profile 落在 canonical.brand.doudianBrandId。
# 不认这条通道的话,任何必填含「品牌」的类目都恒定误报,与商品数据无关。
branded = base_canonical()
branded["brand"] = {"doudianBrandId": 596120136}
branded_msgs = [g["message"] for g in missing_required_attributes(branded, PROPS)]
check("品牌由 brand.doudianBrandId 满足 → 不报缺失",
      not any("品牌" in m for m in branded_msgs), str(branded_msgs))
check("没有 brand.doudianBrandId 时品牌照报",
      any("品牌" in g["message"] for g in missing_required_attributes(base_canonical(), PROPS)))


# ── 没有类目表 ≠ 属性齐了 ────────────────────────────────────────────────

print("拿不到类目表")
check("说出来「没校验」而不是默默放行",
      lambda: any(p["code"] == "category_props_unknown" for p in project(base_canonical(), None, [])["qualityReport"]["pending"]))
check("因此判定不是 ready", lambda: verdict(project(base_canonical(), None, []))["status"] != "ready")


# ── 三态判定 ─────────────────────────────────────────────────────────────

print("判定")
clean = base_canonical()
clean["attributes"] = [{"sourceName": "品牌", "rawValue": "无", "values": ["无"],
                        "doudianPropertyId": "1687"},
                       {"sourceName": "材质", "rawValue": "ABS", "values": ["ABS"],
                        "doudianPropertyId": "1688"}]
check("齐了就 ready", verdict(project(clean, PROPS, []))["status"] == "ready",
      json.dumps(verdict(project(clean, PROPS, [])), ensure_ascii=False))
check("有风险 → needs_human，不是 blocked",
      verdict(project(clean, PROPS, found))["status"] == "needs_human")
check("缺必填 → needs_human", verdict(project(base_canonical(), PROPS, []))["status"] == "needs_human")

# ── 「类目根本没有这个属性」记录但不阻塞 ─────────────────────────────────
#
# 1688 的属性数常年多于抖店叶子类目（实测 15 vs 4），把「无对应项」当阻塞项会让
# pending 恒非空、ready 事实上不可达，自动发布分支形同虚设。豁免只给「查清楚了确实
# 没有」这一种；「没查清楚」的三种（占满 / 离线未匹配 / 通道失败）仍然挡。
noted = base_canonical()
noted["attributes"] = list(clean["attributes"])
noted["qualityReport"]["pending"] = [
    {"code": "attribute_name_no_counterpart", "message": "来源属性「货号」在该类目属性里没有语义对应项"},
]
check("只有「类目无对应项」→ ready",
      lambda: verdict(noted)["status"] == "ready",
      json.dumps(verdict(noted), ensure_ascii=False))
check("ready 时把记录下来的条数说出来",
      lambda: "1 项" in verdict(noted)["reason"],
      verdict(noted)["reason"])

blocked_mix = base_canonical()
blocked_mix["attributes"] = list(clean["attributes"])
blocked_mix["qualityReport"]["pending"] = [
    {"code": "attribute_name_no_counterpart", "message": "无对应项"},
    {"code": "attribute_name_unmapped", "message": "LLM 映射通道失败(connection refused)"},
]
check("混着「没查清楚」的 → 仍 needs_human",
      lambda: verdict(blocked_mix)["status"] == "needs_human",
      json.dumps(verdict(blocked_mix), ensure_ascii=False))
check("needs_human 的计数只算真正挡路的那些",
      lambda: verdict(blocked_mix)["pending"] == 1,
      json.dumps(verdict(blocked_mix), ensure_ascii=False))

# ── reason 必须说清是哪一类 pending ──────────────────────────────────────
#
# 人看到 needs_human 之后的下一个动作，完全取决于挡路的是哪一类：缺必填要去补属性，
# 投影 pending 要去处理 value_id / 图片检测。原来这句话一律写「N 项必填待补」，于是
# 罗小黑那件商品报「1 项必填待补」而必填其实 3/3 齐全 —— 那 1 项是货号没有 value_id。
# 判定没错，是结论在骗人；被支去查一个没问题的地方，比没有结论更贵。
mixed = base_canonical()
mixed["attributes"] = list(clean["attributes"])
mixed["qualityReport"]["pending"] = [
    {"code": "addv2_projection_pending", "message": "1 个属性值待人工处理 (diyType=1,value_id=None)"},
    {"code": "missing_required_attribute", "message": "必填属性「材质」来源数据里没有"},
]
check("混合 pending · 两类都点名",
      lambda: "addv2_projection_pending 1 项" in verdict(mixed)["reason"]
              and "missing_required_attribute 1 项" in verdict(mixed)["reason"],
      verdict(mixed)["reason"])

only_projection = base_canonical()
only_projection["attributes"] = list(clean["attributes"])
only_projection["qualityReport"]["pending"] = [
    {"code": "addv2_projection_pending", "message": "1 个属性值待人工处理"},
]
check("只有投影 pending 时不得说成「必填待补」",
      lambda: "必填" not in verdict(only_projection)["reason"],
      verdict(only_projection)["reason"])
check("只有投影 pending 时仍然是 needs_human",
      lambda: verdict(only_projection)["status"] == "needs_human",
      json.dumps(verdict(only_projection), ensure_ascii=False))

risky = base_canonical()
risky["attributes"] = list(clean["attributes"])
risky["qualityReport"]["pending"] = [{"code": "attribute_name_no_counterpart", "message": "无对应项"}]
risky["qualityReport"]["risks"] = [{"code": "infringing_trademark", "message": "疑似他人商标"}]
check("豁免 pending 不等于放过 risks（水印/侵权照挡）",
      lambda: verdict(risky)["status"] == "needs_human",
      json.dumps(verdict(risky), ensure_ascii=False))

broken = base_canonical()
broken["qualityReport"]["errors"] = [{"code": "source_unreachable", "message": "来源页打不开"}]
check("有 errors 才 blocked", verdict(project(broken, PROPS, found))["status"] == "blocked",
      "「有个水印要确认」和「来源页根本没抓到」不该看起来一样严重")


# ── 模型给的类型名 ──────────────────────────────────────────────────────

print("类型名归一")
# 提示词要英文枚举，模型给中文 —— 实测同一条提示词三次分别回「平台名」「平台」
# 「platform」。之前把中文当"不认识"归到 trademark，于是一个平台名被报成商标
# 侵权；这两类在抖店那边的处理完全不同。真实数据抓到的 bug，注入英文枚举的
# 单测抓不到。
check("中文平台名归到 platform", normalise_kind("平台名") == "platform")
check("裸「平台」也认", normalise_kind("平台") == "platform")
check("英文枚举照常", normalise_kind("platform") == "platform")
check("店铺名归到 shop", normalise_kind("店铺名") == "shop")
check("微信归到 contact", normalise_kind("微信") == "contact")
check("认不出来返回 None 而不是硬塞一类",
      normalise_kind("莫名其妙") is None and normalise_kind(None) is None and normalise_kind(123) is None,
      "硬塞会让「认不出来」和「确实是商标」在结果里长得一样")


# ── JSON Pointer 取值 ────────────────────────────────────────────────────

print("Pointer")
doc = {"a": {"b": [10, 20]}}
check("取得到嵌套值", _pointer_get(doc, "/a/b/1") == 20)
check("取不到返回 None 而不是抛", _pointer_get(doc, "/a/nope/3") is None)
check("越界返回 None", _pointer_get(doc, "/a/b/9") is None)


print()
if FAILURES:
    print(f"{len(FAILURES)} 条失败：" + "、".join(FAILURES))
    sys.exit(1)

# ── 图片检测：并发 + 畸形输出重试 ──────────────────────────────────────
print("图片检测")

import detect as _detect  # noqa: E402

_calls = []
def _fake_run(prompt, image=None):
    _calls.append(str(image))
    if 'images 数组' in prompt:
        return '{"images": [{"slot": 1, "hasOverlay": false, "items": []}, {"slot": 2, "hasOverlay": false, "items": []}]}'
    return '{"hasOverlay": false, "items": []}'

_orig_run = _detect._run_detector
_orig_text = _detect.detect_text
_detect._run_detector = _fake_run
# 文案通道也要 stub:collect_findings 会对 title/description 调 detect_text →
# 真的起 opencode。本文件开头就写了「不碰模型」,让单测去打外部服务既慢又不稳。
_detect.detect_text = lambda text, field: []
import project as _project
_project.detect_text = _detect.detect_text
try:
    can = base_canonical()
    can["images"] = {"main": [{}, {}]}
    from PIL import Image
    import io
    def _jpeg():
        out = io.BytesIO()
        Image.new("RGB", (800, 800), (20, 20, 20)).save(out, "JPEG")
        return out.getvalue()
    got = collect_findings(can, {"/images/main/0": _jpeg(), "/images/main/1": _jpeg()}, skip_model=False)
    check("多张主图批量送去检测", len(_calls) == 1, f"calls={len(_calls)}")
    check("干净图不产生 finding", got == [], str(got))
finally:
    _detect._run_detector = _orig_run
    _detect.detect_text = _orig_text
    _project.detect_text = _orig_text

# 截断的 JSON 是**输出层面的瞬时故障**,不是「这张图没法看」。不重试的话,
# 一张图的半句 JSON 会让 collect_findings 把整个商品判成通道不可用(退出码 2)。
_seq = ['{"hasOverlay": false, "items": []', '{"hasOverlay": false, "items": []}']
def _flaky(prompt, image=None):
    return _seq.pop(0)
_detect._run_detector = _flaky
try:
    out = _detect.detect_image(b"image", "/images/main/0")
    check("畸形 JSON 重试一次后成功", out == [] and not _seq, f"out={out} left={_seq}")
except Exception as exc:  # noqa: BLE001
    check("畸形 JSON 重试一次后成功", False, f"抛了 {type(exc).__name__}: {exc}")
finally:
    _detect._run_detector = _orig_run

# 环境问题不该重试 —— 重试只是把同一个确定性失败再跑一遍。
_env_calls = []
def _missing(prompt, image=None):
    _env_calls.append(1)
    raise _detect.DetectorUnavailable("找不到 opencode，装了吗？")
_detect._run_detector = _missing
try:
    _detect.detect_image(b"image", "/images/main/0")
    check("环境问题不重试", False, "没抛")
except _detect.DetectorUnavailable:
    check("环境问题不重试", len(_env_calls) == 1, f"calls={len(_env_calls)}")
finally:
    _detect._run_detector = _orig_run

print("全部通过")


# ── checked 的写回：门能关，也要能开 ─────────────────────────────────────
#
# 在这套断言之前，全仓没有任何地方把 images[].checked 置 true —— 它在
# build_canonical 的 to_image() 初始化为 False 之后再没人动过，于是 build_addv2 的
# 「未过水印/侵权判定」这条 pending 恒真，verdict 永远到不了 ready。修的是这一段，
# 而下面四条边界是「没检查 ≠ 干净」的具体形态，一条都不能松。

print("checked 写回")


def _with_images(n_main: int = 2, n_detail: int = 1) -> dict:
    c = base_canonical()
    c["images"] = {
        "main": [{"url": f"https://e.com/m{i}.jpg", "sourceUrl": f"https://e.com/m{i}.jpg",
                  "checked": False} for i in range(n_main)],
        "detail": [{"url": f"https://e.com/d{i}.jpg", "sourceUrl": f"https://e.com/d{i}.jpg",
                    "checked": False} for i in range(n_detail)],
        "removed": [],
    }
    return c


ASSETS = {"/images/main/0": b"x", "/images/main/1": b"y", "/images/detail/0": b"z"}

clean_c = _with_images()
marked = mark_checked_images(clean_c, ASSETS, [], skip_model=False)
check("检测跑过且干净 → 标成 checked",
      marked == 3 and all(i["checked"] for i in clean_c["images"]["main"] + clean_c["images"]["detail"]),
      json.dumps(clean_c["images"], ensure_ascii=False))
check("详情图同样送检、同样被标记（它们也要发到抖店）",
      all(i["checked"] for i in clean_c["images"]["detail"]),
      json.dumps(clean_c["images"]["detail"], ensure_ascii=False))

detail_flagged = _with_images()
mark_checked_images(detail_flagged, ASSETS,
                    [Finding(field="/images/detail/0", kind="platform", evidence="淘宝", confidence=0.8)],
                    skip_model=False)
check("详情图有 finding 时同样不标",
      detail_flagged["images"]["detail"][0]["checked"] is False,
      json.dumps(detail_flagged["images"]["detail"], ensure_ascii=False))

flagged_c = _with_images()
mark_checked_images(flagged_c, ASSETS,
                    [Finding(field="/images/main/0", kind="trademark", evidence="Relax", confidence=0.8)],
                    skip_model=False)
check("有 finding 的那张不标", flagged_c["images"]["main"][0]["checked"] is False,
      json.dumps(flagged_c["images"]["main"][0], ensure_ascii=False))
check("同一批里干净的那张照标", flagged_c["images"]["main"][1]["checked"] is True)

skipped_c = _with_images()
n = mark_checked_images(skipped_c, ASSETS, [], skip_model=True)
check("--no-llm 没跑检测 → 一张都不标（没检查 ≠ 干净）",
      n == 0 and not any(i["checked"] for i in skipped_c["images"]["main"]))

nobytes_c = _with_images()
mark_checked_images(nobytes_c, {"/images/main/0": b"x"}, [], skip_model=False)
check("下载失败没字节的那张不标", nobytes_c["images"]["main"][1]["checked"] is False,
      json.dumps(nobytes_c["images"]["main"], ensure_ascii=False))

check("没有字节的详情图也不标（判据对两类图一视同仁）",
      nobytes_c["images"]["detail"][0]["checked"] is False,
      json.dumps(nobytes_c["images"]["detail"], ensure_ascii=False))


# ── 覆盖 = 抖店收得下的值，不是"源站填了字" ──────────────────────────────
#
# 能不能发布看的是抖店必填有没有真的填上。一个 property_id 映射上了、值却没匹配到
# 抖店 value_id 的枚举属性，build_addv2 会把它踢进 pending_di（"进 addv2 必被拒"
# 是那段代码自己的注释）——发布时那个槽位仍然是空的。只看 rawValue 会把它判成已覆盖。

print("覆盖判据：抖店收得下的值")

ENUM_PROPS = {
    "cid": "1",
    "name": "测试类目",
    "props": [{"id": "1687", "name": "颜色", "required": True,
               "options": [["11", "红"], ["12", "蓝"]]}],
}
TEXT_PROPS = {
    "cid": "1",
    "name": "测试类目",
    "props": [{"id": "2001", "name": "货号", "required": True}],  # 自由文本：无 options
}


def _attr(pid, raw, value_id):
    c = base_canonical()
    c["attributes"] = [{"sourceName": "x", "rawValue": raw, "values": [raw],
                        "doudianPropertyId": pid,
                        "doudianValues": [{"name": raw, "valueId": value_id,
                                           "diyType": 0 if value_id is not None else 1}]}]
    return c


check("枚举必填：有 property_id 但 valueId 为空 → 仍然报缺口",
      lambda: len(missing_required_attributes(_attr("1687", "藏青", None), ENUM_PROPS)) == 1,
      str(missing_required_attributes(_attr("1687", "藏青", None), ENUM_PROPS)))
check("枚举必填：valueId 有了 → 算覆盖",
      missing_required_attributes(_attr("1687", "红", 11), ENUM_PROPS) == [],
      str(missing_required_attributes(_attr("1687", "红", 11), ENUM_PROPS)))
check("自由文本必填：没有 options 就不问 valueId（否则是假缺口）",
      missing_required_attributes(_attr("2001", "A-203", None), TEXT_PROPS) == [],
      str(missing_required_attributes(_attr("2001", "A-203", None), TEXT_PROPS)))
