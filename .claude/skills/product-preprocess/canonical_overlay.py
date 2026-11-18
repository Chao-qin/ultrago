def deep_merge(base, patch):
    # 规格列表的顺序决定 SKU 组合，列表必须整组替换。
    if not isinstance(base, dict) or not isinstance(patch, dict):
        return patch
    out = dict(base)
    for key, value in patch.items():
        out[key] = deep_merge(out[key], value) if key in out else value
    return out


def apply_attribute_overlay(canonical, patch):
    # 类目必填属性可能不存在于来源商品中；未匹配的来源属性仍需保留。
    by_name = {attribute.get('sourceName'): attribute for attribute in patch}
    merged = [
        deep_merge(attribute, by_name.pop(attribute.get('sourceName')))
        if attribute.get('sourceName') in by_name else attribute
        for attribute in canonical.get('attributes') or []
    ]
    merged.extend(by_name.values())
    return merged
