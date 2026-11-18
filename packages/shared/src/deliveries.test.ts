import { test } from "node:test";
import assert from "node:assert/strict";
import { DELIVERY_DEFAULTS, normalizeDelivery, normalizeDeliveries, resolveDeliveries, type Delivery } from "./deliveries.js";

test("缺省 on 填 success", () => {
  const [d] = resolveDeliveries([{ kind: "print" }]);
  assert.equal(d.on, "success");
});

test("file delivery resolves artifact", () => {
  const [d] = resolveDeliveries([{ kind: "file", artifact: "{{outFile}}" }]);
  assert.equal(d.on, "success");
  assert.deepEqual(d, { kind: "file", artifact: "{{outFile}}", on: "success" });
});

test("print 缺省 format = markdown", () => {
  const [d] = resolveDeliveries([{ kind: "print" }]);
  if (d.kind === "print") assert.equal(d.format, "markdown");
});

test("file delivery preserves explicit gate", () => {
  const [d] = resolveDeliveries([{ kind: "file", artifact: "x.md", on: "failure" }]);
  assert.equal(d.on, "failure");
  assert.deepEqual(d, { kind: "file", artifact: "x.md", on: "failure" });
});

test("空 / undefined 返回空数组", () => {
  assert.deepEqual(resolveDeliveries(undefined), []);
  assert.deepEqual(resolveDeliveries([]), []);
});

test("message / webhook 的默认值只来自 shared resolver", () => {
  const [m] = resolveDeliveries([{ kind: "message" }]);
  assert.deepEqual(m, { kind: "message", channel: "wechat", template: DELIVERY_DEFAULTS.message.template, on: "success" });

  const [w] = resolveDeliveries([{ kind: "webhook", url: "https://x" }]);
  assert.deepEqual(w, { kind: "webhook", url: "https://x", method: "POST", on: "success" });
});

test("cancelled 显式保留", () => {
  const [d] = resolveDeliveries([{ kind: "print", on: "cancelled" }]);
  assert.equal(d.on, "cancelled");
});

test("不修改入参(纯函数)", () => {
  const input: Delivery[] = [{ kind: "print" }];
  resolveDeliveries(input);
  assert.equal(input[0].on, undefined);
});

test("默认值常量自洽", () => {
  assert.equal(DELIVERY_DEFAULTS.on, "success");
  assert.equal(DELIVERY_DEFAULTS.print.format, "markdown");
});

test("legacy file.path is normalized once to canonical artifact", () => {
  assert.deepEqual(normalizeDelivery({ kind: "file", path: "report.md", overwrite: "overwrite" }), {
    kind: "file",
    artifact: "report.md",
    on: "success",
  });
});

test("delivery normalization strips legacy and unknown fields", () => {
  assert.deepEqual(normalizeDelivery({ kind: "file", artifact: "report.md", path: "ignored.md", overwrite: "error", extra: true }), {
    kind: "file",
    artifact: "report.md",
    on: "success",
  });
  assert.deepEqual(normalizeDeliveries([{ kind: "webhook", url: "https://example.com", extra: true }]), [
    { kind: "webhook", url: "https://example.com", on: "success", method: "POST" },
  ]);
});

test("delivery normalization rejects invalid conclusion and kind fields", () => {
  assert.throws(() => normalizeDelivery({ kind: "print", on: "done" }), /on is invalid/);
  assert.throws(() => normalizeDelivery({ kind: "message", template: 1 }), /template is invalid/);
});
