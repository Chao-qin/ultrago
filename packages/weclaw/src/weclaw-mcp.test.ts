import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveRecipient } from "./weclaw-mcp.js";

test("uses an explicit recipient before the configured default", () => {
  assert.equal(
    resolveRecipient("o-explicit@im.wechat", "o-default@im.wechat"),
    "o-explicit@im.wechat",
  );
});

test("uses the configured default when the caller omits a recipient", () => {
  assert.equal(resolveRecipient(undefined, "o-default@im.wechat"), "o-default@im.wechat");
});

test("rejects sends without an explicit or configured recipient", () => {
  assert.throws(
    () => resolveRecipient(undefined, undefined),
    /No WeChat recipient configured/,
  );
});
