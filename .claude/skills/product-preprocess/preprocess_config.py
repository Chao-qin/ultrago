"""Validation and deterministic execution helpers for product preprocessing policy."""
from __future__ import annotations

import copy
import random
import re


DEFAULT_CONFIG = {
    "configId": "default",
    "pricing": {"strategy": "fixed_amount", "markup": 10.0},
    "text": {
        "removeSensitiveByAi": False,
        "removeBrandByAi": False,
        "replaceRules": [],
        "enableAiShortTitle": False,
    },
    "sku": {"dropZeroStock": True},
    "images": {
        "main": {"start": 1, "end": None, "shuffle": False},
        "detail": {"start": 1, "end": None, "shuffle": False},
        "seed": None,
    },
}

_TOP_KEYS = {"configId", "shopProfile", "pricing", "text", "sku", "images"}
_PRICING_KEYS = {"strategy", "markup", "markupPercent", "markupFixed", "minPriceYuan", "maxPriceYuan", "minMarginYuan"}
_TEXT_KEYS = {"removeSensitiveByAi", "removeBrandByAi", "replaceRules", "enableAiShortTitle"}
_IMAGE_KEYS = {"main", "detail", "seed"}
_SELECTION_KEYS = {"start", "end", "shuffle"}
_STRATEGIES = {"fixed_amount", "percentage", "percentage_plus_fixed", "min_max"}

# 与 console registry 里 `product-preprocess-config` 的契约版本一致，写进
# canonical.preprocessConfig 供审计。Python 侧拿不到版本号（flow 只把 data 传下来，
# 不带 schemaRef），所以这里只能是一个常量 —— 但它不能是【没人管的】常量：
# test_preprocess_config.py 有一条测试直接读 canonical.schema.json 的
# properties.preprocessConfig.properties.schemaVersion.const 与之比对，
# 两边一旦漂移就红。改契约版本时，这里和 canonical 的 const 一起改。
PREPROCESS_CONFIG_SCHEMA_VERSION = 2


def _object(value, path):
    if not isinstance(value, dict):
        raise ValueError(f"{path} 必须是 JSON object")
    return value


def _keys(value, allowed, path):
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"{path} 含未知字段: {', '.join(sorted(unknown))}")


def _number(value, path, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < minimum:
        raise ValueError(f"{path} 必须是大于等于 {minimum} 的数字")
    return float(value)


def _selection(value, path):
    value = _object(value, path)
    _keys(value, _SELECTION_KEYS, path)
    start = value.get("start", 1)
    end = value.get("end")
    if isinstance(start, bool) or not isinstance(start, int) or start < 1:
        raise ValueError(f"{path}.start 必须是正整数")
    if end is not None and (isinstance(end, bool) or not isinstance(end, int) or end < 1):
        raise ValueError(f"{path}.end 必须是正整数或 null")
    if end is not None and end < start:
        raise ValueError(f"{path}.end 不能小于 {path}.start")
    shuffle = value.get("shuffle", False)
    if not isinstance(shuffle, bool):
        raise ValueError(f"{path}.shuffle 必须是 boolean")
    return {"start": start, "end": end, "shuffle": shuffle}


def compile_replace_rules(rules):
    if rules is None:
        return []
    if not isinstance(rules, list):
        raise ValueError("text.replaceRules 必须是 array")
    compiled = []
    flag_map = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}
    for index, rule in enumerate(rules):
        path = f"text.replaceRules[{index}]"
        rule = _object(rule, path)
        _keys(rule, {"pattern", "replacement", "flags", "description"}, path)
        if not isinstance(rule.get("pattern"), str) or not rule["pattern"]:
            raise ValueError(f"{path}.pattern 必须是非空字符串")
        if not isinstance(rule.get("replacement", ""), str):
            raise ValueError(f"{path}.replacement 必须是字符串")
        if not isinstance(rule.get("description"), str) or not rule["description"].strip():
            raise ValueError(f"{path}.description 必须是非空字符串")
        flags = rule.get("flags", "")
        if not isinstance(flags, str) or any(flag not in flag_map for flag in flags) or len(set(flags)) != len(flags):
            raise ValueError(f"{path}.flags 只支持不重复的 i、m、s")
        try:
            pattern = re.compile(rule["pattern"], sum(flag_map[flag] for flag in flags))
        except re.error as exc:
            raise ValueError(f"{path}.pattern 不是合法正则: {exc}") from exc
        compiled.append((pattern, rule.get("replacement", ""), rule["description"]))
    return compiled


def apply_regex_rules(text, rules):
    result = str(text or "")
    for pattern, replacement, _description in rules:
        result = pattern.sub(replacement, result)
    return result


def normalize_config(config, profile=None):
    """Return a validated, detached policy; preserve shopProfile separately.

    `configId` and `shopProfile` are both OPTIONAL, each with something to fall
    back on — which is why neither is required any more:
      - `configId` falls back to DEFAULT_CONFIG's "default". It is an audit
        label, and the flow run's own paramsJson already records the full input,
        so an override that only carries `pricing` loses nothing by omitting it.
      - `shopProfile` falls back to the flow's `profile` argument (assigned
        just below). Requiring it inside the policy as well forced every caller
        who wanted to override `pricing`/`text` to paste the entire shop profile
        a second time — two copies of the same data, which can disagree, and the
        policy's copy silently won. A policy that DOES carry one still wins; the
        branch at the bottom of this function is unchanged.
    """
    if config is None:
        config = {}
    config = _object(config, "preprocessConfig")
    _keys(config, _TOP_KEYS, "preprocessConfig")
    out = copy.deepcopy(DEFAULT_CONFIG)
    out["shopProfile"] = copy.deepcopy(profile or {})
    if "configId" in config:
        if not isinstance(config["configId"], str) or not config["configId"].strip():
            raise ValueError("preprocessConfig.configId 必须是非空字符串")
        out["configId"] = config["configId"]
    if "shopProfile" in config:
        out["shopProfile"] = copy.deepcopy(_object(config["shopProfile"], "preprocessConfig.shopProfile"))

    pricing = _object(config.get("pricing", {}), "preprocessConfig.pricing")
    _keys(pricing, _PRICING_KEYS, "preprocessConfig.pricing")
    out["pricing"].update(copy.deepcopy(pricing))
    strategy = out["pricing"].get("strategy", "fixed_amount")
    if strategy not in _STRATEGIES:
        raise ValueError(f"preprocessConfig.pricing.strategy 不支持: {strategy!r}")
    required = {
        "percentage": ("markupPercent",),
        "percentage_plus_fixed": ("markupPercent", "markupFixed"),
        "min_max": ("minPriceYuan", "maxPriceYuan"),
    }.get(strategy, ())
    for key in required:
        if key not in out["pricing"]:
            raise ValueError(f"preprocessConfig.pricing.{key} 是 {strategy} 必填项")
    for key in _PRICING_KEYS - {"strategy"}:
        if key in out["pricing"]:
            out["pricing"][key] = _number(out["pricing"][key], f"preprocessConfig.pricing.{key}")
    if strategy == "min_max" and out["pricing"]["minPriceYuan"] > out["pricing"]["maxPriceYuan"]:
        raise ValueError("preprocessConfig.pricing.minPriceYuan 不能大于 maxPriceYuan")

    text = _object(config.get("text", {}), "preprocessConfig.text")
    _keys(text, _TEXT_KEYS, "preprocessConfig.text")
    out["text"].update(copy.deepcopy(text))
    for key in _TEXT_KEYS - {"replaceRules"}:
        if not isinstance(out["text"][key], bool):
            raise ValueError(f"preprocessConfig.text.{key} 必须是 boolean")
    out["text"]["compiledReplaceRules"] = compile_replace_rules(out["text"].get("replaceRules"))

    sku = _object(config.get("sku", {}), "preprocessConfig.sku")
    _keys(sku, {"dropZeroStock"}, "preprocessConfig.sku")
    out["sku"].update(copy.deepcopy(sku))
    if not isinstance(out["sku"]["dropZeroStock"], bool):
        raise ValueError("preprocessConfig.sku.dropZeroStock 必须是 boolean")

    images = _object(config.get("images", {}), "preprocessConfig.images")
    _keys(images, _IMAGE_KEYS, "preprocessConfig.images")
    out["images"]["main"] = _selection(images.get("main", out["images"]["main"]), "preprocessConfig.images.main")
    out["images"]["detail"] = _selection(images.get("detail", out["images"]["detail"]), "preprocessConfig.images.detail")
    if "seed" in images and images["seed"] is not None:
        if isinstance(images["seed"], bool) or not isinstance(images["seed"], int) or images["seed"] < 0:
            raise ValueError("preprocessConfig.images.seed 必须是非负整数或 null")
        out["images"]["seed"] = images["seed"]
    return out


def select_image_urls(urls, selection, seed=None):
    start = selection.get("start", 1)
    end = selection.get("end")
    selected = list(urls[start - 1:end])
    if selection.get("shuffle"):
        rng = random.Random(seed)
        rng.shuffle(selected)
    return selected


def audit_config(config):
    """Return JSON-safe policy metadata without compiled regex objects or shop data."""
    out = copy.deepcopy(config)
    out["text"].pop("compiledReplaceRules", None)
    out["text"]["replaceRuleCount"] = len(config["text"].get("compiledReplaceRules", []))
    out.pop("shopProfile", None)
    return {
        "configId": config["configId"],
        "schemaName": "product-preprocess-config",
        "schemaVersion": PREPROCESS_CONFIG_SCHEMA_VERSION,
        "effective": out,
    }
