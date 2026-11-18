#!/usr/bin/env python3
"""
商品 JSON 预处理脚本
用法: python3 .claude/skills/product-preprocess/preprocess.py <输入JSON路径>

输出目录结构:
  products/<sanitized-title>-<YYYYMMDD>-<4-hex>/
    ├── raw.json              # 原始数据
    ├── preprocessed.json     # 预处理结果
    └── final.json            # Agent 处理后的最终结果（由 Agent 生成）
"""

import json
import os
import re
import secrets
import shutil
import sys
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone

from validate_source import validate_source


# ============================================================
# 配置
# ============================================================

PRODUCTS_DIR = Path(os.environ.get("PRODUCT_PREPROCESS_PRODUCTS_DIR", Path(__file__).resolve().parents[3] / "products"))

PRICE_TOO_LOW = 0.5
PRICE_TOO_HIGH = 9999
STOCK_TOO_HIGH = 100000
IMAGE_TIMEOUT = 5

BRAND_RISK_KEYWORDS = [
    "迪士尼", "disney", "三丽鸥", "sanrio", "hellokitty", "kitty",
    "哆啦A梦", "机器猫", "doraemon", "史努比", "snoopy",
    "漫威", "marvel", "蜘蛛侠", "spiderman",
    "皮卡丘", "宝可梦", "pokemon", "pikachu",
    "小猪佩奇", "peppa", "汪汪队", "paw patrol",
    "熊本熊", "kumamon", "line", "布朗熊", "可妮兔",
    "蜡笔小新", "樱桃小丸子", "龙猫", "宫崎骏",
    "泰迪熊", "teddy bear", "芭比", "barbie",
    "乐高", "lego", "费雪", "fisher",
    "万代", "bandai", "多美", "tomy",
    "喜羊羊", "灰太狼", "熊出没", "光头强",
    "阿狸", "兔斯基", "罗小黑",
]

CCC_CERT_PATTERN = re.compile(r"^[A-Z]{1,3}\d{8,12}$|^\d{10,14}$")


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def existing_raw_output_dir(input_path):
    input_path = Path(input_path).resolve()
    if input_path.name == "raw.json" and input_path.parent.parent == PRODUCTS_DIR.resolve():
        return input_path.parent
    return None


def sanitize_directory_title(title, max_length=80, max_bytes=230):
    """Produce a portable, readable path component from a product title."""
    title = str(title or "")
    title = re.sub(r"[\\/]+", "-", title)
    title = re.sub(r"[\x00-\x1f\x7f]", "", title)
    title = re.sub(r"\s+", " ", title).strip(". ")
    title = title[:max_length]
    kept = []
    used_bytes = 0
    for character in title:
        character_bytes = len(character.encode("utf-8"))
        if used_bytes + character_bytes > max_bytes:
            break
        kept.append(character)
        used_bytes += character_bytes
    title = "".join(kept).rstrip(". ")
    return title or "product"


def create_output_dir(data, input_path):
    """Create a new external-source directory without reusing a collision."""
    existing_dir = existing_raw_output_dir(input_path)
    if existing_dir:
        existing_dir.mkdir(parents=True, exist_ok=True)
        return existing_dir

    title = sanitize_directory_title(data.get("BaseInfo", {}).get("Title", ""))
    date = datetime.now().strftime("%Y%m%d")
    while True:
        output_dir = PRODUCTS_DIR / f"{title}-{date}-{secrets.token_hex(2)}"
        try:
            output_dir.mkdir(parents=True, exist_ok=False)
            return output_dir
        except FileExistsError:
            continue


def copy_raw_if_needed(input_path, raw_file):
    """Preserve the first raw artifact and avoid copying a file onto itself."""
    input_path = Path(input_path).resolve()
    raw_file = Path(raw_file).resolve()
    raw_file.parent.mkdir(parents=True, exist_ok=True)

    if input_path == raw_file or raw_file.exists():
        return None

    shutil.copy2(input_path, raw_file)
    return None


def copy_evidence_if_needed(evidence_path, output_dir):
    """Preserve the exact browser evidence beside the generated raw source."""
    if not evidence_path:
        return None
    evidence_path = Path(evidence_path).resolve()
    if not evidence_path.is_file():
        raise ValueError(f"evidence file does not exist: {evidence_path}")
    destination = Path(output_dir).resolve() / "evidence.json"
    shutil.copy2(evidence_path, destination)
    return destination


def write_capture_report(output_dir, data, validation):
    """Write non-sensitive capture metadata and validation results."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    source_meta = data.get("SourceMeta") or {}
    source_errors = source_meta.get("errors") or []
    source_warnings = source_meta.get("warnings") or []
    errors = list(dict.fromkeys(list(source_errors) + list(validation.get("errors", []))))
    warnings = list(dict.fromkeys(list(source_warnings) + list(validation.get("warnings", []))))
    report = {
        "captureMethod": source_meta.get("captureMethod", "unknown"),
        "capturedAt": source_meta.get(
            "capturedAt", datetime.now(timezone.utc).isoformat()
        ),
        "sourceUrl": data.get("sourceUrl", ""),
        "completeness": validation.get("completeness", {}),
        "errors": errors,
        "warnings": warnings,
    }
    report_file = output_dir / "capture-report.json"
    save_json(report_file, report)
    return report_file


def check_image_url(url):
    if os.environ.get("PRODUCT_PREPROCESS_SKIP_IMAGE_CHECK") == "1":
        return "skipped"
    try:
        req = urllib.request.Request(url, method="HEAD")
        req.add_header("User-Agent", "Mozilla/5.0")
        with urllib.request.urlopen(req, timeout=IMAGE_TIMEOUT) as resp:
            return "ok" if resp.status == 200 else f"http_{resp.status}"
    except urllib.error.HTTPError as e:
        return f"http_{e.code}"
    except Exception as e:
        return f"error:{type(e).__name__}"


def check_brand_risk(text):
    if not text:
        return []
    text_lower = text.lower()
    return [kw for kw in BRAND_RISK_KEYWORDS if kw.lower() in text_lower]


def validate_ccc_cert(cert):
    if not cert or not cert.strip():
        return False
    return bool(CCC_CERT_PATTERN.match(cert.strip()))


# ============================================================
# 生成 summary
# ============================================================

def generate_summary(data, issues):
    base = data.get("BaseInfo", {})
    attr = base.get("Attr", {})
    skus = data.get("PriceAndStock", {}).get("Skus", [])

    title = base.get("Title", "")
    category = base.get("CategoryName", "")

    prices = [s.get("Price", 0) for s in skus if s.get("Price", 0) > 0]
    price_range = f"¥{min(prices):.1f}-{max(prices):.1f}" if prices else "无价格"

    filled = 0
    missing_required = []
    all_attrs = attr.get("ImportantAttr", []) + attr.get("OtherAttr", [])
    attr_values = attr.get("AttrValues", {})
    for a in all_attrs:
        ref_pid = str(a.get("RefPid", ""))
        if ref_pid in attr_values and attr_values[ref_pid]:
            filled += 1
        elif a.get("IsRequired"):
            missing_required.append(a.get("Name", ""))

    error_count = sum(1 for i in issues if i["level"] == "error")
    warning_count = sum(1 for i in issues if i["level"] in ("warning", "risk"))

    if error_count > 0:
        status = "有硬伤，需处理"
    elif missing_required:
        status = "基本完整，缺必填项"
    elif warning_count > 0:
        status = "完整，有风险项需确认"
    else:
        status = "完整，可直接使用"

    main_img = sum(len(c.get("List", [])) for c in data.get("CommodityImage", {}).get("ConfigList", []))
    detail_img = sum(len(c.get("List", [])) for c in data.get("DetailImage", {}).get("ConfigList", []))

    return {
        "product": f"{category}「{title[:30]}」{len(skus)}个SKU {price_range}",
        "status": status,
        "filledFields": f"{filled}/{len(all_attrs)}",
        "missingRequired": missing_required,
        "skuCount": len(skus),
        "priceRange": price_range,
        "images": f"主图{main_img}张 详情图{detail_img}张",
        "errors": error_count,
        "warnings": warning_count,
    }


# ============================================================
# 表单结构 + 当前值（agent 填表核心）
# ============================================================

def build_form_fields(data):
    """每个字段：名称、类型、是否必填、选项、当前值"""
    attr = data.get("BaseInfo", {}).get("Attr", {})
    attr_values = attr.get("AttrValues", {})
    fields = []

    for group in ["ImportantAttr", "OtherAttr"]:
        for a in attr.get(group, []):
            ref_pid = str(a.get("RefPid", ""))
            name = a.get("Name", "")
            input_type = a.get("PropInputType", "Input")

            # 当前值
            current = ""
            if ref_pid in attr_values and attr_values[ref_pid]:
                vals = attr_values[ref_pid]
                current = ", ".join(v.get("Label", "") for v in vals)

            field = {
                "name": name,
                "refPid": ref_pid,
                "type": input_type,
                "required": a.get("IsRequired", False),
                "currentValue": current,
            }

            # 选项（Select/MultiSelect 类型）
            if input_type in ("Select", "MultiSelect"):
                field["options"] = [o.get("Label", "") for o in a.get("Options", [])]
                field["maxSelect"] = a.get("ChooseMaxNum", 1)

            fields.append(field)

    return fields


def build_attribute_candidates(data):
    """Keep 1688 source facts separate from the target platform's schema."""
    candidates = []
    for item in data.get("BaseInfo", {}).get("Attr", {}).get("SourceAttr", []):
        source_name = str(item.get("Label", "")).strip()
        raw_value = str(item.get("Value", "")).strip()
        if not source_name or not raw_value:
            continue
        values = [value.strip() for value in re.split(r"[,，]", raw_value) if value.strip()]
        candidates.append({"sourceName": source_name, "rawValue": raw_value, "values": values})
    return candidates


# ============================================================
# SKU 表格
# ============================================================

def build_sku_table(data):
    skus = data.get("PriceAndStock", {}).get("Skus", [])
    if not skus:
        return {"columns": ["specs", "sourcePrice", "stock", "merchantCode"], "rows": []}

    rows = []
    for sku in skus:
        rows.append({
            "specs": [
                {"sourceName": spec.get("PropertyName", ""), "value": spec.get("ValueName", "")}
                for spec in sku.get("SkuSpec", [])
            ],
            "sourcePrice": sku.get("Price", 0),
            "stock": sku.get("Quantity", 0),
            "merchantCode": sku.get("OuterID", ""),
        })

    return {"columns": ["specs", "sourcePrice", "stock", "merchantCode"], "rows": rows}


# ============================================================
# 图片
# ============================================================

def build_images(data):
    return {
        "main": [url for config in data.get("CommodityImage", {}).get("ConfigList", []) for url in config.get("List", [])],
        "detail": [url for config in data.get("DetailImage", {}).get("ConfigList", []) for url in config.get("List", [])],
    }


def build_sku_properties(data):
    return [
        {
            "sourceName": prop.get("PropertyName", ""),
            "values": [
                {"value": value.get("ValueName", ""), "imageUrl": value.get("ImgUrl", "")}
                for value in prop.get("Values", [])
            ],
        }
        for prop in data.get("PriceAndStock", {}).get("SkuProperties", [])
    ]


# ============================================================
# 质量检查
# ============================================================

def quality_check(data, images, sku_table):
    issues = []
    base = data.get("BaseInfo", {})
    attr = base.get("Attr", {})
    title = base.get("Title", "")
    category = base.get("CategoryName", "")

    # 品牌/IP 风险
    title_risks = check_brand_risk(title)
    if title_risks:
        issues.append({"level": "risk", "category": "ip_risk", "field": "标题",
                        "message": f"标题含品牌关键词: {', '.join(title_risks)}"})

    for a in attr.get("OtherAttr", []):
        if a.get("Name") == "卡通角色":
            for opt in a.get("Options", []):
                risks = check_brand_risk(opt.get("Label", ""))
                if risks:
                    issues.append({"level": "warning", "category": "ip_risk", "field": "卡通角色",
                                    "message": f"选项 '{opt['Label']}' 含品牌关键词"})

    for item in attr.get("SourceAttr", []):
        risks = check_brand_risk(str(item.get("Value", "")))
        if risks:
            issues.append({"level": "warning", "category": "ip_risk",
                            "field": f"属性-{item.get('Label', '')}",
                            "message": f"值 '{item['Value']}' 含品牌关键词"})

    # 图片抽样检查
    sample_urls = []
    for urls in images.values():
        sample_urls.extend(urls[:3])
    for url in sample_urls[:5]:
        status = check_image_url(url)
        if status not in ("ok", "skipped"):
            issues.append({"level": "error", "category": "image", "field": "图片",
                            "message": f"图片不可用 ({status})", "value": url})

    # 价格/库存
    for row in sku_table.get("rows", []):
        price = row.get("sourcePrice", 0)
        stock = row.get("stock", 0)
        label = " / ".join(spec.get("value", "") for spec in row.get("specs", [])) or row.get("merchantCode", "unknown")
        if price < PRICE_TOO_LOW:
            issues.append({"level": "error", "category": "price", "field": f"SKU-{label}",
                            "message": f"价格异常偏低: ¥{price}"})
        elif price > PRICE_TOO_HIGH:
            issues.append({"level": "warning", "category": "price", "field": f"SKU-{label}",
                            "message": f"价格异常偏高: ¥{price}"})
        if stock == 0:
            issues.append({"level": "error", "category": "stock", "field": f"SKU-{label}",
                            "message": "库存为0"})
        elif stock > STOCK_TOO_HIGH:
            issues.append({"level": "warning", "category": "stock", "field": f"SKU-{label}",
                            "message": f"库存异常偏高: {stock}"})

    # 3C 证书
    if "玩具" in category or "玩偶" in category:
        for a in attr.get("ImportantAttr", []) + attr.get("OtherAttr", []):
            if a.get("Name") == "CCC证书编号":
                ref_pid = str(a.get("RefPid", ""))
                val = attr.get("AttrValues", {}).get(ref_pid, [])
                cert = val[0].get("Value", "") if val else ""
                if cert and not validate_ccc_cert(cert):
                    issues.append({"level": "error", "category": "cert", "field": "CCC证书编号",
                                    "message": f"格式不合法: {cert}"})
                elif not cert:
                    issues.append({"level": "warning", "category": "cert", "field": "CCC证书编号",
                                    "message": "玩具类商品缺少3C证书"})

    # 必填字段
    for a in attr.get("ImportantAttr", []):
        if a.get("IsRequired"):
            ref_pid = str(a.get("RefPid", ""))
            val = attr.get("AttrValues", {}).get(ref_pid, [])
            if not val:
                issues.append({"level": "warning", "category": "data", "field": a.get("Name", ""),
                                "message": "必填字段未填写"})

    return issues


# ============================================================
# 主流程
# ============================================================

def main():
    # 解析命令行参数
    if len(sys.argv) < 2:
        print("用法: python3 .claude/skills/product-preprocess/preprocess.py <输入JSON路径> [--evidence <evidence.json>]")
        print("示例: python3 .claude/skills/product-preprocess/preprocess.py good.json")
        print("      python3 .claude/skills/product-preprocess/preprocess.py /path/to/product.json")
        print()
        print("输出目录: products/<商品标题清洗结果>-<YYYYMMDD>-<4位随机小写十六进制>/")
        print("  raw.json          - 原始数据")
        print("  preprocessed.json - 预处理结果")
        return 1

    input_path = Path(sys.argv[1]).resolve()
    evidence_path = None
    if len(sys.argv) > 2:
        if len(sys.argv) != 4 or sys.argv[2] != "--evidence":
            print("错误: 仅支持 --evidence <evidence.json>")
            return 1
        evidence_path = Path(sys.argv[3]).resolve()
    if not input_path.exists():
        print(f"错误: 文件不存在 {input_path}")
        return 1

    print(f"读取: {input_path}")
    data = load_json(input_path)

    goods_id = data.get("GoodsID", "")
    if not goods_id:
        goods_id = f"{input_path.stem}_{datetime.now().strftime('%Y%m%d%H%M%S')}"
        print(f"警告: 商品无 GoodsID，使用 {goods_id}")

    output_dir = create_output_dir(data, input_path)

    raw_file = output_dir / "raw.json"
    if input_path == raw_file:
        print(f"原始数据已在目标位置: {raw_file}")
    elif raw_file.exists():
        print(f"保留已有原始数据: {raw_file}")
    else:
        copy_raw_if_needed(input_path, raw_file)
        print(f"原始数据已保存: {raw_file}")

    if evidence_path:
        evidence_file = copy_evidence_if_needed(evidence_path, output_dir)
        print(f"采集证据已保存: {evidence_file}")

    validation = validate_source(data)
    report_file = write_capture_report(output_dir, data, validation)
    print(f"采集报告已保存: {report_file}")
    if not validation["ok"]:
        print(f"错误: 商品源数据不完整: {'; '.join(validation['errors'])}")
        return 2

    output_file = output_dir / "preprocessed.json"

    base_info = data.get("BaseInfo", {})
    images = build_images(data)
    sku_table = build_sku_table(data)
    sku_properties = build_sku_properties(data)
    issues = quality_check(data, images, sku_table)
    capture_warnings = (data.get("SourceMeta") or {}).get("warnings") or []
    capture_warnings = list(dict.fromkeys(list(capture_warnings) + validation["warnings"]))
    issues.extend(
        {
            "level": "warning",
            "category": "capture",
            "field": "source",
            "message": warning,
        }
        for warning in capture_warnings
    )
    summary = generate_summary(data, issues)
    form_fields = build_form_fields(data)
    attribute_candidates = build_attribute_candidates(data)

    output = {
        "goodsId": goods_id,
        "title": base_info.get("Title", ""),
        "category": base_info.get("CategoryName", ""),
        "summary": summary,
        "formFields": form_fields,
        "attributeCandidates": attribute_candidates,
        "skuTable": sku_table,
        "skuProperties": sku_properties,
        "skuImageCheck": validation.get("skuImages", {}),
        "images": images,
        "qualityReport": {
            "errors": [i for i in issues if i["level"] == "error"],
            "risks": [i for i in issues if i["level"] == "risk"],
            "warnings": [i for i in issues if i["level"] == "warning"],
        },
    }

    save_json(output_file, output)
    print(f"已保存: {output_file}")

    # 打印摘要
    print(f"\n{'='*50}")
    print(f"商品ID: {goods_id}")
    print(f"商品: {summary['product']}")
    print(f"状态: {summary['status']}")
    print(f"字段: {summary['filledFields']} 已填")
    print(f"错误: {summary['errors']}  警告: {summary['warnings']}")
    if summary['missingRequired']:
        print(f"缺失必填: {', '.join(summary['missingRequired'])}")
    print(f"\n输出目录: {output_dir}/")
    print(f"  raw.json          - 原始数据")
    print(f"  preprocessed.json - 预处理结果")
    print(f"  capture-report.json - 采集报告")
    print(f"  final.json        - 待 Agent 处理后生成")

    return 0


if __name__ == "__main__":
    sys.exit(main())
