import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { LoopbackGuard, isLoopbackAddress } from "./loopback.guard.js";

function ctxFor(req: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

test("本机地址的各种写法都放行", () => {
  for (const addr of ["127.0.0.1", "127.0.0.53", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(addr), true, addr);
  }
});

test("局域网 / 公网 / 空 / 乱七八糟的地址一律不放行", () => {
  for (const addr of [
    "192.168.1.5",
    "10.0.0.1",
    "172.16.0.1",
    "0.0.0.0",
    "::ffff:192.168.1.5",
    "128.0.0.1",
    "27.0.0.1",
    "127.0.0.256",
    "1270.0.0.1",
    "localhost",
    "",
  ]) {
    assert.equal(isLoopbackAddress(addr), false, addr);
  }
});

test("guard 放行本机 socket", () => {
  assert.equal(new LoopbackGuard().canActivate(ctxFor({ socket: { remoteAddress: "127.0.0.1" } })), true);
});

test("guard 拒绝远端 socket，并在消息里说清是哪个来源", () => {
  assert.throws(
    () => new LoopbackGuard().canActivate(ctxFor({ socket: { remoteAddress: "192.168.1.20" } })),
    /192\.168\.1\.20/,
  );
});

test("看的是 socket 的对端，不是 req.ip —— req.ip 在 trust proxy 打开时由 X-Forwarded-For 派生，可伪造", () => {
  // 远端连进来，却自称 127.0.0.1：放行了就等于这道门可以用一个 header 绕过
  assert.throws(
    () => new LoopbackGuard().canActivate(ctxFor({ ip: "127.0.0.1", socket: { remoteAddress: "203.0.113.9" } })),
    /203\.0\.113\.9/,
  );
  // 反过来：真的本机连接，即使 req.ip 被代理头写成外网地址，也照样放行
  assert.equal(
    new LoopbackGuard().canActivate(ctxFor({ ip: "203.0.113.9", socket: { remoteAddress: "::ffff:127.0.0.1" } })),
    true,
  );
});

test("拿不到 socket 时按拒绝算 —— 判不出来源就不该给执行权", () => {
  assert.throws(() => new LoopbackGuard().canActivate(ctxFor({})), /只允许本机调用/);
});
