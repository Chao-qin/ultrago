# Rigor Gates — full spec

The 8 gates that turn a full-census LLM read from "confident" into "trustworthy". Each gate lists **why it exists** (the failure it prevents), **the rule**, and **how to check it**. The failures below are real ones observed when this method was first run without the gate — treat them as the test suite for your analysis.

---

## Gate 0 — Scope & sampling frame [RIGID]

**Failure prevented:** treating a search-ranked convenience scrape as if it represented a population, then writing "users want X" about everyone.

**Rule.** Before any claim, register the frame:
- platform, query terms / keywords used, capture time window, and the **ranking mechanism** that surfaced these items (e.g. "search relevance + engagement weighting", not random);
- the size of every stratum (per query term, per category);
- an explicit label: *non-probability sample; results are sample-internal.*

**Check.** If any two strata differ by more than ~2×, **do not pool them into one ranking** — report per-stratum or disclose the weighting. Apply the same imbalance rule you'd use to drop a tiny stratum (n≈1) to *every* stratum, not just the obvious one.

---

## Gate 1 — Scale & cost pre-check [RIGID]

**Failure prevented:** defaulting to an unbounded fan-out that blows the budget, or quietly sampling while claiming "full census".

**Rule.** Estimate `corpus_size × per-unit token cost` against the budget.
- Fits → run the full census.
- Doesn't fit → **degrade** to stratified-sample-then-read (sample within each Gate-0 stratum), and label every result as sample-based with its sampling rate. Do not pretend it was a census.

**Check.** The chosen path (census vs. degraded) is stated in the output. "Full census" appears only when coverage was actually 100% (verified in Gate 3).

---

## Gate 2 — Codebook-first [RIGID]

**Failure prevented:** 14 coders each inventing their own meaning of "pain point" / "latent need", then those incommensurable labels getting summed in Gate 5 into a fake distribution.

**Rule.** Induce a codebook from a seed batch (~10–20 units) **before** parallel coding. Freeze it with a version number bound to this run. Each code carries: name · definition · inclusion criteria · exclusion criteria · 2 positive examples · 2 boundary/negative examples. Tag each code:
- **observable** — stated in the text (e.g. "complains underwire hurts");
- **inferential** — read between the lines (e.g. "this 'make it look smaller' request is body-shame driven").

Parallel coders read the frozen codebook first and may **not** silently create codes; a genuinely new code goes back to the orchestrator, which bumps the version. Use `references/codebook-template.md`.

**Check.** A versioned codebook file exists and is referenced by the run. No label appears in results that isn't defined in it.

---

## Gate 3 — Full-census coding [RIGID coverage]

**Failure prevented:** attention collapse (a single context stuffed with thousands of items skims the middle) and mis-counted independence.

**Rule.**
- Batch by **parent unit** (a post *with* its comments) so context is preserved; never split a comment from the thread it replies to.
- Cover 100% of units; batches must be mutually exclusive and exhaustive.
- Define the **count unit up front**: per-author or per-post, **not** per-comment. Comments nest inside posts and are dominated by a few heavy users, so raw comment counts overstate independent signal. Report the effective N.

**Check.** Coverage reconciliation: Σ(coded units) == total units (see `scripts/verify.py`). Every reported % carries its triple: `{numerator unit, dedup level, denominator}`. **Persist per-unit labels** (unit id → codes) as an artifact (e.g. `labels.jsonl`) — without them Gate 4b cannot be run retroactively and no run can be compared to another. Aggregating without saving the per-unit labels is the mistake that makes coding fidelity un-auditable after the fact.

---

## Gate 4 — Two-layer verification [RIGID]

**Failure prevented:** the halo of "we verified 459 quotes, zero fabrication" being read as "the analysis is correct" — when quote-existence says nothing about whether each quote was filed under the right code.

**Rule — run both layers, and never let (a) stand in for (b):**

**(a) Citation fidelity.** Every verbatim quote in the output must exist in the source corpus (whitespace-normalized substring match is fine). Target 100%. `scripts/verify.py` does this.

**(b) Coding fidelity.** Blind re-code a **stratified random** subset (e.g. ~15–20% of units, spread across categories) with a **different model family or a human** — never the same model that produced the labels. Compute per-category precision and a **chance-corrected** agreement statistic (Cohen's κ or Krippendorff's α), against a pre-registered threshold (e.g. α ≥ .67 tentative / ≥ .80 solid). Below threshold → fix the codebook and re-code; do not aggregate.

> **Same-model agreement is 0 reliability evidence.** N agents of one model = one instrument run N times; their errors are correlated, so their consensus is a property of the instrument's priors, not of the data. Call within-model agreement *consistency*, never *reliability*.

**Adversarial classes.** Ad-copy / astroturf / traffic-poaching are written to look like genuine users, so a single classifier's recall is unknown and probably low. Plant known ad examples and measure recall; report the genuine-voice share as a **floor with a recall caveat**, not a point estimate. Require ≥2 independent signals (account pattern + template phrasing + link/brand) before trusting a "genuine" label.

**Check.** Output has separate, non-merged statements for: fabrication rate (a), coding precision (b), and adversarial-class recall. If (b) wasn't run, quantitative claims are downgraded to "qualitative observation, coding un-audited".

---

## Gate 5 — Aggregation discipline [RIGID]

**Failure prevented:** pseudo-precise percentages from approximate counts; untraceable theme merges; competitor "share of voice" that is really an artifact of the query terms and lumps praise with complaints.

**Rule.** Only aggregate after Gates 2 and 4 pass.
- Dedup to the count unit (Gate 3). Report **ordinal tiers** (frequent / occasional / rare) or ranges — approximate counts do not license decimal percentages or exact rankings.
- Every theme merge is logged as `raw label(s) → merged theme + reason + dissenting reading`.
- Competitors: maintain a **reviewed alias table** (catch disguised spellings), then split each mention by **sentiment polarity** and **query bucket**, and count **genuine-source mentions only**. Output "mentions by polarity within a query-defined sample" — never "share of voice / preference / market share".
- **Inferential codes are never summed into headline numbers.** Report them separately, each with its verbatim trigger span, a confidence level, and an alternative benign reading.

**Check.** No decimal-precision % on approxCount data. A merge trace exists. Competitor tables show polarity, not a single "voice" number.

---

## Gate 6 — Saturation, negative-case, reflexivity [FLEXIBLE but expected]

**Failure prevented:** the LLM pattern-matching to confirm the frame you handed it (confirmation bias), over-stating a dominant theme, and burying the minority/contradicting voices.

**Rule.**
- Track **new codes per batch**. If the curve is still rising at the last batch, the theme set is *provisional / unsaturated* — say so.
- For every headline claim, run a **negative-case pass**: actively search the whole corpus for counter-evidence and report the count (or "searched, none found").
- **Reflexivity:** attach the coding prompt to the output as an *instrument disclosure* — your categories co-produce the findings. For any interpretive/emotional category, run one **open-coding pass with no preset categories** and compare: codes that only the open pass produced (your frame was too narrow) and preset codes the open pass never produced (you may have imposed them).

**Check.** Saturation stated; each headline claim has a counter-evidence line; interpretive categories have an open-coding cross-check.

---

## Gate 7 — Decision-ready output + validity boundary [RIGID]

**Failure prevented:** shipping four descriptive lists (pains / needs / scenarios / competitors) that read richly but drive no decision.

**Rule.** Produce an **opportunity matrix** — one row per top insight:

`job/scenario · pain · latent need · frequency tier · intensity · affected segment · competitor currently "hired" · whitespace · recommended action · confidence`

Competitor mentions hang off the pain/scenario they belong to (JTBD "currently hired"), not a standalone table. Overall rankings are shown **with per-segment rankings**; flag any overall rank that is >X% driven by one segment. Every number states its **validity boundary**: the Gate-0 frame + "sample-internal, not a population estimate".

**Check.** Each top insight has a recommended action and a confidence + validity boundary. No population-level phrasing survives.

---

## The core distinction, restated

Coverage (did we read all of it?) is verified by Gate 3 + `verify.py`. **Validity** (did we read it correctly, and do the numbers mean what we say?) is verified by Gates 2, 4, 5, 6. Never let a coverage number stand in for a validity claim — that substitution is the single most common way this method fools its own author.
