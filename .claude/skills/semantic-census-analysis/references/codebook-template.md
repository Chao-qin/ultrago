# Codebook Template (Gate 2)

The codebook is the **single source of truth** for what every code means. Freeze it *before* parallel coding and version it, so 14 coders (or the same coder across 14 batches) apply the same definitions — and so anything summed in Gate 5 is actually commensurable.

Copy this, fill it from a seed batch (~10–20 units), and bind the version to the run.

```yaml
codebook_version: v1            # bump on any code add/change; record which run used which version
corpus: <what corpus, from which Gate-0 frame>
count_unit: per-author          # or per-post — NEVER per-comment (Gate 3)
```

## Code entry format

Each code MUST have all fields. `layer` decides whether it can be counted (observable) or only reported with evidence (inferential).

```yaml
- code: underwire_pain
  layer: observable            # observable = stated in text | inferential = read-between-lines
  definition: User reports physical pain/pressure caused by the underwire or its rigid core.
  include:
    - explicit pain/pressure attributed to wire, gore, or side boning
    - "want no-wire BECAUSE it hurts" (the driver is pain)
  exclude:
    - generic "no-wire" preference with no pain reason (→ comfort_preference)
    - pain attributed to size/fit, not the wire (→ sizing_struggle)
  positive_examples:
    - "钢圈硬得要勒死了"
    - "有钢圈的简直是刑具"
  negative_examples:
    - "我喜欢无钢圈的" (preference, no pain stated → comfort_preference)
    - "买小了勒" (fit issue → sizing_struggle)

- code: latent_seamless_need
  layer: inferential           # cannot be summed into headline numbers (Gate 5)
  definition: A seamless/invisible need expressed WITHOUT the word "seamless" — via a
    situation where the bra shows through clothing.
  include:
    - complaints that edges/shape/color show under thin or tight outerwear
  exclude:
    - explicit "无痕" mentions (→ observable seamless_stated)
  positive_examples:
    - "内衣边缘会显出来"
    - "穿连衣裙就像个煤气罐"
  negative_examples:
    - "这款无痕很好" (explicit + positive → seamless_stated)
  requires_for_use:                 # inferential codes carry evidence, always
    - verbatim_trigger_span         # the exact text that triggered the inference
    - confidence: low|medium|high
    - alternative_reading           # a plausible benign/other reading of the same span
```

## Source-type codes (Gate 4 adversarial classes)

Coding *who is speaking* is as important as *what they say* — 40%+ of a scraped comment set can be non-user text. Treat ad/astroturf as **adversarial** (written to pass as genuine): require ≥2 signals and remember recall is a floor.

```yaml
- code: src_genuine_user       # only these enter demand analysis
- code: src_author_promo       # OP shilling own product/brand
- code: src_competitor_poach   # rival seller soliciting in comments ("来我这看看")
- code: src_noise_social       # thanks / laughter / bumping / emoji-only / off-topic
# ≥2 signals to accept src_genuine_user: account pattern + template phrasing + link/brand
```

## Rules of use (bind into every coder's prompt)

1. Read this codebook first. Apply definitions literally; use include/exclude to resolve edges.
2. **No silent new codes.** If nothing fits, tag `NEEDS_NEW_CODE` + a note and return it to the orchestrator, which decides and bumps `codebook_version`.
3. Observable codes may be counted. **Inferential codes may not be summed** — each is reported with its trigger span, confidence, and alternative reading.
4. When unsure between two codes, record both plus a one-line reason; the orchestrator adjudicates. Never guess silently — guessing is what destroys cross-coder agreement (Gate 4b).
