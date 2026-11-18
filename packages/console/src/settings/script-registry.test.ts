import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DANGER_SCRIPTS,
  MONOREPO_ROOT,
  commandFor,
  findEntry,
  readRegistry,
  workspaceDirs,
} from "./script-registry.js";

/** Build a throwaway repo shaped like this one. */
function fixture(workspaceYaml: string, packages: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "bcp-registry-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), workspaceYaml, "utf8");
  for (const [dir, pkg] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg), "utf8");
  }
  return root;
}

test("workspace 展开：字面路径 + 结尾 /*，且总是含仓库根", () => {
  const root = fixture('packages:\n  - "packages/*"\n  - "packages/console/web"\n', {
    ".": { name: "root" },
    "packages/a": { name: "@x/a" },
    "packages/b": { name: "@x/b" },
    "packages/console": { name: "@x/console" },
    "packages/console/web": { name: "@x/console-web" },
  });
  try {
    const { dirs, warnings } = workspaceDirs(root);
    assert.deepEqual(dirs, [".", "packages/a", "packages/b", "packages/console", "packages/console/web"]);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packages/* 下没有 package.json 的目录不算包", () => {
  const root = fixture('packages:\n  - "packages/*"\n', { ".": { name: "root" }, "packages/real": { name: "@x/real" } });
  mkdirSync(join(root, "packages/not-a-package"), { recursive: true });
  try {
    assert.deepEqual(workspaceDirs(root).dirs, [".", "packages/real"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("不认识的模式要出现在 warnings 里 —— 静默丢包等于面板在说谎", () => {
  const root = fixture('packages:\n  - "apps/**/pkg"\n', { ".": { name: "root" } });
  try {
    const { dirs, warnings } = workspaceDirs(root);
    assert.deepEqual(dirs, ["."]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /apps\/\*\*\/pkg/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读不到 pnpm-workspace.yaml 时也说出来，而不是只回一个根包装作没事", () => {
  const root = mkdtempSync(join(tmpdir(), "bcp-registry-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root" }), "utf8");
  try {
    const { dirs, warnings } = workspaceDirs(root);
    assert.deepEqual(dirs, ["."]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /pnpm-workspace\.yaml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("坏掉的 package.json 是一条 warning，不是一个抛出去的 500", () => {
  const root = fixture('packages:\n  - "packages/*"\n', { ".": { name: "root", scripts: { a: "echo a" } } });
  mkdirSync(join(root, "packages/broken"), { recursive: true });
  writeFileSync(join(root, "packages/broken/package.json"), "{ not json", "utf8");
  try {
    const reg = readRegistry(root);
    assert.deepEqual(reg.entries.map((e) => e.script), ["a"]);
    assert.equal(reg.warnings.length, 1);
    assert.match(reg.warnings[0], /packages\/broken/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("命令：根用 pnpm run，workspace 成员用 --filter <包名>", () => {
  assert.deepEqual(commandFor(".", "ultrago", "build"), ["pnpm", "run", "build"]);
  assert.deepEqual(commandFor("packages/console", "@bcp/console", "build"), [
    "pnpm",
    "--filter",
    "@bcp/console",
    "run",
    "build",
  ]);
});

test("findEntry 认不出的脚本返回 null —— run 接口靠它拒绝，而不是拿请求体去 spawn", () => {
  const reg = readRegistry(MONOREPO_ROOT);
  assert.equal(findEntry(reg, ".", "build")?.script, "build");
  assert.equal(findEntry(reg, ".", "definitely-not-a-script"), null);
  assert.equal(findEntry(reg, "../../etc", "build"), null);
});

// ── 危险分类：靠的是真仓库，因为这张表的 key 必须和磁盘上的真实名字对得上 ──

test("本仓库真实脚本的危险分类", () => {
  const reg = readRegistry(MONOREPO_ROOT);
  const look = (dir: string, script: string) => {
    const e = findEntry(reg, dir, script);
    assert.ok(e, `${dir} 里应该有 ${script}`);
    return e;
  };
  // 会杀掉 console 自己的 → danger + detach
  for (const s of ["kill", "restart", "start", "start:no-weclaw", "dev"]) {
    const e = look(".", s);
    assert.equal(e.danger, true, `${s} 该是 danger`);
    assert.equal(e.detach, true, `${s} 该 detach`);
    assert.notEqual(e.reason, "", `${s} 该给出理由`);
  }
  // 改数据库结构的 → danger，但不 detach（它不动 console 进程）
  const migrate = look("packages/console", "prisma:migrate");
  assert.equal(migrate.danger, true);
  assert.equal(migrate.detach, false);
  // 普通的 → safe
  for (const [dir, s] of [[".", "typecheck"], [".", "test"], ["packages/console", "build"]] as const) {
    const e = look(dir, s);
    assert.equal(e.danger, false, `${dir} ${s} 不该是 danger`);
    assert.equal(e.detach, false);
    assert.equal(e.reason, "");
  }
});

test("DANGER_SCRIPTS 里的每一条都指向真实存在的脚本 —— 脚本被改名时这条会红，而不是悄悄没了护栏", () => {
  const reg = readRegistry(MONOREPO_ROOT);
  const missing: string[] = [];
  for (const [dir, scripts] of Object.entries(DANGER_SCRIPTS)) {
    for (const script of Object.keys(scripts)) {
      if (!findEntry(reg, dir, script)) missing.push(`${dir}:${script}`);
    }
  }
  assert.deepEqual(missing, [], "危险表里有脚本在 package.json 里已经不存在了");
});

test("本仓库读出来的就是 workspace 中的包，且每个脚本都带得出可执行 argv", () => {
  const reg = readRegistry(MONOREPO_ROOT);
  assert.deepEqual(reg.warnings, []);
  const pkgs = [...new Set(reg.entries.map((e) => e.pkg))].sort();
  assert.deepEqual(pkgs, [
     "@bcp/backend",
     "@bcp/comfyui",
     "@bcp/console",
    "@bcp/console-web",
    "@bcp/desktop",
    "@bcp/extension",
    "@bcp/llm",
    "@bcp/shared",
    "@bcp/weclaw",
    "ultrago",
  ]);
  for (const e of reg.entries) {
    assert.equal(e.command[0], "pnpm");
    assert.equal(e.command[e.command.length - 1], e.script);
  }
});
