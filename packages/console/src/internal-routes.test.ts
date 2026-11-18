import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 接线普查：每一个 `/internal/*` 摄入口都必须在 main.ts 里显式挂 body parser。
 *
 * 这条测试的存在有一个具体的事故：`/internal/llm-calls/hook` 加上去时忘了挂，
 * 于是 `@Body()` 拿到 `{}`，每条调用日志都落成一行默认值——channel 变
 * "(unrouted)"、耗时 null、token null——**而且全程没有任何报错**。摄入端是
 * fire-and-forget，对面连一行 warn 都不会打；页面上看到的是"有记录、但内容
 * 全是空的"，要盯着看才发现不对。
 *
 * 为什么不能靠 controller 测试挡住：那些测试用 `NestFactory.create(TestModule)`
 * 起的是**默认 app**，自带全局 body parser，所以它们在 main.ts 漏挂的情况下
 * 照样全绿。真正的差异只存在于生产的按路径挂载里。
 *
 * 为什么是静态检查而不是起真 app：main.ts 是个会 listen 的 bootstrap 脚本，
 * 端口、静态资源、数据库全都要真的在。而这里要防的东西——"新加了摄入口却忘了
 * 挂 parser"——完全是接线层面的，源码就看得见。
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

test("每个 /internal/* controller 都在 main.ts 里挂了 body parser", () => {
  const prefixes = new Set<string>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/@Controller\(\s*["'`](internal\/[^"'`]+)["'`]/g)) {
      // 只取第一段：main.ts 是按前缀挂的（express 的 use 按段匹配）。
      prefixes.add(m[1].split("/").slice(0, 2).join("/"));
    }
  }
  assert.ok(prefixes.size > 0, "一个 /internal 控制器都没找到，说明这条普查搜错了地方");

  const main = readFileSync(join(SRC, "main.ts"), "utf8");
  const missing = [...prefixes].filter(
    (prefix) => !new RegExp(`app\\.use\\(\\s*["'\`]/${prefix}["'\`]`).test(main),
  );
  assert.deepEqual(
    missing,
    [],
    `这些摄入口没有在 main.ts 里挂 body parser，@Body() 会拿到 {}：${missing.join(", ")}`,
  );
});
