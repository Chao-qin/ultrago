/**
 * Challenge detection never reaches the driving agent.
 *
 * Every challenge verdict is a DOM estimate — a Douyin video page's player
 * (background <canvas> + progress `xgplayer-slider`) scored as a slider puzzle
 * at "high", and the agent, told "⚠ confirmed, do NOT retry, tell the user",
 * abandoned a page nothing was blocking. So the estimate only feeds the event
 * webhook (which confirms it visually); the agent-facing text carries none of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { BROWSER_INSTRUCTIONS } from "./browser-mcp-instructions.js";
import { deltaGate } from "./browser-mcp-render.js";

test("instructions 不再对 LLM 讲验证码", () => {
  assert.doesNotMatch(BROWSER_INSTRUCTIONS, /captcha/i);
  assert.doesNotMatch(BROWSER_INSTRUCTIONS, /challenge/i);
});

test("人工接管只依据页面自己的文字，不依据检测结论", () => {
  // The agent is told what to do when the PAGE asks the user to prove they are human — a statement it reads
  // itself — and explicitly not to infer that from a slider or canvas, the shape that misled it on Douyin.
  assert.match(BROWSER_INSTRUCTIONS, /ask the user to prove they are human/);
  assert.match(BROWSER_INSTRUCTIONS, /Go by what the page itself says; a slider, video progress bar or canvas on its own is not such a request/);
});

test("deltaGate 的其它门禁照旧", () => {
  assert.equal(deltaGate({}), null);
  assert.ok(deltaGate({ dialogsOpened: 1 }), "弹窗仍须触发 gate");
  assert.ok(deltaGate({ newErrors: ["x"] }), "新报错仍须触发 gate");
  assert.ok(deltaGate({ scrollLocked: true }), "滚动锁定仍须触发 gate");
});

test("Chrome 不渲染被遮挡的窗口时，page_state 直接说出原因与修法", async () => {
  const { renderPageState, renderingStalled } = await import("./browser-mcp-render.js");
  const base = {
    url: "https://x/", title: "t", readyState: "complete", loading: false, interactableCount: 3,
    scroll: { y: 0, height: 100, viewport: 100, moreBelow: false, moreAbove: false },
    focus: { focused: false }, forms: { controls: 0, filled: 0, emptyRequired: 0, invalid: 0, dirty: 0 },
    dialogs: 0, scrollLocked: false, overlay: false, busy: 0, errorCount: 0, tabId: 1, active: true,
  } as never;
  assert.equal(renderingStalled({ ...(base as object), framesStalled: true } as never), true, "页面自称可见却没有动画帧");
  assert.equal(renderingStalled({ ...(base as object), documentHidden: true, windowState: "normal" } as never), true, "未最小化的活动标签页却是 hidden");
  assert.equal(renderingStalled({ ...(base as object), documentHidden: true, windowState: "minimized" } as never), false, "最小化本来就不渲染");
  assert.equal(renderingStalled({ ...(base as object), documentHidden: true, active: false, windowState: "normal" } as never), false, "后台标签页本来就不渲染");
  const out = renderPageState({ ...(base as object), framesStalled: true } as never);
  assert.match(out, /NOT rendering this window/);
  assert.match(out, /--disable-backgrounding-occluded-windows/);
  assert.doesNotMatch(renderPageState(base), /NOT rendering/);
});
