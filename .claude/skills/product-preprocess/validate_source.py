#!/usr/bin/env python3

import json
from pathlib import Path


def _image_urls(data):
    groups = (data.get("CommodityImage") or {}).get("ConfigList") or []
    return [
        url
        for group in groups
        for url in (group.get("List") or [])
        if isinstance(url, str) and url
    ]


def _sku_image_status(data):
    """Report whether captured SKU values retain their source images."""
    properties = (data.get("PriceAndStock") or {}).get("SkuProperties") or []
    values = [
        value
        for prop in properties
        if isinstance(prop, dict)
        for value in (prop.get("Values") or [])
        if isinstance(value, dict)
    ]
    image_required = [
        value
        for prop in properties
        if isinstance(prop, dict)
        and any(isinstance(value.get("ImgUrl"), str) and value["ImgUrl"].strip() for value in (prop.get("Values") or []) if isinstance(value, dict))
        for value in (prop.get("Values") or [])
        if isinstance(value, dict)
    ]
    missing = [str(value.get("ValueName") or "") for value in image_required if not isinstance(value.get("ImgUrl"), str) or not value["ImgUrl"].strip()]
    with_image = len(image_required) - len(missing)
    return {
        "present": bool(values),
        "total": len(image_required),
        "withImage": with_image,
        "missing": missing,
        "complete": bool(image_required) and not missing,
    }


def _sku_image_mapping_status(data):
    """Compare normalized SKU images with the DOM evidence captured by the browser."""
    source_meta = data.get("SourceMeta") or {}
    evidence = source_meta.get("skuImages") or []
    properties = (data.get("PriceAndStock") or {}).get("SkuProperties") or []
    values = [
        (str(prop.get("PropertyName") or "").strip(), value)
        for prop in properties
        if isinstance(prop, dict)
        for value in (prop.get("Values") or [])
        if isinstance(value, dict)
    ]
    if not evidence:
        return {
            "present": False,
            "total": len(values),
            "evidenceTotal": 0,
            "mismatches": [],
            "consistent": None,
        }

    evidence_by_key = {
        (
            str(item.get("propertyName") or item.get("PropertyName") or "").strip(),
            str(item.get("valueName") or item.get("ValueName") or "").strip(),
        ): str(
            item.get("imageUrl") or item.get("ImgUrl") or ""
        ).strip()
        for item in evidence
        if isinstance(item, dict)
    }
    mismatches = []
    for property_name, value in values:
        name = str(value.get("ValueName") or "").strip()
        key = (property_name, name)
        if key not in evidence_by_key:
            continue
        expected = evidence_by_key[key]
        actual = str(value.get("ImgUrl") or "").strip()
        if not expected or expected != actual:
            mismatches.append({"propertyName": property_name, "valueName": name, "expected": expected, "actual": actual})

    return {
        "present": True,
        "total": len(values),
        "evidenceTotal": len(evidence_by_key),
        "mismatches": mismatches,
        "consistent": bool(values) and not mismatches,
    }


def validate_source(data):
    """Validate a captured 1688 source without modifying it."""
    if not isinstance(data, dict):
        return {
            "ok": False,
            "errors": ["source JSON must be an object"],
            "warnings": [],
            "completeness": {},
        }

    errors = []
    warnings = []
    base = data.get("BaseInfo") or {}
    attrs = base.get("Attr") or {}
    price_stock = data.get("PriceAndStock") or {}
    skus = price_stock.get("Skus") or []
    images = _image_urls(data)
    sku_images = _sku_image_status(data)
    sku_image_mapping = _sku_image_mapping_status(data)
    capture_method = str((data.get("SourceMeta") or {}).get("captureMethod", "")).lower()
    page_state = str((data.get("SourceMeta") or {}).get("pageState", "")).lower()

    if not data.get("GoodsID"):
        errors.append("missing GoodsID")
    if not data.get("SourceID"):
        errors.append("missing SourceID")
    if not base.get("Title"):
        errors.append("missing title")
    if any(marker in page_state for marker in ("login", "captcha", "slider", "risk")):
        errors.append("page requires login or risk verification")
    if not skus:
        warnings.append("missing SKU prices or stock")
    if not images:
        warnings.append("missing images")
    if not attrs.get("ImportantAttr") and not attrs.get("SourceAttr"):
        warnings.append("missing product attributes")
    if sku_images["present"] and sku_images["missing"]:
        # SKU image gaps are recorded but don't gate preprocessing: SKILL.md
        # requires that only "goodsId/sourceId/title missing" + "page blocked" +
        # "ALL main images unavailable" stop the flow; partial capture gaps are
        # a known browser-side limitation, surfaced as warnings so downstream
        # tooling (and the doubao text pass) can decide per-SKU.
        missing = ", ".join(sku_images["missing"])
        warnings.append(
            f"partial SKU images: {sku_images['withImage']}/{sku_images['total']}; "
            f"missing: {missing}"
        )
    if capture_method == "browser-dom" and sku_images["present"] and not sku_image_mapping["present"]:
        warnings.append("missing SKU image mapping evidence")
    if sku_image_mapping["present"] and sku_image_mapping["mismatches"]:
        errors.append("SKU image mapping does not match captured DOM evidence")

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "skuImages": sku_images,
        "skuImageMapping": sku_image_mapping,
        "completeness": {
            "goodsId": bool(data.get("GoodsID")),
            "sourceId": bool(data.get("SourceID")),
            "title": bool(base.get("Title")),
            "images": bool(images),
            "attributes": bool(attrs.get("ImportantAttr") or attrs.get("SourceAttr")),
            "skus": bool(skus),
            "skuImages": sku_images,
            "skuImageMapping": sku_image_mapping,
        },
    }


def load_and_validate(path):
    """Load a UTF-8 source JSON and return its validation report."""
    with Path(path).open("r", encoding="utf-8") as source_file:
        return validate_source(json.load(source_file))
