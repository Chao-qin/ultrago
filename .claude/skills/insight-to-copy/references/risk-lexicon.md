# Risk Lexicon (compliance SSOT for insight-to-copy)

Run every copy line against this before it ships. This is the single source of truth for banned/risky wording — keep it here, don't duplicate rules into SKILL.md. Not legal advice; when in doubt, mark **建议法务确认** and default to the safer wording.

## 1. 广告法 绝对化用语 — rewrite, never ship

最 / 第一 / 顶级 / 顶尖 / 极致 / 永久 / 100% / 国家级 / 世界级 / 唯一 / 首个 / 独家(无据) / 王牌 / 冠军 / 史上最.

> Fix: replace with concrete, verifiable, non-superlative description. "最舒服" → "久穿减少压迫感(见实测)".

## 2. 医疗 / 功效暗示 — soften to comfort/visual, or drop

治疗 / 治愈 / 疗效 / 矫正 / 康复 / 消除 / 根治 / 防下垂(作医疗功效讲) / 护乳腺 / 塑形(作理疗讲) / 促进健康 / 医用级(无资质).

> Fix: keep it experiential, not medical. "护乳腺" → "两胸自然分开、不硬挤中间(舒适向)"; "防下垂矫正" → "承托、减少下坠感(穿着体感)".

## 3. Ad-shell words — allowed ONLY with anchor + product evidence

聚拢 / 显小 / 显瘦 / 显大 / 提拉 / 无痕 / 收副乳 / 无钢圈托得住 / 封神 / 闭眼冲 / 神器 / 绝绝子.

> Why gated: `semantic-census-analysis` found these are the exact words seller ad-copy inflates and that a user segment actively rejects (反聚拢/反显小). Using them ungrounded re-imports the noise the analysis removed.
> Rule: each occurrence needs a findings anchor **and** a real product spec, else drop or convert to scenario language ("无痕" → "穿连衣裙/紧身衣不显痕迹" only if the product is actually tested seamless).
> **例外(判 voice,仅需报告锚点)**:该词作为**被拒旧话术**在否定/批判语境引用("不按聚拢显小挑"),或作为**报告支持的选购标准**("要找 X 版型")——只要**不声称所推产品具备该属性**。一旦描述所推产品,即回到上面的双锚点要求。

## 4. Misleading terms / tags

- "测评 / 评测 / 亲测" on own-brand promo → implies third-party review; relabel "分享 / 体验".
- "官方推荐 / 平台认证"(无据) / 伪造销量·排名 / "医生推荐"(无据).
- Fabricated brand / IP / authorization (see the platform ops skill's authenticity red lines).

## 5. Validity-boundary phrases — ban over-generalization

别再将就 / 都适合 / 人人必备 / 姐妹们必入 / 终于找到(暗示已验证解决) / 所有大胸都 / 中国女生都.

> Fix: scenario + fit-audience. "圆盘胸姐妹别再将就了" → "圆盘胸、一弯腰容易空杯的姐妹,可以看看这个思路".

## Quick self-check before ship

1. Each line in the claim ledger with both anchors? (findings + product)
2. No §1/§2 words? §3 words each justified? §4 clean? §5 no over-generalization?
3. Every physical/operational claim either backed or a `[占位符]`?
4. Positioning coherent across channels (not 显瘦规训 on one, 去媚自在 on another)?

Fail any → fix before handing to the publishing skill.
