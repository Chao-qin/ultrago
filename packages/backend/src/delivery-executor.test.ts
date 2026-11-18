import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalMethod } from "@bcp/shared";
import { extractArtifacts, extractOutputs, instantiateDeliveries } from "./delivery-executor.js";
import { resolve } from "node:path";

test("extractArtifacts keeps report ownership inside reports and permits dot-prefixed filenames", () => {
  const results = ["reports/report.md", "reports/..report.md", "reports/子目录/商品.json", "reports-other/outside.md", "outside.md", "reports"].map((file, index) => ({ index, goal: "fixture", method: LocalMethod.WriteFile, value: { path: resolve(file) } }));
  assert.deepEqual(extractArtifacts(results).map((item) => item.path), ["report.md", "..report.md", "子目录/商品.json"]);
  if (process.platform === "win32") {
    const differentDrive = process.cwd().startsWith("D:") ? "C:" : "D:";
    assert.deepEqual(extractArtifacts([{ index: 0, goal: "fixture", method: LocalMethod.WriteFile, value: { path: `${differentDrive}\\outside.md` } }]), []);
  }
});

test("instantiateDeliveries: 填充 {{slot}} 并补默认 on", () => {
  const [d] = instantiateDeliveries([{ kind: "file", artifact: "{{outFile}}" }], { outFile: "x.md" });
  assert.equal(d.on, "success");
  if (d.kind === "file") assert.equal(d.artifact, "x.md");
});

test("instantiateDeliveries: webhook url 填充", () => {
  const [d] = instantiateDeliveries([{ kind: "webhook", url: "{{hookUrl}}", on: "failure" }], { hookUrl: "https://x" });
  assert.equal(d.on, "failure");
  if (d.kind === "webhook") assert.equal(d.url, "https://x");
});

test("instantiateDeliveries: legacy file.path is normalized before slot filling", () => {
  const [delivery] = instantiateDeliveries([{ kind: "file", path: "{{outFile}}" } as never], { outFile: "report.md" });
  assert.deepEqual(delivery, { kind: "file", artifact: "report.md", on: "success" });
});

test("instantiateDeliveries: 空/undefined 返回空数组", () => {
  assert.deepEqual(instantiateDeliveries(undefined, {}), []);
  assert.deepEqual(instantiateDeliveries([], {}), []);
});

test("extractOutputs: 取最后一个 local.eval 的值", () => {
  const results = [
    { index: 0, goal: "g", method: LocalMethod.Eval, value: "first" },
    { index: 1, goal: "g", method: "browser.snapshot", value: { x: 1 } },
    { index: 2, goal: "g", method: LocalMethod.Eval, value: "last markdown" },
  ];
  assert.equal(extractOutputs(results), "last markdown");
});

test("extractOutputs: 无 local.eval 返回 undefined", () => {
  assert.equal(extractOutputs([]), undefined);
  assert.equal(extractOutputs([{ index: 0, goal: "g", method: "browser.snapshot", value: {} }]), undefined);
});
