import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, anchored on this file's own location the way
 *  flow-runner.service.ts does it. `src/settings/` and `dist/settings/` sit at
 *  the same depth, so a single expression is right under `tsx watch src` and
 *  under `node dist/main.js` alike — unlike `process.cwd()`, which differs
 *  depending on where the console was launched from. */
export const MONOREPO_ROOT = path.resolve(__dirname, "../../../..");

/** One runnable package.json script. */
export interface ScriptEntry {
  /** Repo-relative directory of the owning package; "." for the monorepo root. */
  dir: string;
  /** package.json "name" — the label the UI groups by. */
  pkg: string;
  script: string;
  /** The raw right-hand side from package.json, shown so you can see what a
   *  name actually does before pressing the button. */
  raw: string;
  /** What we would actually spawn, argv-style (no shell). */
  command: string[];
  danger: boolean;
  /** Why it is dangerous, in one sentence. Empty for safe scripts. This is the
   *  text of the confirm dialog, so it has to say what will happen, not that
   *  something will. */
  reason: string;
  /** True when running this script kills or restarts the console that is
   *  serving the page you pressed the button on. Such a run cannot stream its
   *  output back over its own HTTP connection, so it is detached to a log file
   *  instead. See ScriptRunnerService. */
  detach: boolean;
}

export interface ScriptRegistry {
  entries: ScriptEntry[];
  /** Workspace patterns this parser could not expand, and package.json files
   *  it could not read. Reported rather than dropped: a pattern we don't
   *  understand should look like a gap, not like a package that isn't there. */
  warnings: string[];
}

/**
 * Scripts that need a confirmation before they run, keyed by repo-relative
 * directory then script name. Anything absent from this table is treated as
 * safe — the table is an explicit list rather than a heuristic on the command
 * text, because "does this restart the thing I'm talking to" is not something
 * a regex over `bash scripts/backend.sh kill` should be deciding.
 */
export const DANGER_SCRIPTS: Record<string, Record<string, { reason: string; detach: boolean }>> = {
  ".": {
    kill: { reason: "执行 backend.sh kill，会把正在服务本页面的 console 一起杀掉。", detach: true },
    restart: { reason: "先 kill 再 start：console 会在执行途中被杀掉，然后由新进程重新拉起。", detach: true },
    start: { reason: "先 pnpm build 再 backend.sh start，会回收现有 stack（含本 console）并重启。", detach: true },
    "start:no-weclaw": { reason: "同 start，只是跳过 weclaw：会回收并重启现有 stack（含本 console）。", detach: true },
    dev: { reason: "backend.sh dev 会接管 8787 / 8788 / 8790 端口，与正在运行的 console 冲突。", detach: true },
  },
  "packages/console": {
    start: { reason: "会再起一个 console 进程去抢占同一个端口。", detach: true },
    dev: { reason: "会再起一套 console（web + api）去抢占同一个端口。", detach: true },
    "dev:api": { reason: "会再起一个 console API 进程去抢占同一个端口。", detach: true },
    "prisma:migrate": { reason: "prisma migrate dev 会修改 console 数据库的结构。", detach: false },
    "prisma:deploy": { reason: "会把尚未应用的迁移写进 console 数据库。", detach: false },
  },
  "packages/llm": {
    stop: { reason: "停掉本地 LLM 运行时，依赖它的 flow / book 会开始失败。", detach: false },
    migrate: { reason: "迁移模型，并可能删除迁移前的旧模型。", detach: false },
    setup: { reason: "下载并安装模型，耗时很长且占用大量磁盘。", detach: false },
  },
  "packages/weclaw": {
    "install:bin": { reason: "下载并覆盖 weclaw 二进制（覆盖的是上游原版，不含 external_delivery 补丁）。", detach: false },
    "update:bin": { reason: "下载并覆盖 weclaw 二进制。", detach: false },
  },
};

/**
 * Expand `pnpm-workspace.yaml` into repo-relative package directories.
 *
 * Deliberately not a YAML parser: this file's `packages:` list is a flat
 * sequence of quoted strings, and the two pattern shapes it uses (a literal
 * path and a trailing `/*`) are the two handled here. Anything else comes back
 * as a warning instead of being silently skipped — the failure mode we can't
 * afford is a package quietly missing from the panel.
 *
 * The monorepo root is always included even though it is not a workspace
 * member: its package.json holds the scripts people reach for most.
 */
export function workspaceDirs(root: string): { dirs: string[]; warnings: string[] } {
  const dirs = ["."];
  const warnings: string[] = [];
  const file = path.join(root, "pnpm-workspace.yaml");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    warnings.push(`读不到 pnpm-workspace.yaml，只列出仓库根的脚本：${e instanceof Error ? e.message : String(e)}`);
    return { dirs, warnings };
  }

  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    // A non-indented, non-item line ends the sequence.
    if (!item) {
      if (line.trim() === "" || line.startsWith(" ")) continue;
      break;
    }
    const pattern = item[1].replace(/^["']|["']$/g, "");
    if (!pattern.includes("*")) {
      if (hasPackageJson(root, pattern)) dirs.push(pattern);
      continue;
    }
    if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
      const parent = pattern.slice(0, -2);
      let names: string[];
      try {
        names = readdirSync(path.join(root, parent)).sort();
      } catch {
        warnings.push(`workspace 模式「${pattern}」的目录读不到，已跳过`);
        continue;
      }
      for (const name of names) {
        const dir = `${parent}/${name}`;
        if (statSync(path.join(root, dir)).isDirectory() && hasPackageJson(root, dir)) dirs.push(dir);
      }
      continue;
    }
    warnings.push(`workspace 模式「${pattern}」这个解析器不认识（只支持字面路径和结尾的 /*），该模式下的包不会出现在本页`);
  }
  return { dirs, warnings };
}

function hasPackageJson(root: string, dir: string): boolean {
  return existsSync(path.join(root, dir, "package.json"));
}

/**
 * How we invoke one script. Workspace members go through `--filter <name>`,
 * which is the same way the root package.json delegates to them; the root's
 * own scripts are a plain `pnpm run` with cwd at the root. Both spawn with
 * cwd = MONOREPO_ROOT, so no caller has to reason about where it started.
 */
export function commandFor(dir: string, pkg: string, script: string): string[] {
  return dir === "." ? ["pnpm", "run", script] : ["pnpm", "--filter", pkg, "run", script];
}

/** Read every workspace package.json and flatten its scripts into one list. */
export function readRegistry(root: string = MONOREPO_ROOT): ScriptRegistry {
  const { dirs, warnings } = workspaceDirs(root);
  const entries: ScriptEntry[] = [];
  for (const dir of dirs) {
    let pkgJson: { name?: string; scripts?: Record<string, string> };
    try {
      pkgJson = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")) as typeof pkgJson;
    } catch (e) {
      warnings.push(`${dir}/package.json 读不到或不是合法 JSON，已跳过：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const pkg = pkgJson.name ?? dir;
    for (const [script, raw] of Object.entries(pkgJson.scripts ?? {})) {
      const risk = DANGER_SCRIPTS[dir]?.[script];
      entries.push({
        dir,
        pkg,
        script,
        raw,
        command: commandFor(dir, pkg, script),
        danger: risk !== undefined,
        reason: risk?.reason ?? "",
        detach: risk?.detach ?? false,
      });
    }
  }
  return { entries, warnings };
}

/** Look one entry up for execution. Returns null when the caller named a
 *  script that is not in any workspace package.json — the run endpoint refuses
 *  rather than spawning whatever it was handed. */
export function findEntry(registry: ScriptRegistry, dir: string, script: string): ScriptEntry | null {
  return registry.entries.find((e) => e.dir === dir && e.script === script) ?? null;
}
