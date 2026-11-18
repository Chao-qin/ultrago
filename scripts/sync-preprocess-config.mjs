#!/usr/bin/env node
/**
 * 把仓库里的 preprocess 配置对齐到 console 的那条 SchemaRecord。
 *
 * WHY THIS EXISTS
 * `register-schemas.mjs` 是 BOOTSTRAP：它只在「该 name 一条有效记录都没有」时，用
 * `product-preprocess-config.example.json` 建一条初始记录。所以那份文件改过之后，
 * **已经有记录的机器（任何跑过一段时间的机器）不会更新** —— 配置于是分裂成
 * 「仓库里的一份」和「DB 里的一份」，而运行时只认 DB 那份（`applyPreprocessConfigDefault`
 * 按 (schemaName, schemaVersion) 精确查）。本脚本补的就是这个缺口。
 *
 * 语义与两个 flow 的 sync 脚本一致：**仓库文件是权威源，跑一次就把它对齐进 DB**，幂等。
 *
 * 匹配与冲突
 * - 按 `(schemaName, schemaVersion)` 精确匹配；版本常量有测试钉着 `register-schemas.mjs`
 *   的 manifest，改一边漏改另一边会红。
 * - 0 条 → POST 创建；1 条 → 内容不同才 PATCH；**多条 → 拒绝**（不猜该对齐哪一条，
 *   与 `flows.service.ts` 在「存在多条配置记录」时的立场一致）。
 *
 * 方向是【仓库覆盖 DB】：在 console UI 里对这条记录做的编辑，会被下一次运行覆盖。
 * 想保留的改动请写回 `example.json` —— 那正是「跟着仓库走」的含义。
 *
 * Usage:
 *   node scripts/sync-preprocess-config.mjs [--url http://127.0.0.1:8790] [--dry-run]
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = process.env.CONSOLE_URL || "http://127.0.0.1:8790";

export const SCHEMA_NAME = "product-preprocess-config";
/** 必须与 register-schemas.mjs 的 manifest 里那一行一致（有测试对拍）。 */
export const SCHEMA_VERSION = 2;
export const SOURCE_FILE = ".claude/skills/product-preprocess/product-preprocess-config.example.json";

/** 比较配置时用的稳定序列化：键排序，避免「同一份配置只是键顺序不同」被当成改动。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestJson(baseUrl, path, init, fetchImpl) {
  const response = await fetchImpl(new URL(path, `${baseUrl.replace(/\/$/, "")}/`), init);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${init?.method || "GET"} ${path} returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }
  if (!response.ok) throw new Error(`${init?.method || "GET"} ${path} ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

/**
 * @returns {Promise<{id: string|null, name: string, created: boolean, changed: boolean, reason?: string}>}
 */
export async function syncPreprocessConfigRecord({
  baseUrl = DEFAULT_URL,
  dryRun = false,
  fetchImpl = fetch,
  readFileImpl = readFile,
} = {}) {
  const wanted = JSON.parse(await readFileImpl(resolve(ROOT, SOURCE_FILE), "utf8"));
  const listed = await requestJson(
    baseUrl,
    `/api/schema-records?schemaName=${encodeURIComponent(SCHEMA_NAME)}`,
    undefined,
    fetchImpl,
  );
  const records = Array.isArray(listed) ? listed : [];
  // 只认目标版本：registry 里可能同时留着更早的版本，它们不是要对齐的对象。
  const matching = records.filter((row) => row?.schemaVersion === SCHEMA_VERSION);
  if (matching.length > 1) {
    throw new Error(
      `存在 ${matching.length} 条 ${SCHEMA_NAME}@${SCHEMA_VERSION} 记录，不确定该对齐哪一条；` +
        `请先在 console 里清理，本脚本不猜`,
    );
  }

  if (!matching.length) {
    if (dryRun) return { id: null, name: SCHEMA_NAME, created: true, changed: true, reason: "目标版本尚无记录，将创建" };
    const created = await requestJson(
      baseUrl,
      "/api/schema-records",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaName: SCHEMA_NAME, schemaVersion: SCHEMA_VERSION, data: wanted }),
      },
      fetchImpl,
    );
    return { id: created?.id ?? null, name: SCHEMA_NAME, created: true, changed: true };
  }

  const target = matching[0];
  let current = null;
  try {
    current = JSON.parse(target.data ?? "null");
  } catch {
    current = undefined; // 库里的 payload 不是合法 JSON —— 按「不同」处理，交给本次 PATCH 修好
  }
  const changed = stableStringify(current) !== stableStringify(wanted);
  if (!changed || dryRun) {
    return { id: target.id, name: SCHEMA_NAME, created: false, changed, ...(changed ? { reason: "内容不同，将覆盖" } : {}) };
  }
  const updated = await requestJson(
    baseUrl,
    `/api/schema-records/${encodeURIComponent(target.id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: wanted }),
    },
    fetchImpl,
  );
  return { id: updated?.id ?? target.id, name: SCHEMA_NAME, created: false, changed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const urlIndex = process.argv.indexOf("--url");
  const baseUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : DEFAULT_URL;
  syncPreprocessConfigRecord({ baseUrl, dryRun: process.argv.includes("--dry-run") })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
