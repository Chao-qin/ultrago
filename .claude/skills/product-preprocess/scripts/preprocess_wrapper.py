#!/usr/bin/env python3
"""Stable JSON adapter for product preprocessing.

The public contract is deliberately narrow: a raw product body enters and a
canonical product projection body returns. Category catalogues, LLM policy,
and projection policy are runtime dependencies, not agent-chosen request
switches. A validated shop profile may come from a Flow's SchemaRecord choice;
otherwise the caller must provide a local profile. ``persist`` can additionally
write the exact returned body to one repository-local JSON file; it never
changes processing behaviour.
"""

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(PACKAGE_DIR))

from build_canonical import _normalize_raw_input  # noqa: E402
from build_doudian_product import build_doudian_product  # noqa: E402
from preprocess import load_json  # noqa: E402
from preprocess_config import normalize_config  # noqa: E402


REPO_ROOT = PACKAGE_DIR.parent.parent.parent
CONSOLE_URL = __import__("os").environ.get("CONSOLE_URL", "http://127.0.0.1:8790")


def decode_request(raw_input):
    """Decode the public body into fixed production dependencies and inputs."""
    try:
        request = json.loads(raw_input)
    except json.JSONDecodeError as exc:
        raise ValueError(f"stdin 不是合法 JSON: {exc}") from exc
    if not isinstance(request, dict):
        raise ValueError("stdin 顶层必须是 JSON object")

    unknown_fields = set(request) - {"raw", "profile", "mode", "category", "persist", "preprocessConfig"}
    if unknown_fields:
        raise ValueError(f"入参含未知字段: {', '.join(sorted(unknown_fields))}")

    raw = request.get("raw")
    if not isinstance(raw, dict):
        raise ValueError("入参必须包含 object 类型的 raw")

    profile = request.get("profile")
    if profile is not None and not isinstance(profile, dict):
        raise ValueError("profile 必须是 JSON object")

    mode = request.get("mode")
    if mode is not None and mode not in {"draft", "publish"}:
        raise ValueError("mode 必须是 draft 或 publish")

    category_leaf_id = decode_category(request.get("category"))
    preprocess_config = decode_preprocess_config(request.get("preprocessConfig"), profile)

    return {
        "raw": raw,
        "profile": profile,
        "mode": mode,
        "category_leaf_id": category_leaf_id,
        "preprocess_config": preprocess_config,
        "persist_path": resolve_persist_path(request.get("persist")),
    }


def decode_preprocess_config(value, profile=None):
    """Validate the optional policy and return a detached normalized object."""
    if value is None:
        return None
    return normalize_config(value, profile)


def decode_category(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("category 必须是 JSON object")
    kind = value.get("kind")
    if kind == "auto" and set(value) == {"kind"}:
        return None
    if kind == "fixed" and set(value) == {"kind", "leafId"}:
        leaf_id = value["leafId"]
        if isinstance(leaf_id, bool) or not isinstance(leaf_id, int) or leaf_id <= 0:
            raise ValueError("category.leafId 必须是正整数")
        return leaf_id
    raise ValueError("category.kind 必须是 auto，或 fixed 且提供 leafId")


def resolve_persist_path(value):
    """Resolve the sole optional persistence target inside the repository."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("persist 必须是 JSON object")
    if value.get("kind") == "none" and set(value) == {"kind"}:
        return None
    if value.get("kind") != "file" or set(value) != {"kind", "path"}:
        raise ValueError("persist.kind 必须是 none，或 file 且提供 path")
    path = value["path"]
    if not isinstance(path, str) or not path.strip():
        raise ValueError("persist.path 必须是非空字符串")
    candidate = Path(path)
    if candidate.is_absolute():
        raise ValueError(f"persist.path 必须是仓库内相对路径，收到绝对路径：{path}")
    root = REPO_ROOT.resolve()
    resolved = (root / candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"persist.path 逃出了仓库目录：{path}")
    return resolved


def exit_code_for_result(result):
    if result.get("projection_error"):
        return 2
    verdict = result.get("projection_verdict")
    if verdict and verdict.get("status") == "blocked":
        return 2
    return 0 if (result.get('publication') or {}).get('canPublish') is True else 1


def build_output(result, mode=None):
    """Return only JSON values; never turn an artifact path into the output."""
    publication = result.get('publication') or {
        'canPublish': False, 'canDraft': False, 'missingRequired': ['缺少发布条件判断'],
    }
    verdict = result.get('projection_verdict') or {}
    blocked = bool(result.get('projection_error')) or verdict.get('status') == 'blocked'
    if blocked:
        publication = {**publication, 'canPublish': False, 'canDraft': False}
    missing = publication['missingRequired']
    status = 'blocked' if blocked else 'ready' if publication['canPublish'] else 'needs_input' if missing else 'blocked'
    reason = result.get('projection_error') or (
        verdict.get('reason') if blocked else None
    ) or ('商品已满足发布条件' if status == 'ready' else
          f"商品仍需补充：{'、'.join(missing)}" if missing else '商品不满足发布或草稿条件')
    output = {
        'canonical': result.get('canonical') or {},
        'publication': publication,
        'outcome': {
            'status': status, 'reason': reason, 'missingRequired': missing,
            'label': {'ready': '预处理通过', 'needs_input': '待补资料', 'blocked': '已阻断'}[status],
            'level': 'info' if status == 'ready' else 'error' if status == 'blocked' else 'warning',
        },
    }
    if result.get('phase_timings') is not None:
        output['phaseTimings'] = result['phase_timings']
    if mode is not None:
        output["mode"] = mode
    return output


def process_product(request):
    """Process one raw JSON body with the fixed production policy.

    The returned envelope is the same regardless of ``persist``. Image asset
    ownership is intentionally outside this adapter until the resource service
    exists, so this body-only interface never exposes working directories.
    """
    decoded = decode_request(request) if isinstance(request, str) else request
    result = build_doudian_product(
        _normalize_raw_input(decoded["raw"]),
        profile=decoded["profile"],
        no_llm=False,
        no_project=False,
        category_leaf_id=decoded["category_leaf_id"],
        console_url=CONSOLE_URL,
        download_images=True,
        config=decoded.get("preprocess_config"),
    )
    return build_output(result, decoded["mode"])


def persist_output(path, output):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    try:
        request = decode_request(sys.stdin.read())
        output = process_product(request)
        if request["persist_path"] is not None:
            persist_output(request["persist_path"], output)
    except Exception as exc:
        print(f"商品处理失败: {exc}", file=sys.stderr)
        output = {
            'canonical': {},
            'publication': {'canPublish': False, 'canDraft': False, 'missingRequired': []},
            'outcome': {'status': 'blocked', 'label': '已阻断', 'level': 'error', 'reason': str(exc), 'missingRequired': []},
        }
        if getattr(exc, 'phase_timings', None) is not None:
            output['phaseTimings'] = exc.phase_timings

    # FlowRunner parses stdout only after exit=0; the business result is in JSON.
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
