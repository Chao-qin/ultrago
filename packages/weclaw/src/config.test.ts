import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readDefaultRecipient } from "./config.js";

test("reads the default recipient from the user config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "weclaw-config-"));
  try {
    await writeFile(
      path.join(directory, "user.json"),
      JSON.stringify({ default_recipient: "  o-user@im.wechat  " }),
    );

    assert.equal(readDefaultRecipient(directory), "o-user@im.wechat");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats a missing or empty default recipient as unset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "weclaw-config-"));
  try {
    assert.equal(readDefaultRecipient(directory), undefined);
    await writeFile(path.join(directory, "user.json"), JSON.stringify({ default_recipient: "  " }));
    assert.equal(readDefaultRecipient(directory), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
