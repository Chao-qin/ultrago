import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { desktopPolicyGuard, desktopRefusal } from "./desktop-policy.js";

function withDesktop(value: string | undefined, run: () => void): void {
  const saved = process.env.BCP_DESKTOP;
  if (value === undefined) delete process.env.BCP_DESKTOP; else process.env.BCP_DESKTOP = value;
  try { run(); } finally {
    if (saved === undefined) delete process.env.BCP_DESKTOP; else process.env.BCP_DESKTOP = saved;
  }
}

test("the desktop build refuses settings and model-admin writes even to a caller holding its token", () => {
  withDesktop("1", () => {
    for (const [method, path] of [
      ["POST", "/api/settings/scripts/run"], ["PUT", "/api/settings/env"], ["GET", "/api/settings/env/reveal"],
      ["GET", "/API/Settings/env"], ["PUT", "/api/llm/admin/channels"], ["POST", "/api/llm/admin/keys"],
      ["DELETE", "/api/LLM/Admin/keys/k1"], ["HEAD", "/api/llm/admin"],
    ]) assert.ok(desktopRefusal(method, path), `${method} ${path} 应被拒绝`);
    for (const [method, path] of [["GET", "/api/llm/admin"], ["GET", "/api/llm/admin/runtime"], ["POST", "/api/runs"], ["GET", "/api/llm-calls"]]) {
      assert.equal(desktopRefusal(method, path), undefined, `${method} ${path} 应放行`);
    }
  });
});

test("outside the desktop build nothing is refused here", () => {
  withDesktop(undefined, () => {
    assert.equal(desktopRefusal("PUT", "/api/settings/env"), undefined);
    assert.equal(desktopRefusal("POST", "/api/llm/admin/keys"), undefined);
  });
});

test("the console mounts the refusal right after the desktop token check, before any route", () => {
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(main, /app\.use\(desktopHttpGuard\);\s*app\.use\(desktopPolicyGuard\);/, "main.ts 没有挂上 desktopPolicyGuard");
});

test("through real Express routing, refused requests never reach the settings or admin handlers", async () => {
  const reached: string[] = [];
  const app = express();
  app.use(desktopPolicyGuard);
  app.all("/api/settings/env", (req, res) => { reached.push(`${req.method} ${req.path}`); res.json({}); });
  app.all("/api/llm/admin/channels", (req, res) => { reached.push(`${req.method} ${req.path}`); res.json({}); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = process.env.BCP_DESKTOP;
  process.env.BCP_DESKTOP = "1";
  try {
    for (const [method, path] of [["PUT", "/api/settings/env"], ["GET", "/API/SETTINGS/env"], ["PUT", "/api/settings/env/"], ["PUT", "/api/settings/env?x=1"], ["PUT", "/api/llm/admin/channels"], ["PUT", "/Api/Llm/Admin/Channels"]]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 409, `${method} ${path}`);
    }
    assert.equal((await fetch(`${base}/api/llm/admin/channels`)).status, 200, "只读照常");
    assert.deepEqual(reached, ["GET /api/llm/admin/channels"], "被拒的请求一个都没进处理函数");
  } finally {
    if (saved === undefined) delete process.env.BCP_DESKTOP; else process.env.BCP_DESKTOP = saved;
    await new Promise((resolve) => server.close(resolve));
  }
});
