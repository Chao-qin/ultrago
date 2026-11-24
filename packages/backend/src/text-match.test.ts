/**
 * The one way text is compared (query, the plan verifiers, pick_option — and, by a copy, the page runtime's
 * locators and wait_for). check:dom runs TEXT_CASES against the runtime's copy too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGrade, normalizeText, TEXT_MATCH_CASES as TEXT_CASES } from "@bcp/shared";
import { renderSnapshotView } from "./browser-mcp-render.js";

test("规范化：大小写、各种空白（含不换行空格）、零宽字符都折叠", () => {
  for (const [raw, want] of TEXT_CASES) assert.equal(normalizeText(raw), want, JSON.stringify(raw));
});

test("分档：完全相等 > 整段出现 > 每个词都出现（任意顺序）；空的期望什么也不匹配", () => {
  assert.equal(matchGrade("Save  Draft", "save draft"), "exact");
  assert.equal(matchGrade("Save draft now", "save draft"), "substring");
  assert.equal(matchGrade("15.2.0 for aarch64-apple-darwin", "aarch64 15.2.0"), "words");
  assert.equal(matchGrade("ripgrep", "rip grep x"), undefined);
  assert.equal(matchGrade("任何东西", "​ "), undefined, "空的期望不是证据");
});

test("query 按档排序、不删减：名字完全相等的排在只是包含它的前面；多个词任意顺序命中", () => {
  const els = [
    { ref: "e1", tag: "a", role: "link", name: "Save draft and continue" },
    { ref: "e2", tag: "button", role: "button", name: "Save Draft" },
    { ref: "e3", tag: "a", role: "link", name: "Draft: save later" },
  ] as never;
  assert.deepEqual(renderSnapshotView(els, { query: "save draft" }).shown, ["e2", "e1", "e3"]);
});
