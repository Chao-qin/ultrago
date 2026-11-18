import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOK_SCHEMA_VERSION,
  isBookV2,
  validateBookV2,
  validateGate,
  validateSignalCondition,
  resolveSignalRef,
  type BookPageDefinition,
} from "./book-signals.js";

const pages: Record<string, BookPageDefinition> = {
  source: {
    signals: {
      ready: { condition: { selector: "#app" } },
      captured: { condition: { textPresent: "done" }, timeoutMs: 15_000 },
    },
  },
  target: {
    signals: {
      formReady: { condition: { settled: true } },
    },
  },
};

test("isBookV2 accepts the schema marker and rejects everything else", () => {
  assert.equal(isBookV2({ schemaVersion: BOOK_SCHEMA_VERSION }), true);
  assert.equal(isBookV2({ schemaVersion: 1 }), false);
  assert.equal(isBookV2(null), false);
  assert.equal(isBookV2(undefined), false);
  assert.equal(isBookV2("v2"), false);
});

test("validateBookV2 rejects missing or unsupported schemaVersion", () => {
  assert.throws(() => validateBookV2({ schemaVersion: 1 }), /schemaVersion/);
  assert.throws(() => validateBookV2({}), /schemaVersion/);
  assert.throws(() => validateBookV2({ schemaVersion: 3 }), /schemaVersion/);
});

test("validateBookV2 rejects missing or empty pages", () => {
  const step = { goal: "x", page: "source", verify: {}, gate: { all: ["ready"] } };
  const base = { schemaVersion: 2, name: "b", goal: "g", steps: [step] };
  assert.throws(() => validateBookV2(base), /pages/);
  assert.throws(() => validateBookV2({ ...base, pages: {} }), /pages/);
  assert.throws(() => validateBookV2({ ...base, pages: { source: { signals: {} } } }), /signals/);
});

test("validateBookV2 rejects unknown page targets and unknown signals", () => {
  const book = {
    schemaVersion: 2,
    name: "b",
    goal: "g",
    pages,
    steps: [
      { goal: "x", page: "nope", verify: {}, gate: { all: ["ready"] } },
    ],
  };
  assert.throws(() => validateBookV2(book), /unknown page "nope"/);
});

test("validateGate accepts local and cross-page gate forms", () => {
  assert.doesNotThrow(() => validateGate({ all: ["ready"] }, pages, "source"));
  assert.doesNotThrow(() => validateGate({ all: [{ page: "source", signal: "ready" }] }, pages));
  assert.doesNotThrow(() => validateGate({ any: ["ready", { page: "target", signal: "formReady" }] }, pages, "source"));
});

test("validateGate rejects unknown signals", () => {
  assert.throws(() => validateGate({ all: ["missing"] }, pages, "source"), /unknown signal/);
  assert.throws(() => validateGate({ all: ["missing"] }, pages), /without a step page/);
  assert.throws(() => validateGate({ all: [{ page: "source", signal: "nope" }] }, pages), /unknown signal/);
  assert.throws(() => validateGate({ all: [{ page: "ghost", signal: "ready" }] }, pages), /unknown signal/);
  assert.throws(() => validateGate({} as never, pages), /all|any/);
});

test("resolveSignalRef resolves bare names to the step page and explicit refs to their page", () => {
  const local = resolveSignalRef(pages, "ready", "source");
  assert.equal(local.page, "source");
  assert.equal(local.signal, "ready");
  const cross = resolveSignalRef(pages, { page: "target", signal: "formReady" });
  assert.equal(cross.page, "target");
  assert.ok("settled" in cross.definition.condition);
});

test("validateSignalCondition accepts every leaf and composition form", () => {
  assert.doesNotThrow(() => validateSignalCondition({ urlIncludes: "baidu.com/s" }));
  assert.doesNotThrow(() => validateSignalCondition({ settled: true }));
  assert.doesNotThrow(() => validateSignalCondition({ selector: "#kw", state: "hidden" }));
  assert.doesNotThrow(() => validateSignalCondition({ textPresent: "热搜" }));
  assert.doesNotThrow(() => validateSignalCondition({ script: { code: "window.__sku", frameId: 3 } }));
  assert.doesNotThrow(() => validateSignalCondition({ all: [{ selector: "#a" }, { not: { textPresent: "loading" } }] }));
  assert.doesNotThrow(() => validateSignalCondition({ any: [{ settled: true }, { selector: "#b" }] }));
});

test("validateSignalCondition rejects malformed conditions", () => {
  assert.throws(() => validateSignalCondition({}), /no condition discriminator/);
  assert.throws(() => validateSignalCondition({ selector: "#a", settled: true }), /multiple condition discriminators/);
  assert.throws(() => validateSignalCondition({ urlIncludes: "" }), /non-empty string/);
  assert.throws(() => validateSignalCondition({ selector: "#a", state: "huh" }), /visible|hidden/);
  assert.throws(() => validateSignalCondition({ script: "window.x" }), /\{ code: string \}/);
  assert.throws(() => validateSignalCondition({ all: [] }), /non-empty array/);
  assert.throws(() => validateSignalCondition({ not: {} }), /no condition discriminator/);
});

test("validateBookV2 enforces gate presence except for bootstrap actions", () => {
  const base = { schemaVersion: 2, name: "b", goal: "g", pages };
  const withAction = (action: unknown) => ({ ...base, steps: [{ goal: "x", page: "source", verify: {}, action }] });
  // Non-bootstrap action without a gate is rejected.
  assert.throws(() => validateBookV2(withAction({ method: "browser.eval", params: { code: "1" } })), /gate/);
  // Bootstrap (newWindow) may omit the gate.
  assert.doesNotThrow(() =>
    validateBookV2({ ...base, steps: [{ goal: "x", page: "source", verify: { noErrors: true }, action: { method: "browser.newWindow", params: { url: "https://x" } } }] }),
  );
});

test("validateBookV2 rejects physical tabId on page-scoped actions", () => {
  const book = {
    schemaVersion: 2,
    name: "b",
    goal: "g",
    pages,
    steps: [
      { goal: "x", page: "source", verify: {}, gate: { all: ["ready"] }, action: { method: "browser.eval", params: { code: "1", tabId: 716391825 } } },
    ],
  };
  assert.throws(() => validateBookV2(book), /tabId/);
});

test("validateBookV2 rejects waitSignal as a step action", () => {
  const book = {
    schemaVersion: 2,
    name: "b",
    goal: "g",
    pages,
    steps: [
      { goal: "x", page: "source", verify: {}, gate: { all: ["ready"] }, action: { method: "browser.waitSignal", params: {} } },
    ],
  };
  assert.throws(() => validateBookV2(book), /waitSignal/);
});

test("validateBookV2 allows check-only steps only as signal waits", () => {
  const base = { schemaVersion: 2, name: "b", goal: "g", pages };
  // No action + no gate: rejected.
  assert.throws(() => validateBookV2({ ...base, steps: [{ goal: "x", page: "source", verify: {} }] }), /check-only|gate/);
  // No action + gate: valid signal-wait step.
  assert.doesNotThrow(() =>
    validateBookV2({ ...base, steps: [{ goal: "x", page: "source", verify: {}, gate: { all: ["captured"] } }] }),
  );
});

test("validateBookV2 accepts a complete v2 book and preserves its shape", () => {
  const book = {
    schemaVersion: 2,
    name: "sample",
    goal: "do a thing",
    pages,
    steps: [
      { goal: "open", page: "source", verify: { noErrors: true }, action: { method: "browser.newWindow", params: { url: "https://example.com" } } },
      { goal: "wait ready", page: "source", verify: {}, gate: { all: ["ready"] } },
      { goal: "collect", page: "source", verify: { settled: true }, gate: { all: ["ready"] }, action: { method: "browser.eval", params: { code: "1" } } },
    ],
  };
  const v2 = validateBookV2(book);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.steps.length, 3);
});

/** A minimal v2 book whose single step is a bootstrap, so each case below only
 *  has to say what it changes about that step. */
function bootstrapBook(step: Record<string, unknown>): unknown {
  return {
    schemaVersion: BOOK_SCHEMA_VERSION,
    name: "b",
    goal: "g",
    pages,
    steps: [{ goal: "开窗", page: "source", action: { method: "browser.newWindow", params: { url: "https://x" } }, ...step }],
  };
}

test("开窗步骤 + retry：verify 里等页面渲染的判据必须被拒 —— 重试会多开一个窗口", () => {
  // 实测来源：doudian-publish step 0 用 elementName:"商品正面图" 当 verify、
  // onFail:"retry"、maxRetries:3，于是一次 run 最多开四个窗口（learn 2026-09-05）。
  // 判据本身是对的,位置错了 —— 它属于下一步的 gate。
  for (const [key, value] of [
    ["elementName", "商品正面图"],
    ["textPresent", "发布商品"],
    ["elementEnabled", "下一步"],
    ["settled", true],
    ["formSubmittable", true],
  ] as const) {
    assert.throws(
      () => validateBookV2(bootstrapBook({ verify: { [key]: value }, onFail: "retry" })),
      new RegExp(key),
      `${key} 要等页面渲染,配在 newWindow + retry 上必须被拒`,
    );
  }
});

test("开窗步骤 + retry：能自证动作本身的判据照常放行", () => {
  // 这些在动作返回的那一刻就能判定,不需要等任何渲染,所以重试也不会因为「页面还没好」
  // 而白白多开窗口。
  for (const verify of [
    { actionSucceeded: true },
    { urlIncludes: "/ffa/g/create" },
    { urlIncludes: "/ffa/g/create", actionSucceeded: true },
    { networkOk: { urlIncludes: "/api/create" } },
    { noErrors: true },
  ]) {
    assert.doesNotThrow(() => validateBookV2(bootstrapBook({ verify, onFail: "retry" })), JSON.stringify(verify));
  }
});

test("开窗步骤：onFail 不是 retry 时不拦 —— escalate 不会重做动作", () => {
  // 规则针对的是「重做动作」这一个后果,不是判据本身。escalate 停在原地,
  // 一个窗口都不会多,所以同样的 verify 在这里是合法的。
  assert.doesNotThrow(() =>
    validateBookV2(bootstrapBook({ verify: { elementName: "商品正面图" }, onFail: "escalate" })),
  );
  assert.doesNotThrow(() => validateBookV2(bootstrapBook({ verify: { elementName: "商品正面图" } })));
});

test("开窗步骤 + retry：after 同样被拒 —— 它超时也会走 onFail 重做动作", () => {
  assert.throws(
    () => validateBookV2(bootstrapBook({ verify: { actionSucceeded: true }, onFail: "retry", after: { all: ["ready"] } })),
    /after/,
    "after 超时走的是 onFail:retry,对非幂等动作等于又一个窗口",
  );
});

test("非 bootstrap 的动作不受这条规则约束 —— 重做一次点击不会多出一个窗口", () => {
  const clickBook = {
    schemaVersion: BOOK_SCHEMA_VERSION,
    name: "b",
    goal: "g",
    pages,
    steps: [
      {
        goal: "点下一步",
        page: "source",
        gate: { all: ["ready"] },
        action: { method: "browser.click", params: { name: "下一步" } },
        verify: { elementName: "保存草稿" },
        onFail: "retry",
      },
    ],
  };
  assert.doesNotThrow(() => validateBookV2(clickBook));
});
