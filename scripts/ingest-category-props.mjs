#!/usr/bin/env node
/**
 * 把抖店类目采集产物按【一个叶子类目一条记录】灌进 console。
 * 两份产物共用这一个脚本：属性（doudian-category-props）与资质（doudian-category-qualification）。
 *
 * 为什么按叶子拆。整份产物是 4275 条的大字典（属性 128MB / 资质 46MB），而发布一个商品只
 * 需要其中一个类目。那个形状对产物是对的、对下游是错的 —— 读 map 意味着把全部载入内存。
 *
 * 为什么是 upsert 而不是「先删再插」。记录的 source 是
 * `file:reports/<产物>.json#<叶子id>`，同一个叶子跨多次采集算出来是同一个 source。
 * 所以：存在就 PATCH、不存在就 POST，另外把「本次采集里已不存在的 cid」软删掉。
 * 既不会重复、也不会留旧代。
 *
 * **2026-09-03 修的两个真问题**（都在这次采集口径变更时才暴露）：
 *   1. 旧版文档写着「pass --replace to soft-delete the previous generation first」，
 *      而全脚本【没有任何 --replace 的实现】—— 按文档去用会以为换了数据，实际什么都没换。
 *   2. 旧版逻辑只有一句 `if (existing.has(source)) { skipped++; continue; }`。
 *      新旧两代采集算出来的 source 完全一样，于是拿新数据重跑会把 4236 条全部当「已存在」
 *      跳过，库里静默留着旧代。这个方向比重复危险 —— 重复看得见，静默陈旧看不见。
 *      现在每条记录带 capturedAt，脚本按它判断该不该更新，并把「跳过了多少条、为什么」
 *      打出来，而不是让它消失在计数里。
 *
 * NOT RUN BY THE ASSISTANT. 这个脚本写数据库，起草在这里、由你执行。
 * 它走 console 的 HTTP API 而不是直连 Prisma，所以每一次写都过与手工创建同一套校验
 * —— 包括 schema 校验，那正是重点。
 *
 *   pnpm start                                        # console 必须在跑
 *   node scripts/ingest-category-props.mjs --dry-run  # 先看它打算做什么
 *   node scripts/ingest-category-props.mjs
 *   node scripts/ingest-category-props.mjs --only=qualification --limit=50
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isNewCapture, readCapture } from "./lib/category-capture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BCP_CONSOLE_URL ?? "http://127.0.0.1:8790";

/** 两份产物的登记表。payloadKey 是每条记录里那个「抖店原样」字段的名字 —— 信封一样，
 *  只有这一个字段不同，所以同一段逻辑能同时管两份。 */
const KINDS = [
  {
    key: "props",
    capture: "reports/doudian-category-properties.json",
    schemaFile: ".claude/skills/product-preprocess/projection/doudian-category-props.schema.json",
    schemaName: "doudian-category-props",
    payloadKey: "category_properties",
  },
  {
    key: "qualification",
    capture: "reports/doudian-category-qualification.json",
    schemaFile: ".claude/skills/product-preprocess/projection/doudian-category-qualification.schema.json",
    schemaName: "doudian-category-qualification",
    payloadKey: "qualification",
  },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (p) => argv.find((a) => a.startsWith(p))?.slice(p.length);
const dryRun = has("--dry-run");
const force = has("--force"); // 即便 capturedAt 相同也重写一遍（改了记录形状时用）
const limit = Number(val("--limit=") ?? 0);
const only = val("--only=");

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** 一条记录的内容。字段跨得明明白白而不是 spread —— 产物以后长出新字段时，
 *  它会以 schema 校验失败的形式到达，而不是悄悄混进库里。 */
function recordFor(cid, entry, capturedAt, payloadKey) {
  return {
    cid: String(cid),
    name: entry.name,
    path: entry.path,
    capturedAt,
    collection: entry.collection ?? { ok: true },
    [payloadKey]: entry[payloadKey] ?? null,
  };
}

async function ensureSchema(kind, registered) {
  if (registered.some((s) => s.name === kind.schemaName)) {
    console.log(`  schema ${kind.schemaName} 已存在，跳过注册`);
    return;
  }
  const doc = JSON.parse(readFileSync(resolve(ROOT, kind.schemaFile), "utf8"));
  if (dryRun) {
    console.log(`  [dry-run] 会注册 schema ${kind.schemaName}`);
    return;
  }
  await api(`/api/schemas`, {
    method: "POST",
    body: JSON.stringify({
      name: kind.schemaName,
      kind: "entity",
      entity: "product",
      title: doc.title,
      description: doc.description?.split("\n")[0],
      jsonSchema: doc,
    }),
  });
  console.log(`  已注册 schema ${kind.schemaName}`);
}

async function ingest(kind) {
  console.log(`\n=== ${kind.schemaName} ===`);
  // 走适配层读：产物进 git 时是 gzip 的（属性 122MB 超过 GitHub 单文件 100 MiB 硬上限）。
  const doc = JSON.parse(readCapture(resolve(ROOT, kind.capture)));
  if (!isNewCapture(doc)) {
    throw new Error(
      `${kind.capture} 还是 2026-09-03 之前的旧形状（顶层没有 data/kind）。` +
        `先跑 resource/playbooks/doudian-category-schema.json 重新采集 —— 拒绝把旧形状灌进库，` +
        `否则库里会同时存在两代形状，而且分不出哪条是哪代。`,
    );
  }
  const capturedAt = doc.capturedAt;
  const entries = Object.entries(doc.data);
  const todo = limit > 0 ? entries.slice(0, limit) : entries;
  console.log(
    `  ${kind.capture}: ${entries.length} 条（capturedAt ${capturedAt}，` +
      `成功 ${doc.stats.ok} / 未采到 ${doc.stats.failed}）${limit > 0 ? ` —— --limit=${limit}，本次 ${todo.length} 条` : ""}`,
  );

  const registered = await api(`/api/schemas`);
  await ensureSchema(kind, registered);

  // 库里现有的这一批。preview=true 只取摘要，但我们需要 data.capturedAt 才能判断代次，
  // 所以取完整记录 —— 4275 条的代价换「不会静默留旧代」，值。
  const existing = new Map();
  for (const r of await api(`/api/schema-records?schemaName=${kind.schemaName}`)) {
    if (r.source) existing.set(r.source, { id: r.id, capturedAt: r.data?.capturedAt ?? null });
  }
  console.log(`  库内已有 ${existing.size} 条`);

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let retired = 0;
  const failures = [];
  const seen = new Set();

  for (const [cid, entry] of todo) {
    const source = `file:${kind.capture}#${cid}`;
    seen.add(source);
    const prev = existing.get(source);
    if (prev && prev.capturedAt === capturedAt && !force) {
      unchanged++;
      continue;
    }
    const data = recordFor(cid, entry, capturedAt, kind.payloadKey);
    if (dryRun) {
      prev ? updated++ : created++;
      continue;
    }
    try {
      if (prev) {
        await api(`/api/schema-records/${prev.id}`, { method: "PATCH", body: JSON.stringify({ data }) });
        updated++;
      } else {
        await api(`/api/schema-records`, {
          method: "POST",
          body: JSON.stringify({ schemaName: kind.schemaName, data, source }),
        });
        created++;
      }
      if ((created + updated) % 200 === 0) console.log(`    ${created + updated}/${todo.length}`);
    } catch (e) {
      // 收集而不是抛：一个坏类目不该让另外 4234 个进不去，而「哪些进不去」才是有用的产出。
      // 静默跳过则是这个仓库反复在消灭的那种失败。
      failures.push(`${cid}: ${e.message.slice(0, 160)}`);
    }
  }

  // 本次采集里已经不存在的 cid：抖店下掉了这个类目。软删而不是留着 ——
  // 留着就会有人按一个已经发不了的类目去投影。只在全量跑时做（--limit 是抽样，
  // 拿抽样去判断「不存在」会把没抽到的全删了）。
  if (!limit) {
    for (const [source, rec] of existing) {
      if (seen.has(source)) continue;
      retired++;
      if (dryRun) continue;
      try {
        await api(`/api/schema-records/${rec.id}`, { method: "DELETE" });
      } catch (e) {
        failures.push(`退役 ${source}: ${e.message.slice(0, 160)}`);
      }
    }
  }

  console.log(
    `  ${dryRun ? "[dry-run] " : ""}新建 ${created} · 更新 ${updated} · ` +
      `未变 ${unchanged}（capturedAt 相同${force ? "，--force 下不会出现" : "，要强制重写加 --force"}）· 退役 ${retired}`,
  );
  if (limit) console.log(`  ⚠ --limit=${limit} 生效：只处理了前 ${todo.length} 条，且【跳过了退役检查】`);
  if (failures.length) {
    console.error(`  ${failures.length} 条失败：`);
    for (const f of failures.slice(0, 20)) console.error(`    ${f}`);
    if (failures.length > 20) console.error(`    …还有 ${failures.length - 20} 条`);
  }
  return failures.length;
}

let bad = 0;
for (const kind of KINDS) {
  if (only && only !== kind.key) continue;
  bad += await ingest(kind);
}
if (bad > 0) process.exit(1);
