#!/usr/bin/env node
/**
 * DOM runtime regression harness.
 *
 * WHY this can exist at all: `bcpDomRuntime` must be fully self-contained,
 * because `chrome.scripting.executeScript({func})` serializes it. That same
 * constraint means it can be bundled, stringified and injected into ANY page —
 * so the real code path runs here verbatim, with no extension, no service
 * worker and no MCP server in the loop.
 *
 * WHY a real browser: the behaviour under test is the browser's own — HTML
 * value sanitization, layout, hit testing. jsdom does not implement those, so a
 * harness built on it would pass while production breaks.
 *
 * WHY no new dependency: this is a dev tool, not shipped code. It locates an
 * esbuild and a playwright-core that are already on the machine instead of
 * adding either to the lockfile. If neither is found it says so and exits 2 —
 * a missing harness must never read as "tests passed".
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { bundleRuntime, loadEsbuild, loadPlaywright } from "./toolchain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ harness
let passed = 0;
const failures = [];

function eq(actual, expected, label) {
  if (Object.is(actual, expected)) { passed++; return; }
  failures.push(`${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

function match(actual, re, label) {
  if (typeof actual === "string" && re.test(actual)) { passed++; return; }
  failures.push(`${label}\n    expected to match: ${re}\n    actual:            ${JSON.stringify(actual)}`);
}

/** The nearest ancestor of `e` (by parentRef) that is a hidden group, or undefined. */
function climb(els, e) {
  const byRef = new Map(els.map((x) => [x.ref, x]));
  for (let p = e && byRef.get(e.parentRef); p; p = byRef.get(p.parentRef)) if (p.hiddenGroup) return p.ref;
  return undefined;
}

async function main() {
  const esbuild = await loadEsbuild();
  const pw = await loadPlaywright();
  if (!esbuild || !pw) {
    console.error(
      `dom-runtime-check: toolchain unavailable (esbuild=${!!esbuild}, playwright-core=${!!pw}).\n` +
      `This harness needs both. Install playwright-core and its chromium, or run inside an\n` +
      `environment that already has them. Exiting 2 — this is NOT a pass.`,
    );
    process.exit(2);
  }

  const { bcpDomRuntime, bcpSignalWait, bcpWaitFactory, bcpEventProbes, bcpDomHelpersFactory, bcpReadOnlyGuard, bcpDialogShim, bcpDialogRestore } = await bundleRuntime(esbuild);
  const runtimeSource = bcpDomRuntime.toString();
  const probesSource = bcpEventProbes.toString();
  const signalSource = bcpSignalWait.toString();
  const waitSource = bcpWaitFactory.toString();
  const domHelpersSource = bcpDomHelpersFactory.toString();

  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage();

  /** Load a page, inject the REAL runtime, and expose helpers bound to it.
   *
   *  `url` serves a case that `setContent` structurally cannot: it leaves the
   *  page on about:blank, so any detection keyed on `location.pathname` sees
   *  "blank" no matter what the case intends. A path-shaped false positive is
   *  then unreproducible AND unmutatable — the assertion would pass whether the
   *  rule exists or not, which is the definition of a fake defence. */
  async function withPage(html, body, url) {
    if (url) {
      await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
      await page.goto(url);
    } else {
      await page.setContent(html);
    }
    await page.evaluate((src) => { globalThis.__bcpRun = eval(`(${src})`); }, runtimeSource);
    await page.evaluate((src) => { globalThis.__bcpSignalWait = eval(`(${src})`); }, signalSource);
    await page.evaluate(() => globalThis.__bcpRun("snapshot", {}));
    const refById = await page.evaluate(() => {
      const out = {};
      for (const [ref, el] of globalThis.__bcpRefs) if (el.id) out[el.id] = ref;
      return out;
    });
    const call = (op, params) => page.evaluate(([op, params]) => globalThis.__bcpRun(op, params), [op, params]);
    const value = (id) => page.evaluate((id) => {
      const el = document.getElementById(id);
      return el?.value ?? el?.control?.value;
    }, id);
    // Third arg is the factory SOURCE, exactly as the service worker passes it
    // (background.ts, WaitSignal case) — so `script` leaves here get `bcpDom`
    // the same way they do in production, and a leaf that uses it is really
    // exercised rather than merely compiled.
    const waitSignal = (condition, timeoutMs) =>
      page.evaluate(([c, t, d]) => globalThis.__bcpSignalWait(c, t, d), [condition, timeoutMs, domHelpersSource]);
    // bcpWait is created the same way browser.eval creates it: from the factory's
    // own source, with an absolute budget.
    const wait = (budgetMs, expr, setup) =>
      page.evaluate(
        ([src, budget, body, pre]) => {
          if (pre) new Function(pre)();
          const w = new Function(`return (${src})`)()(Date.now() + budget);
          return new Function("bcpWait", `return (${body})`)(w);
        },
        [waitSource, budgetMs, expr, setup ?? null],
      );
    // Install the REAL resident probes. They message the SW through the
    // extension API, which a plain page has none of — bcpEventProbes prefers
    // `browser` over `chrome`, so defining that is enough to capture its sends
    // without touching the code under test. Returns both what it pushed and the
    // verdict it cached, which is what bcpDomRuntime then reads.
    const probes = (nav) => page.evaluate(([src, nav]) => {
      // A real navigation gives the probe a fresh realm, which is what makes its
      // __bcpProbes idempotence guard and its cached verdict per-document.
      // setContent replaces the DOM through document.write and keeps the realm,
      // so without this reset case N would silently re-read case N-1's verdict.
      delete globalThis.__bcpProbes;
      delete globalThis.__bcpCaptcha;
      delete globalThis.__bcpCheckCaptcha;
      globalThis.__bcpSent = [];
      globalThis.browser = {
        runtime: { sendMessage: (m) => { globalThis.__bcpSent.push(m); return Promise.resolve(); } },
      };
      // `nav` is the SW-supplied HTTP evidence about the top document. Passing
      // undefined is the real "recycled SW" path, not a test-only shortcut.
      eval(`(${src})`)(nav ?? undefined);
      return { sent: globalThis.__bcpSent, verdict: globalThis.__bcpCaptcha ?? null };
    }, [probesSource, nav ?? null]);
    await body({ call, value, ref: (id) => refById[id], refById, waitSignal, wait, probes });
    if (url) await page.unroute("**/*");
  }

  // ------------------------------------------------------------------ cases
  // M1 — input semantics dispatch by input.type.
  await withPage(
    `<form>
       <label id="lbl" for="num" style="cursor:pointer">价格</label>
       <input id="num" type="number" step="0.01">
       <input id="dt" type="date"><input id="mo" type="month"><input id="tm" type="time">
       <input id="col" type="color"><input id="rg" type="range" min="0" max="100">
       <input id="txt" type="text"><input id="ro" type="text" readonly>
       <input id="cb" type="checkbox"><input id="fl" type="file">
     </form>`,
    async (t) => {
      // Structured types must be assigned whole: per-character assembly is wiped
      // by the sanitizer on every setter call.
      for (const [id, input, label] of [
        ["num", "19.9", "number keeps a decimal"],
        ["num", "-50", "number keeps a leading minus"],
        ["num", "1299.00", "number keeps trailing zeros"],
        ["dt", "2026-08-18", "date round-trips"],
        ["mo", "2026-08", "month round-trips"],
        ["tm", "13:45", "time round-trips"],
        ["col", "#ff8800", "color round-trips"],
        ["rg", "42", "in-range value round-trips"],
        ["txt", "hello world", "text still types per character"],
      ]) {
        const r = await t.call("type", { ref: t.ref(id), text: input });
        eq(r.error, undefined, `${label} — no error`);
        eq(await t.value(id), input, label);
      }

      // A value the field rejects must surface, not be silently swallowed.
      const oob = await t.call("type", { ref: t.ref("rg"), text: "-1.5" });
      match(oob.error, /rejected .*-1\.5/, "out-of-range value reports rejection");
      const nan = await t.call("type", { ref: t.ref("num"), text: "abc" });
      match(nan.error, /not a valid number/, "non-numeric input into number is refused");

      // Controls that cannot take typed text must say so, not no-op.
      match((await t.call("type", { ref: t.ref("ro"), text: "x" })).error, /readonly/, "readonly is refused");
      match((await t.call("type", { ref: t.ref("cb"), text: "x" })).error, /cannot be typed into/, "checkbox is refused");
      match((await t.call("type", { ref: t.ref("fl"), text: "x" })).error, /cannot be typed into/, "file input is refused");

      // follow-label: targeting the visible label must reach its control.
      const viaLabel = await t.call("type", { ref: t.ref("lbl"), text: "88.8" });
      eq(viaLabel.error, undefined, "typing via a label does not error");
      eq(await t.value("num"), "88.8", "typing via a label writes through to the control");
    },
  );

  // M2 — action retry: a transient overlay must be waited out, a permanent one
  // must be reported (never silently redirected back onto the target).
  await withPage(
    `<style>
       #mask { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 9 }
       button { position: relative; z-index: 1 }
     </style>
     <button id="b1" onclick="window.__hits=(window.__hits||0)+1">确定</button>
     <div id="mask" class="loading-mask"></div>`,
    async (t) => {
      // Permanent overlay: must fail, and must name what covered the target.
      const blocked = await t.call("click", { ref: t.ref("b1"), ms: 400 });
      match(blocked.error, /intercepted/, "covered click reports interception");
      match(blocked.error, /loading-mask/, "interception names the covering element");
      eq(await page.evaluate(() => window.__hits ?? 0), 0, "covered click does not fire the handler");

      // Transient overlay: clears mid-flight, so the retry loop must land it
      // within a single call.
      await page.evaluate(() => {
        window.__hits = 0;
        const m = document.getElementById("mask");
        setTimeout(() => m.remove(), 250);
      });
      const recovered = await t.call("click", { ref: t.ref("b1"), ms: 3000 });
      eq(recovered.error, undefined, "click retries until a transient overlay clears");
      eq(await page.evaluate(() => window.__hits), 1, "recovered click fires the handler exactly once");
    },
  );

  // NOT covered here: `scroll-behavior: smooth`, where the box keeps moving
  // after scrollIntoView so the first measurement is stale. Headless Chromium
  // appears to resolve smooth scrolling synchronously, so the case cannot be
  // reproduced in this harness — an assertion for it stayed green even with the
  // interception branch mutated out, i.e. it proved nothing. Verify that one on
  // a real page instead.

  // M3 — descriptive locators resolved at action time, strict by default.
  await withPage(
    `<div class="row" data-r="1">
       <span class="title">商品ABC</span>
       <button class="act" onclick="window.__c='A'">编辑</button>
     </div>
     <div class="row" data-r="2">
       <span class="title">商品XYZ</span>
       <button class="act" onclick="window.__c='X'">编辑</button>
     </div>
     <button id="only" aria-label="唯一动作" onclick="window.__c='only'">Go</button>
     <label for="qty">数量</label><input id="qty" type="number">`,
    async (t) => {
      // Unique text resolves with no ref at all.
      eq((await t.call("click", { text: "Go" })).error, undefined, "locator: unique text resolves");
      eq(await page.evaluate(() => window.__c), "only", "locator: text clicked the right element");

      // role + name, on markup whose name comes from aria-label.
      await page.evaluate(() => { window.__c = null; });
      eq((await t.call("click", { role: "button", name: "唯一动作" })).error, undefined, "locator: role+name resolves");
      eq(await page.evaluate(() => window.__c), "only", "locator: role+name clicked the right element");

      // Ambiguity must FAIL and enumerate, never silently pick the first.
      const amb = await t.call("click", { text: "编辑" });
      match(amb.error, /2 elements match/, "locator: ambiguity is an error");
      match(amb.error, /0\)/, "locator: ambiguity lists numbered candidates");

      // nth is the explicit escape hatch.
      await page.evaluate(() => { window.__c = null; });
      eq((await t.call("click", { text: "编辑", nth: 1 })).error, undefined, "locator: nth disambiguates");
      eq(await page.evaluate(() => window.__c), "X", "locator: nth picked the second in document order");

      // near narrows a repeated control by proximity to an anchor.
      await page.evaluate(() => { window.__c = null; });
      const near = await t.call("click", { text: "编辑", near: "商品ABC" });
      eq(near.error, undefined, "locator: near disambiguates a repeated control");
      eq(await page.evaluate(() => window.__c), "A", "locator: near picked the row it belongs to");

      // css works on markup with no semantics whatsoever.
      await page.evaluate(() => { window.__c = null; });
      eq((await t.call("click", { css: '[data-r="2"] .act' })).error, undefined, "locator: css resolves");
      eq(await page.evaluate(() => window.__c), "X", "locator: css clicked the right element");

      // A description that matches nothing must say so.
      match((await t.call("click", { text: "不存在的按钮" })).error, /nothing matches/, "locator: no match is an error");

      // A locator failure is also DATA, not only a sentence. Replay has to tell
      // "this selector went stale" (another route to the element might work)
      // apart from "the browser went away" (nothing about a locator can help),
      // and the only thing available before this was matching prose. The codes
      // are literals inside the injected runtime — it cannot import — so these
      // assertions are what keeps them agreeing with RpcErrorCode in @bcp/shared.
      const missInfo = (await t.call("click", { text: "不存在的按钮" })).errorInfo;
      eq(missInfo?.code, "LOCATOR_NO_MATCH", "locator: a miss carries a machine-readable code");

      const ambInfo = (await t.call("click", { text: "编辑" })).errorInfo;
      eq(ambInfo?.code, "LOCATOR_AMBIGUOUS", "locator: an ambiguous match carries its own code");
      eq(ambInfo?.candidates?.length, 2, "locator: ambiguity lists the candidates as data, not just prose");
      eq(ambInfo?.candidates?.[0]?.role, "button", "locator: a candidate carries the role a Locator could use");
      eq(ambInfo?.candidates?.[0]?.name, "编辑", "locator: a candidate carries its accessible name");

      // The dimension that did the excluding is named. This is the one fact a
      // fallback chain needs: "css is what stopped matching, the rest still fits".
      const relaxed = (await t.call("click", { text: "编辑", css: ".no-such-class" })).errorInfo;
      eq(relaxed?.code, "LOCATOR_NO_MATCH", "locator: over-constrained is still a miss");
      eq(relaxed?.relaxedBy, "css", "locator: the failure names which dimension excluded everything");
      eq(relaxed?.candidates?.length, 2, "locator: and offers what dropping it would have matched");

      // nth out of range is its own case: the element set was found, the index
      // was not in it — a different repair from "nothing matches".
      const nthInfo = (await t.call("click", { text: "编辑", nth: 5 })).errorInfo;
      eq(nthInfo?.code, "LOCATOR_NTH_RANGE", "locator: an out-of-range nth is distinguishable from a miss");

      // A locator that RESOLVES must not fabricate a diagnosis, and must report
      // the other ways the element it reached could have been named. A book
      // records one or two dimensions, so the first page change ends the run
      // with no second way in; these are read at the one moment the answer is
      // certain — the element is in hand, found by the author's own locator.
      await page.evaluate(() => { window.__c = null; });
      const hit = await t.call("click", { text: "Go" });
      eq(hit.errorInfo, undefined, "locator: success carries no errorInfo");
      eq(hit.resolved?.role, "button", "resolve: a hit reports the element's role");
      eq(hit.resolved?.name, "唯一动作", "resolve: a hit reports its accessible name");
      eq(hit.resolved?.text, "Go", "resolve: text is reported when it differs from the name");
      eq(hit.resolved?.css, "#only", "resolve: an id becomes a css dimension");

      // Text identical to the accessible name is dropped: two copies of one
      // string look like corroboration without being any, and a fallback that
      // counts agreeing dimensions would be fooled by it.
      const dup = await t.call("click", { text: "编辑", nth: 0 });
      eq(dup.resolved?.name, "编辑", "resolve: name is reported");
      eq(dup.resolved?.text, undefined, "resolve: text that merely repeats the name is omitted");

      // type_text locates by name — its `text` is the value, not a locator.
      eq((await t.call("type", { name: "数量", text: "19.9" })).error, undefined, "locator: type_text resolves by name");
      eq(await t.value("qty"), "19.9", "locator: type_text wrote to the field found by name");
    },
  );

  // An error is what the page declares invalid (aria-invalid), with the message
  // the field points to. role="alert" means "announce this promptly", NOT "this
  // is an error" — a version banner carrying it used to make every page report a
  // standing error. And a class name is no declaration: no library's classes are
  // known here.
  await withPage(
    `<div role="alert">新版本可用，请刷新页面</div>
     <div class="error el-form-item__error">只有类名的提示</div>
     <input id="bad" aria-invalid="true" aria-describedby="bad-msg"><div id="bad-msg">用户名不能为空</div>
     <input id="bare" aria-label="手机号" aria-invalid="true">`,
    async (t) => {
      const st = await t.call("state", {});
      eq(st.value.errorCount, 2, "the two declared-invalid fields; neither the banner nor a bare class counts");
      eq(st.value.errors?.[0], undefined, "errors are only listed in detail mode");
      const detail = await t.call("state", { verbosity: "detail", resetDelta: true });
      eq(JSON.stringify(detail.value.errors), JSON.stringify(["用户名不能为空", "手机号 is invalid"]),
        "each error is the message its field points to, or the field's name when it points to none");
      const snap = await t.call("snapshot", {});
      eq(snap.value.elements.find((e) => e.ref === t.ref("bad"))?.invalid, true, "the field itself is flagged in the snapshot too");
    },
  );

  // Component libraries frequently render radio groups without a native
  // `name` (the group lives in framework state). Each such radio is still a
  // valid standalone control and page_state must not assume a named group.
  await withPage(
    `<input id="radio-on" type="radio" checked>
     <input id="radio-off" type="radio">`,
    async (t) => {
      const st = await t.call("state", {});
      eq(st.error, undefined, "state accepts unnamed radios");
      eq(st.value?.forms.controls, 2, "state counts unnamed radios as standalone controls");
      eq(st.value?.forms.filled, 1, "state reads checked state for unnamed radios");
    },
  );

  // Action evidence: the agent cannot see the screen and does not remember its
  // own calls, so an action must be able to prove what it did.
  await withPage(
    `<div id="panel" class="mode-qr">
       <button id="tog" aria-pressed="false"
         onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed')==='true'?'false':'true');
                  const p=document.getElementById('panel'); p.className = p.className==='mode-qr'?'mode-pw':'mode-qr';">切换</button>
     </div>
     <button id="pd" onclick="event.preventDefault()">拦截</button>`,
    async (t) => {
      // A toggle moves none of the page-level axes, so state evidence is the
      // only thing that can show it worked.
      const first = await t.call("click", { ref: t.ref("tog") });
      const s1 = (first.value?.delta?.stateChanged ?? []).join(" | ");
      match(s1, /aria-pressed: false → true/, "evidence reports the aria-pressed flip");
      match(s1, /class changed/, "evidence reports the ancestor class flip");
      eq(first.value?.delta?.repeatedAfterMs, undefined, "first click is not flagged as a repeat");

      // THE case from the real session: clicking a toggle twice looks exactly
      // like a dead control unless the agent is told it already did this.
      const second = await t.call("click", { ref: t.ref("tog") });
      eq(typeof second.value?.delta?.repeatedAfterMs, "number", "second click on the same element is flagged");
      eq(await page.evaluate(() => document.getElementById("panel").className), "mode-qr",
        "two clicks really did revert the state — the flag is warning about a real revert");

      // preventDefault is positive proof a handler ran, even with nothing visible.
      const pd = await t.call("click", { ref: t.ref("pd") });
      eq(pd.value?.delta?.defaultPrevented, true, "preventDefault is reported as evidence the page reacted");
    },
  );

  // Geometry + coordinate targeting: the bridge between what an agent SEES in a
  // screenshot and what it can act on.
  await withPage(
    `<button id="near" style="position:absolute;left:100px;top:50px;width:80px;height:30px"
       onclick="window.__c='near'">按钮</button>
     <button id="icon" style="position:absolute;left:300px;top:50px;width:40px;height:40px"
       onclick="window.__c='icon'"><i class="glyph">✕</i></button>
     <button id="wide" style="position:absolute;left:0;top:200px;width:600px;height:40px"
       onclick="window.__x=event.clientX">宽按钮</button>
     <button id="far" style="position:absolute;left:10px;top:6000px">屏外</button>`,
    async (t) => {
      const snap = await t.call("snapshot", {});
      const byId = async (id) => {
        const ref = t.ref(id);
        return snap.value.elements.find((e) => e.ref === ref);
      };
      const near = await byId("near");
      eq(JSON.stringify(near?.rect), JSON.stringify([100, 50, 80, 30]), "on-screen element carries its viewport box");
      const far = await byId("far");
      eq(far?.rect, undefined, "off-screen element carries no box (a number there would only mislead)");
      eq(far?.inViewport, false, "off-screen element is still listed, just flagged");

      // Clicking a point lands on what is painted there.
      await page.evaluate(() => { window.__c = null; });
      eq((await t.call("click", { x: 140, y: 65 })).error, undefined, "coordinate click resolves");
      eq(await page.evaluate(() => window.__c), "near", "coordinate click hit the element at that point");

      // A point over a decorative glyph must climb to the real control, so the
      // risk gate and the accessible name apply to the button, not the icon.
      await page.evaluate(() => { window.__c = null; });
      const viaGlyph = await t.call("click", { x: 320, y: 70 });
      eq(viaGlyph.error, undefined, "coordinate click over an icon resolves");
      eq(await page.evaluate(() => window.__c), "icon", "coordinate click climbed from the glyph to its button");

      // The named point is used verbatim — NOT the element's centre, which for a
      // wide control is somewhere else entirely.
      await page.evaluate(() => { window.__x = null; });
      await t.call("click", { x: 60, y: 220 });
      const landedX = await page.evaluate(() => window.__x);
      eq(Math.abs(landedX - 60) <= 2, true, `coordinate click used the given point, not the centre (got ${landedX})`);

      match((await t.call("click", { x: 5000, y: 5000 })).error, /no element at/, "an off-screen point is refused");
    },
  );

  // Why climbing to the interactive ancestor matters, and it is NOT "can the
  // event reach the handler" — it always can, by bubbling. It is that the risk
  // gate reads the TARGET's accessible name. Land on the decorative glyph and
  // that name is an icon character, so a destructive control sails through
  // unconfirmed.
  await withPage(
    `<button id="danger" style="position:absolute;left:100px;top:100px;width:60px;height:60px"
       onclick="window.__deleted=true"><i class="glyph">🗑</i>删除</button>`,
    async (t) => {
      // Aim at the glyph's真 centre, and assert the point really resolves to the
      // glyph — otherwise this test would silently be clicking the button and
      // proving nothing about climbing.
      const g = await page.evaluate(() => {
        const r = document.querySelector(".glyph").getBoundingClientRect();
        const p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        return { ...p, hit: document.elementFromPoint(p.x, p.y)?.tagName };
      });
      eq(g.hit, "I", "the aimed point really lands on the decorative glyph");

      await page.evaluate(() => { window.__deleted = false; });
      const blocked = await t.call("click", { x: g.x, y: g.y });
      match(blocked.error, /risky action/, "a coordinate click over an icon still hits the risk gate");
      eq(await page.evaluate(() => window.__deleted), false, "the destructive handler did not run");

      const allowed = await t.call("click", { x: g.x, y: g.y, confirm: true });
      eq(allowed.error, undefined, "the same click proceeds once confirmed");
      eq(await page.evaluate(() => window.__deleted), true, "confirmed click reached the control");
    },
  );

  // The climb must survive `cursor` being an INHERITED property. The earlier
  // version of this test used a native <button> (cursor:default), so the glyph
  // did not inherit `pointer` and the bug hid. A custom control that sets
  // cursor:pointer — i.e. most real buttons — makes every descendant compute
  // `pointer`, and a cursor-first test returns the glyph at depth 0.
  await withPage(
    `<div id="danger" role="button" tabindex="0"
       style="position:absolute;left:100px;top:100px;width:80px;height:60px;cursor:pointer"
       onclick="window.__deleted=true"><i class="glyph" style="cursor:pointer">🗑</i>删除</div>`,
    async (t) => {
      const g = await page.evaluate(() => {
        const r = document.querySelector(".glyph").getBoundingClientRect();
        const p = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        return { ...p, hit: document.elementFromPoint(p.x, p.y)?.tagName,
                 glyphCursor: getComputedStyle(document.querySelector(".glyph")).cursor };
      });
      eq(g.hit, "I", "the aimed point lands on the glyph");
      eq(g.glyphCursor, "pointer", "the glyph INHERITS cursor:pointer — the condition that hid the bug");

      await page.evaluate(() => { window.__deleted = false; });
      const blocked = await t.call("click", { x: g.x, y: g.y });
      match(blocked.error, /risky action/, "coordinate click climbs past an inheriting glyph to the real control");
      eq(await page.evaluate(() => window.__deleted), false, "the destructive handler did not run");
    },
  );

  // When the only copy of the text is invisible, REFUSING is the correct answer.
  // Making the invisible descendant unable to displace its ancestor was tried and
  // reverted: the query then resolved to that ancestor — a layout container
  // "showing" text nobody can see — and clicking it is strictly worse than an
  // error, because a label like 删除账户 would trip the risk gate on text the
  // user never saw. This assertion pins the refusal deliberately.
  await withPage(
    `<div id="wrap" style="position:absolute;left:0;top:0">目标文本<span style="display:none">目标文本</span></div>
     <select id="sel" style="position:absolute;left:0;top:200px"><option>选项A</option></select>
     <button id="ok" style="position:absolute;left:0;top:300px"
       onclick="(window.__hits ??= []).push('ok')">可见文本</button>`,
    async (t) => {
      match((await t.call("click", { text: "目标文本" })).error, /nothing matches/,
        "text whose only copy is invisible is refused, not resolved to a visible ancestor");
      match((await t.call("click", { text: "选项A" })).error, /nothing matches/,
        "a 0×0 <option> is refused rather than redirected to its <select>");
      // …but ordinary visible text must still resolve — the refusal above must
      // not come from having broken text matching outright.
      await page.evaluate(() => { window.__hits = []; });
      const good = await t.call("click", { text: "可见文本" });
      eq(good.error, undefined, "ordinary visible text still resolves");
      eq((await page.evaluate(() => window.__hits)).includes("ok"), true, "and reaches the right control");
    },
  );

  // Pointer-mode drag: a widget built on pointer events (here a range slider that follows document pointermove
  // while pressed) ignores HTML5 drag-and-drop entirely, which is why `drag` used to report success and change
  // nothing. The pointer method presses, moves in steps and releases over the target.
  await withPage(
    `<div id="track" style="position:absolute;left:20px;top:40px;width:400px;height:20px;background:#ddd">
       <div id="handle" style="position:absolute;left:0;top:0;width:20px;height:20px;background:#333;cursor:pointer" tabindex="0"></div>
     </div>
     <div id="end" style="position:absolute;left:400px;top:40px;width:20px;height:20px" tabindex="0"></div>
     <script>
       const handle = document.getElementById('handle');
       let pressed = false;
       window.__moves = 0;
       handle.addEventListener('pointerdown', () => { pressed = true; });
       document.addEventListener('pointermove', (e) => {
         if (!pressed || e.buttons !== 1) return;
         window.__moves++;
         handle.style.left = Math.max(0, Math.min(380, e.clientX - 20 - 10)) + 'px';
       });
       document.addEventListener('pointerup', () => { pressed = false; });
     </script>`,
    async (t) => {
      const left = () => page.evaluate(() => parseInt(document.getElementById("handle").style.left, 10));
      const html5 = await t.call("drag", { ref: t.ref("handle"), toRef: t.ref("end") });
      eq(html5.error, undefined, "an html5 drag still runs");
      eq(await left(), 0, "a pointer-built slider ignores html5 drag-and-drop");
      const pointer = await t.call("drag", { ref: t.ref("handle"), toRef: t.ref("end"), dragMethod: "pointer" });
      eq(pointer.error, undefined, "a pointer drag runs");
      eq((await page.evaluate(() => window.__moves)) >= 10, true, "it moves in steps while pressed");
      eq(await left(), 380, "and the slider follows it to the target");
    },
  );

  // What a pointer drag must deliver for real libraries: a list that commits only on RELEASE over the drop target,
  // and one that listens to mouse events alone. The slider case above cannot tell either from a broken drag.
  await withPage(
    `<ul style="list-style:none;margin:0;padding:0">
       <li id="a" style="position:absolute;left:0;top:0;width:200px;height:30px;cursor:grab" tabindex="0">A</li>
       <li id="b" style="position:absolute;left:0;top:200px;width:200px;height:30px" tabindex="0">B</li>
       <li id="m" style="position:absolute;left:300px;top:0;width:200px;height:30px;cursor:grab" tabindex="0">M</li>
       <li id="n" style="position:absolute;left:300px;top:200px;width:200px;height:30px" tabindex="0">N</li>
     </ul>
     <script>
       let dragging = null;
       window.__order = [];
       document.getElementById('a').addEventListener('pointerdown', () => { dragging = 'a'; });
       document.getElementById('b').addEventListener('pointerup', () => { if (dragging) window.__order.push('pointer:' + dragging + '→b'); dragging = null; });
       let mouse = null;
       document.getElementById('m').addEventListener('mousedown', () => { mouse = 'm'; });
       document.addEventListener('mousemove', (e) => { if (mouse && e.buttons === 1) window.__mouseMoved = true; });
       document.getElementById('n').addEventListener('mouseup', () => { if (mouse && window.__mouseMoved) window.__order.push('mouse:' + mouse + '→n'); mouse = null; });
     </script>`,
    async (t) => {
      eq((await t.call("drag", { ref: t.ref("a"), toRef: t.ref("b"), dragMethod: "pointer" })).error, undefined, "a pointer drag to a release-committing list runs");
      eq((await t.call("drag", { ref: t.ref("m"), toRef: t.ref("n"), dragMethod: "pointer" })).error, undefined, "a pointer drag to a mouse-only list runs");
      eq(JSON.stringify(await page.evaluate(() => window.__order)), JSON.stringify(["pointer:a→b", "mouse:m→n"]), "release lands on the target, and mouse events are sent while pressed");
    },
  );

  // A drag presses and releases, so it answers to the click gate: one end inside the other is a click in
  // disguise, and a risky label on either end needs confirm — in both drag methods.
  await withPage(
    `<div id="row" style="position:absolute;left:0;top:0;width:300px;height:40px;cursor:grab" tabindex="0"><span id="inner" tabindex="0">行</span></div>
     <button id="del" style="position:absolute;left:0;top:100px" onpointerup="(window.__hits ??= []).push('del')" onclick="(window.__hits ??= []).push('del-click')">删除账户</button>
     <div id="bin" aria-label="拖到这里删除" style="position:absolute;left:0;top:200px;width:120px;height:60px" tabindex="0"
          ondrop="(window.__hits ??= []).push('binned')" ondragover="event.preventDefault()"></div>`,
    async (t) => {
      await page.evaluate(() => { window.__hits = []; });
      match((await t.call("drag", { ref: t.ref("del"), toRef: t.ref("del"), dragMethod: "pointer" })).error, /two separate elements/, "dragging a control onto itself is refused");
      match((await t.call("drag", { ref: t.ref("row"), toRef: t.ref("inner"), dragMethod: "pointer" })).error, /two separate elements/, "and so is dragging onto its own child");
      match((await t.call("drag", { ref: t.ref("del"), toRef: t.ref("row"), dragMethod: "pointer" })).error, /risky action on "删除账户" \(drag source\)/, "a risky control is not pressed without confirm");
      match((await t.call("drag", { ref: t.ref("row"), toRef: t.ref("bin") })).error, /risky action on "拖到这里删除" \(drag target\)/, "nor dropped onto a risky zone");
      eq(JSON.stringify(await page.evaluate(() => window.__hits)), "[]", "nothing ran");
      eq((await t.call("drag", { ref: t.ref("row"), toRef: t.ref("bin"), confirm: true })).error, undefined, "confirm allows it");
      eq((await page.evaluate(() => window.__hits)).includes("binned"), true, "and the drop happens");
    },
  );

  // Inside a frame, "in the viewport" and the box must be about the TOP viewport — what the user sees, what a
  // screenshot shows and what click({x,y}) means. A frame below the fold is not visible however its own viewport
  // looks, and a frame-local box would point at the wrong place in a screenshot.
  await withPage(
    `<iframe id="low" style="position:absolute;left:50px;top:3000px;width:300px;height:100px;border:2px solid #000"
       srcdoc="<button style='position:absolute;left:10px;top:10px'>下方</button>"></iframe>
     <iframe id="high" style="position:absolute;left:50px;top:100px;width:300px;height:100px;border:2px solid #000"
       srcdoc="<button style='position:absolute;left:10px;top:10px'>上方</button>"></iframe>`,
    async () => {
      await page.waitForFunction(() => [...document.querySelectorAll("iframe")].every((f) => f.contentDocument?.querySelector("button")));
      const inFrame = async (id) => {
        const handle = await page.$(`#${id}`);
        const target = await handle.contentFrame();
        await target.evaluate((src) => { globalThis.__bcpRun = eval(`(${src})`); }, runtimeSource);
        const snap = await target.evaluate(() => globalThis.__bcpRun("snapshot", {}));
        return snap.value.elements[0];
      };
      const low = await inFrame("low");
      eq(low.inViewport, false, "a control in a frame below the fold is not in the viewport");
      eq(low.rect, undefined, "and gets no box");
      const high = await inFrame("high");
      eq(high.inViewport, true, "a control in a visible frame is in the viewport");
      eq(high.rect?.[0] >= 60 && high.rect?.[1] >= 110, true, "its box is in top-viewport coordinates (frame offset + border added)");
    },
  );

  // The confirm list an agent reads and the gate that enforces it are written in two places (the injected runtime
  // cannot import), so they are tied here in both directions: every documented word trips the gate, and every
  // word the gate trips is documented. A drift either way is a refusal the agent did not expect, or none it did.
  {
    const { readFileSync } = await import("node:fs");
    const docs = readFileSync(pathResolve(HERE, "../../shared/src/mcp-instructions.ts"), "utf8");
    // The docs state the list once (CONFIRM_DOC, shared by click and double_click); any extra copy must match it.
    const copies = [...docs.matchAll(/label contains a risky word: ([^(]+?) \(case-insensitive/g)].map((m) => m[1]);
    eq(copies.length >= 1 && copies.every((c) => c === copies[0]), true, "every copy of the confirm list is identical");
    const listed = copies[0];
    const risky = /const RISKY = (\/.+\/i);/.exec(runtimeSource) ?? /RISKY = (\/.+\/i);/.exec(runtimeSource);
    eq(!!listed && !!risky, true, "the documented confirm list and the RISKY gate are both found");
    // A wording change in the docs must fail this check, not crash the harness past every later case.
    if (listed && risky) {
    const gate = eval(risky[1]);
    const documented = listed.split(/[\/,\s]+/).filter(Boolean).join(" ").replace(/place order/, "place_order").replace(/sign out/, "sign_out").replace(/log out/, "log_out").split(" ").map((w) => w.replace("_", " "));
    for (const word of documented) eq(gate.test(word), true, `documented risky word "${word}" is gated`);
    const enforced = risky[1].slice(2, -3).split("|").map((w) => w.replace(/\\b/g, "").replace(/\\s\*/g, " "));
    for (const word of enforced) eq(documented.includes(word), true, `gated word "${word}" is documented`);
    }
  }

  // A pointer drag dispatches at screen coordinates, so both ends must be on screen at once: scrolling the source
  // into view can carry the target away, and dropping at its stale position would hit whatever is there now.
  await withPage(
    `<div id="src" style="position:absolute;left:20px;top:20px;width:40px;height:40px;cursor:pointer" tabindex="0"></div>
     <div id="far" style="position:absolute;left:20px;top:4000px;width:40px;height:40px" tabindex="0"></div>`,
    async (t) => {
      match((await t.call("drag", { ref: t.ref("src"), toRef: t.ref("far"), dragMethod: "pointer" })).error,
        /not on screen together/, "a pointer drag refuses targets it cannot see together with the source");
    },
  );

  // zhipin.com's real header (2026-11-10): the visible login link holds a display:none hover panel, so its full
  // text is "登录/注册 登录注册后可以：…" and never EQUALS its label, while hidden register forms elsewhere hold
  // exact copies. An exact query then reported the label "NOT displayed". The rendered text is what the user
  // reads, so an exact miss falls back to it — and a word the user cannot see on its own still refuses.
  await withPage(
    `<div id="header"><a id="login" href="#" class="btn header-login-btn" style="position:absolute;left:0;top:0"
        onclick="event.preventDefault();(window.__hits ??= []).push('login')">登录/注册
        <div class="header-login-desc" style="display:none"><span>登录注册后可以：</span><ul><li>找工作，直接谈</li></ul></div></a></div>
     <div class="fast-register-box" style="display:none"><button class="btn registe-btn">登录/注册</button></div>
     <div class="sign-wrap" style="display:none"><button type="submit" class="btn">登录/注册</button><button class="btn">登录</button></div>`,
    async (t) => {
      await page.evaluate(() => { window.__hits = []; });
      const exact = await t.call("click", { text: "登录/注册", exact: true });
      eq(exact.error, undefined, "an exact label resolves to the visible control whose hidden hover panel adds text");
      eq((await page.evaluate(() => window.__hits)).includes("login"), true, "and clicks that visible control");
      match((await t.call("click", { text: "登录", exact: true })).error, /nothing matches/,
        "a word shown only as part of a longer visible label is still not an exact match");
    },
  );

  // The same notion of an exact label everywhere a label is matched: a description, a `near` anchor and
  // click_text. Here the hidden panel even repeats the whole label, and the wrapper has no box of its own
  // (its link is absolutely positioned), which must not let <body> win as the "innermost" holder.
  await withPage(
    `<div id="header"><a id="login" href="#" style="position:absolute;left:0;top:0"
        onclick="event.preventDefault();(window.__hits ??= []).push('login')">登录/注册
        <div style="display:none">登录/注册后可以：找工作，直接谈</div></a></div>
     <button id="go" style="position:absolute;left:150px;top:0" onclick="(window.__hits ??= []).push('go')">搜索</button>
     <div style="display:none"><button>登录/注册</button></div>`,
    async (t) => {
      await page.evaluate(() => { window.__hits = []; });
      eq((await t.call("click", { text: "登录/注册", exact: true })).error, undefined, "a hidden panel repeating the label does not hide the visible control");
      eq((await t.call("clickText", { text: "登录/注册", exact: true })).error, undefined, "click_text applies the same exact label");
      eq((await t.call("click", { text: "搜索", near: "登录/注册", exact: true })).error, undefined, "and so does a near anchor");
      eq(JSON.stringify(await page.evaluate(() => window.__hits)), JSON.stringify(["login", "login", "go"]), "each reached the visible control");
    },
  );

  // `near` ranks by edge-to-edge distance and collapses to the strictly closest.
  // Several anchors are allowed on purpose — a heading plus the same text inside
  // a row is ubiquitous, and refusing that was tried and reverted because it
  // broke calls that worked.
  await withPage(
    `<div style="position:absolute;left:0;top:0;width:80px">商品ABC</div>
     <button style="position:absolute;left:100px;top:0" onclick="window.__c='a'">编辑</button>
     <div style="position:absolute;left:0;top:100px;width:80px">商品XYZ</div>
     <button style="position:absolute;left:100px;top:100px" onclick="window.__c='b'">编辑</button>`,
    async (t) => {
      await page.evaluate(() => { window.__c = null; });
      const r = await t.call("click", { text: "编辑", near: "商品ABC" });
      eq(r.error, undefined, "near with a unique anchor resolves");
      eq(await page.evaluate(() => window.__c), "a", "near picked the control beside its anchor");

      // A substring anchor matching BOTH rows is no longer refused as
      // "ambiguous". Here each candidate is equidistant from its own anchor, so
      // the tie-guard declines to collapse and the call falls back to strict —
      // listing candidates instead of guessing. Two distinct behaviours, both
      // deliberate: multiple anchors are fine; an exact tie is not resolved.
      await page.evaluate(() => { window.__c = null; });
      const multi = await t.call("click", { text: "编辑", near: "商品" });
      eq(/make the anchor unique/.test(multi.error ?? ""), false,
        "multiple anchors are no longer refused as ambiguous");
      match(multi.error, /2 elements match/,
        "an exact tie falls back to strict rather than guessing a row");
    },
  );

  // The cap is isotropic and short on purpose. The earlier version weighted
  // vertical gaps 3× and capped at 1000, which reached ~1000px sideways — far
  // enough to pair an anchor with an unrelated control across the viewport and
  // click it with no warning. Refusing is the correct answer at that distance.
  await withPage(
    `<div style="position:absolute;left:0;top:0;width:80px">商品ABC</div>
     <button style="position:absolute;left:600px;top:0" onclick="window.__c='far'">删除</button>`,
    async (t) => {
      await page.evaluate(() => { window.__c = null; });
      const far = await t.call("click", { text: "删除", near: "商品ABC" });
      match(far.error, /nothing matches|near/i, "a control 520px away is not paired with the anchor");
      eq(await page.evaluate(() => window.__c), null, "and was never clicked");
    },
  );

  // Half a coordinate is a caller mistake, not a description.
  await withPage(`<button id="b">x</button>`, async (t) => {
    match((await t.call("click", { x: 10 })).error, /x and y must be given together/, "x without y is rejected");
  });

  // A clip-path control: the bounding box is a square, but only the upper-right
  // triangle is actually painted, so the box CENTRE lands on the card beneath.
  // elementFromPoint then returns an ANCESTOR of the target — which must count
  // as unreachable. Accepting it dispatched the event onto that card and looked
  // like a dead button; this exact shape cost three debugging sessions on a real
  // login page before the cause was found.
  await withPage(
    `<div id="card" style="position:absolute;left:0;top:0;width:300px;height:300px"
       onclick="(window.__hits ??= []).push('card')">
       <button id="corner"
         style="position:absolute;left:100px;top:0;width:100px;height:100px;clip-path:polygon(0 0, 40% 0, 40% 100%, 0 100%)"
         onclick="(window.__hits ??= []).push('corner')">切换</button>
     </div>`,
    async (t) => {
      // Sanity: the box centre really does resolve to the card, not the button.
      const probe = await page.evaluate(() => {
        const r = document.getElementById("corner").getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        // Scan for a point the browser actually resolves to the button, rather
        // than computing one from the clip geometry by hand — border and padding
        // make the rect wider than the declared width.
        let insideX = null;
        for (let x = Math.round(r.left) + 2; x < r.right; x += 2) {
          if (document.elementFromPoint(x, cy)?.id === "corner") { insideX = x; break; }
        }
        return { cx, cy, insideX, hit: document.elementFromPoint(cx, cy)?.id };
      });
      eq(typeof probe.insideX, "number", "the clipped button is reachable somewhere on its row");
      eq(probe.hit, "card", "the clipped button's box centre lands on its ancestor card");

      // The centre is unreachable, but the control is not: the runtime scans the
      // box, finds a point that really hit-tests to the button, and acts there.
      // It used to return "intercepted" with that point written in the message
      // and make the caller re-issue it — measured in a real session, the caller
      // spent 70s and two identical retries before doing so. What must NEVER
      // happen is dispatching onto the cover; that is what the next assertion
      // pins, and the recovery is only allowed to move the point, never the
      // target.
      await page.evaluate(() => { window.__hits = []; });
      const byRef = await t.call("click", { ref: t.ref("corner"), ms: 400 });
      eq(byRef.error, undefined, "a clipped target is reached at a point that is actually exposed");
      eq((await page.evaluate(() => window.__hits)).includes("corner"), true,
        "and the clipped control itself received the click");
      match(byRef.value?.delta?.recoveredVia ?? "", /centre covered/,
        "the reply says the centre was covered and where it acted instead");

      // Aiming inside the painted region works. The click legitimately bubbles
      // to the card as well, so assert the BUTTON was reached rather than
      // reading a last-writer-wins variable — the bubbled card handler would
      // otherwise overwrite it and look like a failure.
      await page.evaluate(() => { window.__hits = []; });
      const inside = await t.call("click", { x: probe.insideX, y: probe.cy });
      eq(inside.error, undefined, "a point inside the visible shape resolves");
      eq((await page.evaluate(() => window.__hits)).includes("corner"), true,
        "the clipped control itself received the click");
    },
  );

  // A detached target must be reported, not dispatched into the void.
  await withPage(
    `<button id="gone">走了</button>`,
    async (t) => {
      const ref = t.ref("gone");
      await page.evaluate(() => document.getElementById("gone").remove());
      const r = await t.call("click", { ref, ms: 300 });
      match(r.error, /stale ref|detached/, "clicking a removed element reports it");
    },
  );

  // ---- Evidence the runtime already had in hand but never reported ----

  // `submit:true` is a request, not an outcome. Both of these fail silently on
  // real pages, and the tool used to print "and submitted" for either.
  await withPage(
    `<input id="loose" type="text">
     <form id="f1" onsubmit="window.__submitted='f1';return false">
       <input id="ok" type="text"><button type="submit">Go</button>
     </form>
     <form id="f2" onsubmit="window.__submitted='f2';return false">
       <input id="blocked" type="text" onkeydown="if(event.key==='Enter')event.preventDefault()">
       <button type="submit">Go</button>
     </form>`,
    async (t) => {
      await page.evaluate(() => { window.__submitted = null; });

      const loose = await t.call("type", { ref: t.ref("loose"), text: "x", submit: true });
      eq(loose.value?.delta?.submitted, false, "a field outside any <form> reports submitted:false");
      eq(await page.evaluate(() => window.__submitted), null, "and really did not submit");

      const blocked = await t.call("type", { ref: t.ref("blocked"), text: "x", submit: true });
      eq(blocked.value?.delta?.submitted, false, "a handler that preventDefaults Enter reports submitted:false");
      eq(await page.evaluate(() => window.__submitted), null, "and really did not submit");

      // The submit listener returns false, so the form submits WITHOUT navigating
      // — otherwise requestSubmit would tear down the injected runtime and there
      // would be nothing left to report with.
      const good = await t.call("type", { ref: t.ref("ok"), text: "x", submit: true });
      eq(good.value?.delta?.submitted, true, "a real submit reports submitted:true");
      eq(await page.evaluate(() => window.__submitted), "f1", "and the form actually received it");
    },
  );

  // An input mask that refuses a character silently truncates the value; the
  // per-character loop already knew and said nothing.
  await withPage(
    `<input id="masked" type="text"
       oninput="this.value=this.value.replace(/[^0-9]/g,'')">
     <input id="plain" type="text">`,
    async (t) => {
      const r = await t.call("type", { ref: t.ref("masked"), text: "19.9" });
      eq(r.value?.delta?.valueMismatch?.requested, "19.9", "a dropped character is reported, not swallowed");
      eq(r.value?.delta?.valueMismatch?.actual, "199", "and the report says what the field actually holds");
      const clean = await t.call("type", { ref: t.ref("plain"), text: "19.9" });
      eq(clean.value?.delta?.valueMismatch, undefined, "a field that accepts the text reports no mismatch");
    },
  );

  // A controlled <select> can put the old option back on change.
  await withPage(
    `<select id="reverting" onchange="this.selectedIndex=0">
       <option>甲</option><option>乙</option>
     </select>
     <select id="normal"><option>甲</option><option>乙</option></select>`,
    async (t) => {
      const rev = await t.call("select", { ref: t.ref("reverting"), values: ["乙"] });
      eq(rev.value?.selected?.join(), "甲", "select reports what survived the change handler, not what it set");
      const ok = await t.call("select", { ref: t.ref("normal"), values: ["乙"] });
      eq(ok.value?.selected?.join(), "乙", "an uncontrolled select still reports the new value");
    },
  );

  // Reordering a list moves none of the six page-signature axes, so the DnD
  // accept handshake is the only cheap signal that the drop landed.
  await withPage(
    `<div id="src" draggable="true">A</div>
     <div id="live" draggable="true" ondragover="event.preventDefault()">B</div>
     <div id="dead" draggable="true">C</div>`,
    async (t) => {
      const live = await t.call("drag", { ref: t.ref("src"), toRef: t.ref("live") });
      eq(live.error, undefined, "drag resolves both refs");
      eq(live.value?.delta?.defaultPrevented, true, "a drop zone that accepts the drag is reported as accepting");
      const dead = await t.call("drag", { ref: t.ref("src"), toRef: t.ref("dead") });
      eq(dead.value?.delta?.defaultPrevented, false, "dragging onto dead space is reported as not accepted");
    },
  );

  // Synthetic keys drive no native default action, so preventDefault is the only
  // positive proof the page saw the keystroke.
  await withPage(
    `<div id="listens" tabindex="0" onkeydown="event.preventDefault()">listens</div>
     <div id="ignores" tabindex="0">ignores</div>`,
    async (t) => {
      const heard = await t.call("key", { ref: t.ref("listens"), key: "Enter" });
      eq(heard.value?.delta?.defaultPrevented, true, "a key a handler consumed is reported as seen");
      const lost = await t.call("key", { ref: t.ref("ignores"), key: "Enter" });
      eq(lost.value?.delta?.defaultPrevented, undefined, "a key nothing listened for is not claimed as seen");
    },
  );

  // read_content is the agent's main text channel; collapsing newlines flattens
  // every table and list into one line before the agent ever sees it.
  await withPage(
    `<table><tr><td>行一甲</td><td>行一乙</td></tr><tr><td>行二甲</td><td>行二乙</td></tr></table>
     <ul><li>项目一</li><li>项目二</li></ul>`,
    async (t) => {
      const r = await t.call("read", {});
      eq(r.value.text.includes("\n"), true, "page text keeps the line structure innerText computed");
      eq(/行一乙\s*\n\s*行二甲/.test(r.value.text), true, "table rows stay on separate lines");
      eq(/ {2,}/.test(r.value.text), false, "runs of spaces within a line are still squeezed");
    },
  );

  // Long pages are read as exact chunks. The historical implementation added
  // an ellipsis at 8K, which both hid the real length and made it impossible
  // to recover the missing tail. Pagination must reconstruct the normalized
  // browser text byte-for-byte (for JS strings, code-unit-for-code-unit).
  const longPage = "长页面内容".repeat(7000) + "\n页面尾部";
  await withPage(
    `<main>${longPage}</main>`,
    async (t) => {
      const expected = await page.evaluate(() =>
        (document.body?.innerText ?? "").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
      );
      const first = await t.call("read", {});
      eq(first.value.text.length, 32000, "default read uses the larger 32K chunk");
      eq(first.value.offset, 0, "the first chunk starts at offset zero");
      eq(first.value.totalChars, expected.length, "read reports the normalized total length");
      eq(first.value.truncated, true, "a long page is explicitly marked truncated");
      eq(first.value.nextOffset, 32000, "nextOffset points immediately after the returned chunk");

      const second = await t.call("read", { offset: first.value.nextOffset, maxChars: expected.length });
      eq(second.value.offset, 32000, "continuation starts at the requested offset");
      eq(second.value.truncated, false, "the final chunk is not marked truncated");
      eq(second.value.nextOffset, undefined, "the final chunk has no next offset");
      eq(first.value.text + second.value.text, expected, "concatenating chunks reconstructs the full page");

      const full = await t.call("read", { full: true });
      eq(full.value.text, expected, "backend dump reads can request the complete normalized text");
      eq(full.value.truncated, false, "full reads never advertise a missing tail");
      eq(full.value.overview.headings.length, 0, "the structural overview is present even without headings");
    },
  );

  // ---- Shadow DOM: the snapshot hands out refs for shadow-inner controls, so
  // the hit test has to be able to see them too. document.elementFromPoint
  // RETARGETS its answer to the host (w3c/csswg-drafts#556), which made every
  // such click report "intercepted by <the host>" — i.e. blocked by itself.
  await withPage(
    `<my-btn></my-btn>
     <script>
       customElements.define("my-btn", class extends HTMLElement {
         connectedCallback() {
           const r = this.attachShadow({ mode: "open" });
           r.innerHTML = '<button id="inner" style="width:120px;height:40px">确定</button>';
           r.getElementById("inner").addEventListener("click", () => { window.__hit = (window.__hit ?? 0) + 1; });
         }
       });
     </script>`,
    async (t) => {
      await page.evaluate(() => { window.__hit = 0; });
      const r = await t.call("click", { ref: t.ref("inner"), ms: 400 });
      eq(r.error, undefined, "a control inside an open shadow root is clickable by ref");
      eq(await page.evaluate(() => window.__hit), 1, "and the click reaches it exactly once");
    },
  );

  // ---- C: the `controls` edge. aria-controls / aria-owns / popovertarget are
  // the page stating which container a control opens. Without them a panel that
  // portals itself to <body> is reachable only by re-scanning the whole new
  // snapshot for a matching role/name, and [expanded] says one opened without
  // saying which. These assert the edge is RESOLVED (to a ref in this snapshot),
  // not merely copied through as an id.
  await withPage(
    `<button id="one" aria-controls="panel">规格</button>
     <button id="many" aria-controls="panel panel2">两个</button>
     <button id="owner" aria-owns="panel2">owns</button>
     <button id="pop" popovertarget="panel">popover</button>
     <button id="both" aria-controls="panel" popovertarget="panel">两种写法指同一个</button>
     <button id="none">无边</button>
     <button id="dangling" aria-controls="nosuchid">悬空</button>
     <button id="uncollected" aria-controls="plain">指向非交互元素</button>
     <div id="panel" role="listbox">面板</div>
     <div id="panel2" role="listbox">面板二</div>
     <div id="plain">普通容器，不进快照</div>`,
    async (t) => {
      const els = (await t.call("snapshot", {})).value.elements;
      const by = (id) => els.find((e) => e.ref === t.ref(id));
      eq(by("one")?.controls?.join(), t.ref("panel"), "C-controls aria-controls resolves to the target's ref");
      eq(by("many")?.controls?.join(), [t.ref("panel"), t.ref("panel2")].join(),
        "C-list a space-separated id list yields every ref, in document order of the attribute");
      eq(by("owner")?.controls?.join(), t.ref("panel2"), "C-owns aria-owns is read the same way");
      eq(by("pop")?.controls?.join(), t.ref("panel"), "C-pop popovertarget is read the same way");
      // Carrying both is ordinary markup — the popover API for browsers that
      // have it, aria-controls for assistive tech that predates it. One target
      // named twice is still one edge; `→[e5][e5]` would just be noise.
      eq(by("both")?.controls?.length, 1, "C-dedup a target named by two attributes yields one edge");
      eq(by("none")?.controls, undefined, "C-absent no attribute means no edge, not an empty array");
      eq(by("dangling")?.controls, undefined, "C-dangling an id matching nothing yields no edge");
      // The honest boundary: `plain` carries no role/tabindex/pointer, so it is
      // not in the snapshot and has no ref. Emitting the raw id here would hand
      // back an edge the caller cannot follow.
      eq(by("uncollected")?.controls, undefined, "C-uncollected a target with no ref yields no edge");
    },
  );

  // Ids are scoped to the shadow root that contains them. Resolving against
  // `document` does not merely miss the shadow target — when the light DOM
  // happens to hold the same id (component libraries reuse generated ids
  // freely) it silently returns the WRONG element, and the caller follows an
  // edge into a panel belonging to a different component.
  await withPage(
    `<div id="dup" role="listbox">灯泡 DOM 的同名面板</div>
     <my-sel></my-sel>
     <script>
       customElements.define("my-sel", class extends HTMLElement {
         connectedCallback() {
           this.attachShadow({ mode: "open" }).innerHTML =
             '<button id="trigger" aria-controls="dup">选择</button><div id="dup" role="listbox">影子里的面板</div>';
         }
       });
     </script>`,
    async (t) => {
      const refs = await page.evaluate(() => {
        const sr = document.querySelector("my-sel").shadowRoot;
        const find = (el) => { for (const [r, e] of globalThis.__bcpRefs) if (e === el) return r; return null; };
        return {
          trigger: find(sr.getElementById("trigger")),
          shadowPanel: find(sr.getElementById("dup")),
          lightPanel: find(document.getElementById("dup")),
        };
      });
      const els = (await t.call("snapshot", {})).value.elements;
      const trig = els.find((e) => e.ref === refs.trigger);
      eq(trig?.controls?.join(), refs.shadowPanel,
        "C-shadow an id inside a shadow root resolves within that root");
      eq(trig?.controls?.includes(refs.lightPanel), false,
        "C-shadow-wrong and never to the same-id element in the light DOM");
    },
  );

  // The baseline exists to keep rows lazy-loaded by OUR OWN scroll from being
  // billed to the action as an interruption. Taken in the same synchronous turn
  // as the scroll it could never contain them — IntersectionObserver is
  // delivered during the rendering steps, which had not happened yet.
  await withPage(
    `<div style="height:2000px"></div>
     <button id="deep" style="height:40px">目标</button>
     <script>
       new IntersectionObserver((es, o) => {
         if (!es.some((e) => e.isIntersecting)) return;
         o.disconnect();
         for (let i = 0; i < 5; i++) document.body.appendChild(document.createElement("button"));
       }).observe(document.getElementById("deep"));
     </script>`,
    async (t) => {
      const r = await t.call("click", { ref: t.ref("deep") });
      eq(r.error, undefined, "clicking a below-the-fold control works");
      eq(r.value?.delta?.elementDelta, undefined,
        "rows lazy-loaded by our own scroll are not billed to the click as an interruption");
    },
  );

  // click_text takes index 0 when several elements match — the only op that
  // silently picks. It may keep picking, but it has to say it picked.
  await withPage(
    `<div><span>编辑</span></div><div><span>编辑</span></div><div><span>编辑</span></div>`,
    async (t) => {
      const r = await t.call("clickText", { text: "编辑" });
      eq(r.error, undefined, "clickText still resolves when several elements match");
      eq(r.value?.candidates, 3, "and reports how many it chose among");
    },
  );

  // The system's most frequent failure. It has to end with something the caller
  // can run, not just a statement that nothing matched.
  await withPage(
    `<button style="display:none">隐藏按钮</button><button>别的</button>`,
    async (t) => {
      const r = await t.call("click", { text: "隐藏按钮" });
      match(r.error, /nothing matches/, "an unmatched locator still fails loudly");
      eq(/hidden|invisible|display|screenshot|x\s*,\s*y|click\(\{/i.test(r.error ?? ""), true,
        "and the failure names an executable next step rather than restating itself");
    },
  );

  // ---- Snapshot identity and diff ----
  // Refs used to be pure document position, renumbered on every snapshot: the
  // caller's handles all went stale on any re-render, and nothing could be
  // compared across two reads, so every snapshot arrived as an undifferentiated
  // full page. Identity is what fixes both.
  await withPage(
    `<button id="a">甲</button><button id="b">乙</button>
     <div id="host"></div>`,
    async (t) => {
      const first = await t.call("snapshot", {});
      const refOf = (r, id) => r.value.elements.find((e) => e.name?.includes(id))?.ref;
      const aRef1 = refOf(first, "甲");
      eq(typeof aRef1, "string", "a control gets a ref");
      eq(typeof first.value.docId, "string", "the snapshot names the document its refs belong to");

      // Insert a control, remove another, then re-read.
      await page.evaluate(() => {
        document.getElementById("host").innerHTML = '<button>丙</button>';
        document.getElementById("b").remove();
      });
      const second = await t.call("snapshot", {});

      eq(refOf(second, "甲"), aRef1, "a control that survived keeps the ref the caller already holds");
      eq(second.value.docId, first.value.docId, "and the document is still the same one");
      eq([aRef1, refOf(first, "乙")].includes(refOf(second, "丙")), false, "a new control gets a number no earlier control had");

      // A fresh element must never be handed a number a live element still holds.
      await page.evaluate(() => {
        document.getElementById("host").innerHTML += '<button>丁</button>';
      });
      const third = await t.call("snapshot", {});
      const refs = third.value.elements.map((e) => e.ref);
      eq(new Set(refs).size, refs.length, "refs stay unique after reuse");
      eq(refOf(third, "甲"), aRef1, "and the surviving ref is still stable across a third read");
    },
  );

  // ---- What the backend's snapshot reply relies on ----
  // Refs are numbered per document: a new document starts again at e1, so the
  // backend compares docId before it compares refs. The isolated world gives
  // every real document a fresh store; here the realm is reset by hand, the
  // way the probe cases above do it, because setContent keeps the realm.
  await withPage(`<button>甲</button>`, async (t) => {
    const newDocument = () => page.evaluate(() => {
      for (const k of Object.keys(globalThis)) if (k.startsWith("__bcp") && k !== "__bcpRun" && k !== "__bcpSignalWait") delete globalThis[k];
    });
    await newDocument();
    const before = await t.call("snapshot", {});
    await newDocument();
    const after = await t.call("snapshot", {});
    eq(after.value.elements[0]?.ref, before.value.elements[0]?.ref, "a new document reuses the same ref numbers");
    eq(after.value.docId === before.value.docId, false, "so it must report a different docId");
  });

  // Hidden elements are still collected and reported with their tag — a
  // concealed file input is upload_file's target, a native <select> under a
  // custom dropdown is select_option's — and the backend names them by ref. A
  // menu rendered up front and hidden by CSS keeps its refs when it opens —
  // only the hidden flag flips, which is what makes it "new to you" in the
  // backend.
  await withPage(
    `<label>上传<input id="file" type="file" style="display:none"></label>
     <select id="native" style="display:none"><option>北京</option></select>
     <ul id="menu" style="display:none"><li><a href="#" id="opt">Python</a></li></ul>`,
    async (t) => {
      const closed = await t.call("snapshot", {});
      const of = (r, ref) => r.value.elements.find((e) => e.ref === ref);
      eq(of(closed, t.ref("file"))?.tag, "input", "the hidden file input is reported with its tag");
      eq(of(closed, t.ref("file"))?.hidden, true);
      eq(of(closed, t.ref("native"))?.tag, "select", "so is the hidden native <select>");
      eq(of(closed, t.ref("native"))?.hidden, true);
      eq(of(closed, t.ref("opt"))?.hidden, true, "the menu item is collected while hidden");
      await page.evaluate(() => { document.getElementById("menu").style.display = "block"; });
      const open = await t.call("snapshot", {});
      eq(of(open, t.ref("opt"))?.hidden, undefined, "opening the menu flips it to visible");
      eq(open.value.docId, closed.value.docId, "without changing the document");
    },
  );

  // ---- Hidden groups. A closed menu's container is routinely a role-less
  // <ul>/<div> that nothing else collects, so its items had no common ref and
  // the backend could only list or count them one by one. The runtime collects
  // the OUTERMOST node whose own rule hides two or more collected elements —
  // the same rule hiddenCause names when an action is refused.
  await withPage(
    `<button id="trigger">菜单</button>
     <nav id="outer" style="display:none">
       <a href="#" id="top">首页</a>
       <ul id="inner" style="display:none"><li><a href="#" id="a1">甲</a></li><li><a href="#" id="a2">乙</a></li></ul>
     </nav>
     <div id="solo-wrap" style="display:none"><a href="#" id="solo">落单</a></div>
     <div role="menu" id="menu" style="display:none"><a href="#" id="m1">一</a><a href="#" id="m2">二</a></div>
     <details id="det"><summary id="sum">更多</summary><a href="#" id="d1">导出</a><a href="#" id="d2">删除</a></details>
     <div style="visibility:hidden"><a href="#" id="vis-back" style="visibility:visible">仍可见</a><a href="#" id="v1">藏</a></div>
     <div id="va" style="visibility:hidden"><div style="visibility:visible"><button id="vb">可见</button>
       <ul id="vu" style="display:none"><li><a href="#" id="vu1">x</a></li><li><a href="#" id="vu2">y</a></li></ul></div></div>
     <div id="sw" style="display:none"><span id="shost"></span></div>
     <script>document.getElementById("shost").attachShadow({ mode: "open" }).innerHTML = '<a href="#">影一</a><a href="#">影二</a>';</script>`,
    async (t) => {
      const els = (await t.call("snapshot", {})).value.elements;
      const refOfEl = await page.evaluate(() => {
        const out = {};
        for (const [ref, el] of globalThis.__bcpRefs) if (el.id) out[el.id] = ref;
        return out;
      });
      const of = (id) => els.find((e) => e.ref === refOfEl[id]);
      const groups = els.filter((e) => e.hiddenGroup);
      eq(of("outer")?.hiddenGroup, true, "the outermost hiding node of a role-less menu is collected as its group");
      eq(of("inner"), undefined, "a hiding node inside another is not a second group: the outermost one names the subtree");
      for (const id of ["top", "a1", "a2"]) eq(climb(els, of(id)), refOfEl.outer, `${id} nests under the group through parentRef`);
      eq(of("solo-wrap"), undefined, "a node hiding a single collected element is no group — that element stands alone");
      eq(of("menu")?.hiddenGroup, undefined, "an already collected container (role=menu) is the group itself, nothing is added");
      eq(of("det")?.hiddenGroup, true, "a closed <details> groups what it hides");
      eq(of("det")?.hidden, undefined, "while the <details> itself still shows (its summary)");
      eq(of("sum")?.parentRef, refOfEl.det, "the summary nests under it too");
      eq(of("vis-back")?.hidden, undefined, "a child that overrides visibility:hidden is visible and not grouped");
      eq(of("vu")?.hiddenGroup, true, "under a visibility override the group is the node that really hides the items");
      eq(of("va"), undefined, "not the visibility:hidden ancestor whose visible child shows them");
      eq(of("vb")?.hidden, undefined, "and the visible button beside them is no member of anything hidden");
      eq(of("sw"), undefined, "a host hidden from outside its shadow root is no group: nesting does not cross into the shadow tree, so the group could hold none of it");
      eq(groups.length, 3, "exactly three groups: the nav, the details and the overridden list");
      // Whatever the page, a group must hold what it stands for: it is collected only to name them.
      for (const g of groups) eq(els.filter((e) => climb(els, e) === g.ref).length >= 2, true, `group ${g.ref} holds at least two members through parentRef`);
      const order = els.map((e) => e.ref);
      eq(order.indexOf(refOfEl.outer) < order.indexOf(refOfEl.top), true, "a group precedes what it holds, as the tree and paging assume");
      await page.evaluate(() => { document.getElementById("outer").style.display = "block"; document.getElementById("inner").style.display = "block"; });
      const open = (await t.call("snapshot", {})).value.elements;
      eq(open.some((e) => e.hiddenGroup && e.ref === refOfEl.outer), false, "an opened menu is no longer a hidden group");
      eq(open.find((e) => e.ref === refOfEl.a1)?.hidden, undefined, "and its items keep their refs, now visible");
      await page.evaluate(() => { document.getElementById("outer").style.display = "none"; });
      const closedAgain = (await t.call("snapshot", {})).value.elements;
      eq(closedAgain.find((e) => e.hiddenGroup && e.name?.includes("首页"))?.ref, refOfEl.outer, "closed again, the group gets its own ref back: the agent's ref did not go stale while the node existed");
    },
  );

  // ---- Where a query's words are, when no element is named by them: the
  // facts a zero-hit reply gives instead of "try other words".
  await withPage(
    `<button id="named" aria-label="提交订单">去 Deutsch 版</button>
     <table><tr><td>Iceland</td><td>387,758</td></tr></table>
     <div style="display:none">Iceland (hidden copy)</div>
     <span id="sh"></span>
     <script>document.getElementById("sh").attachShadow({ mode: "open" }).innerHTML = "<p>iceland in a component</p>";</script>`,
    async (t) => {
      const de = (await t.call("snapshot", { query: "deutsch" })).value.textHits;
      eq(de?.count, 1, "the words inside a control named otherwise are found");
      eq(de?.samples[0]?.ref, t.ref("named"), "with the ref of the control they are inside");
      const ice = (await t.call("snapshot", { query: "ICELAND" })).value.textHits;
      eq(ice?.count, 3, "case folded; table text, hidden text and a shadow root's text all count");
      eq(ice?.samples.filter((h) => h.hidden).length, 1, "the hidden copy says it is hidden");
      eq(ice?.samples.some((h) => h.ref), false, "plain text carries no ref");
      eq((await t.call("snapshot", { query: "不在页面上" })).value.textHits?.count, 0, "absent words count zero");
      eq((await t.call("snapshot", {})).value.textHits, undefined, "no query, no text search");
      const miss = await t.call("click", { name: "387,758" });
      match(miss.error ?? "", /nothing matches .*the words occur 1 time\(s\) in this frame's text: in page text "387,758"/s,
        "a locator that finds no control says where the words are instead");
      const gone = await t.call("click", { name: "不在页面上" });
      match(gone.error ?? "", /the words are not in this frame's text at all/, "or that they are nowhere");
      const waited = await t.call("wait", { waitText: "hidden copy", ms: 100 });
      eq(waited.value?.matched, false);
      eq(waited.value?.textHits?.samples?.[0]?.hidden, true, "a wait that ran out reports the text is there but hidden");
    },
  );

  // ---- Names and states as the platform defines them, one predicate each,
  // shared by the snapshot and the actions.
  await withPage(
    `<a href="#" id="de" title="Kuckucksuhr – German">Deutsch</a>
     <a href="#" id="icon"><img alt="首页图标" src="data:,"></a>
     <a href="#" id="tip" title="只有提示"></a>
     <span id="l1">保存</span><span id="l2">草稿</span><button id="lb" aria-labelledby="l1 l2"></button>
     <button id="sw" role="switch" aria-checked="true">通知</button>
     <button id="tg" aria-pressed="false">加粗</button>
     <div role="tablist"><div role="tab" id="tab" aria-selected="true">概览</div></div>
     <fieldset disabled><button id="fs">提交表单</button></fieldset>
     <input type="checkbox" id="cb">
     <div id="box" style="height:40px;overflow:auto"><div style="height:400px"></div><button id="below">底部</button></div>
     <div id="row" style="cursor:pointer" onclick="0">订单 123 <span id="edit" title="编辑" style="cursor:pointer">✎</span></div>
     <select id="size"><option value="1">Small</option><option value="2" selected>Large</option></select>`,
    async (t) => {
      const els = (await t.call("snapshot", {})).value.elements;
      const of = (id) => els.find((e) => e.ref === t.ref(id));
      eq(of("de")?.name, "Deutsch", "a link is named by the words it shows, not by its title tooltip");
      eq(of("icon")?.name, "首页图标", "an image-only link is named by its image's alt");
      eq(of("tip")?.name, "只有提示", "an empty link still falls back to its title");
      eq(of("lb")?.name, "保存 草稿", "aria-labelledby with several ids joins their text");
      eq(of("sw")?.checked, true, "a switch's aria-checked is its state");
      eq(of("tg")?.pressed, false, "a toggle button's aria-pressed is its state");
      eq(of("tab")?.selected, true, "the selected tab says so");
      eq(of("fs")?.disabled, true, "a button inside a disabled fieldset is disabled");
      const refused = await t.call("click", { ref: t.ref("fs"), timeoutMs: 200, confirm: true });
      eq(typeof refused.error, "string", "and the action does not click it as if it were usable");
      eq(of("below")?.inViewport, false, "a button scrolled out of its own list is not in the viewport");
      eq(of("below")?.rect, undefined, "and gets no box that would land on whatever covers that spot");
      eq(typeof t.ref("edit"), "string", "an icon its author named inside a clickable row is a control of its own");
      eq(of("edit")?.name, "编辑");
      eq(of("size")?.value, "Large", "a <select> reports the chosen option's text, as its options are listed");
      const toggled = await t.call("click", { ref: t.ref("cb") });
      match((toggled.value?.delta?.stateChanged ?? []).join(" | "), /target checked: false → true/, "a native checkbox click reports the flip");
    },
  );

  // ---- The page runtime's copy of the text rule agrees with the shared one
  // (packages/shared/src/text-match.ts): wait_for finds text written with
  // other case, spacing or invisible characters exactly when the backend's
  // normalization says the two are the same.
  {
    const { normalizeText, TEXT_MATCH_CASES } = await import("../../shared/dist/text-match.js");
    for (const [raw, norm] of TEXT_MATCH_CASES) {
      eq(normalizeText(raw), norm, `shared rule: ${JSON.stringify(raw)}`);
      await withPage(`<p id="p">${raw.replace(/</g, "&lt;")}</p>`, async (t) => {
        const r = await t.call("wait", { waitText: norm.toUpperCase(), ms: 300 });
        eq(r.value?.matched, true, `wait_for matches ${JSON.stringify(raw)} as ${JSON.stringify(norm)}`);
        const absent = await t.call("wait", { waitText: `${norm} 不在页面上`, ms: 100 });
        eq(absent.value?.matched, false, "and does not match text the page does not show");
      });
    }
  }

  // ---- What judges the page sees what the snapshot sees: text, errors and
  // waits reach into open shadow roots (a web component's error toast used to
  // be invisible to textAbsent, noErrors and the action's newErrors).
  await withPage(
    `<button id="go">继续</button><span id="toast-host"></span><span id="hidden-host" style="display:none"></span>
     <script>
       document.getElementById("hidden-host").attachShadow({ mode: "open" }).innerHTML = '<p>隐藏的提示</p>';
       document.getElementById("go").onclick = () => {
         document.getElementById("toast-host").attachShadow({ mode: "open" }).innerHTML = '<input aria-invalid="true" aria-describedby="m"><p id="m">提交失败</p>';
       };
     </script>`,
    async (t) => {
      const acted = await t.call("click", { ref: t.ref("go") });
      eq(JSON.stringify(acted.value?.delta?.newErrors ?? []), JSON.stringify(["提交失败"]), "an error shown inside a shadow root is a new error of the action");
      const read = (await t.call("read", { full: true })).value.text;
      match(read, /提交失败/, "the page text includes what a shadow root shows");
      eq(read.includes("隐藏的提示"), false, "but not what it holds hidden");
      const waited = await t.call("wait", { waitText: "提交失败", ms: 500 });
      eq(waited.error, undefined, "wait_for finds text a shadow root shows");
    },
  );

  // ---- A ref acts only in the document it was read in. The backend sends the
  // docId of the read along with the ref; a document that was replaced since
  // (navigation, reload) numbers its elements afresh, so its e1 is not the e1
  // the caller saw.
  await withPage(`<button id="b" onclick="document.body.dataset.hit = '1'">保存</button>`, async (t) => {
    const docId = (await t.call("snapshot", {})).value.docId;
    const stale = await t.call("click", { ref: t.ref("b"), expectDoc: "another-document" });
    match(stale.error ?? "", /was read from a document this frame no longer shows .* Nothing was done/, "a ref from another document is refused, and says why");
    eq(await page.evaluate(() => document.body.dataset.hit ?? null), null, "and nothing was clicked");
    const ok = await t.call("click", { ref: t.ref("b"), expectDoc: docId });
    eq(ok.error, undefined, "the same document acts normally");
    eq(await page.evaluate(() => document.body.dataset.hit ?? null), "1");
  });

  // ---- Page dialogs during an action are answered AND reported. The shim runs in
  // the page's MAIN world around every in-page action (the extension installs it
  // and calls the restore afterwards); here both run in the page the same way.
  await withPage(
    `<button id="del" onclick="if (confirm('确定删除?')) document.body.dataset.deleted = '1'; alert('保存失败')">删除</button>`,
    async (t) => {
      await page.evaluate(([shim]) => { (0, eval)(`(${shim})`)(false); }, [bcpDialogShim.toString()]);
      await t.call("click", { ref: t.ref("del"), confirm: true });
      const seen = await page.evaluate(([restore]) => (0, eval)(`(${restore})`)(), [bcpDialogRestore.toString()]);
      eq(JSON.stringify(seen), JSON.stringify([{ kind: "confirm", message: "确定删除?", answered: "Cancel" }, { kind: "alert", message: "保存失败" }]),
        "the restore hands back what the page asked and how it was answered");
      eq(await page.evaluate(() => document.body.dataset.deleted ?? null), null, "and the confirm answered Cancel really cancelled what it guarded");
      eq(await page.evaluate(() => window.confirm.toString().includes("native code")), true, "native dialogs are back");
    },
  );

  // ---- One pipeline: every action that dispatches at a location must refuse a
  // covered target, not write into it. Only `click` used to check.
  await withPage(
    `<form style="position:relative">
       <input id="fld" style="position:absolute;left:0;top:0;width:200px;height:40px">
       <select id="sel" style="position:absolute;left:0;top:60px;width:200px;height:40px">
         <option>甲</option><option>乙</option>
       </select>
       <div id="veil" style="position:absolute;left:0;top:0;width:400px;height:200px;background:rgba(0,0,0,.4)"></div>
     </form>`,
    async (t) => {
      match((await t.call("type", { ref: t.ref("fld"), text: "x", ms: 300 })).error, /intercepted/,
        "typing into a covered field is refused, not written");
      eq(await t.value("fld"), "", "and the field was really left untouched");
      match((await t.call("select", { ref: t.ref("sel"), values: ["乙"], ms: 300 })).error, /intercepted/,
        "selecting on a covered <select> is refused");
      eq(await page.evaluate(() => document.getElementById("sel").selectedIndex), 0,
        "and the selection was really left alone");

      // Uncovering makes both work — the guard must not have broken the normal path.
      await page.evaluate(() => { document.getElementById("veil").remove(); });
      eq((await t.call("type", { ref: t.ref("fld"), text: "x" })).error, undefined, "an uncovered field still accepts typing");
      eq(await t.value("fld"), "x", "and the value lands");
    },
  );

  // scroll returned hardcoded 0/0/true on the wheel path and no before-position
  // on the DOM path, so "moved 800px" and "did not move" were the same reply.
  await withPage(
    // tabindex so the containers appear in the snapshot and can be named by ref —
    // a plain overflow:auto div matches nothing in SNAP_SELECTOR.
    `<div id="box" tabindex="0" style="height:120px;overflow:auto"><div style="height:2000px"></div></div>
     <div id="pinned" tabindex="0" style="height:120px;overflow:auto"
       onscroll="this.scrollTop=0"><div style="height:2000px"></div></div>`,
    async (t) => {
      const moved = await t.call("scroll", { ref: t.ref("box"), deltaY: 300, humanize: false });
      eq(moved.value?.via, "dom", "a real container scrolls through the DOM path");
      eq(moved.value?.movedBy > 0, true, "and the reply says how far it actually moved");

      const pinned = await t.call("scroll", { ref: t.ref("pinned"), deltaY: 300, humanize: false });
      eq(pinned.value?.movedBy, 0, "a container an onscroll handler pins back reports movedBy 0, not success");
    },
  );

  // ---- The modal guard on auto-recovery ----
  // Reaching a covered control at a still-exposed corner is right when the cover
  // is incidental (a card over its own corner button). It is WRONG when the
  // cover is a modal: blocking what is behind it is the page's whole intent, and
  // clicking through would defeat it. Both halves are pinned here — the first
  // fixture must recover, the second must refuse — so neither can be dropped
  // without a failure.
  await withPage(
    `<button id="under" style="position:absolute;left:0;top:0;width:300px;height:60px"
       onclick="window.__reached = (window.__reached ?? 0) + 1">下层按钮</button>
     <div id="plain" style="position:absolute;left:0;top:0;width:200px;height:60px;background:#ccc"></div>`,
    async (t) => {
      await page.evaluate(() => { window.__reached = 0; });
      const r = await t.call("click", { ref: t.ref("under"), ms: 400 });
      eq(r.error, undefined, "an incidental cover is reached around at an exposed point");
      eq(await page.evaluate(() => window.__reached), 1, "and the real control got the click");
    },
  );
  await withPage(
    `<button id="under" style="position:absolute;left:0;top:0;width:300px;height:60px"
       onclick="window.__reached = (window.__reached ?? 0) + 1">下层按钮</button>
     <div role="dialog" id="modal"
       style="position:absolute;left:0;top:0;width:200px;height:60px;background:#fff">对话框</div>`,
    async (t) => {
      await page.evaluate(() => { window.__reached = 0; });
      const r = await t.call("click", { ref: t.ref("under"), ms: 400 });
      match(r.error, /intercepted/, "a MODAL cover is never reached around, even with a corner exposed");
      eq(await page.evaluate(() => window.__reached), 0, "and nothing behind the modal was clicked");
    },
  );

  // ---- New interactions, each on the shared pipeline ----

  // A synthetic contextmenu cannot open Chrome's own menu; what it CAN do is
  // reach a page's custom one, and preventDefault is how that page says so.
  await withPage(
    `<div id="row" tabindex="0" style="width:200px;height:60px"
       oncontextmenu="event.preventDefault(); window.__menu = 1">右键我</div>
     <div id="plain" tabindex="0" style="width:200px;height:60px">没有菜单</div>`,
    async (t) => {
      await page.evaluate(() => { window.__menu = 0; });
      const r = await t.call("contextmenu", { ref: t.ref("row") });
      eq(r.error, undefined, "right-click resolves");
      eq(await page.evaluate(() => window.__menu), 1, "the page's contextmenu handler ran");
      eq(r.value?.delta?.defaultPrevented, true, "and the reply says the page handled it");
      const none = await t.call("contextmenu", { ref: t.ref("plain") });
      eq(none.value?.delta?.defaultPrevented, undefined,
        "an element with no context menu is not reported as having opened one");
    },
  );

  // Two detail:1 clicks never fire a dblclick handler — that is the whole reason
  // this cannot be "just call click twice".
  await withPage(
    // Two handlers on purpose: plenty of pages never bind dblclick at all and
    // instead check `event.detail === 2` on a plain click, so the detail
    // sequence has to be right, not just the trailing dblclick event.
    `<div id="cell" tabindex="0" style="width:200px;height:60px"
       ondblclick="window.__dbl = (window.__dbl ?? 0) + 1"
       onclick="if (event.detail === 2) window.__detail2 = (window.__detail2 ?? 0) + 1">单元格</div>`,
    async (t) => {
      await page.evaluate(() => { window.__dbl = 0; window.__detail2 = 0; });
      await t.call("click", { ref: t.ref("cell") });
      await t.call("click", { ref: t.ref("cell") });
      eq(await page.evaluate(() => window.__dbl), 0, "two separate clicks do NOT make a double-click");
      eq(await page.evaluate(() => window.__detail2), 0, "and neither of them carries detail:2");
      const r = await t.call("dblclick", { ref: t.ref("cell") });
      eq(r.error, undefined, "double-click resolves");
      eq(await page.evaluate(() => window.__dbl), 1, "the dblclick handler fires exactly once");
      eq(await page.evaluate(() => window.__detail2), 1,
        "and the second click carries detail:2, for pages that check that instead");
    },
  );

  // A rich editor consumes the paste; a plain field does not, and then the
  // insertion is ours. Doing both, or neither, is the bug this pins.
  await withPage(
    `<input id="plain" type="text">
     <div id="rich" contenteditable="true"
       onpaste="event.preventDefault(); this.textContent = 'EDITOR:' + event.clipboardData.getData('text/plain')"></div>`,
    async (t) => {
      const p1 = await t.call("paste", { ref: t.ref("plain"), text: "粘贴内容" });
      eq(p1.error, undefined, "paste into a plain field resolves");
      eq(await t.value("plain"), "粘贴内容", "and the text was inserted by us");
      eq(p1.value?.delta?.defaultPrevented, undefined, "a plain field does not claim to have handled it");

      const p2 = await t.call("paste", { ref: t.ref("rich"), text: "粘贴内容" });
      eq(p2.value?.delta?.defaultPrevented, true, "an editor that consumes the paste is reported as having done so");
      eq(await page.evaluate(() => document.getElementById("rich").textContent), "EDITOR:粘贴内容",
        "and we did NOT also insert it ourselves");
    },
  );

  // A paste lands where a real one would: at the caret of a field that already
  // had focus (replacing the selection), else at the end — and it never
  // flattens an editor's existing markup into plain text.
  await withPage(
    `<input id="field" type="text" value="abcdef">
     <input id="cold" type="text" value="abc">
     <div id="doc" contenteditable="true"><b>粗体</b> 正文</div>`,
    async (t) => {
      await page.evaluate(() => { const f = document.getElementById("field"); f.focus(); f.setSelectionRange(2, 4); });
      eq((await t.call("paste", { ref: t.ref("field"), text: "XY" })).error, undefined, "paste into a focused field resolves");
      eq(await t.value("field"), "abXYef", "it replaces the selection at the caret instead of appending");
      await t.call("paste", { ref: t.ref("cold"), text: "!" });
      eq(await t.value("cold"), "abc!", "a field that had no focus gets the text at the end");
      await t.call("paste", { ref: t.ref("doc"), text: "追加" });
      eq(await page.evaluate(() => document.querySelector("#doc b")?.textContent), "粗体", "the editor keeps its markup");
      eq(await page.evaluate(() => document.getElementById("doc").textContent), "粗体 正文追加", "and the text is appended after it");
    },
  );

  // page_state's rendering probe: a visible page that renders must never be
  // reported as stalled — that warning tells the user to restart Chrome.
  await withPage(
    `<button id="b">ok</button>`,
    async (t) => {
      const s = await t.call("state", {});
      eq(s.value?.documentHidden, false, "a page in the foreground is not hidden");
      eq(s.value?.framesStalled, undefined, "and a rendering page is not reported as stalled");
    },
  );

  // hover and right-click take the same locator as click: a description works
  // where a ref used to be the only way in.
  await withPage(
    `<div id="menuTrigger" tabindex="0" style="width:120px;height:30px"
       onmouseenter="window.__hovered = 1">更多操作</div>
     <div id="rowItem" tabindex="0" style="width:120px;height:30px"
       oncontextmenu="event.preventDefault(); window.__ctx = 1">订单 1001</div>`,
    async (t) => {
      await page.evaluate(() => { window.__hovered = 0; window.__ctx = 0; });
      eq((await t.call("hover", { text: "更多操作" })).error, undefined, "hover by visible text resolves");
      eq(await page.evaluate(() => window.__hovered), 1, "and reaches the element's mouseenter handler");
      eq((await t.call("contextmenu", { text: "订单 1001" })).error, undefined, "right-click by visible text resolves");
      eq(await page.evaluate(() => window.__ctx), 1, "and the page's contextmenu handler runs");
    },
  );

  // Playbook uploads use a stable CSS locator instead of snapshot-scoped refs.
  // Hidden file inputs remain valid targets, while an ambiguous selector must
  // fail closed rather than silently attaching to the wrong uploader.
  await withPage(
    `<input id="file" type="file" hidden>
     <input id="other" type="file" hidden>`,
    async (t) => {
      const payload = btoa("file-data");
      const byCss = await t.call("upload", { css: "#file", filename: "data.txt", mimeType: "text/plain", dataBase64: payload });
      eq(byCss.error, undefined, "upload resolves a hidden file input by CSS");
      eq(await page.evaluate(() => [...document.getElementById("file").files].map((f) => f.name).join(",")), "data.txt",
        "the CSS-targeted input receives the file");

      const ambiguous = await t.call("upload", { css: "input[type=file]", filename: "data.txt", mimeType: "text/plain", dataBase64: payload });
      match(ambiguous.error, /2 elements match/, "ambiguous CSS upload refuses to guess");
      match(ambiguous.error, /pass nth/, "...and says how to disambiguate");
    },
  );

  // A ref dies on the re-render an upload causes, so a playbook has to locate
  // its slots the way click does — by name/nth. The styled slot and the hidden
  // <input> inside it usually share an accessible name; only the slot may be
  // counted, or nth would advance two per uploader.
  await withPage(
    // The real shape: a styled, VISIBLE slot wrapping a display:none input that
    // carries the same accessible name. Visibility is what separates the two.
    `<label id="s0" aria-label="上传辅助图" style="display:inline-block;width:96px;height:96px">
       <input type="file" aria-label="上传辅助图" style="display:none"></label>
     <label id="s1" aria-label="上传辅助图" style="display:inline-block;width:96px;height:96px">
       <input type="file" aria-label="上传辅助图" style="display:none"></label>`,
    async (t) => {
      const payload = btoa("slot-data");
      const args = { filename: "a.txt", mimeType: "text/plain", dataBase64: payload };

      const ambiguous = await t.call("upload", { name: "上传辅助图", ...args });
      match(ambiguous.error, /2 elements match/, "two same-named slots refuse to guess — the hidden inputs are NOT also counted");

      const first = await t.call("upload", { name: "上传辅助图", nth: 0, ...args });
      eq(first.error, undefined, "upload resolves a slot by name+nth");
      eq(await page.evaluate(() => [...document.querySelector("#s0 input").files].map((f) => f.name).join(",")), "a.txt",
        "nth=0 fills the FIRST slot's hidden input, reached through its styled label");
      eq(await page.evaluate(() => document.querySelector("#s1 input").files.length), 0,
        "and leaves the second slot alone");

      const second = await t.call("upload", { name: "上传辅助图", nth: 1, ...args });
      eq(second.error, undefined, "nth=1 resolves the second slot");
      eq(await page.evaluate(() => [...document.querySelector("#s1 input").files].map((f) => f.name).join(",")), "a.txt",
        "and fills it");

      const missing = await t.call("upload", { name: "上传辅助图", nth: 9, ...args });
      match(missing.error, /out of range/, "an nth past the end fails closed rather than wrapping");
    },
  );

  // Sortable libraries clear their placeholder on dragleave and decide
  // insert-before/after from movement between successive dragovers.
  await withPage(
    `<div id="a" draggable="true" ondragleave="window.__left = 1">A</div>
     <div id="b" draggable="true" ondragover="event.preventDefault(); window.__overs = (window.__overs ?? 0) + 1">B</div>`,
    async (t) => {
      await page.evaluate(() => { window.__left = 0; window.__overs = 0; });
      const r = await t.call("drag", { ref: t.ref("a"), toRef: t.ref("b") });
      eq(r.error, undefined, "drag resolves");
      eq(await page.evaluate(() => window.__left), 1, "the source receives dragleave");
      eq((await page.evaluate(() => window.__overs)) > 1, true, "and the target sees more than one dragover");
    },
  );

  // pointerenter/mouseenter don't bubble. hover(ref: wrap) hit-tests to the
  // covering INNER span (deepElementFromPoint), same shape as a Naive UI
  // avatar whose trigger listener sits on the wrapper around an inner text
  // node — a lone dispatch on the inner span must never be the whole story;
  // the wrapper's own mouseenter has to fire too, before the inner one.
  await withPage(
    `<div id="wrap" style="position:absolute;left:0;top:0;width:40px;height:40px;cursor:pointer"
       onmouseenter="(window.__hits ??= []).push('wrap')">
       <span id="inner" style="display:block;width:100%;height:100%"
         onmouseenter="(window.__hits ??= []).push('inner')">头</span>
     </div>`,
    async (t) => {
      await page.evaluate(() => { window.__hits = []; });
      const r = await t.call("hover", { ref: t.ref("wrap") });
      eq(r.error, undefined, "hover resolves");
      eq((await page.evaluate(() => window.__hits)).join(), "wrap,inner",
        "a hover-trigger listener bound on the wrapper fires too, outermost before the hit-tested inner span");
    },
  );

  // ------------------------------------------------------------------ signal waits (Book v2)
  // S1 — a selector signal that starts false becomes true after a DOM mutation
  // and resolves EVENT-DRIVEN, without any external retry loop.
  await withPage(
    `<div id="holder"></div>`,
    async (t) => {
      const started = Date.now();
      const pending = t.waitSignal({ selector: "#target" }, 3000);
      await page.evaluate(() => {
        setTimeout(() => {
          const el = document.createElement("div");
          el.id = "target";
          el.textContent = "loaded";
          document.getElementById("holder").appendChild(el);
        }, 300);
      });
      const r = await pending;
      eq(r.satisfied, true, "S1 selector signal resolves after a DOM mutation");
      eq(r.timedOut, undefined, "S1 no timeout on the mutation-driven resolve");
      eq(r.evidence?.found, true, "S1 evidence reports the selector match");
      eq(Date.now() - started < 2500, true, `S1 event-driven (resolved ~300ms, not by polling: ${Date.now() - started}ms)`);
    },
  );

  // S2 — attribute changes (SPA readiness flips) also re-evaluate.
  await withPage(
    `<div id="gate" style="display:none">内容</div>`,
    async (t) => {
      const pending = t.waitSignal({ selector: "#gate" }, 3000);
      await page.evaluate(() => {
        setTimeout(() => { document.getElementById("gate").style.display = "block"; }, 200);
      });
      const r = await pending;
      eq(r.satisfied, true, "S2 selector signal resolves on an attribute (style) change");
    },
  );

  // S3 — all/any/not composition + leaf conditions.
  await withPage(
    `<div id="a">文本A</div>`,
    async (t) => {
      const all = await t.waitSignal({ all: [{ selector: "#a" }, { textPresent: "文本A" }] }, 1500);
      eq(all.satisfied, true, "S3 all gate satisfied by existing leaves");
      const any = await t.waitSignal({ any: [{ selector: "#missing" }, { textPresent: "文本A" }] }, 1500);
      eq(any.satisfied, true, "S3 any gate satisfied by one branch");
      const not = await t.waitSignal({ not: { selector: "#missing" } }, 1500);
      eq(not.satisfied, true, "S3 not gate: a missing selector satisfies the negation");
      const settled = await t.waitSignal({ settled: true }, 1500);
      eq(settled.satisfied, true, "S3 settled leaf holds on a complete document");
      const url = await t.waitSignal({ urlIncludes: "about" }, 1500);
      eq(url.satisfied, true, "S3 urlIncludes leaf matches the page URL");
      const absent = await t.waitSignal({ textPresent: "不存在的文本" }, 600);
      eq(absent.satisfied, false, "S3 textPresent fails when the text is absent");
      eq(absent.timedOut, true, "S3 ...by timeout");
      eq(absent.failedPaths?.length > 0, true, "S3 and reports the failing leaf path");
    },
  );

  // S4 — timeout cleanup: after the deadline, a late mutation must NOT emit any
  // further result/callback (observer, listeners and timers are cleaned up).
  await withPage(
    `<div id="h"></div>`,
    async (t) => {
      const r = await t.waitSignal({ selector: "#late" }, 400);
      eq(r.satisfied, false, "S4 times out when the selector never appears in time");
      eq(r.timedOut, true, "S4 reports timedOut");
      await page.evaluate(() => {
        const el = document.createElement("div");
        el.id = "late";
        document.getElementById("h").appendChild(el);
      });
      // Give a stray observer a chance to fire; the resolved promise must be final.
      await new Promise((r2) => setTimeout(r2, 300));
      eq(r.satisfied, false, "S4 the resolved timeout result is final (wait cleaned up)");
      eq(r.url !== undefined, true, "S4 diagnostics carry the last URL");
      eq(r.pageState !== undefined, true, "S4 diagnostics carry a page-state summary");
    },
  );

  // S5 — a selector condition reaches an OPEN shadow root through the same
  // composed-DOM traversal the runtime uses elsewhere.
  await withPage(
    `<div id="host"></div>`,
    async (t) => {
      await page.evaluate(() => {
        const host = document.getElementById("host");
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = "<button id='inner'>影子按钮</button>";
      });
      const r = await t.waitSignal({ selector: "#inner" }, 1500);
      eq(r.satisfied, true, "S5 selector pierces an open shadow root");
    },
  );

  // S6 — script leaf: MAIN-world evaluation of a page expression (this harness
  // page has no CSP, so new Function runs) + fail-closed on a blocked frameId.
  await withPage(
    `<div id="counter" data-n="3"></div>`,
    async (t) => {
      const ok = await t.waitSignal({ script: { code: "document.getElementById('counter').dataset.n === '3'" } }, 1500);
      eq(ok.satisfied, true, "S6 script leaf evaluates a MAIN-world expression");
      const blocked = await t.waitSignal({ script: { code: "true", frameId: 4 } }, 800);
      eq(blocked.satisfied, false, "S6 a non-top frameId fails closed");
      eq(blocked.blocked !== undefined, true, "S6 ...with the blocked reason");
    },
  );

  // S7 — `bcpDom` reaches a script leaf, and it is the REAL primitive.
  //
  // This is the assertion that was missing: v8 converted the books' visibility
  // predicates to `bcpDom.visible` INCLUDING inside signal conditions, but only
  // browser.eval injected it, so six gates went permanently blocked with
  // "bcpDom is not defined" (run 597a0cad) — a whole book down, an hour after
  // it had passed 33/33. Nothing in the RPC shape or in check:books could see
  // it: the capability lives entirely inside the injected function, so only a
  // real browser running the real leaf can prove it is there.
  //
  // The probe deliberately uses a closed <details>: getComputedStyle reports it
  // visible, only checkVisibility() reports it hidden. So this passes ONLY with
  // the genuine primitive — a stub or a hand-rolled fallback answers wrong and
  // the assertion goes red.
  await withPage(
    `<details id="d"><summary>展开</summary><p id="inner">被 details 折叠</p></details><p id="shown">看得见</p>`,
    async (t) => {
      const r = await t.waitSignal(
        { script: { code: "bcpDom.visible(document.getElementById('shown')) && !bcpDom.visible(document.getElementById('inner'))" } },
        1500,
      );
      eq(r.blocked, undefined, `S7 bcpDom is injected into script leaves (blocked: ${r.blocked})`);
      eq(r.satisfied, true, "S7 ...and it is the real checkVisibility predicate (closed <details> is hidden)");

      // Fail-closed, not false: an unknown name must surface as `blocked` with
      // the name in it. A gate that reported plain `false` here would look like
      // "the page isn't ready yet" and burn the full timeout on a typo.
      const nope = await t.waitSignal({ script: { code: "bcpNope.visible(document.body)" } }, 800);
      eq(nope.satisfied, false, "S7 an undefined name does not satisfy the gate");
      eq(/bcpNope is not defined/.test(nope.blocked ?? ""), true, `S7 ...and fails closed naming it (${nope.blocked})`);
      eq(nope.timedOut, undefined, "S7 ...immediately, without burning the deadline");
    },
  );


  // W — bcpWait: the four waiting shapes books were hand-rolling in eval.
  await withPage(
    `<div id="box">idle</div>`,
    async (t) => {
      // until() resolves with the truthy value, and reports null on timeout
      // rather than throwing — a book decides what "never appeared" means.
      const found = await t.wait(3000, `(async () => {
        setTimeout(() => { document.getElementById('box').textContent = 'ready'; }, 200);
        return await bcpWait.until(() => document.getElementById('box').textContent === 'ready' ? 'hit' : null, 2000, 50);
      })()`);
      eq(found, "hit", "W1 until() returns the truthy value once the condition holds");

      const missed = await t.wait(3000, `bcpWait.until(() => false, 300, 50)`);
      eq(missed, null, "W1 until() returns null at maxMs instead of throwing");

      // A throw inside the predicate means "not yet", not "failed" — book
      // predicates read half-rendered DOM constantly.
      const survived = await t.wait(3000, `(async () => {
        let n = 0;
        return await bcpWait.until(() => { if (++n < 3) throw new Error('not yet'); return n; }, 2000, 20);
      })()`);
      eq(survived, 3, "W1 until() keeps polling when the predicate throws");

      // domQuiet: false while the DOM keeps mutating, true once it stops.
      const busy = await t.wait(4000, `(async () => {
        const id = setInterval(() => { document.getElementById('box').textContent = String(Math.random()); }, 40);
        const r = await bcpWait.domQuiet(300, 900);
        clearInterval(id);
        return r;
      })()`);
      eq(busy, false, "W2 domQuiet() is false while the DOM keeps mutating");

      const calm = await t.wait(4000, `bcpWait.domQuiet(150, 2000)`);
      eq(calm, true, "W2 domQuiet() is true once the DOM settles");

      // grew: settles on a count that stopped changing — the "two rounds with no
      // growth" shape lazy-list books were writing by hand. The sequence is driven
      // by READ COUNT, not by wall clock, so the case is deterministic AND can
      // tell rounds:2 from rounds:1 — it contains a false plateau (2,2) that a
      // one-round check would settle on, returning 2 instead of 5.
      const settled = await t.wait(6000, `(async () => {
        const seq = [1, 2, 2, 3, 4, 5, 5, 5, 5];
        let i = 0;
        return await bcpWait.grew(() => seq[Math.min(i++, seq.length - 1)], { everyMs: 10, maxMs: 3000, rounds: 2 });
      })()`);
      eq(settled, 5, "W3 grew() rides out a false plateau and returns the settled count");

      // Every helper is capped by bcpDeadline, so no book can overrun its budget
      // by asking for a longer wait than the eval has left.
      const capped = await t.wait(400, `(async () => {
        const t0 = Date.now();
        await bcpWait.until(() => false, 30000, 50);
        return Date.now() - t0;
      })()`);
      eq(capped < 2000, true, `W5 helpers never wait past bcpDeadline (waited ${capped}ms)`);
    },
  );


  // W4 — netIdle needs its OWN page: the fetch/XHR wrap happens once per
  // document, so the controllable fetch has to exist before the factory runs.
  await withPage(
    `<div id="n">net</div>`,
    async (t) => {
      // page.setContent keeps the same window, so the once-per-document wrap
      // from earlier cases is still in place. Clearing the marker reproduces what
      // a real navigation gives the factory: a fresh document to wrap.
      const setup = `
        delete window.__bcpWaitPatched;
        delete window.__bcpWaitNet;
        window.__release = null;
        const gate = new Promise((r) => { window.__release = r; });
        window.fetch = () => gate.then(() => new Response("{}"));
      `;
      const duringRequest = await t.wait(
        4000,
        `(async () => {
          const p = fetch("/slow");
          const busy = await bcpWait.netIdle(150, 700);
          window.__release();
          await p.catch(() => {});
          const idle = await bcpWait.netIdle(150, 2000);
          return { busy, idle };
        })()`,
        setup,
      );
      eq(duringRequest.busy, false, "W4 netIdle() is false while a request is in flight");
      eq(duringRequest.idle, true, "W4 netIdle() is true once it has resolved");
    },
  );

  // V — "what counts as visible", over every way CSS/HTML can hide something.
  //
  // This repo had SEVEN copies of this predicate (bcpDomRuntime's, bcpSignalWait's,
  // and five mutually inconsistent ones hand-copied into books). Measured against
  // Playwright's definition they disagreed on 2-10 of the rows below — variant C
  // answered `display:none` on an ANCESTOR as visible, i.e. an element not in the
  // render tree at all. Two of the rows (content-visibility, a closed <details>)
  // were answered wrong by ALL SEVEN, because getComputedStyle cannot see either.
  //
  // The copies cannot be collapsed into one symbol: each of these functions is
  // stringified into the page separately and cannot reach a sibling's closure.
  // So the defence is this matrix, run against every copy. Expected values are
  // Playwright's (docs/src/actionability.md + its injected domUtils), not ours.
  //
  // MUTATION CHECK (done, keep doing it): reverting isVisible to the old
  // `opacity !== "0"` + `w===0 && h===0` turns V-opacity-self, V-w0, V-h0,
  // V-cv-hidden and V-details red. Reverting the signal copy to
  // getClientRects() turns V-wh0/V-scale0 red.
  {
    // One page, every mechanism — closer to a real page than 22 isolated ones,
    // and it lets a single snapshot check the runtime's own copy.
    const box = "width:80px;height:24px";
    const CASES = [
      // [id, expected-visible, html]  — target always carries id=`t-<id>`
      ["baseline", true, `<button id="t-baseline" style="${box}">ok</button>`],
      ["display-self", false, `<button id="t-display-self" style="display:none">x</button>`],
      ["display-anc", false, `<div style="display:none"><button id="t-display-anc" style="${box}">x</button></div>`],
      ["vis-self", false, `<button id="t-vis-self" style="visibility:hidden;${box}">x</button>`],
      ["vis-anc", false, `<div style="visibility:hidden"><button id="t-vis-anc" style="${box}">x</button></div>`],
      ["opacity-self", true, `<button id="t-opacity-self" style="opacity:0;${box}">x</button>`],
      ["opacity-anc", true, `<div style="opacity:0"><button id="t-opacity-anc" style="${box}">x</button></div>`],
      ["w0", false, `<button id="t-w0" style="width:0;height:24px;padding:0;border:0;overflow:hidden">x</button>`],
      ["h0", false, `<button id="t-h0" style="width:80px;height:0;padding:0;border:0;overflow:hidden">x</button>`],
      ["wh0", false, `<button id="t-wh0" style="width:0;height:0;padding:0;border:0;overflow:hidden">x</button>`],
      ["cv-hidden", false, `<div style="content-visibility:hidden"><button id="t-cv-hidden" style="${box}">x</button></div>`],
      ["details", false, `<details><summary>s</summary><button id="t-details" style="${box}">x</button></details>`],
      ["hidden-attr", false, `<button id="t-hidden-attr" hidden>x</button>`],
      ["aria-hidden", true, `<button id="t-aria-hidden" aria-hidden="true" style="${box}">x</button>`],
      ["inert", true, `<div inert><button id="t-inert" style="${box}">x</button></div>`],
      ["scale0", false, `<button id="t-scale0" style="transform:scale(0);${box}">x</button>`],
      ["clip", true, `<button id="t-clip" style="clip-path:inset(100%);${box}">x</button>`],
      ["offscreen", true, `<button id="t-offscreen" style="position:absolute;left:-9999px;${box}">x</button>`],
      ["indent", true, `<button id="t-indent" style="text-indent:-9999px;${box}">x</button>`],
      ["fontsize0", false, `<span id="t-fontsize0" style="font-size:0">文字</span>`],
      ["empty-span", false, `<span id="t-empty-span"></span>`],
      ["covered", true, `<button id="t-covered" style="${box}">x</button>`],
      // `content-visibility:auto` off-screen must stay VISIBLE. Enabling
      // checkVisibility's `contentVisibilityAuto` would report it invisible, and
      // that deadlocks the agent: a virtualised row it cannot locate is a row it
      // cannot scroll to either, so "not found" becomes terminal. Left visible,
      // the locator resolves it and the click's own scroll-into-view renders it.
      // Playwright makes the same call.
      //
      // HONEST LIMIT — this row does NOT guard that option. Mutation-tested by
      // switching `contentVisibilityAuto: true` on in all three copies: still
      // green, because headless-without-scrolling never puts the subtree into the
      // skipped state, so the option has nothing to report. What the row does pin
      // is the OUTCOME (off-screen auto content stays reachable). Guarding the
      // option itself needs a harness that can drive a real scroll and wait a
      // frame; until then, treat the option as unverified rather than as covered.
      ["cv-auto-offscreen", true,
        `<div style="height:200vh"></div><div style="content-visibility:auto">` +
        `<button id="t-cv-auto-offscreen" style="${box}">x</button></div>`],
    ];
    // The overlay goes last so it cannot displace anything above it. Visibility
    // is deliberately NOT occlusion-aware — "can I click it right now" is asked
    // at action time by the hit-test, not here — so `covered` stays visible.
    const html = CASES.map(([, , h]) => `<div>${h}</div>`).join("") +
      `<div style="position:fixed;inset:0;background:#000;opacity:0.01"></div>`;

    await withPage(html, async (t) => {
      // 1) bcpDomHelpersFactory's copy — the one books get as `bcpDom`.
      const viaFactory = await page.evaluate(
        ([src, ids]) => {
          const dom = new Function(`return (${src})`)()();
          return ids.map((id) => dom.visible(document.getElementById(`t-${id}`)));
        },
        [domHelpersSource, CASES.map(([id]) => id)],
      );
      CASES.forEach(([id, want], i) => {
        eq(viaFactory[i], want, `V-${id} bcpDom.visible agrees with Playwright's definition`);
      });

      // 2) bcpDomRuntime's own copy, observed through the snapshot's [hidden]
      //    flag. Only <button> cases are asserted here: the snapshot collects
      //    interactable elements, and a bare <span> is not one.
      const snap = await t.call("snapshot", {});
      for (const [id, want, h] of CASES) {
        if (!h.includes("<button")) continue;
        const ref = t.ref(`t-${id}`);
        const el = snap.value.elements.find((e) => e.ref === ref);
        eq(el !== undefined, true, `V-${id} the snapshot lists the element even when hidden`);
        eq(el?.hidden !== true, want, `V-${id} the runtime's own isVisible agrees (snapshot [hidden])`);
      }

      // 3) bcpSignalWait's copy, reached through a `selector` signal condition —
      //    the only door to it from outside. Asking for the state we EXPECT means
      //    both answers settle on the first evaluation, so a wrong verdict fails
      //    fast instead of burning the timeout.
      //
      //    This copy was originally left out, and the omission was invisible:
      //    the comments claimed "run against all three" while a mutation to it
      //    (geometry gate → `if (false)`) kept the suite green. A defence nobody
      //    proved can refute anything is not a defence.
      for (const [id, want, h] of CASES) {
        if (!h.includes("<button")) continue;
        const r = await t.waitSignal({ selector: `#t-${id}`, state: want ? "visible" : "hidden" }, 60);
        eq(r.satisfied, true, `V-${id} bcpSignalWait's copy agrees too (selector signal)`);
      }
    });

    // 3) The option-name probe. checkVisibility silently ignores unknown
    //    dictionary keys, so an engine that knows only the older spelling would
    //    answer `visibility:hidden` as VISIBLE and nobody would hear about it.
    //    Both spellings are passed in all three copies; this proves at least one
    //    is honoured HERE, and states the Firefox gap out loud rather than
    //    assuming it.
    await withPage(`<div id="p" style="width:80px;height:24px;visibility:hidden"></div>`, async () => {
      const honoured = await page.evaluate(() => {
        const d = document.getElementById("p");
        if (typeof d.checkVisibility !== "function") return "no-api";
        return {
          new: d.checkVisibility({ visibilityProperty: true }) === false,
          old: d.checkVisibility({ checkVisibilityCSS: true }) === false,
        };
      });
      eq(honoured !== "no-api" && (honoured.new || honoured.old), true,
        "V-probe at least one checkVisibility option spelling is honoured on this engine");
    });

    // bcpDom.hover / .press — the pointer sequences books get.
    //
    // What is actually at stake is the ANCESTOR WALK. `mouseenter`/`pointerenter`
    // do not bubble, and a real mouse fires them on every element along the
    // cursor's path; a lone dispatchEvent does not. Naive UI / Element / Ant all
    // put the trigger listener on a wrapper ABOVE the node a hit-test returns, so
    // without the walk a menu simply never opens and the failure reads as "my
    // locator is wrong" (learn 2026-08-19).
    //
    // MUTATION CHECK (done): dropping the `chain.reverse()` loop from `sequence`
    // turns V-hover-ancestor and V-press-ancestor red while everything else
    // stays green.
    await withPage(
      `<div id="wrap" style="padding:20px"><button id="btn" style="width:80px;height:24px">x</button></div>`,
      async () => {
        const r = await page.evaluate((src) => {
          const dom = new Function(`return (${src})`)()();
          const seen = [];
          const watch = (el, tag) => {
            for (const t of ["pointerenter", "mouseenter", "mouseover", "pointerdown", "mouseup", "click"]) {
              el.addEventListener(t, (e) => seen.push(`${tag}:${e.type}`));
            }
          };
          watch(document.getElementById("wrap"), "wrap");
          watch(document.getElementById("btn"), "btn");
          const btn = document.getElementById("btn");
          dom.hover(btn);
          const hover = seen.splice(0);
          dom.press(btn);
          return { hover, press: seen.splice(0) };
        }, domHelpersSource);

        eq(r.hover.includes("btn:mouseover"), true, "V-hover reaches the element itself");
        eq(r.hover.includes("wrap:mouseenter"), true,
          "V-hover-ancestor mouseenter is re-fired on the ANCESTOR (it does not bubble)");
        eq(r.hover.some((e) => e.endsWith(":click")), false,
          "V-hover does NOT click — hovering a delete button must not delete");
        eq(r.hover.some((e) => e.endsWith(":pointerdown")), false, "V-hover presses nothing down");

        eq(r.press.includes("btn:click"), true, "V-press clicks");
        eq(r.press.includes("wrap:mouseenter"), true,
          "V-press-ancestor the pointer arrives along the ancestor chain before pressing");
        eq(r.press.indexOf("btn:pointerdown") < r.press.indexOf("btn:click"), true,
          "V-press pointerdown precedes click — a click with no press before it is what bot checks look for");
      },
    );

    // The covered verdict. `? hit : el` used to swallow this: an element behind
    // an overlay got the events anyway and the caller was told nothing, which is
    // precisely what CLAUDE.md records as removed from realClick ("silently
    // re-routing the event back to the target made a covered click report
    // success"). The events still go out — 32 book call sites depend on it — but
    // the verdict is now returned, so a caller CAN tell the two apart.
    //
    // MUTATION CHECK (done): restoring `return true` unconditionally turns
    // V-press-covered red while V-press-uncovered stays green.
    await withPage(
      `<button id="free" style="display:block;width:80px;height:24px">a</button>
       <div style="height:60px"></div>
       <button id="under" style="display:block;width:80px;height:24px">b</button>
       <div id="veil" style="position:fixed;inset:0;background:#000;opacity:.5"></div>`,
      async () => {
        const r = await page.evaluate((src) => {
          const dom = new Function(`return (${src})`)()();
          const under = document.getElementById("under");
          let landed = false;
          under.addEventListener("click", () => { landed = true; });
          // The veil covers everything, so lift it off the free button only.
          document.getElementById("veil").style.clipPath = "inset(40px 0 0 0)";
          return {
            free: dom.press(document.getElementById("free")),
            under: dom.press(under),
            landed,
          };
        }, domHelpersSource);

        eq(r.free, true, "V-press-uncovered an element painted at its own centre reports true");
        eq(r.under, false, "V-press-covered an element behind an overlay reports FALSE, not silent success");
        eq(r.landed, true, "V-press-covered …while still dispatching, so existing book call sites keep working");
      },
    );

    // bcpDom.click — the retrying one. The whole reason it exists is that eval
    // code never passes through reachTarget, so a book doing many interactions
    // inside one eval had NO actionability handling at all: no wait, no scroll
    // alignment, no retry. The invariant that makes retrying safe is that it
    // dispatches ONLY on a passing hit test — retrying with `press` (which fires
    // regardless) would click two, three, four times.
    //
    // MUTATION CHECK (done): dispatching before the hit test passes turns
    // V-click-no-double red (clicks becomes 3+), and dropping the retry loop
    // turns V-click-retries red.
    await withPage(
      `<button id="b" style="display:block;width:80px;height:24px">x</button>
       <div id="mask" style="position:fixed;inset:0;background:#000"></div>`,
      async () => {
        const lifted = await page.evaluate(async (src) => {
          const dom = new Function(`return (${src})`)()(Date.now() + 8000);
          const b = document.getElementById("b");
          let clicks = 0;
          b.addEventListener("click", () => { clicks++; });
          setTimeout(() => document.getElementById("mask").remove(), 350);
          const res = await dom.click(b, { timeoutMs: 3000 });
          return { res, clicks };
        }, domHelpersSource);
        eq(lifted.res.ok, true, "V-click succeeds once the cover goes away");
        eq(lifted.res.attempts > 1, true, "V-click-retries …and it took more than one attempt to get there");
        eq(lifted.clicks, 1, "V-click-no-double exactly ONE click despite retrying");

        const stuck = await page.evaluate(async (src) => {
          const dom = new Function(`return (${src})`)()(Date.now() + 8000);
          document.body.insertAdjacentHTML("beforeend",
            `<div id="mask2" style="position:fixed;inset:0;background:#000"></div>`);
          const b = document.getElementById("b");
          let clicks = 0;
          b.addEventListener("click", () => { clicks++; });
          const res = await dom.click(b, { timeoutMs: 400 });
          return { res, clicks };
        }, domHelpersSource);
        eq(stuck.res.ok, false, "V-click reports failure when the cover never lifts");
        eq(/盖住/.test(stuck.res.reason ?? ""), true,
          "V-click …naming the covering element, which the book cannot find out afterwards");
        eq(stuck.clicks, 0, "V-click-no-blind-fire a click that never passed the hit test is never dispatched");
      },
    );

    // V-set — setValue / setFiles must write through the PROTOTYPE accessor.
    //
    // That is the entire point of both: a framework-controlled input installs
    // its own `value`/`files` accessor and discards a plain assignment on the
    // next render (React's, and the reason the 抖店 CSV import reported
    // "文件上传失败" until it stopped assigning directly).
    //
    // The probe below installs an OWN accessor on the element, which is what a
    // framework's guard looks like from here: a plain `el.files = x` runs it,
    // the prototype setter does not. So `hijacked` false IS the bypass — an
    // assertion that fails the moment someone "simplifies" these back to a
    // direct assignment. (Mutation check done: both flip to hijacked:true and
    // the value/file stops landing.)
    await withPage(
      `<input id="text" type="text"><input id="file" type="file">`,
      async () => {
        const r = await page.evaluate((src) => {
          const dom = new Function(`return (${src})`)()();
          const out = { events: [] };

          const text = document.getElementById("text");
          const realValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          let valueHijacked = false;
          Object.defineProperty(text, "value", {
            configurable: true,
            get() { return realValue.get.call(this); },
            set(v) { valueHijacked = true; realValue.set.call(this, v); },
          });
          text.addEventListener("input", () => out.events.push("text:input"));
          text.addEventListener("change", () => out.events.push("text:change"));
          dom.setValue(text, "写进去了");
          out.valueHijacked = valueHijacked;
          out.value = realValue.get.call(text);

          const file = document.getElementById("file");
          const realFiles = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
          let filesHijacked = false;
          Object.defineProperty(file, "files", {
            configurable: true,
            get() { return realFiles.get.call(this); },
            set(v) { filesHijacked = true; realFiles.set.call(this, v); },
          });
          file.addEventListener("input", () => out.events.push("file:input"));
          file.addEventListener("change", () => out.events.push("file:change"));
          out.landed = dom.setFiles(file, [
            new File(["a,b\n1,2\n"], "sku.csv", { type: "text/csv" }),
            new File(["x"], "spec.jpg", { type: "image/jpeg" }),
          ]);
          out.filesHijacked = filesHijacked;
          out.names = [...realFiles.get.call(file)].map((f) => f.name);
          return out;
        }, domHelpersSource);

        eq(r.value, "写进去了", "V-set-value the value really lands on the input");
        eq(r.valueHijacked, false, "V-set-value-native …written through the prototype setter, past the framework's own accessor");
        eq(r.events.filter((e) => e.startsWith("text:")).length, 0,
          "V-set-value dispatches NOTHING — which events re-read the field is the book's call (learn 2026-09-14)");

        eq(r.names.join(","), "sku.csv,spec.jpg", "V-set-files both files land, in order");
        eq(r.landed, 2, "V-set-files returns how many actually landed, read back from the input");
        eq(r.filesHijacked, false, "V-set-files-native …also written past the framework's accessor");
        eq(r.events.filter((e) => e.startsWith("file:")).join(","), "file:input,file:change",
          "V-set-files fires input THEN change, once each — same as the engine's own upload op");
      },
    );
  }

  // C — challenge detection. The heuristics live ONLY in the resident probe and
  // only feed its events (for the webhook's visual check). Every verdict is a DOM
  // estimate, so bcpDomRuntime — the agent's view — must never carry one.
  await withPage(
    `<body><h1>安全验证</h1><p>请拖动滑块完成验证</p><button id="go">开始验证</button></body>`,
    async (t) => {
      const p = await t.probes();
      eq(!!p.verdict, true, "C1 barren page + challenge keywords is a candidate");
      eq(p.sent[0]?.event?.kind, "captcha_appeared", "C1 the probe pushes captcha_appeared");
      eq(p.sent.length, 1, "C1 install emits exactly one event, not one per signal");
      match(p.sent[0]?.event?.summary, /possible challenge/, "C1 the event summary calls it a candidate");
      const st = await t.call("state", {});
      eq(st.value.captcha, undefined, "C1 page_state carries no challenge estimate");
      const miss = await t.call("click", { text: "不存在的按钮" });
      eq(/risk-control|CAPTCHA/i.test(miss.error ?? ""), false, "C1 a locator miss is not blamed on a challenge estimate");
    },
  );

  await withPage(
    `<body>${"<p>正常的页面内容，足够长，不算贫瘠。</p>".repeat(40)}
       ${'<a href="#">条目</a>'.repeat(15)}
       <div role="dialog"><p>请完成安全验证</p><button id="slide">滑块</button></div></body>`,
    async (t) => {
      const p = await t.probes();
      eq(!!p.verdict, true, "C2 challenge keywords inside a dialog on a REAL page is a candidate");
      const st = await t.call("state", {});
      eq(st.value.captcha, undefined, "C2 page_state carries no challenge estimate");
    },
  );

  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}<div class="g-recaptcha"></div></body>`,
    async (t) => {
      const p = await t.probes();
      match(p.verdict?.evidence?.join("; ") ?? "", /vendor fingerprint: recaptcha/, "C3 a vendor fingerprint names the vendor in its evidence");
    },
  );

  // The two negatives are the point of the threshold — without them the
  // detector could report everything and still look green above.
  await withPage(
    `<body><h1>商品列表</h1>${'<a href="#">条目</a>'.repeat(20)}</body>`,
    async (t) => {
      const p = await t.probes();
      eq(p.verdict, null, "C4 an ordinary page reports no challenge");
      eq(p.sent.length, 0, "C4 …and pushes no event");
      const st = await t.call("state", {});
      eq(st.value.captcha, undefined, "C4 page_state carries no captcha field");
      const miss = await t.call("click", { text: "不存在的按钮" });
      eq(/risk-control interstitial/.test(miss.error ?? ""), false,
        "C4 a normal locator miss is NOT blamed on a challenge");
    },
  );

  await withPage(
    `<body><p>加载中</p></body>`,
    async (t) => {
      const p = await t.probes();
      eq(p.verdict, null, "C5 a barren page with no challenge keywords is NOT reported — one signal is not enough");
    },
  );

  // C6 — the structural fallback: a challenge no fingerprint knows. This is the
  // only branch that can catch a vendor who just shipped a redesign.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}
       <div style="position:fixed;inset:0;background:#fff">
         <canvas width="300" height="150"></canvas><div class="xyz-drag-handle"></div>
       </div></body>`,
    async (t) => {
      const p = await t.probes();
      match(p.verdict?.evidence?.join("; ") ?? "", /viewport-covering layer/, "C6 covering layer + canvas + drag handle is a candidate");
    },
  );

  // C7 — the negative that gives C6 meaning. An image lightbox is ALSO a
  // covering layer with media in it; without the drag handle or the keywords it
  // must not be convicted.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}
       <div style="position:fixed;inset:0;background:#000">
         <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:400px">
       </div></body>`,
    async (t) => {
      const p = await t.probes();
      eq(p.verdict, null, "C7 a lightbox (covering layer + img, no handle, no keywords) is NOT a challenge");
    },
  );

  // C8 — the interactable-COUNT half of `barren` must really discriminate.
  // Dropping it leaves a page-level verdict reachable from one keyword alone,
  // and no other case in this file would notice.
  await withPage(
    `<body><h1>安全验证</h1>${'<a href="#">x</a>'.repeat(30)}</body>`,
    async (t) => {
      const p = await t.probes();
      eq(p.verdict, null, "C8 30 interactables + short text is NOT barren, so one keyword cannot convict");
    },
  );

  // C20 — a fingerprint answers "is the machinery loaded", not "is it in the
  // way". A login form that PRELOADS a hidden slider answers yes to the first
  // and no to the second, and reporting it as an interception makes the agent
  // abandon work that was never blocked.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}
       <div class="yidun_slider" style="display:none"></div></body>`,
    async (t) => {
      const p = await t.probes();
      eq(p.verdict, null, "C20 a preloaded widget nobody can see is not a candidate");
      eq(p.sent.length, 0, "C20 …and pushes no event");
    },
  );

  // C21 — the other half of C20. Downgrading on invisibility must not swallow a
  // challenge that IS on screen; without this, C20 could be satisfied by never
  // reporting high again.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}
       <div class="yidun_slider" style="width:300px;height:40px"></div></body>`,
    async (t) => {
      const p = await t.probes();
      eq(!!p.verdict, true, "C21 a DISPLAYED vendor widget is a candidate");
    },
  );

  // C22 — a hidden fingerprint must not short-circuit structural evidence that
  // scores higher. The vendor branch returns early; if the low verdict were
  // returned there instead of last, this real challenge would report as low.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}
       <div class="yidun_slider" style="display:none"></div>
       <div style="position:fixed;inset:0;background:#fff">
         <canvas width="300" height="150"></canvas><div class="xyz-drag-handle"></div>
       </div></body>`,
    async (t) => {
      const p = await t.probes();
      eq(!!p.verdict, true, "C22 a hidden fingerprint does not swallow a real structural candidate");
    },
  );

  // C23 — the false positive that the url-path vote caused. An ordinary
  // email-verification page is barren AND sits on /verify/: two votes of three,
  // so it was convicted, and the agent was told its last action had not landed.
  // Served from a REAL url — on about:blank this case passes either way.
  await withPage(
    `<body><h1>请查收邮件</h1><p>我们已经发送了一封确认邮件到你的邮箱。</p>
       <a href="#">重新发送</a></body>`,
    async (t) => {
      const p = await t.probes();
      eq(p.verdict, null, "C23 a barren page on /account/verify/ is NOT a challenge without keywords");
      eq(p.sent.length, 0, "C23 …and nobody gets paged about it");
    },
    "https://example.com/account/verify/",
  );

  // C24 — Cloudflare, the most common interstitial on the web. Its pages never
  // say "captcha"; they say these three strings, none of which the keyword set
  // carried before — so it used to read as an ordinary short page.
  await withPage(
    `<body><h1>Just a moment...</h1><p>Checking your browser before accessing.</p></body>`,
    async (t) => {
      const p = await t.probes({ status: 403 });
      eq(!!p.verdict, true, "C24 a Cloudflare interstitial is a candidate");
      match(p.verdict?.evidence?.join("; ") ?? "", /HTTP 403/, "C24 the blocking status is recorded as evidence");
    },
  );

  // C25 — the header convicts alone. Every other signal here is us inferring
  // from appearance; this one is the origin stating it, so it must not need a
  // barren page or a keyword to agree with it.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}<p>看起来完全正常的一页</p></body>`,
    async (t) => {
      const p = await t.probes({ status: 403, cfChallenge: true });
      eq(!!p.verdict, true, "C25 cf-mitigated: challenge convicts on its own");
    },
  );

  // C26 — the negative that gives the status vote its meaning. A plain 403 is
  // barren AND 403; if status could corroborate without a keyword, every
  // permission error on the web would report as risk control.
  await withPage(
    `<body><h1>403 Forbidden</h1><p>nginx</p></body>`,
    async (t) => {
      const p = await t.probes({ status: 403 });
      eq(p.verdict, null, "C26 a plain 403 page is barren and 403, and still NOT a challenge");
    },
  );

  // C27 — and the positive that proves the status vote is load-bearing at all.
  // Rich document, so `barren` is false: keywords alone are deliberately not
  // enough, and only the 503 makes the second signal. Drop that vote and this
  // goes null.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}<h1>访问受限</h1><p>${"内容".repeat(200)}</p></body>`,
    async (t) => {
      const p = await t.probes({ status: 503 });
      eq(!!p.verdict, true, "C27 keywords + a blocking HTTP status convict without a barren page");
    },
  );

  // C28 — ONE challenge that renders in steps is ONE event. A real challenge
  // does not appear fully-formed: the container lands first (keywords in a
  // dialog → medium), the puzzle image arrives while the open animation still
  // covers the viewport (→ high), then the animation settles into a centred
  // card and the covering-layer branch stops matching (→ medium). Keying the
  // dedup on confidence made that three `captcha_appeared`s inside 1s, each
  // pushed with a screenshot of a different half-rendered frame — which is
  // exactly what a human saw on chat.deepseek.com. The verdict must keep
  // tracking the page; only the EVENT is edge-triggered.
  await withPage(
    `<body>${"<p>正常的页面内容，足够长，不算贫瘠。</p>".repeat(40)}
       ${'<a href="#">条目</a>'.repeat(15)}
       <div role="dialog"><p>请完成安全验证</p></div></body>`,
    async (t) => {
      const p = await t.probes();
      eq(!!p.verdict, true, "C28 the container-only frame is a candidate");
      const seq = await t.wait(3000, `(() => {
        const g = globalThis;
        const last = () => (g.__bcpCaptcha?.evidence ?? []).at(-1) ?? null;
        const conf = [last()];
        const ov = document.createElement("div");
        ov.id = "__ov";
        ov.style.cssText = "position:fixed;inset:0;background:#fff";
        ov.innerHTML = '<canvas width="300" height="150"></canvas>';
        document.body.appendChild(ov);
        g.__bcpCheckCaptcha();
        conf.push(last());
        document.getElementById("__ov").remove();
        g.__bcpCheckCaptcha();
        conf.push(last());
        return { conf, kinds: g.__bcpSent.map((m) => m.event?.kind ?? null) };
      })()`);
      // The precondition. If the verdict stopped moving, C28 would pass for the
      // wrong reason — one event because there was only ever one verdict.
      eq(seq.conf[0] !== seq.conf[1] && seq.conf[2] === seq.conf[0], true, `C28 the verdict still tracks every render step (${seq.conf.join(" > ")})`);
      eq(seq.kinds.join(","), "captcha_appeared", "C28 …but the three steps are ONE captcha_appeared");
    },
  );

  // C29 — the negative that gives C28 meaning. Collapsing on the BLOCKED edge
  // must not collapse a genuine second challenge: a human clearing one and
  // getting another (a wrong answer re-issues the puzzle) has to page them
  // again, or the notification silently stops working after the first attempt.
  await withPage(
    `<body>${"<p>正常的页面内容，足够长，不算贫瘠。</p>".repeat(40)}
       ${'<a href="#">条目</a>'.repeat(15)}
       <div id="dlg" role="dialog"><p>请完成安全验证</p></div></body>`,
    async (t) => {
      await t.probes();
      const seq = await t.wait(3000, `(() => {
        const g = globalThis;
        const dlg = document.getElementById("dlg");
        dlg.remove();
        g.__bcpCheckCaptcha();
        document.body.appendChild(dlg);
        g.__bcpCheckCaptcha();
        return g.__bcpSent.map((m) => m.event?.kind ?? null);
      })()`);
      eq(seq.join(","), "captcha_appeared,captcha_cleared,captcha_appeared",
        "C29 clearing and re-issuing a challenge pages the human both times");
    },
  );

  // C9 — the ACTION path. A challenge-shaped layer raised by the action must not
  // reach the agent through that action's delta: it is an estimate (a video
  // player's canvas + progress slider has exactly this shape).
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}<button id="go">继续</button>
       <script>
         document.getElementById('go').addEventListener('click', function () {
           var d = document.createElement('div');
           d.style.cssText = 'position:fixed;inset:0;background:#fff';
           d.innerHTML = '<canvas width="300" height="150"></canvas><div class="drag-bar"></div>';
           document.body.appendChild(d);
         });
       </script></body>`,
    async (t) => {
      await t.probes();
      const r = await t.call("click", { ref: t.ref("go") });
      eq(r.value?.delta?.captchaAppeared, undefined, "C9 an action's delta never carries a challenge estimate");
    },
  );

  // C10 — the vendor rows added from the vendors' own integration docs.
  await withPage(
    `<body>${'<a href="#">项</a>'.repeat(20)}<div class="geetest_holder"></div></body>`,
    async (t) => {
      const p = await t.probes();
      match(p.verdict?.evidence?.join("; ") ?? "", /vendor fingerprint: geetest/, "C10 a geetest_-prefixed class names the vendor");
    },
  );

  // R — evalCheck runs under bcpReadOnlyGuard. Each case drives the REAL guard source in a real page: reads
  // pass, every class of page effect is refused (and the refusal names it), and the page is left exactly as it
  // was — the swapped APIs are restored, so the page's own code keeps working after a refused check.
  {
    const guardSource = bcpReadOnlyGuard.toString();
    await withPage(
      `<form id="f"><input id="i" value="a"><button id="b" type="button">B</button></form>
       <div id="s" style="height:50px;overflow:auto"><div style="height:500px"></div></div>`,
      async () => {
        const run = (body) => page.evaluate(([src, body]) => {
          const guard = new Function(`return (${src})`)()();
          try {
            return { value: guard(new Function(body), body) };
          } catch (e) {
            return { error: String(e instanceof Error ? e.message : e) };
          }
        }, [guardSource, body]);
        const r1 = await run("return document.getElementById('i').value + document.title.length");
        eq(r1.value, "a0", "R1 a read passes and returns its value");
        const refused = [
          ["return document.getElementById('b').click()", /HTMLElement\.click\(\) is not allowed/, "R2 click"],
          ["document.getElementById('i').value = 'x'; return true", /setting HTMLInputElement\.value is not allowed/, "R3 setting an input value"],
          ["document.getElementById('s').scrollTop = 30; return true", /setting Element\.scrollTop is not allowed/, "R4 scrolling a container"],
          ["return document.getElementById('i').focus()", /HTMLElement\.focus\(\) is not allowed/, "R5 focus"],
          ["return document.body.dispatchEvent(new Event('x'))", /EventTarget\.dispatchEvent\(\) is not allowed/, "R6 dispatching an event"],
          ["fetch('/x'); return true", /window\.fetch\(\) is not allowed/, "R7 fetch"],
          ["localStorage.setItem('k', '1'); return true", /Storage\.setItem\(\) is not allowed/, "R8 storage writes"],
          ["history.pushState(null, '', '#x'); return true", /History\.pushState\(\) is not allowed/, "R9 history"],
          ["document.getElementById('b').setAttribute('data-x', '1'); return true", /changed the page \(1 DOM change/, "R10 a DOM write"],
          ["document.body.append('t'); return true", /changed the page/, "R11 inserting a node"],
          ["return Promise.resolve(true)", /must return its result synchronously/, "R12 a Promise result"],
        ];
        for (const [body, want, label] of refused) match((await run(body)).error ?? "(no error)", want, `${label} is refused by the read-only guard`);
        const after = await page.evaluate(() => {
          let clicks = 0;
          const b = document.getElementById("b");
          b.addEventListener("click", () => clicks++);
          b.click();
          document.getElementById("i").value = "z";
          return { clicks, value: document.getElementById("i").value, attr: b.getAttribute("data-x"), fetchIsNative: /\[native code\]/.test(String(window.fetch)) };
        });
        eq(after.clicks, 1, "R13 click works again after a refused check (APIs restored)");
        eq(after.value, "z", "R13 input value setter restored");
        eq(after.attr, "1", "R13 the guard reports a DOM write; it does not undo it");
        eq(after.fetchIsNative, true, "R13 window.fetch restored");
        eq((await run("window.__probe = 1; return window.__probe")).value, 1, "R14 JS heap state is outside the guard (documented boundary)");

        // Nothing may outlive the guarded window: deferred code would run after the APIs are restored.
        await page.evaluate(() => { window.__lateClicks = 0; document.getElementById("b").addEventListener("click", () => window.__lateClicks++); });
        match((await run("(async () => { await 0; document.getElementById('b').click(); })(); return true")).error ?? "(no error)",
          /async \/ await is not allowed/, "R15 async code is refused before it runs");
        const deferred = [
          ["setTimeout(() => document.getElementById('b').click(), 0); return true", /window\.setTimeout\(\) is not allowed/, "R16 setTimeout"],
          ["queueMicrotask(() => document.getElementById('b').click()); return true", /window\.queueMicrotask\(\) is not allowed/, "R17 queueMicrotask"],
          ["Promise.resolve().then(() => document.getElementById('b').click()); return true", /Promise\.then\(\) is not allowed/, "R18 a promise callback"],
          ["requestAnimationFrame(() => document.getElementById('b').click()); return true", /requestAnimationFrame\(\) is not allowed/, "R19 requestAnimationFrame"],
        ];
        for (const [body, want, label] of deferred) match((await run(body)).error ?? "(no error)", want, `${label} is refused by the read-only guard`);
        await page.waitForTimeout(50);
        eq(await page.evaluate(() => window.__lateClicks), 0, "R20 no deferred click ever happened");
        eq((await run("return 'await approval'.length")).value, 14, "R21 'await' inside a string is not mistaken for async code");

        const before = await page.evaluate(() => location.href);
        match((await run("location.hash = 'x'; return true")).error ?? "(no error)", /navigating to .*#x is not allowed/, "R22 location.hash navigation is refused");
        match((await run("location.assign('/elsewhere'); return true")).error ?? "(no error)", /navigating to .*\/elsewhere is not allowed/, "R23 location.assign is refused");
        await page.waitForTimeout(200);
        eq(await page.evaluate(() => location.href), before, "R24 a refused navigation did not happen");
        match((await run("localStorage.k = '1'; return true")).error ?? "(no error)", /writing localStorage is not allowed/, "R25 a storage property write is refused");
        eq(await page.evaluate(() => localStorage.getItem("k")), null, "R25 nothing was stored");
        match((await run("indexedDB.open('x'); return true")).error ?? "(no error)", /IDBFactory\.open\(\) is not allowed/, "R26 IndexedDB is refused");
        eq((await run("return localStorage.getItem('missing') === null && sessionStorage.length >= 0")).value, true, "R27 storage reads still work");
        eq(await page.evaluate(() => new Promise((r) => setTimeout(() => r("ran"), 0))), "ran", "R28 timers work again after the check");
      },
      "https://guard.test/",
    );
  }

  await browser.close();

  // ----------------------------------------------------------------- report
  if (failures.length) {
    console.error(`\ndom-runtime-check: ${failures.length} FAILED, ${passed} passed\n`);
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    process.exit(1);
  }
  console.log(`dom-runtime-check: ${passed} passed`);
}

main().catch((err) => {
  console.error("dom-runtime-check: harness error\n", err);
  process.exit(2);
});
