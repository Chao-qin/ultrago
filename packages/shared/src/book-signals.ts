/**
 * Book v2 — page signals and gates.
 *
 * A v2 book replaces fixed-delay/retry timing with page-owned signals: every
 * step names a logical `page`, may declare a `gate` (a boolean composition of
 * signal references), and the runner only performs the step action after the
 * gate is satisfied in the bound tab(s). Signal DEFINITIONS live in the book
 * (`pages[page].signals`); their DOM/page-state evaluation runs in the bound
 * tab via the `browser.waitSignal` RPC.
 *
 * This module is the shared contract: it is imported by codegen (playbook
 * validation), by the backend runner (gate resolution + evaluation), and by
 * the extension's DOM runtime indirectly through RpcContracts. It stays a
 * pure type + validation module — no runtime deps.
 */

import type { PlanStep } from "./index.js";
import { RpcMethod } from "./methods.js";

/** Books must declare this schema version; anything else is rejected. */
export const BOOK_SCHEMA_VERSION = 2;

/** One leaf or composite condition in a signal definition. Exactly ONE
 * discriminator field must be present; composite forms nest recursively.
 *
 * - `urlIncludes`: the committed page URL contains the string.
 * - `settled`: the page-state hydration gate is satisfied (readyState
 *   complete + body content, same semantics as `page_state.loading`).
 * - `selector`: a CSS selector is visible (default) or hidden in the composed
 *   DOM (open shadow roots and same-origin iframes included).
 * - `networkIdle`: no request has been in flight for this many ms. `settled`
 *   is DOM-only (readyState + non-empty body) and goes true while XHRs are
 *   still out — this is the leaf for "wait until the request that will change
 *   the DOM has come back".
 * - `textPresent`: rendered page text contains the string.
 * - `script`: a read-only MAIN-world expression, subject to the backend
 *   `BCP_EVAL` gate; optional `frameId` same as `browser.eval`. Must return a
 *   JSON-serializable truthy value.
 * - `all` / `any` / `not`: boolean composition of conditions.
 */
export type SignalCondition =
  | { urlIncludes: string }
  | { settled: true }
  | { networkIdle: number }
  | { selector: string; state?: "visible" | "hidden" }
  | { textPresent: string }
  | { script: { code: string; frameId?: number } }
  | { all: SignalCondition[] }
  | { any: SignalCondition[] }
  | { not: SignalCondition };

/** The discriminator fields of SignalCondition, in declaration order. */
export const SIGNAL_CONDITION_KINDS = [
  "urlIncludes",
  "settled",
  "networkIdle",
  "selector",
  "textPresent",
  "script",
  "all",
  "any",
  "not",
] as const;

/** A named condition owned by one logical page definition. */
export interface BookSignalDefinition {
  /** The condition tree evaluated in the bound tab. */
  condition: SignalCondition;
  /** Per-signal wait deadline (ms). A gate may override it for the current step. */
  timeoutMs?: number;
  /** Human-readable intent, surfaced in timeout diagnostics. */
  description?: string;
}

/** One logical page instance: a book-local name bound to a run-scoped tab. */
export interface BookPageDefinition {
  /** Named conditions this page owns. */
  signals: Record<string, BookSignalDefinition>;
  description?: string;
}

/** A gate reference: a bare signal name (resolved in the step's own page) or
 * an explicit `{ page, signal }` cross-page reference. */
export type SignalRef = string | { page: string; signal: string };

/** The pre-action readiness condition of a step. */
export type SignalGate = { all: SignalRef[] } | { any: SignalRef[] };

/** A v2 book. `steps` reuse PlanStep (which gains `page`/`gate`), so the
 * existing verify/recovery contract stays the post-action half. */
export interface BookV2 {
  schemaVersion: typeof BOOK_SCHEMA_VERSION;
  name: string;
  goal: string;
  /** Book-local logical page namespace. Required and non-empty in v2. */
  pages: Record<string, BookPageDefinition>;
  steps: PlanStep[];
}

/* ------------------------------------------------------------------ *
 * Validation                                                          *
 * ------------------------------------------------------------------ */

/** True when the object carries the v2 schema marker. */
export function isBookV2(book: unknown): book is BookV2 {
  return (
    typeof book === "object" &&
    book !== null &&
    (book as Record<string, unknown>).schemaVersion === BOOK_SCHEMA_VERSION
  );
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SELECTOR_STATES = new Set(["visible", "hidden"]);
const GATE_KINDS = new Set(["all", "any"]);
/** Verify predicates that can only hold once the page has rendered something.
 *  Deliberately excludes the ones a bootstrap CAN prove about itself the moment
 *  it returns — `actionSucceeded`, `urlIncludes`, `networkOk`, `noErrors`. */
const WAITING_VERIFY_KEYS = new Set([
  "elementName",
  "elementEnabled",
  "elementChecked",
  "elementValue",
  "textPresent",
  "textAbsent",
  "formSubmittable",
  "dialogOpen",
  "settled",
]);

function fail(msg: string): never {
  throw new Error(`book v2 validation: ${msg}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one signal condition tree (structure only, not page context). */
export function validateSignalCondition(cond: unknown, path = "condition"): void {
  if (!isPlainObject(cond)) fail(`${path}: expected a condition object`);
  const keys = Object.keys(cond);
  const kinds = keys.filter((k) => (SIGNAL_CONDITION_KINDS as readonly string[]).includes(k));
  if (kinds.length === 0) fail(`${path}: no condition discriminator (${SIGNAL_CONDITION_KINDS.join(" | ")})`);
  if (kinds.length > 1) fail(`${path}: multiple condition discriminators (${kinds.join(", ")})`);
  const kind = kinds[0];
  const next = (child: unknown, sub: string) => validateSignalCondition(child, `${path}.${sub}`);
  switch (kind) {
    case "urlIncludes": {
      if (typeof cond.urlIncludes !== "string" || cond.urlIncludes.length === 0) {
        fail(`${path}.urlIncludes: expected a non-empty string`);
      }
      break;
    }
    case "settled": {
      if (cond.settled !== true) fail(`${path}.settled: expected true`);
      break;
    }
    case "networkIdle": {
      // A zero-length quiet window would be satisfied by any gap between two
      // requests of the same burst, which is not idleness at all.
      if (typeof cond.networkIdle !== "number" || !Number.isFinite(cond.networkIdle) || cond.networkIdle <= 0) {
        fail(`${path}.networkIdle: expected a positive number of milliseconds`);
      }
      break;
    }
    case "selector": {
      if (typeof cond.selector !== "string" || cond.selector.length === 0) {
        fail(`${path}.selector: expected a non-empty string`);
      }
      if (cond.state !== undefined && !SELECTOR_STATES.has(String(cond.state))) {
        fail(`${path}.state: expected "visible" | "hidden"`);
      }
      break;
    }
    case "textPresent": {
      if (typeof cond.textPresent !== "string" || cond.textPresent.length === 0) {
        fail(`${path}.textPresent: expected a non-empty string`);
      }
      break;
    }
    case "script": {
      const s = cond.script;
      if (!isPlainObject(s) || typeof s.code !== "string" || s.code.length === 0) {
        fail(`${path}.script: expected { code: string }`);
      }
      if (s.frameId !== undefined && typeof s.frameId !== "number") {
        fail(`${path}.script.frameId: expected a number`);
      }
      break;
    }
    case "all":
    case "any": {
      const arr = cond[kind];
      if (!Array.isArray(arr) || arr.length === 0) {
        fail(`${path}.${kind}: expected a non-empty array of conditions`);
      }
      arr.forEach((c, i) => next(c, `${kind}[${i}]`));
      break;
    }
    case "not": {
      next(cond.not, "not");
      break;
    }
  }
}

/** Resolve a signal reference against the book's pages. Returns the resolved
 * definition; throws with a precise message when the reference is unknown. */
export function resolveSignalRef(
  pages: Record<string, BookPageDefinition>,
  ref: SignalRef,
  stepPage?: string,
): { page: string; signal: string; definition: BookSignalDefinition } {
  let pageName: string;
  let signalName: string;
  if (typeof ref === "string") {
    if (stepPage === undefined) {
      fail(`local signal reference "${ref}" used without a step page`);
    }
    pageName = stepPage;
    signalName = ref;
  } else if (isPlainObject(ref) && typeof ref.page === "string" && typeof ref.signal === "string") {
    pageName = ref.page;
    signalName = ref.signal;
  } else {
    fail(`invalid signal reference ${JSON.stringify(ref)}`);
  }
  const page = pages[pageName];
  if (!page) fail(`unknown signal reference "${pageName}.${signalName}": page "${pageName}" is not declared in pages`);
  const definition = page.signals[signalName];
  if (!definition) fail(`unknown signal reference "${pageName}.${signalName}": signal is not declared on page "${pageName}"`);
  if (!isPlainObject(definition) || !("condition" in definition)) {
    fail(`signal "${pageName}.${signalName}": missing condition`);
  }
  return { page: pageName, signal: signalName, definition: definition as unknown as BookSignalDefinition };
}

/** Validate a gate's references against the book's pages. `stepPage` enables
 * local (bare-name) references; missing it makes bare refs an error. */
export function validateGate(gate: SignalGate, pages: Record<string, BookPageDefinition>, stepPage?: string): void {
  if (!isPlainObject(gate)) fail("gate: expected { all: [...] } or { any: [...] }");
  const keys = Object.keys(gate);
  if (keys.length === 0 || !keys.every((k) => GATE_KINDS.has(k))) {
    fail("gate: expected { all: [...] } or { any: [...] }");
  }
  if (keys.length > 1) fail(`gate: only one of all/any allowed, got ${keys.join(", ")}`);
  const refs = "all" in gate ? gate.all : gate.any;
  if (!Array.isArray(refs) || refs.length === 0) fail(`gate.${keys[0]}: expected a non-empty array of signal references`);
  for (const ref of refs) {
    resolveSignalRef(pages, ref as SignalRef, stepPage);
  }
}

/** Full v2 book validation. Throws on the first violation. Covers:
 * - schemaVersion, name, goal, steps presence
 * - non-empty pages, signal names, condition trees
 * - every step's `page` (declared), gate refs (local + cross-page)
 * - gate presence except for page bootstrap actions (newWindow/newTab)
 * - check-only steps must be signal waits (gate present, no action)
 * - no physical `tabId` params on v2 page-scoped actions
 * - no `browser.waitSignal` as a step action (gates are the wait mechanism) */
export function validateBookV2(book: unknown): BookV2 {
  if (!isPlainObject(book)) fail("expected a book object");
  if (book.schemaVersion !== BOOK_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${BOOK_SCHEMA_VERSION} (got ${JSON.stringify(book.schemaVersion)})`);
  }
  if (typeof book.name !== "string" || book.name.length === 0) fail("name: expected a non-empty string");
  if (typeof book.goal !== "string" || book.goal.length === 0) fail("goal: expected a non-empty string");
  if (!Array.isArray(book.steps) || book.steps.length === 0) fail("steps: expected a non-empty array");

  const pagesRaw = book.pages;
  if (!isPlainObject(pagesRaw) || Object.keys(pagesRaw).length === 0) {
    fail("pages: expected a non-empty object of logical page definitions");
  }
  const pages: Record<string, BookPageDefinition> = {};
  for (const [pageName, pageDefRaw] of Object.entries(pagesRaw)) {
    if (!IDENTIFIER_RE.test(pageName)) fail(`pages.${pageName}: page name is not a valid identifier`);
    const pageDef = pageDefRaw as Record<string, unknown>;
    if (!isPlainObject(pageDef.signals) || Object.keys(pageDef.signals).length === 0) {
      fail(`pages.${pageName}: signals: expected a non-empty object`);
    }
    const signals: Record<string, BookSignalDefinition> = {};
    for (const [signalName, sigDefRaw] of Object.entries(pageDef.signals)) {
      if (!IDENTIFIER_RE.test(signalName)) fail(`pages.${pageName}.signals.${signalName}: signal name is not a valid identifier`);
      const sigDef = sigDefRaw as Record<string, unknown>;
      if (!isPlainObject(sigDef) || !("condition" in sigDef)) {
        fail(`pages.${pageName}.signals.${signalName}: expected { condition }`);
      }
      if (sigDef.timeoutMs !== undefined && (typeof sigDef.timeoutMs !== "number" || sigDef.timeoutMs <= 0)) {
        fail(`pages.${pageName}.signals.${signalName}.timeoutMs: expected a positive number`);
      }
      validateSignalCondition(sigDef.condition, `pages.${pageName}.signals.${signalName}.condition`);
      signals[signalName] = sigDef as unknown as BookSignalDefinition;
    }
    pages[pageName] = { signals };
  }

  for (const [i, stepRaw] of (book.steps as unknown[]).entries()) {
    const path = `steps[${i}]`;
    const step = stepRaw as Record<string, unknown>;
    if (typeof step.goal !== "string" || step.goal.length === 0) fail(`${path}.goal: expected a non-empty string`);
    const pageName = step.page;
    if (typeof pageName !== "string" || pageName.length === 0) {
      fail(`${path}.page: every v2 step must target a logical page`);
    }
    if (!pages[pageName]) fail(`${path}.page: unknown page "${pageName}"`);
    if (typeof step.verify !== "object" || step.verify === null) {
      fail(`${path}.verify: expected an object (post-action verification)`);
    }

    const action = step.action as Record<string, unknown> | undefined;
    const method = action?.method;
    const isBootstrap =
      typeof method === "string" && (method === RpcMethod.NewWindow || method === RpcMethod.NewTab);

    if (typeof step.gate !== "object" || step.gate === null) {
      if (!isBootstrap) {
        fail(`${path}.gate: missing (required unless the step is a page bootstrap action)`);
      }
    } else {
      validateGate(step.gate as SignalGate, pages, pageName);
    }

    // The consequence gate is optional (a step may have no observable delayed
    // effect), but when present it is validated exactly like `gate` — same
    // vocabulary, same page scoping — so a typo'd signal name fails at load
    // rather than as a mystery timeout mid-run.
    if (step.after !== undefined) {
      if (typeof step.after !== "object" || step.after === null) {
        fail(`${path}.after: expected a gate object ({all:[...]} or {any:[...]})`);
      }
      if (!action) {
        fail(`${path}.after: only meaningful on a step that performs an action (it awaits that action's consequence)`);
      }
      validateGate(step.after as SignalGate, pages, pageName);
    }

    // A bootstrap action OPENS something: redoing it opens another one. And
    // `onFail: "retry"` redoes the action — so anything in this step that can
    // only become true after the page renders turns "the page was slow" into
    // "one more window". Measured: doudian-publish step 0 waited for
    // `elementName: "商品正面图"` here with maxRetries 3, so one run could open
    // four windows before giving up (learn 2026-09-05).
    //
    // The readiness belongs on the NEXT step's gate, where a timeout costs no
    // retry budget and the action is never performed. This is checkable
    // statically — the method is in a two-member set and the predicates are a
    // fixed list — so it is refused at load rather than left for a reviewer.
    if (isBootstrap && step.onFail === "retry") {
      const verify = (step.verify ?? {}) as Record<string, unknown>;
      const waiting = Object.entries(verify)
        .filter(([key, value]) => value !== undefined && value !== false && WAITING_VERIFY_KEYS.has(key))
        .map(([key]) => key);
      if (waiting.length > 0) {
        fail(
          `${path}.verify: ${waiting.join("+")} 要等页面渲染，而 ${method} + onFail:"retry" 会重做动作 —— ` +
            `每重试一次就多开一个窗口。把就绪判据移到下一步的 gate（信号超时不消耗重试预算，动作也不会执行），` +
            `这一步只验能自证动作本身的东西：actionSucceeded / urlIncludes / networkOk。`,
        );
      }
      if (step.after !== undefined) {
        fail(
          `${path}.after: ${method} 是非幂等动作，而 after 超时会走 onFail:"retry" 重做它 —— 又一个窗口。` +
            `把这个等待放到下一步的 gate 上，或把本步的 onFail 改成 "escalate"。`,
        );
      }
    }

    if (action) {
      if (method === RpcMethod.WaitSignal) {
        fail(`${path}.action: browser.waitSignal cannot be a step action — declare a gate instead`);
      }
      const params = action.params as Record<string, unknown> | undefined;
      if (params && typeof params === "object" && "tabId" in params) {
        fail(`${path}.action.params: physical tabId is not allowed on v2 page-scoped actions (the runner binds the logical page)`);
      }
    } else if (typeof step.gate !== "object" || step.gate === null) {
      fail(`${path}: check-only steps must be a signal wait (declare a gate)`);
    }
  }

  return {
    schemaVersion: BOOK_SCHEMA_VERSION,
    name: book.name as string,
    goal: book.goal as string,
    pages,
    steps: book.steps as PlanStep[],
  };
}
