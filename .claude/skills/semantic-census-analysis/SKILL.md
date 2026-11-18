---
name: semantic-census-analysis
description: >-
  Rigorous LLM-driven qualitative analysis of messy user-generated text — comments,
  reviews, 评论, 弹幕, 用户反馈, 问卷开放题, tickets, transcripts. Read the WHOLE corpus
  semantically instead of 词频/词云/关键字统计 or eyeballing a sample, then gate every
  finding (codebook-first coding, cross-model reliability, two-layer verification,
  adversarial-class recall, explicit validity boundary, decision-ready output) so
  results are trustworthy, not just confident. Use whenever someone wants to 分析/挖掘
  a pile of comments/reviews/用户需求/痛点/卖点/需求洞察/VoC, or asks 这些数据说明什么 /
  用户到底想要什么 / 帮我看看这批评论 — ESPECIALLY when about to just count keywords or
  generalize from a few examples. Do NOT use for structured/numeric data (use SQL/stats),
  corpora too large to read in full within budget (degrade to stratified-sample+read),
  or population-level/cross-platform generalization (non-probability qualitative insight,
  not survey estimates).
---

# Semantic Census Analysis

Turn a messy pile of user-generated text into **trustworthy** qualitative insight.

The one thing to remember: **reading everything (coverage) is not the same as reading it correctly (validity).** A full-census LLM pass that codes every comment can still be systematically wrong if the coder is biased, the categories are undefined, or the counts mix apples and ads. This skill is the discipline that closes that gap.

## Why this beats the two common shortcuts

- **vs. keyword / 词频 / 词云:** counting a word ignores negation ("不聚拢"), sarcasm, questions vs. complaints, and — worst — counts seller ad-copy and noise as if it were user need. The strongest needs often contain none of the "expected" keywords.
- **vs. sampling + eyeballing:** with modern LLMs you can usually read the *entire* corpus, so a non-representative peek is now a choice, not a constraint. Census removes sampling error — but does nothing about **measurement** error, which is the real threat. That is what the gates below control.

## When to use / when NOT to (check first)

Use it for open-ended text where meaning matters: comments, reviews, tickets, survey free-text, transcripts.

Do **not** use it — and say so plainly — when:
- the data is structured/numeric → use SQL/statistics instead;
- the corpus is too large to read in full within the token/time budget → **degrade** to a stratified-sample-then-read hybrid and label results accordingly (Gate 1);
- the ask needs **population-level** or **cross-platform** claims → this is non-probability qualitative insight; refuse to output survey-style estimates.

## The pipeline: 8 gates

Run them in order. Gates marked **[RIGID]** are non-negotiable — skipping one is how "confident but wrong" gets shipped. The coding *taxonomy itself* is **[FLEXIBLE]** — adapt it to the domain. Full spec: **`references/rigor-gates.md`** — the **single source of truth** for gate rules and thresholds; change rules there, never duplicate them into the table below (this table is a one-line index only, to avoid the two-files-drift that already bit `verify.py`'s docs).

| # | Gate | The rule in one line |
|---|------|----------------------|
| 0 | **Scope & sampling frame** [RIGID] | Register the frame — platform, queries/keywords, capture time, ranking mechanism, per-stratum sizes — and label it a *non-probability* sample. This bounds every claim downstream. |
| 1 | **Scale & cost pre-check** [RIGID] | Estimate corpus × per-unit cost vs. budget. If full census fits → proceed. If not → degrade to stratified-sample + read and label it. Never silently fan out an unbounded read. |
| 2 | **Codebook-first** [RIGID] | Before any parallel coding, freeze a **versioned** codebook: each code = name + definition + inclusion + exclusion + 2 positive + 2 negative examples. Mark each code **observable** (in the text) or **inferential** (read between the lines). Coders read it first; no silent new codes — escalate to bump the version. See `references/codebook-template.md`. |
| 3 | **Full-census coding** [RIGID coverage] | Batch by *parent unit* (post → its comments) to preserve context, not by flat comment. Cover 100%; reconcile counts. Define the **count unit** (per-author or per-post, **not** per-comment) up front. |
| 4 | **Two-layer verification** [RIGID] | (a) *Citation fidelity*: every verbatim quote must exist in the source (grep, 100%). (b) *Coding fidelity*: blind re-code a stratified subset with a **different model family or a human**, report per-category precision + a chance-corrected agreement (κ/α) against a pre-registered threshold. Same-model agreement is **0 reliability evidence**. Adversarial classes (ads/astroturf) need a planted-positive **recall** test. `scripts/verify.py` runs (a) and coverage reconciliation. |
| 5 | **Aggregation discipline** [RIGID] | Only after Gates 2 & 4 pass. Dedup to the count unit. Report **ordinal tiers / ranges, not pseudo-precise %**. Keep an auditable raw-label → merged-theme trace. Competitors: alias table × sentiment polarity × genuine-source-only × query bucket — never a bare "share of voice". **Inferential codes are never summed** — reported separately with span + confidence + an alternative reading. |
| 6 | **Saturation, negative-case, reflexivity** [FLEXIBLE but expected] | Track new-codes-per-batch; if still rising at the last batch, label the theme set *provisional*. For each headline claim, actively search for counter-evidence and report the count. Attach the coding prompt as an *instrument* disclosure; consider one open-coding pass with no preset categories to test whether a category (e.g. an emotional "subtext") was imposed by your prompt rather than found in the data. |
| 7 | **Decision-ready output + validity boundary** [RIGID] | End with an opportunity matrix (one row per top insight: job/scenario · pain · latent need · frequency tier · intensity · segment · competitor currently "hired" · whitespace · recommended action · confidence). Every number carries its **validity boundary** (frame + "sample-internal, not a population estimate"). |

## Red flags — these thoughts mean STOP

| The thought | The reality |
|---|---|
| "词频/词云 就够了" | It counts ad-copy and noise as need, and misses every need phrased without the keyword. Gate 2–3. |
| "点赞高 = 重要" | Engagement selects for virality, not signal density; ad posts get likes, help posts hold the real needs. |
| "N 个 agent 都同意 → 可靠" | Same model × N = one instrument run N times; errors are correlated. Reliability needs a *different* coder (Gate 4). |
| "grep 全过了 → 分析对了" | Grep proves the quote is real, not that its label is right. Fidelity ≠ validity (Gate 4b). |
| "真声 57.4%（写进结论）" | Pseudo-precision from an unvalidated classifier; and ad-detection recall is unknown, so it's a floor. Use tiers + recall caveat. |
| "用户其实想要 X（无原文支撑）" | Inferential leap = highest hallucination risk. Anchor a verbatim span + confidence + alternative reading, or drop it. |
| "所以中国用户都……" | Cross-platform / population generalization from a non-probability sample. Stay inside the frame (Gate 0). |

## Method vs. Findings separation [RIGID]

This skill file (and any reusable playbook) holds **method only**. Every number, quote list, and category distribution from a specific run goes into an **output artifact** (e.g. `report.md`, `findings.json`) — never hard-coded back into the method as a threshold or baseline. A ratio from one corpus is not a benchmark for the next.

## Bundled resources

- **`references/rigor-gates.md`** — the concrete spec, thresholds, and rationale for all 8 gates. Read before running.
- **`references/codebook-template.md`** — the coding-SSOT template (Gate 2), including the observable-vs-inferential split.
- **`scripts/verify.py`** — citation-fidelity check (every quote vs. source) + coverage reconciliation (Gate 4a / Gate 3). Deterministic; run it, don't eyeball.

## Orchestration note

Coding fans out well to parallel sub-agents (one per batch, context-preserving). Keep the **codebook, the merge/aggregation, and the two verification gates in the orchestrator** — those are where cross-item judgment and independence live, and they must not be delegated to the same coders whose work they check.
