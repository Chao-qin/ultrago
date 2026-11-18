#!/usr/bin/env python3
"""
verify.py — deterministic verification for semantic-census-analysis (Gate 3 + Gate 4a).

Two checks, both zero-sampling:

  1. Citation fidelity (Gate 4a): every verbatim quote in your findings must exist
     in the source corpus. Grep proves a quote is REAL — it does NOT prove the quote
     was filed under the right code. That is Gate 4b (coding fidelity), which needs an
     independent re-coder, not this script. Do not let a green run here stand in for it.

  2. Coverage reconciliation (Gate 3): coded-unit count vs. true corpus unit count,
     so "full census" is a measured fact, not a claim — reported per LEVEL (posts AND
     comments), because "we covered everything" must hold at every nesting level.

Matching is per ATOMIC text unit (one string leaf = one comment/title/field), not a
single joined haystack, so a quote can never falsely "match" by straddling two fields.

Usage
-----
  # citation fidelity — check that every quote exists verbatim in the corpus
  python verify.py cite --corpus data.json --quotes quotes.json [--quote-key text]

      quotes.json: a JSON array of strings, OR any JSON — with --quote-key it recurses
      into that field; without it, every string leaf is treated as a quote. Explicit
      quotes are ALL checked (no length filtering). --min-len only filters the
      auto-harvest (no --quote-key, raw array) case, and the filtered count is printed.

  # coverage reconciliation — posts and comments both
  python verify.py cover --corpus data.json --unit posts    --coded 310
  python verify.py cover --corpus data.json --unit comments --coded 5176
      --unit posts|comments|flat_list  (see --help)

Exit code is non-zero if any quote is missing (cite) or coverage != 100% (cover),
so it can gate a pipeline.
"""
import argparse, json, re, sys


def norm(s):
    return re.sub(r"\s+", "", s or "")


def iter_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from iter_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from iter_strings(v)


def atomic_units(corpus_path):
    """Every string leaf, normalized, as an independent unit (no cross-field join)."""
    data = json.load(open(corpus_path, encoding="utf-8"))
    return [norm(s) for s in iter_strings(data) if s and s.strip()]


def collect_quotes(quotes_path, quote_key):
    """Return (quotes, is_explicit). Explicit = came from an array or a --quote-key
    field, so every one must be checked. Recurses through nested objects/arrays."""
    data = json.load(open(quotes_path, encoding="utf-8"))
    if quote_key:
        found = []
        def walk(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k == quote_key:
                        found.extend(s for s in iter_strings(v) if s.strip())
                    else:
                        walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(data)
        return found, True
    if isinstance(data, list) and all(isinstance(x, str) for x in data):
        return [s for s in data if s.strip()], True   # explicit array of strings
    return [s for s in iter_strings(data) if s.strip()], False  # auto-harvest


def cmd_cite(args):
    atoms = atomic_units(args.corpus)
    joined = "".join(atoms) if args.allow_fragment_join else None
    quotes, explicit = collect_quotes(args.quotes, args.quote_key)

    filtered = 0
    if not explicit and args.min_len:
        before = len(quotes)
        quotes = [q for q in quotes if len(q.strip()) >= args.min_len]
        filtered = before - len(quotes)

    if not quotes:
        print("no quotes found to check — check --quote-key / input shape", file=sys.stderr)
        return 2

    def present(q):
        nq = norm(q)
        if any(nq in a for a in atoms):      # must live inside ONE atomic unit
            return True
        return joined is not None and nq in joined
    missing = [q for q in quotes if not present(q)]
    found = len(quotes) - len(missing)

    print(f"citation fidelity: {found}/{len(quotes)} quotes verbatim-present "
          f"({found/len(quotes)*100:.1f}%)  [per-atom match"
          f"{'; fragment-join allowed' if args.allow_fragment_join else ''}]")
    if filtered:
        print(f"  note: {filtered} auto-harvested string(s) below --min-len {args.min_len} "
              f"were NOT checked (pass an explicit --quotes array to check them).")
    for q in missing[: args.show]:
        print(f"  MISSING: {q[:100]}")
    if missing:
        print(f"\n{len(missing)} missing. A real-but-elided quote (fragments joined with …) "
              f"reads as missing under per-atom matching — re-check a distinctive fragment, or "
              f"pass --allow-fragment-join, before calling it fabrication.")
    print("\nReminder: this is Gate 4a only. Coding fidelity (Gate 4b) still needs an "
          "independent (cross-model or human) re-coder.")
    return 1 if missing else 0


def _counts(data, comments_key):
    """Return (posts, comments) for a {category: [post,...]} or top-level [post,...] shape."""
    if isinstance(data, dict):
        posts_lists = [v for v in data.values() if isinstance(v, list)]
    elif isinstance(data, list):
        posts_lists = [data]
    else:
        return None, None
    posts = sum(len(pl) for pl in posts_lists)
    comments = 0
    for pl in posts_lists:
        for p in pl:
            if isinstance(p, dict) and isinstance(p.get(comments_key), list):
                comments += len(p[comments_key])
    return posts, comments


def cmd_cover(args):
    data = json.load(open(args.corpus, encoding="utf-8"))
    posts, comments = _counts(data, args.comments_key)

    if args.unit == "flat_list":
        total = len(data) if isinstance(data, list) else None
    elif args.unit in ("posts", "top_values"):
        total = posts
    elif args.unit == "comments":
        total = comments
    else:
        total = None
    if total is None:
        print(f"cannot count --unit '{args.unit}' for this corpus shape. "
              f"posts={posts} comments={comments} (comments-key='{args.comments_key}'). "
              f"For other shapes, count with jq and pass --coded only.", file=sys.stderr)
        return 2

    # always surface both levels so comment coverage can't hide behind post coverage
    if posts is not None:
        print(f"corpus levels: posts={posts}  comments={comments}")
    cov = args.coded / total * 100 if total else 0
    print(f"coverage[{args.unit}]: coded {args.coded} / corpus {total} = {cov:.1f}%")
    if args.coded != total:
        print("  NOT full coverage at this level — label results by actual coverage (Gate 1/3).")
        return 1
    print("  full coverage confirmed at this level.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Verification gates for semantic-census-analysis")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("cite", help="Gate 4a: every quote exists in the corpus")
    c.add_argument("--corpus", required=True)
    c.add_argument("--quotes", required=True)
    c.add_argument("--quote-key", default=None,
                   help="field name to pull quotes from (recurses; every value checked)")
    c.add_argument("--min-len", type=int, default=6,
                   help="only filters AUTO-HARVEST (no --quote-key raw array); filtered count printed")
    c.add_argument("--allow-fragment-join", action="store_true",
                   help="also accept a quote that spans multiple fields (looser; off by default)")
    c.add_argument("--show", type=int, default=30, help="max missing quotes to print")
    c.set_defaults(func=cmd_cite)

    v = sub.add_parser("cover", help="Gate 3: coded vs. true unit count, per level")
    v.add_argument("--corpus", required=True)
    v.add_argument("--coded", type=int, required=True)
    v.add_argument("--unit", default="posts",
                   choices=["posts", "comments", "flat_list", "top_values"],
                   help="which level to gate on (posts and comments both always reported)")
    v.add_argument("--comments-key", default="comments",
                   help="nested field holding each post's comments (default: comments)")
    v.set_defaults(func=cmd_cover)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
