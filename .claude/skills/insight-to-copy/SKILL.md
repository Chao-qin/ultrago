---
name: insight-to-copy
description: >-
  Turn AUDITED research findings (from semantic-census-analysis or any VoC/评论/用户洞察
  report) into platform-compliant marketing copy — 抖店/淘宝 商品标题·卖点·详情文案, 小红书
  种草文案, 直播话术, 落地页文案. Enforces a claim ledger: every sentence must bind BOTH a
  findings anchor AND a real product-spec anchor, or it becomes a placeholder / gets dropped.
  Blocks 广告法 violations (绝对化 / 医疗功效), platform risk words, ad-shell words (聚拢/显小/
  提拉/无痕/封神), and over-generalization past the study's validity boundary. Use whenever
  someone wants to 写文案/写卖点/起草商品标题/写种草/把分析结论变成推广内容/insight→copy,
  ESPECIALLY right after a data-analysis or VoC report. Do NOT use to invent claims with no
  findings, to publish (hand off to the platform ops skill, e.g. douyindian-product-ops), or
  when there is no audited findings artifact yet (run the analysis first).
---

# Insight → Copy

Convert **audited** research findings into copy that is **grounded, compliant, and safe to publish** — the missing SSOT between "we analyzed the data" and "we listed the product."

The failure this prevents (observed for real): copy that *sounds* insight-driven but (a) makes claims the report never supported, (b) promises product effects the real product may not have, (c) reuses the platform's own ad-shell words the analysis flagged as noise, or (d) turns a sample-internal hypothesis into a universal promise. Ad-hoc copywriting in a chat has no memory of these rules; this skill is that memory.

## When to use / when NOT to

Use it the moment findings become copy. Do **not** use it when:
- there is **no audited findings artifact** yet → run `semantic-census-analysis` (or your analysis) first; copy from un-audited findings inherits their errors;
- the task is to **publish** → this skill produces copy only; hand the vetted copy to the platform ops skill (e.g. `douyindian-product-ops`) and let it enforce its own real-data/confirm gates;
- you are asked to **invent** a selling point with no basis → refuse; say what evidence is missing.

## The one rule: the claim ledger [RIGID]

**No sentence ships without two anchors.** Every claim line is entered in a ledger:

| 文案句 | 报告发现锚点 | 真实商品证据 | 判定 |
|---|---|---|---|

- **报告发现锚点** — the exact finding (with location) that supports this angle. No finding → the line is invention → **drop it**.
- **真实商品证据** — the real product spec/material/service that makes the claim true. Not confirmed → the claim becomes a **`[占位符]`** to be filled with real data before publish, *even if it has no obvious number* (see below).
- **判定** — `ship`(产品主张·双锚点齐) / `voice`(非主张·用户原声或态度,仅需报告锚点) / `placeholder` / `drop` / `soften`.

A finding anchor alone is **not** enough: the report proves *the need exists in the sample*, never *your product meets it*. Both columns, or it doesn't ship.

**先分类,再定 ship(堵住"非主张"被松解读的漏洞):**
- **产品主张** = 任何断言产品属性/效果/服务的句子——含卖点、穿着体感、结构、"客服帮选码",以及**属性标签(如 `#无钢圈内衣`)**和**点名具体结构的占位示例(如"例如无钢圈软支撑")**。→ 双锚点(报告 + 真实商品证据)齐全才 `ship`;缺商品证据 → `placeholder`。
- **非主张句** = 用户原声复述 / 个人态度 / 定位角度,**且不含任何产品属性**。→ 只需报告锚点,判 **`voice`**(不叫 ship,避免与已验证的产品主张混淆)。
- **关键**:"No sentence ships" 里的 `ship` **专指"已过双锚点的产品主张"**;`voice` 不是 ship。**一旦句子点名/暗示某产品属性(无钢圈/软支撑/无痕…)——包括标签与占位示例——它立刻变成产品主张**,回到第一条。合规自检必须逐项写"已满足 / 待商品证据",不得先判自己无罪。
- **属性词的两种"非主张"用法(判 `voice`,仅需报告锚点)**:① 作为**被拒旧话术**在明确否定/批判语境引用("不按聚拢显小挑");② 作为**报告支持的选购标准/建议**("要找 X 版型")。**前提:两者都不得断言所推产品具备该属性**——一旦转为描述所推产品,立即回到产品主张(双锚点/占位)。

## Placeholder discipline [RIGID]

The trap: treating only obvious specs (`[杯型]`, `[面料]`) as placeholders while letting **effect claims** ("软支撑不勒 / 不外露 / 不空杯 / 不闷") pass as if free. Those depend on real pattern, materials, and fit testing just as much. **Every claim that requires physical/operational verification is a placeholder** until backed — mark it, don't ship it. Service promises ("客服帮选码") are placeholders too: only ship if the SOP truly exists.

## Compliance gates [RIGID]

Run all copy through `references/risk-lexicon.md` (the禁语/风险词 SSOT). It blocks:
- **广告法 绝对化**: 最/第一/顶级/永久/国家级… → rewrite.
- **医疗/功效暗示**: 治疗/矫正/防下垂(疗效向)/护乳腺… → soften to comfort/visual language.
- **ad-shell words** the analysis marked as seller-noise (聚拢/显小/提拉/无痕/封神/闭眼冲): allowed ONLY with a findings anchor + product evidence; otherwise they re-import the exact话术 the research told you to distrust.
- **misleading tags/terms** (e.g. "测评" for own-brand promo) → relabel.

## Validity-boundary gate [RIGID]

Findings from a non-probability sample are **testable hypotheses, not universal facts**. Ban copy that assumes group-wide commonality or that the product already solved it: "别再将就 / 都适合 / 终于找到 / 姐妹们必入". Prefer **scenario + fit-audience** framing ("圆盘胸、穿连衣裙容易空杯的姐妹，可以看看…") over全称断言. Consumer copy carries no caveats itself, but you (the author) must not cross the boundary.

## Output format

Always deliver, in this order:
1. **Positioning** — one coherent angle (don't sell contradictory value props across channels/products).
2. **Claim ledger** (the table above) — this is the audit trail; reviewers read it first.
3. **The copy**, per channel, with every unverified claim as a `[占位符]`.
4. **Publish-readiness checklist** — what real product data must fill the placeholders + the reminder that publishing goes through the ops skill with user confirmation.

## Rigid vs flexible

RIGID: the two-anchor ledger, placeholder discipline, compliance + validity gates. FLEXIBLE: tone, structure, channel format — adapt to platform and brand voice.

## Handoff

Input: an audited findings artifact (e.g. `semantic-census-analysis` report). Output: vetted copy + ledger. Next: `douyindian-product-ops` (or platform equivalent) publishes it, filling placeholders from real product data — **never auto-publish from here.**
