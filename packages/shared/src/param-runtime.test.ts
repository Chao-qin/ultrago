import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentParamShape, normalizeParams, parseParamValue, renderDefaultTemplate, resolveParamDefaults, validateOutput, validateParams } from "./param-runtime.js";
import type { ParamSchemaFragment } from "./param-runtime.js";
import { AJV_CHECKED_KEYWORDS, UNCHECKED_PREFIX, splitOutputProblems, unenforcedSchemaKeywords } from "./schema-keywords.js";
import { BOOK_PARAM_SCHEMAS } from "./generated/schema.js";

const context = { bookName: "book", runId: "run", planId: "plan", uuid: "uuid", timezone: "UTC", now: new Date("2026-08-23T09:10:11Z") };

test("default precedence and typed normalization", () => {
  const schema = [{ name: "count", required: false, default: 3, schema: { type: "integer" } }, { name: "enabled", required: false, schema: { type: "boolean", default: false } }];
  const values = resolveParamDefaults(schema, {}, context);
  assert.deepEqual(normalizeParams(schema, values), { count: 3, enabled: false });
});

test("top-level default takes precedence over schema.default", () => {
  const schema = [{ name: "value", required: true, default: "top", schema: { type: "string", default: "schema" } }];
  assert.deepEqual(resolveParamDefaults(schema, {}, context), { value: "top" });
});

test('nested object defaults fill missing fields without replacing entered values', () => {
  const schema = [{
    name: 'options',
    required: false,
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 20 },
        label: { type: 'string', default: '默认标签' },
        nested: {
          type: 'object',
          properties: { enabled: { type: 'boolean', default: true } },
        },
      },
    },
  }];
  assert.deepEqual(resolveParamDefaults(schema, { options: { limit: 5 } }), {
    options: { limit: 5, label: '默认标签', nested: { enabled: true } },
  });
  assert.deepEqual(resolveParamDefaults(schema, {}), {
    options: { limit: 20, label: '默认标签', nested: { enabled: true } },
  });
});

test("user false and zero win over defaults", () => {
  const schema = [
    { name: "count", required: false, default: 3, schema: { type: "integer" } },
    { name: "enabled", required: false, default: true, schema: { type: "boolean" } },
  ];
  const values = resolveParamDefaults(schema, { count: 0, enabled: false }, context);
  assert.deepEqual(values, { count: 0, enabled: false });
});

test("boolean garbage is preserved and rejected instead of becoming false", () => {
  const spec = { name: "enabled", required: false, schema: { type: "boolean" } };
  assert.equal(parseParamValue(spec, "false"), false);
  assert.equal(parseParamValue(spec, "garbage"), "garbage");
  assert.match(validateParams([spec], { enabled: "garbage" }).join(";"), /must be boolean/);
});

test("plain object parameter maps keep number and boolean runtime types", () => {
  const schema = [
    { name: "limit", required: true, schema: { type: "integer", minimum: 1 } },
    { name: "enabled", required: true, schema: { type: "boolean" } },
  ];
  const normalized = normalizeParams(schema, { limit: "20", enabled: "false" });
  assert.deepEqual(normalized, { limit: 20, enabled: false });
  assert.deepEqual(validateParams(schema, normalized), []);
});

test("dynamic template renders the complete run context", () => {
  assert.equal(renderDefaultTemplate("book-{{date}}-{{time}}-{{datetime}}-{{timestamp}}-{{runId}}-{{planId}}-{{uuid}}.md", context), "book-2026-08-23-09-10-11-2026-08-23-09-10-11-1787476211000-run-plan-uuid.md");
});

test("unknown template variables fail closed", () => {
  assert.throws(() => renderDefaultTemplate("{{missing}}", context), /unknown defaultTemplate variable/);
});

test("default templates reject unsafe filename syntax", () => {
  assert.throws(() => renderDefaultTemplate("../{{bookName}}.md", context), /unsafe filename/);
});

test("dynamic defaults are omitted without an execution context", () => {
  const schema = [{ name: "outFile", required: true, defaultTemplate: "{{bookName}}-{{uuid}}.md", schema: { type: "string" } }];
  assert.deepEqual(resolveParamDefaults(schema, {}), {});
  assert.deepEqual(validateParams(schema, {}), []);
});

test("validation rejects unresolved templates and invalid values", () => {
  const schema = [{ name: "url", required: true, schema: { type: "string", minLength: 5 } }, { name: "limit", required: false, schema: { type: "integer", minimum: 1 } }];
  assert.match(validateParams(schema, { url: "{{url}}", limit: 0 }).join(";"), /unresolved template/);
  assert.match(validateParams(schema, { url: "ok", limit: 0 }).join(";"), /must be >= 1/);
});

test("validation covers enum, ranges, pattern and lengths", () => {
  const schema = [
    { name: "mode", required: true, schema: { type: "string", enum: ["a", "b"] } },
    { name: "code", required: true, schema: { type: "string", minLength: 3, maxLength: 5, pattern: "^[A-Z]+$" } },
    { name: "score", required: true, schema: { type: "number", minimum: 1, maximum: 10 } },
  ];
  const errors = validateParams(schema, { mode: "c", code: "ab", score: 11 });
  assert.match(errors.join(";"), /must be one of/);
  assert.match(errors.join(";"), /length must be >= 3/);
  assert.match(errors.join(";"), /does not match pattern/);
  assert.match(errors.join(";"), /must be <= 10/);
});

test("nested object and array schemas validate structured book params", () => {
  const schema = [{
    name: "attachments",
    required: false,
    schema: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["image", "file"] },
          url: { type: "string", minLength: 1 },
          localPath: { type: "string", minLength: 1 },
        },
        oneOf: [
          { required: ["url"], not: { required: ["localPath"] } },
          { required: ["localPath"], not: { required: ["url"] } },
        ],
      },
    },
  }];
  assert.deepEqual(validateParams(schema, {
    attachments: [{ type: "image", url: "https://example.com/a.png" }],
  }), []);
  assert.match(validateParams(schema, { attachments: [{ type: "other", url: "x", extra: true }] }).join(";"), /must be one of/);
  assert.match(validateParams(schema, { attachments: [{ type: "file" }] }).join(";"), /must match exactly one/);
  assert.match(validateParams(schema, { attachments: [{ type: "file", url: "x", localPath: "/tmp/x" }] }).join(";"), /must match exactly one/);
  assert.match(validateParams(schema, { attachments: [{ type: "file", url: "" }] }).join(";"), /must match exactly one/);
});

test("required string properties may intentionally be empty", () => {
  const schema = [{
    name: "config",
    required: false,
    schema: {
      type: "object",
      properties: {
        replaceRules: {
          type: "array",
          items: {
            type: "object",
            required: ["pattern", "replacement"],
            properties: {
              pattern: { type: "string", minLength: 1 },
              replacement: { type: "string" },
            },
          },
        },
      },
    },
  }];

  assert.deepEqual(validateParams(schema, {
    config: { replaceRules: [{ pattern: "某品牌", replacement: "" }] },
  }), []);
});

test("attachmentParamShape reads the shipped doubao-ask schema as a file field", () => {
  // The real codegen'd schema, not a paraphrase — the detector exists to serve
  // exactly this declaration, so a book-side change must break this test.
  const doubao = BOOK_PARAM_SCHEMAS["doubao-ask"];
  const attachments = doubao.find((p) => p.name === "attachments");
  assert.ok(attachments, "doubao-ask must still declare an attachments param");
  assert.deepEqual(attachmentParamShape(attachments), { kinds: ["image", "file"] });
  for (const other of doubao.filter((p) => p.name !== "attachments")) {
    assert.equal(attachmentParamShape(other), null, `${other.name} must not render as a file field`);
  }
});

test("attachmentParamShape ignores arrays that are not file sources", () => {
  const shapeOf = (schema: Record<string, unknown>) => attachmentParamShape({ name: "p", required: false, schema });
  assert.equal(shapeOf({ type: "array", items: { type: "string" } }), null);
  assert.equal(shapeOf({ type: "object", properties: { url: {}, localPath: {} } }), null);
  // Half the contract is not the contract: a source item must accept both keys.
  assert.equal(shapeOf({ type: "array", items: { type: "object", properties: { url: { type: "string" } } } }), null);
  assert.equal(shapeOf({ type: "array", items: { type: "object", properties: { localPath: { type: "string" } } } }), null);
  // No `type` discriminator declared → the picker emits no `type` key.
  assert.deepEqual(shapeOf({ type: "array", items: { type: "object", properties: { url: {}, localPath: {} } } }), { kinds: null });
});

test("a $ref schema is now genuinely checked, not merely admitted to be unchecked", () => {
  // The shape this whole mechanism was built around: every real constraint
  // lives behind a `$ref`. The hand-written validator could not follow one, so
  // it checked nothing and said so. `canonical-product` — the contract this
  // pipeline exists to produce — is exactly this shape, with nine of them.
  const refSchema = {
    type: "object",
    required: ["images"],
    properties: { images: { type: "array", items: { $ref: "#/$defs/image" } } },
    $defs: { image: { type: "object", required: ["url"], properties: { url: { type: "string", minLength: 5 } } } },
  };

  const problems = validateOutput(refSchema, { images: [123, { nope: 1 }] });
  assert.deepEqual(problems, ["/images/0 must be object", "/images/1 must have required property 'url'"]);
  assert.equal(problems.some((p) => p.startsWith(UNCHECKED_PREFIX)), false, "跟着 ref 走过去了，不再是「查不了」");

  // And the other half of the claim: a conforming document comes back clean.
  // Without this the test would pass on a validator that rejects everything.
  assert.deepEqual(validateOutput(refSchema, { images: [{ url: "https://example.com" }] }), []);
});

test("const and minItems are violations now, and format is still only a notice", () => {
  // These three used to be one bucket: "outside the subset". They are two
  // buckets now, and the split is not cosmetic — a violation fails the node,
  // a notice does not.
  const problems = validateOutput(
    { type: "object", properties: { a: { const: "X" }, b: { type: "array", minItems: 3 }, c: { type: "string", format: "uri" } } },
    { a: "WRONG", b: [], c: "not a uri" },
  );
  assert.ok(problems.includes("/a must be equal to constant"));
  assert.ok(problems.includes("/b must NOT have fewer than 3 items"));

  const notices = problems.filter((p) => p.startsWith(UNCHECKED_PREFIX));
  assert.equal(notices.length, 1);
  // Asserted on the keyword LIST, not on the sentence: the sentence ends in
  // "…against those constraints", and a substring search for `const` finds it
  // there. This assertion caught that on its first run.
  assert.deepEqual(
    unenforcedSchemaKeywords({ type: "object", properties: { a: { const: "X" }, b: { type: "array", minItems: 3 }, c: { type: "string", format: "uri" } } }),
    ["format"],
    "const 与 minItems 现在是真查的，只有 format 该被列为未查",
  );
});

test("a vendor keyword is reported rather than passed over in silence", () => {
  // `strict: false` is not a preference — this repo's own canonical schema
  // carries `x-doudian-*` keywords that abort compilation under `strict: true`.
  // Its cost is that ajv skips anything it does not recognise without a word,
  // and that silence is the exact failure this notice exists to prevent.
  const problems = validateOutput({ type: "object", "x-doudian-total-limit": "pic + description", properties: { a: { type: "string" } } }, { a: "x" });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].startsWith(UNCHECKED_PREFIX) && problems[0].includes("x-doudian-total-limit"));
});

test("an empty result still means checked-and-conforming, not merely unexamined", () => {
  assert.deepEqual(validateOutput({ type: "object", properties: { a: { type: "string" } } }, { a: "x" }), []);
  const dirty = validateOutput({ type: "object", properties: { a: { type: "string" } } }, { a: 1 });
  assert.deepEqual(dirty, ["/a must be string"]);
  assert.ok(!dirty.some((p) => p.startsWith(UNCHECKED_PREFIX)));
  // No contract at all stays "nothing to check".
  assert.deepEqual(validateOutput(null, { anything: true }), []);
  assert.deepEqual(validateOutput({}, { anything: true }), []);
  // Annotations alone are not constraints.
  assert.deepEqual(validateOutput({ title: "x", description: "y" }, { anything: true }), []);
});

test("splitOutputProblems separates a value that is wrong from one nobody could check", () => {
  // The case that made "non-empty list" the wrong test for a breach: the data
  // conforms to everything that CAN be checked, and the only entry is the
  // validator admitting what it could not. `format` is what still lands here
  // now that `$ref` and `minItems` do not.
  const schema = { type: "object", properties: { home: { type: "string", format: "uri" } } };
  const conforming = validateOutput(schema, { home: "https://example.com" });
  assert.equal(conforming.length, 1, `expected exactly the notice, got ${JSON.stringify(conforming)}`);
  const clean = splitOutputProblems(conforming);
  assert.deepEqual(clean.violations, [], "a conforming value must yield no violations");
  assert.equal(clean.notices.length, 1);

  // A real breach under the same schema keeps both, in their own buckets — the
  // notice must not swallow the violation, nor vice versa.
  const breach = splitOutputProblems(validateOutput(schema, { home: 42 }));
  assert.deepEqual(breach.violations, ["/home must be string"]);
  assert.equal(breach.notices.length, 1);

  // The two states that already worked keep working.
  assert.deepEqual(splitOutputProblems([]), { violations: [], notices: [] });
  assert.deepEqual(splitOutputProblems(["output.a must be string"]), { violations: ["output.a must be string"], notices: [] });
});

test("the whitelist matches what the engine actually enforces, keyword by keyword", () => {
  // Written because the first version of this list was WRONG in exactly the way
  // the notice exists to prevent: it claimed seven 2020-12 keywords that ajv's
  // default (draft-07) build silently ignored, so a schema using
  // `dependentRequired` would have been reported as fully checked while nothing
  // looked at it. The engine moved to the 2020-12 build and the list became
  // true — but a list that has to STAY true against a dependency is a list that
  // needs a test, not a careful author.
  //
  // Each case is a schema using one keyword plus a value that violates it. If
  // the engine reports a violation, it enforces the keyword; if all it produces
  // is the "not fully checked" notice, it does not. Either answer is fine — the
  // assertion is that `AJV_CHECKED_KEYWORDS` agrees with it.
  const cases: Record<string, [ParamSchemaFragment, unknown]> = {
    type: [{ type: "string" }, 1],
    enum: [{ enum: ["a"] }, "b"],
    const: [{ const: "a" } as ParamSchemaFragment, "b"],
    minLength: [{ type: "string", minLength: 3 }, "a"],
    maxLength: [{ type: "string", maxLength: 1 }, "ab"],
    pattern: [{ type: "string", pattern: "^a$" }, "b"],
    minimum: [{ type: "number", minimum: 5 }, 1],
    maximum: [{ type: "number", maximum: 1 }, 5],
    exclusiveMinimum: [{ type: "number", exclusiveMinimum: 5 } as ParamSchemaFragment, 5],
    exclusiveMaximum: [{ type: "number", exclusiveMaximum: 5 } as ParamSchemaFragment, 5],
    multipleOf: [{ type: "number", multipleOf: 2 } as ParamSchemaFragment, 3],
    minItems: [{ type: "array", minItems: 2 } as ParamSchemaFragment, [1]],
    maxItems: [{ type: "array", maxItems: 1 } as ParamSchemaFragment, [1, 2]],
    uniqueItems: [{ type: "array", uniqueItems: true } as ParamSchemaFragment, [1, 1]],
    items: [{ type: "array", items: { type: "string" } }, [1]],
    prefixItems: [{ type: "array", prefixItems: [{ type: "string" }] } as ParamSchemaFragment, [1]],
    contains: [{ type: "array", contains: { type: "string" } } as ParamSchemaFragment, [1]],
    minContains: [{ type: "array", contains: { type: "number" }, minContains: 2 } as ParamSchemaFragment, [1]],
    maxContains: [{ type: "array", contains: { type: "number" }, maxContains: 1 } as ParamSchemaFragment, [1, 2]],
    properties: [{ type: "object", properties: { a: { type: "string" } } }, { a: 1 }],
    patternProperties: [{ type: "object", patternProperties: { "^a": { type: "string" } } } as ParamSchemaFragment, { ab: 1 }],
    additionalProperties: [{ type: "object", properties: { a: {} }, additionalProperties: false }, { b: 1 }],
    required: [{ type: "object", required: ["a"] }, {}],
    propertyNames: [{ type: "object", propertyNames: { pattern: "^a$" } } as ParamSchemaFragment, { b: 1 }],
    minProperties: [{ type: "object", minProperties: 2 } as ParamSchemaFragment, { a: 1 }],
    maxProperties: [{ type: "object", maxProperties: 1 } as ParamSchemaFragment, { a: 1, b: 2 }],
    dependentRequired: [{ type: "object", dependentRequired: { a: ["b"] } } as ParamSchemaFragment, { a: 1 }],
    dependentSchemas: [{ type: "object", dependentSchemas: { a: { required: ["b"] } } } as ParamSchemaFragment, { a: 1 }],
    allOf: [{ allOf: [{ type: "string" }] } as ParamSchemaFragment, 1],
    anyOf: [{ anyOf: [{ type: "string" }] } as ParamSchemaFragment, 1],
    oneOf: [{ oneOf: [{ type: "string" }] }, 1],
    not: [{ not: { type: "string" } }, "a"],
    if: [{ if: { type: "string" }, then: { maxLength: 1 } } as ParamSchemaFragment, "ab"],
    $ref: [{ $defs: { x: { type: "string" } }, $ref: "#/$defs/x" } as ParamSchemaFragment, 1],
    unevaluatedProperties: [{ type: "object", properties: { a: {} }, unevaluatedProperties: false } as ParamSchemaFragment, { b: 1 }],
    unevaluatedItems: [{ type: "array", prefixItems: [{}], unevaluatedItems: false } as ParamSchemaFragment, [1, 2]],
    format: [{ type: "string", format: "uri" } as ParamSchemaFragment, "not a uri"],
  };

  const disagreements: string[] = [];
  for (const [keyword, [schema, violating]] of Object.entries(cases)) {
    const problems = validateOutput(schema, violating);
    const enforced = problems.some((p) => !p.startsWith(UNCHECKED_PREFIX));
    if (enforced !== AJV_CHECKED_KEYWORDS.has(keyword)) {
      disagreements.push(`${keyword}: 白名单说${AJV_CHECKED_KEYWORDS.has(keyword) ? "查" : "不查"}，引擎实际${enforced ? "查" : "不查"}`);
    }
  }
  assert.deepEqual(disagreements, [], `白名单与引擎不符：\n${disagreements.join("\n")}`);

  // And the census: every keyword in the list is exercised above, so the list
  // cannot grow an unmeasured entry.
  const untested = [...AJV_CHECKED_KEYWORDS].filter((k) => !(k in cases)).sort();
  assert.deepEqual(untested, ["$defs", "$dynamicAnchor", "$dynamicRef", "definitions", "else", "then"], "只有这几个是靠 $ref / if-then-else 间接覆盖的；新增条目必须在上面配一个用例");
});

test("multipleOf: 0.01 判的是价格，不是浮点除法的余数", () => {
  // `canonical-product` 和 `raw-1688-offer` 都用 `multipleOf: 0.01` 表达「价格
  // 到分为止」。ajv 默认拿 `data / multipleOf !== parseInt(...)` 回答这件事，
  // 而二进制浮点让 `19.9 / 0.01` 等于 1989.9999999999998 —— 于是一个转分正好
  // 是 1990 的价格被判违约。真实代价：flow run e364da1b 的 preprocess 节点挂在
  // `/canonical/skus/5/price`，而那两个 SKU 的价格是 9.9 元加 10 元的固定加价。
  // 另有两次挂在采集节点，价格是 1688 页面上原样抓下来的，根本没算过。
  //
  // 断言分三段，缺一段这条防线就是假的：普查证明不再误杀、原始事故值钉死、
  // 反向用例证明我们没有把这条约束整个关掉。
  const price: ParamSchemaFragment = { type: "number", exclusiveMinimum: 0, multipleOf: 0.01 } as ParamSchemaFragment;
  const rejects = (v: number) => validateOutput(price, v).some((p) => !p.startsWith(UNCHECKED_PREFIX));

  // 普查：0.01 ~ 100.00 之间每一个合法的两位小数价格。修复前这一段有 1363 个
  // 误杀（13.6%），且毫无规律可循（9.9 过，19.9 不过），所以只钉几个样本挡不住
  // 回归。上界取 100 而不是 1000：误杀是按比例散布的，十倍的量只是把这个文件的
  // 单测从 0.4 秒拖到 7.6 秒（validateOutput 每次都新建一个 ajv 实例），换不到
  // 任何新的失败模式。
  const falsePositives: number[] = [];
  for (let cents = 1; cents <= 10_000; cents += 1) {
    const yuan = cents / 100;
    if (rejects(yuan)) falsePositives.push(yuan);
  }
  assert.deepEqual(falsePositives.slice(0, 20), [], `${falsePositives.length} 个合法的整分价格被判违约`);

  // 事故现场那两个值，以及几个同样踩雷的常见价位。
  for (const yuan of [19.9, 0.29, 8.2, 1.11, 2.01, 16.4, 32.8, 65.6]) {
    assert.equal(rejects(yuan), false, `${yuan} 元是合法价格（${Math.round(yuan * 100)} 分）`);
  }

  // 真该拦的还得拦住。这几条对本次修复不敏感（修复前后都被拒），它们防的是**下
  // 一次改这行**：把容差放宽成 multipleOfPrecision: 1，0.001 就会被漏过去。
  for (const bad of [19.905, 19.999, 12.3456, 0.001]) {
    assert.equal(rejects(bad), true, `${bad} 不是整分，必须拦下`);
  }
  // 整数步长不受影响：容差只吃掉浮点噪声，吃不掉 1 的余数。走 rejects 过滤掉
  // "未完整校验" 那条 notice —— 直接数 problems.length 的话，multipleOf 万一被
  // 移出白名单，光那条 notice 就能把这句顶成假绿。
  const integerStep: ParamSchemaFragment = { type: "number", multipleOf: 2 } as ParamSchemaFragment;
  assert.equal(validateOutput(integerStep, 3).some((p) => !p.startsWith(UNCHECKED_PREFIX)), true);
});
