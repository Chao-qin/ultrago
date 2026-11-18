#!/usr/bin/env python3
"""投影层：canonical 商品 + 类目属性表 → 带标注的 canonical + 一个可发布判定。

这一层不改商品，只回答三个问题：
  1. 这个商品有哪些侵权/合规风险？   → qualityReport.risks
  2. 抖店这个类目要求的必填属性齐了吗？ → qualityReport.pending
  3. 现在能不能进发布？             → verdict

**标注写进 canonical 自己的 qualityReport，不另起结构。** 那份 schema 早就把
语义定死了，而且定得比我想的准：`risks` 的说明里明写「品牌/IP、极限词、授权、
资质、水印、联系方式。**不得当作 error 中止流程**」，`pending` 是「这里必须有
值但我们还没能力算出来…填表单阶段必须逐项人工兜底」。也就是说"标注而非剔除"和
"必填不能靠猜"不是本文件的发明，是既有契约，这里只是第一次真的去满足它。

**必填属性一个都不编。** 抖店对属性不实是有处罚的，而模型面对「适用车型」这种
1688 页面上根本没有的字段，只会给一个看起来很合理的答案。所以补全只做**抽取**
（从标题、已有属性、规格里找），找不到就落进 pending 让人来填 —— 卡住比编造好。

不写库、不发请求（除了检测通道）。输入输出都是 stdin/stdout 上的 JSON，所以它
在 flow 里就是一个普通的「跑命令」节点。
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from execution_budget import announce_work, plan_inspection
if __package__:
    from .detect import Finding, DetectorUnavailable, detect_montage, detect_text, detection_budget, TIMEOUT_S
else:
    from detect import Finding, DetectorUnavailable, detect_montage, detect_text, detection_budget, TIMEOUT_S
from vision_montage import MontageTask, build_montages
# 类目记录的读取适配层：2026-09-03 单叶子记录改为【原样保留】抖店下发的结构
# （items 用 label、options 是对象数组），而本文件下游读的是 props[] + 二元组。
# 归一在入口做一次，missing_required_attributes 等函数一行不用动；旧记录也照读。
from category_capture import normalize_props_entry  # noqa: E402

# risk kind → qualityReport 里的稳定 code。code 是给统计和回归断言用的，
# message 会改、code 不会（findingList 的 schema 就是这么写的）。
RISK_CODES = {
    "platform": ("infringing_platform_mention", "出现其它平台名"),
    "shop": ("infringing_shop_mention", "出现其它店铺名"),
    "contact": ("infringing_contact_info", "出现联系方式"),
    "trademark": ("infringing_trademark", "疑似他人商标"),
}

# 类目属性表里品牌槽位的属性名。品牌的 property_id 逐类目不同(防蓝光镜是 1687),
# 名字却是稳定的,所以按名字认槽 —— 这是类目数据能提供的唯一稳定键。
BRAND_PROP_NAME = "品牌"

# 图片检测并发度。抖店主图上限 5 张,全开即可 —— 实测(2026-08-31)串行 149s、
# 5 路并行 24s(6.2 倍),且**零锁冲突**。设 1 退回串行。
IMAGE_WORKERS = int(os.environ.get("BCP_IMAGE_WORKERS", "5"))


def _finding_entry(f: Finding) -> dict:
    code, label = RISK_CODES[f.kind]
    parts = [label]
    if f.detail:
        parts.append(f.detail)
    return {
        "code": code,
        "message": f"{'；'.join(parts)}（把握 {f.confidence:.0%}）",
        "field": f.field,
        "evidence": f.evidence,
    }


def _pointer_get(doc: Any, pointer: str) -> Any:
    """JSON Pointer 取值，取不到返回 None（而不是抛）。

    取不到是常态 —— canonical 的很多字段是可选的，一个缺失的 `description`
    不该让整条投影崩掉。"""
    if not pointer or pointer == "/":
        return doc
    cur = doc
    for raw in pointer.lstrip("/").split("/"):
        key = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, list):
            if not key.isdigit() or int(key) >= len(cur):
                return None
            cur = cur[int(key)]
        elif isinstance(cur, dict):
            if key not in cur:
                return None
            cur = cur[key]
        else:
            return None
    return cur


def _attribute_index(canonical: dict) -> dict[str, str]:
    """来源属性名 → 值。**只用于 property_id 没映射上时的降级提示,不作覆盖判据** ——
    来源名(1688 侧)和抖店属性名是两套命名空间,逐字相同纯属巧合。"""
    out: dict[str, str] = {}
    for attr in canonical.get("attributes") or []:
        name = (attr.get("sourceName") or "").strip()
        if name:
            out[name] = attr.get("rawValue") or "、".join(attr.get("values") or [])
    return out


def _mapped_property_ids(canonical: dict) -> dict[str, str]:
    """抖店 property_id → 值。**必填覆盖的权威判据。**

    映射阶段已经把来源属性名解析成了 doudianPropertyId(「材质」→1951、
    「镜片功能」→810)。拿名字去比等于把那一阶段的产出整个丢掉:只有来源名与抖店名
    逐字相同才算命中,而它们本就来自两个平台 —— 实测「材质/镜架材质」
    「镜片功能/功能」两条明明映射成功却被报成缺失。

    兄弟实现 validate_doudian_rules.rule_7 的 mapped_props 和 build_doudian_product
    的 covered_ids 一直都按 id 比对;这里对齐它们,而不是另立一套。

    这里只回答"这个 property_id 有没有值",**不**回答"这个值抖店收不收" ——
    后者要看该属性是枚举还是自由文本,而那个信息在类目表里,不在 canonical 里,
    所以由 missing_required_attributes 判(见那里的 `_has_usable_value`)。"""
    out: dict[str, str] = {}
    for attr in canonical.get("attributes") or []:
        pid = attr.get("doudianPropertyId")
        if pid is None:
            continue
        value = attr.get("rawValue") or "、".join(attr.get("values") or [])
        if str(value).strip():
            out[str(pid)] = value
    return out


def _has_usable_value(canonical: dict, pid: str) -> bool:
    """这个 property_id 的值抖店**收不收**。

    枚举属性(有 options)必须有非空 valueId:
    build_addv2.project_product_format_new 会把 valueId 为空的值踢进 pending_di,
    「进 addv2 必被拒」是那段代码自己的注释 —— 发布时那个槽位仍然是空的。
    实测:品牌 rawValue「见描述」、doudianPropertyId=1687、valueId=None,只看
    rawValue 的旧判据算它已覆盖,于是必填品牌是空的却没有任何信号。

    自由文本属性(无 options,型号/货号/尺寸/生产企业名称这类,占 42.6%)本就没有
    value_id,对它们要求 valueId 会造出假缺口 —— 所以这个判据只对枚举属性生效,
    调用方按 prop["options"] 决定要不要问。
    """
    for attr in canonical.get("attributes") or []:
        if str(attr.get("doudianPropertyId")) != str(pid):
            continue
        if any(v.get("valueId") is not None for v in (attr.get("doudianValues") or [])):
            return True
    return False


def missing_required_attributes(canonical: dict, category_props: dict) -> list[dict]:
    """抖店这个类目要求、而商品数据里找不到的必填属性。

    只做**匹配**，不做生成。找得到就算齐，找不到就是一条 pending —— 交给人，
    不交给模型。这条规则是这一层存在的主要理由：一个属性编得越像真的，越难在
    审核时被发现，也越贵。

    覆盖判据是 **property_id**(见 _mapped_property_ids)。名字只在 property_id
    没映射上时用于降级提示,且**不算覆盖**:名字对上但没 property_id 的属性投影时
    进不了 product_format_new,当成"已填"就是把真缺口静默放过去 —— 那比误报危险。"""
    by_pid = _mapped_property_ids(canonical)
    by_name = _attribute_index(canonical)
    # 品牌不走 attributes[]。它由 shop-profile 决定,落在 canonical.brand.doudianBrandId,
    # 投影成 addV2 顶层的 standard_brand_id。只看 attributes[] 的话,任何必填含「品牌」
    # 的类目都会恒定误报 —— 与商品数据无关,是结构性盲区。
    brand_id = (canonical.get("brand") or {}).get("doudianBrandId")
    gaps: list[dict] = []
    for prop in category_props.get("props") or []:
        if not prop.get("required") or prop.get("hidden"):
            continue
        pid = str(prop.get("id") or "")
        name = prop.get("name") or ""
        # 枚举属性还要过一道:值必须是抖店收得下的(非空 valueId)。只看"有没有值"
        # 会把「映射上了 property_id、值却没匹配到 value_id」判成已覆盖,而那种属性
        # 投影时进不了 product_format_new —— 与"名字对上但没 property_id"同一种静默
        # 放过。自由文本属性没有 options,不问这一道(它们本就没有 value_id)。
        if pid and pid in by_pid:
            enum_without_value_id = bool(prop.get("options")) and not _has_usable_value(canonical, pid)
            if not enum_without_value_id:
                continue
        if name == BRAND_PROP_NAME and brand_id:
            continue
        evidence = f"property_id={prop.get('id')}" + (
            f"，候选 {len(prop.get('options') or [])} 项" if prop.get("options") else ""
        )
        if name in by_name and str(by_name[name]).strip():
            message = (
                f"抖店类目「{category_props.get('name', '?')}」要求必填属性「{name}」，"
                f"来源有同名属性(值「{by_name[name]}」)但没有映射到 property_id —— "
                f"投影时不会被发出去，需要人工确认"
            )
        else:
            message = (
                f"抖店类目「{category_props.get('name', '?')}」要求必填属性「{name}」，"
                f"来源数据里没有 —— 需要人工填写，不要猜"
            )
        gaps.append(
            {
                "code": "missing_required_attribute",
                "message": message,
                "field": "/attributes",
                "evidence": evidence,
            }
        )
    return gaps


def _dedupe(entries: Iterable[dict]) -> list[dict]:
    """同一个字段上的同一段证据只留一条 —— **不看 code**。

    不看 code 是必须的，因为上游已经报过一遍。`build_canonical` 有一套联系方式
    正则，把标题里的手机号记成 `title_contact_info`；模型再看一遍同一句话，把同
    一个号记成 `infringing_contact_info`。code 不同、字段和证据完全相同，按 code
    去重就会让一个手机号在 risks 里出现两次 —— 而判定是按条数报给人看的
    （「N 项风险待确认」），重复计数会把 2 说成 4。

    代价说清楚：同一段文字被两个检测判成不同类别时（比如既像平台名又像商标），
    只留先到的那条。先到的是 canonical 里已有的，也就是上游正则那条 —— 它确定、
    免费、可复现，比模型的分类更该被信。真要两条都看，去 detect.py 单独跑。

    保序：先到先留，所以上游的标注不会被本层的覆盖掉。"""
    seen: set[tuple] = set()
    out: list[dict] = []
    for e in entries:
        key = (e.get("field"), e.get("evidence"))
        # 证据为空时退回按 code 区分：`category_props_unknown` 这类没有 evidence
        # 的条目，全按 (None, None) 去重会把不同的问题吃成一条。
        if not e.get("evidence"):
            key = (e.get("field"), e.get("evidence"), e["code"])
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def project(canonical: dict, category_props: dict | None, findings: list[Finding]) -> dict:
    """带标注的 canonical，外加一个 verdict。

    输入的 canonical 不被就地修改 —— 调用方手里那份还是原样，这样"标注前/标注后"
    可以对比，也不会有人拿着被改过的字典以为它还是原始数据。"""
    out = json.loads(json.dumps(canonical))
    report = out.setdefault("qualityReport", {"errors": [], "risks": [], "warnings": [], "pending": []})
    for bucket in ("errors", "risks", "warnings", "pending"):
        report.setdefault(bucket, [])

    report["risks"] = _dedupe([*report["risks"], *(_finding_entry(f) for f in findings)])

    if category_props is None:
        report["pending"] = _dedupe(
            [
                *report["pending"],
                {
                    "code": "category_props_unknown",
                    "message": "没有拿到这个类目的属性表，必填项无从校验 —— 不能据此认为属性齐了",
                    "field": "/category/doudianLeafId",
                    "evidence": str((canonical.get("category") or {}).get("doudianLeafId")),
                },
            ]
        )
    else:
        report["pending"] = _dedupe([*report["pending"], *missing_required_attributes(out, category_props)])

    out["qualityReport"] = report
    return out


# 记录下来但**不阻塞发布**的 pending code。
#
# 「目标类目根本没有这个属性」不是待办事项:没有任何人补得上它 —— 抖店的这个叶子
# 类目就是没有这一项。把它当阻塞项的后果是结构性的:1688 的属性数常年多于抖店叶子
# 类目(实测 15 vs 4),于是 pending 恒非空,`ready` 事实上不可达,Flow 的自动发布
# 分支形同虚设 —— 卡住商品的不是任何风险,而是"两个平台的属性表本来就不一样"。
#
# 只豁免「查清楚了确实没有」这一种(attribute_name_no_counterpart)。属性被占满 /
# 离线路径没做语义匹配 / LLM 通道失败 仍然记 attribute_name_unmapped 并继续阻塞 ——
# 那些是「没查清楚」,放过它们等于假装检查过。
#
# 条目本身仍留在 qualityReport.pending 里,只是不计入阻塞判定:账要记全,门要开对。
NON_BLOCKING_PENDING_CODES = frozenset({"attribute_name_no_counterpart"})


def verdict(canonical: dict) -> dict:
    """能不能进发布，以及为什么不能。

    三态而不是布尔：`blocked` 是数据本身坏了（errors），`needs_human` 是有人得
    看一眼（risks 或 pending），`ready` 是可以往下走。把后两者合成一个「不通过」
    会让「有个水印要确认」和「来源页根本没抓到」看起来一样严重。"""
    r = canonical.get("qualityReport") or {}
    errors, risks, pending = r.get("errors") or [], r.get("risks") or [], r.get("pending") or []
    if errors:
        return {"status": "blocked", "reason": f"{len(errors)} 项阻断", "errors": len(errors)}
    blocking = [p for p in pending
                if (p or {}).get("code") not in NON_BLOCKING_PENDING_CODES]
    noted = len(pending) - len(blocking)
    if risks or blocking:
        # reason 的唯一读者是人，而人下一步要做什么完全取决于【是哪一类 pending】：
        # 缺必填要去补属性，投影 pending 要去处理 value_id / 图片检测。
        #
        # 原来这里一律写「N 项必填待补」——那是 pending 只装一种东西时写的话。如今它
        # 还装着 addv2_projection_pending（build_doudian_product.py:2205 明知故犯地塞
        # 了进来）、shop_profile_missing、brand_id_unmapped 等等。实测撞上：罗小黑那件
        # 商品报「1 项必填待补」，人去查必填却发现 3/3 齐全，那 1 项其实是货号
        # 「783717802988」是 diyType=1 自定义值没有 value_id。判定没错，是这句话在骗人，
        # 而一句会骗人的结论比没有结论更贵——它把人支去查一个根本没问题的地方。
        #
        # 按 code 分组原样报，不建标签映射表：pending 的 code 会随上游增加，
        # 一张要手工维护的中文标签表迟早漏掉新 code，漏掉时又会退化成今天这种
        # 「说了一个错的类别」。code 本身就是准确的，宁可生硬。
        by_code: dict[str, int] = {}
        for p in blocking:
            code = (p or {}).get("code") or "unknown"
            by_code[code] = by_code.get(code, 0) + 1
        detail = "、".join(f"{code} {n} 项" for code, n in sorted(by_code.items()))
        return {
            "status": "needs_human",
            "reason": f"{len(risks)} 项风险待确认；{len(blocking)} 项待人工处理（{detail}）",
            "risks": len(risks),
            "pending": len(blocking),
        }
    # 说明有几条"类目无对应属性"被记下但没拦 —— 不写出来的话，一份 pending 非空的
    # 报告配一个 ready 会让人以为判定漏了。
    return {"status": "ready",
            "reason": "无阻断、无风险、必填已齐"
                      + (f"（另有 {noted} 项来源属性在该类目无对应项，已记录不阻塞）" if noted else "")}


def publication_readiness(canonical: dict, category_props: dict | None, validation: dict,
                          *, detection_complete: bool) -> dict:
    report = canonical.get('qualityReport') or {}
    category_known = bool((canonical.get('category') or {}).get('doudianLeafId'))
    draftable = bool(
        category_known and (canonical.get('title') or {}).get('text')
        and (canonical.get('images') or {}).get('main') and canonical.get('skus')
        and not report.get('errors') and detection_complete
    )
    missing = []
    if not category_known or category_props is None:
        missing.append('类目或类目必填定义未确定')
    else:
        missing.extend(item['message'] for item in missing_required_attributes(canonical, category_props))
    missing.extend(check['detail'] for check in validation.get('results', [])
                   if check.get('status') != 'pass')
    if not detection_complete:
        missing.append('图片或文案检测未完成')
    missing.extend(item.get('message', '商品数据错误') for item in report.get('errors') or [])
    return {
        'canPublish': draftable and not missing,
        'canDraft': draftable,
        'missingRequired': list(dict.fromkeys(missing)),
    }


def _image_jobs(canonical: dict, image_assets: dict[str, bytes] | None) -> list[MontageTask]:
    """哪些图会被送进检测。

    检测和「标记已检查」必须用**同一份**判据,否则两边会各自漂移 —— 往轻了说是
    送检了却没标(门永远开不了),往重了说是没送检却标成检查过(在没检查的情况下
    宣布合规)。所以这份名单只有一处。

    **主图和详情图都要送检**。此前只送主图,不是收窄范围的决策(全仓没有任何地方
    记过这个决定),而是没做完:详情图同样会发到抖店、同样会因为水印/他人商标/联系
    方式被处罚,而 build_addv2 的那条 pending 数的本来就是「待发布图片」——主图和详情
    图一起数。只检主图的后果是它们的 checked 永远 false,那条 pending 在任何带详情图
    的商品上恒真,ready 不可达。

    代价:每件商品多 N 张视觉调用(实测单张 14-21 秒,`BCP_IMAGE_WORKERS` 路并发,
    默认 5)。这是这道门该有的成本 —— 少检的那部分不会因为没看就变干净。
    """
    source_images: list[tuple[bytes, str]] = []
    images = canonical.get("images") or {}
    for role in ("main", "detail"):
        for i, _img in enumerate(images.get(role) or []):
            pointer = f"/images/{role}/{i}"
            data = (image_assets or {}).get(pointer)
            if data is None:  # 下载失败的图没有字节,送不进去,也就不该被标成检查过
                continue
            source_images.append((data, pointer))
    return build_montages(source_images)


def mark_checked_images(canonical: dict, image_assets: dict[str, bytes] | None,
                        findings: list, skip_model: bool) -> int:
    """把「检测跑过且没发现问题」的图标成 checked=true,返回标记张数。

    在此之前全仓**没有任何地方**把 checked 置 true —— 它在 build_canonical 的
    to_image() 里初始化为 False 之后再没人动过。后果:build_addv2 的「未过水印/
    侵权判定」这条 pending 恒真,verdict 因此永远到不了 ready。门能关不能开,
    等于没有门。

    三条边界一条都不能松,它们都是「没检查 ≠ 干净」的具体形态:
      - skip_model(--no-llm)→ 一张都不标。collect_findings 返回空列表时既可能是
        "没跑"也可能是"跑了没发现",调用方靠这个参数区分,这里必须守同一条线。
      - 没有字节的图(下载失败)→ 不在 _image_jobs 里,不标。
      - 有 finding 的图 → 不标,risk 照记。
    """
    if skip_model:
        return 0
    flagged = {getattr(f, "field", None) for f in findings}
    images = canonical.get("images") or {}
    marked = 0
    for role in ("main", "detail"):
        for index, _img in enumerate(images.get(role) or []):
            pointer = f"/images/{role}/{index}"
            if pointer in flagged or (image_assets or {}).get(pointer) is None:
                continue
            images[role][index]["checked"] = True
            marked += 1
    return marked


def collect_findings(canonical: dict, image_assets: dict[str, bytes] | None, skip_model: bool,
                     *, deadline: float | None = None) -> list[Finding]:
    """跑检测通道。`skip_model` 时返回空 —— 用于只想看必填校验的场景。

    注意空列表在这里的含义是「没跑」，不是「跑了没发现」。调用方靠 skip_model
    自己知道是哪一种；混淆这两者就是在没检查的情况下宣布合规。"""
    if skip_model:
        return []

    # Do not spend CPU decoding images after the shared product budget is gone.
    if deadline is not None and time.monotonic() >= deadline:
        raise DetectorUnavailable("商品 LLM 总预算耗尽，检测未完成")
    jobs = _image_jobs(canonical, image_assets)
    texts = [(pointer, text) for pointer in ('/title/text', '/description')
             if isinstance(text := _pointer_get(canonical, pointer), str) and text.strip()]
    plan = plan_inspection(len(jobs), [text for _pointer, text in texts],
                           workers=IMAGE_WORKERS, unit_seconds=TIMEOUT_S)
    now = time.monotonic()
    inspection_deadline = now + plan.total_seconds
    if deadline is not None:
        inspection_deadline = min(inspection_deadline, deadline)
    announce_work('image-detection', max(0, inspection_deadline - now))

    def inspect_image(job: MontageTask):
        # 线程池不会继承调用线程的 ContextVar，必须显式传递同一截止时间。
        with detection_budget(inspection_deadline, request_timeout=plan.image_request_seconds):
            return detect_montage(job)

    # map 保持结果与主图序号一致；并发请求的排队时间已计入单次请求预算。
    found: list[Finding] = []
    if jobs:
        with ThreadPoolExecutor(max_workers=plan.workers) as pool:
            for part in pool.map(inspect_image, jobs):
                found += part

    for (pointer, text), request_timeout in zip(texts, plan.text_request_seconds):
        with detection_budget(inspection_deadline, request_timeout=request_timeout):
            found += detect_text(text, pointer)
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description="给 canonical 商品打合规标注并判定能否发布")
    ap.add_argument("--canonical", type=Path, required=True)
    ap.add_argument("--category-props", type=Path, help=f"该叶子类目的属性表（doudian-category-props 记录）")
    ap.add_argument("--skip-model", action="store_true", help="不跑模型检测，只做必填校验")
    ap.add_argument("--out", type=Path, help="写到文件；不给就写 stdout")
    args = ap.parse_args()

    canonical = json.loads(args.canonical.read_text("utf-8"))
    props = (
        normalize_props_entry(json.loads(args.category_props.read_text("utf-8")))
        if args.category_props else None
    )

    try:
        findings = collect_findings(canonical, None, args.skip_model)
    except DetectorUnavailable as exc:
        # 退 2 = 通道坏了，与"检测发现问题"严格分开。绝不降级成"没发现问题"。
        print(json.dumps({"ok": False, "error": f"检测通道不可用：{exc}"}, ensure_ascii=False), file=sys.stderr)
        return 2

    projected = project(canonical, props, findings)
    result = {"ok": True, "verdict": verdict(projected), "canonical": projected}
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text + "\n", "utf-8")
        print(json.dumps({"ok": True, "verdict": result["verdict"], "out": str(args.out)}, ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
