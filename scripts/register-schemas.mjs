#!/usr/bin/env node
/**
 * BOOTSTRAP: seed the console's Schema registry (`/api/schemas`) from the
 * .schema.json files in this repo.
 *
 * The registry — not these files — is the source of truth. Schemas are created
 * and edited through the console UI / API, and consumers read them from there
 * (build_canonical.py fetches canonical-product over HTTP rather than reading
 * a file beside itself). What is left here is the ARCHIVE those contracts were
 * originally imported from, kept so a fresh database can be seeded and so the
 * Python tests have a structural fixture to run against without a live
 * console.
 *
 * So: run this to populate an empty registry. Do NOT run it to "sync" an edit
 * made in a file — an edit made in a file is an edit made in the wrong place.
 *
 * Idempotent: re-registering identical content is a no-op. Registering CHANGED
 * content under an unchanged version is refused by the API — a schema document
 * is immutable once anything cites it. For a manifest entry below, bump its
 * `version`. A `book-input-*` / `book-output-*` entry has no manifest line to
 * edit — it's generated from a playbook — so bump the playbook's own
 * `paramSchemaRef` / `outputSchemaRef` instead (e.g. "...@1" → "...@2") and
 * rerun; the generator below reads the version from there.
 *
 * Usage:
 *   node scripts/register-schemas.mjs [--url http://127.0.0.1:8790] [--dry-run]
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { paramSpecsToJsonSchema } from "../packages/shared/dist/param-schema-bridge.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = process.env.CONSOLE_URL || "http://127.0.0.1:8790";

/** The manifest. Adding a schema to the system means adding a line here.
 *
 * Two fields carry rules the API enforces (see checkSchemaContract):
 *   - `upstreamRef` belongs to a PROJECTION, never a canonical. A canonical is
 *     the platform-neutral shape we design; pointing it at one platform's docs
 *     makes it that platform's alias wearing a neutral name. This manifest used
 *     to do exactly that for canonical-product, which is where the bad row in
 *     the registry came from.
 *   - `derivesFrom` is required ON a projection: which canonical it projects.
 */
const SCHEMAS = [
  {
    file: ".claude/skills/product-preprocess/canonical.schema.json",
    name: "canonical-product",
    // @2：attributes 项补上 doudianValues 声明。该字段一直被 build_doudian_product
    // 写入，却没在本层声明，而本层是 additionalProperties:false —— 数据违反自己的
    // 契约，且只读已声明字段的消费方看不见映射结果（填表单要的抖店文案就在里面）。
    // @1 已被 doudian-addv2 的 derivesFrom 引用，不可变，故升版本而非改 @1。
    // @3：补两个「代码在写、契约没声明」的字段 —— $defs.image.localPath（主图裁剪
    // 副本的相对路径，build_images 一直在写，而 $defs.image 是
    // additionalProperties:false）与 specs[].values[].localPath（规格图下载并中心裁
    // 成 1:1 后的相对路径；抖店规格图强制 1:1，来源站常给竖图）。
    // @4：类目属性快照收进 category.categoryProps，发布 book 不再需要单独入参。
    // @6：全内存图片处理，canonical 不再暴露 localPath。
    // @7：记录本次运行实际使用的 product-preprocess-config 摘要。
    // @8：那份摘要里的 `preprocessConfig.schemaVersion` 由 const 1 改为 2 ——
    // product-preprocess-config 本身升到了 @2（configId/shopProfile 改可选），
    // 但 Python 的 audit_config 还写着 1，两边都不实。注意别和本 schema 顶层的
    // `schemaVersion`（恒为 1，表示结构兼容）搞混：改的是摘要里那一个。
    // @7 已被 flow 参数引用，不可变，故升版本而非改 @7。
    version: 8,
    kind: "canonical",
    entity: "product",
    // No upstreamRef on purpose. Aligning our value constraints WITH Doudian's
    // (as the description says) is not the same as Doudian OWNING this shape.
    description: '商品清洗与发布共用的数据契约',
  },
  {
    file: ".claude/skills/product-preprocess/shop-profile.schema.json",
    name: "shop-profile",
    version: 2,
    kind: "config",
    entity: "shop",
    description: "店铺级发布配置：抖店必填但商品数据推导不出的字段",
  },
  {
    file: ".claude/skills/product-preprocess/product-preprocess-config.schema.json",
    name: "product-preprocess-config",
    // @2：configId 与 shopProfile 从必填改为可选。@1 的 required 逼着"只想覆盖
    // pricing/text"的调用方把整份店铺配置再抄一遍（而 flow 早已有 profile 参数），
    // 于是任何片段式输入都被参数校验拦下。这两个字段本来就有回退来源：configId 落到
    // DEFAULT_CONFIG 的 "default"，shopProfile 回退到 profile 参数 ——
    // preprocess_config.normalize_config 里堵住这两条回退的两个 raise 已同步删除。
    // @1 已被 flow 参数与 SchemaRecord 引用，不可变，故升版本而非改 @1。
    version: 2,
    kind: "config",
    entity: "product",
    description: "商品预处理策略：价格、文案、库存和图片处理",
  },
  {
    file: ".claude/skills/product-preprocess/doudian-shop-profile.schema.json",
    name: "doudian-shop-profile",
    version: 1,
    kind: "entity",
    entity: "shop",
    description: "抖店店铺资料快照；不含完整证件号和证件照片",
  },
  {
    file: ".claude/skills/product-preprocess/doudian-category-tree.schema.json",
    name: "doudian-category-tree",
    // @2：dd48965 把形状从「顶层就是 cid 字典」改为包了 {source,endpoint,capturedAt,
    // stats,legend,failures,kind,data} 的整份采集外壳。同 name@v1 在 console 已注册
    // 且已被 SchemaRecord 引用，不可改；升版本且无任何代码 pin @v1（仅有一个测试
    // fixture 和一段注释），安全。
    version: 2,
    kind: "entity",
    entity: "product",
    description: "抖店商品类目树（整份采集）；从商家后台逐级下钻抓取，tree+flat 双视图",
  },
  {
    file: ".claude/skills/product-preprocess/doudian-category-properties.schema.json",
    name: "doudian-category-properties",
    // @2：同上，dd48965 推倒重写为原样保留的形状。升版本。
    version: 2,
    kind: "entity",
    entity: "product",
    description: "抖店类目属性（整份采集）；按类目抓发布表单 schema，2026-09-03 起原样保留",
  },
  {
    file: ".claude/skills/product-preprocess/doudian-category-qualification.schema.json",
    name: "doudian-category-qualification",
    version: 1,
    kind: "entity",
    entity: "product",
    description: "抖店类目资质要求（整份采集）；判「这个类目能不能发」的唯一依据",
  },
  // 逐叶记录：整份产物的形状对产物是对的、对下游是错的 —— 发布一个商品只需要一个类目，
  // 读那个 4275 条的 map 意味着把全部载入内存。schemaRecord 存的是这两份。
  {
    file: ".claude/skills/product-preprocess/projection/doudian-category-props.schema.json",
    name: "doudian-category-props",
    version: 1,
    kind: "entity",
    entity: "product",
    description: "抖店叶子类目属性表（单条）；scripts/ingest-category-props.mjs 按叶子入库",
  },
  {
    file: ".claude/skills/product-preprocess/projection/doudian-category-qualification.schema.json",
    name: "doudian-category-qualification-record",
    version: 1,
    kind: "entity",
    entity: "product",
    description: "抖店叶子类目资质要求（单条）；scripts/ingest-category-props.mjs 按叶子入库",
  },
  {
    file: ".claude/skills/product-preprocess/raw-1688-offer.schema.json",
    name: "raw-1688-offer",
    // @2：仅 description 修正 —— 根描述里的版本引用已过期（canonical-product@1
    // → @3、doudian-addv2@4 → @6），required/properties 契约结构一字未动。
    version: 2,
    kind: "entity",
    entity: "product",
    description: "1688 详情页原始抓取结构；下游 preprocess/build_canonical 把它投成 canonical-product",
  },
  {
    inline: { type: "string", minLength: 1 },
    name: "book-output-nonempty-string",
    version: 1,
    kind: "book_output",
    entity: "book",
    source: "api",
    description: "通用出参契约：任意非空字符串。多本 book 共用，不属于其中任何一本",
  },
];

// Schema 只定义可编辑配置的形状；新库还需要一条可直接选择的初始 SchemaRecord。
// 不能用 source 做幂等键：用户在后台创建的配置没有 source，且初始化记录不能覆盖它。
const DEFAULT_SCHEMA_RECORDS = [
  {
    schemaName: "product-preprocess-config",
    // 版本必须与上面 SCHEMAS 里的那一行一致：flows.service.ts 是按
    // (schemaName, schemaVersion) 精确匹配这条记录来实现"省略参数就填默认策略"的，
    // 版本对不上等同于"没有记录"，运行会静默回落到 Python 的内置策略 —— 正是
    // applyPreprocessConfigDefault 注释里要避免的那件事。
    schemaVersion: 2,
    file: ".claude/skills/product-preprocess/product-preprocess-config.example.json",
  },
];

/** Books declare their contracts inline (params / outputSchema) rather than as
 * separate .schema.json files — lift those into the same manifest instead of
 * letting each book keep its own uncompared copy. Books with no params/no
 * outputSchema simply don't produce a ref; an absent ref is the honest way to
 * say "this book declares nothing here". */
const PLAYBOOKS_DIR = resolve(ROOT, "resource/playbooks");
const playbookFiles = (await readdir(PLAYBOOKS_DIR, { withFileTypes: true }))
  .filter((d) => d.isFile() && d.name.endsWith(".json"))
  .map((d) => d.name)
  .sort();

/** A playbook points at its own contract version via `paramSchemaRef` /
 * `outputSchemaRef` (e.g. "book-input-doubao-ask@2"). There's no manifest line
 * for a generated entry to bump, so the version lives on the playbook side —
 * bump the ref there and rerun. First-time registration (no ref yet) is @1. */
function versionFromRef(ref, fallback = 1) {
  if (typeof ref !== "string") return fallback;
  const at = ref.lastIndexOf("@");
  const v = at === -1 ? NaN : Number(ref.slice(at + 1));
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

let failed = 0;

const playbooks = [];
for (const fileName of playbookFiles) {
  const bookName = fileName.replace(/\.json$/, "");
  try {
    const pb = JSON.parse(await readFile(resolve(PLAYBOOKS_DIR, fileName), "utf8"));
    playbooks.push({ bookName, pb });
  } catch (e) {
    console.error(`✗ book ${bookName}: 读不到或不是合法 JSON — ${e.message}`);
    failed++;
  }
}

for (const { bookName, pb } of playbooks) {
  if (!Array.isArray(pb.params)) continue;
  // 零参数 + 有 `paramSchemaRef` 也要生成。零参数是一份合法契约（"这本书不收
  // 任何入参"，即 properties:{} / additionalProperties:false），不是"没有契约"，
  // 而一本 CITES paramSchemaRef 的书就是在声明它的契约住在注册表里。
  //
  // 判据此前只看 `params.length > 0`，于是 doudian-shopprofile 从 445e00c
  // 落地那天起 ref 就是悬空的：注册表永远不会有 book-input-doudian-shopprofile@1，
  // filesync 的 resolveRef 解析失败后静默回落到内联契约，只留一条 warning
  // （见 app.module.ts 启动日志里对空注册表的同一段告警）。
  //
  // 零参数且**没有** ref 的书（doudian-category-schema）仍然跳过：它没有声明
  // 契约要进注册表，给它凭空登记一份空契约只会多一行要维护的版本。
  if (pb.params.length === 0 && !pb.paramSchemaRef) continue;
  try {
    SCHEMAS.push({
      inline: paramSpecsToJsonSchema(pb.params, `${bookName} 入参契约`),
      source: `inline:book:${bookName}`,
      name: `book-input-${bookName}`,
      version: versionFromRef(pb.paramSchemaRef),
      kind: "book_input",
      entity: "book",
      description: `${bookName} playbook 的入参契约`,
      bookGenerated: true,
    });
  } catch (e) {
    console.error(`✗ book-input-${bookName}: 转换失败 — ${e.message}`);
    failed++;
  }
}

// A content that's already named in the static manifest (e.g.
// book-output-nonempty-string) is covered — don't generate a second entry.
// A content NOT in the manifest but shared by >1 book is an unnamed
// coincidence; fail closed instead of guessing a name from whichever book
// happened to come first (that's how "book-output-doubao-ask" ended up
// silently standing in for doudian-category-tree too).
const manifestOutputByContent = new Map();
for (const entry of SCHEMAS) {
  if (entry.kind === "book_output" && entry.inline !== undefined) {
    manifestOutputByContent.set(JSON.stringify(entry.inline), entry.name);
  }
}
const unmatchedOutputGroups = new Map(); // content -> { outputSchema, books: [{bookName, pb}] }
for (const { bookName, pb } of playbooks) {
  if (!(pb.outputSchema && typeof pb.outputSchema === "object")) continue;
  const key = JSON.stringify(pb.outputSchema);
  if (manifestOutputByContent.has(key)) continue;
  if (!unmatchedOutputGroups.has(key)) unmatchedOutputGroups.set(key, { outputSchema: pb.outputSchema, books: [] });
  unmatchedOutputGroups.get(key).books.push({ bookName, pb });
}
for (const { outputSchema, books } of unmatchedOutputGroups.values()) {
  if (books.length > 1) {
    const names = books.map((b) => b.bookName).join(", ");
    console.error(`✗ 检测到 ${books.length} 本书（${names}）共享同一 outputSchema，请在 manifest 里给它一个显式名字`);
    console.error(`  （加一条 book_output 手工条目，而不是让脚本自动挑一本书的名字代表它）。`);
    failed++;
    continue;
  }
  const { bookName, pb } = books[0];
  SCHEMAS.push({
    inline: outputSchema,
    source: `inline:book:${bookName}`,
    name: `book-output-${bookName}`,
    version: versionFromRef(pb.outputSchemaRef),
    kind: "book_output",
    entity: "book",
    description: `${bookName} playbook 的出参契约`,
    bookGenerated: true,
  });
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const urlIndex = args.indexOf("--url");
const baseUrl = (urlIndex >= 0 ? args[urlIndex + 1] : DEFAULT_URL).replace(/\/$/, "");

for (const entry of SCHEMAS) {
  let jsonSchema;
  let source;
  if (entry.inline !== undefined) {
    jsonSchema = entry.inline;
    source = entry.source;
  } else {
    const abs = resolve(ROOT, entry.file);
    try {
      jsonSchema = JSON.parse(await readFile(abs, "utf8"));
    } catch (e) {
      console.error(`✗ ${entry.name}: 读不到或不是合法 JSON — ${e.message}`);
      failed++;
      continue;
    }
    source = entry.source ?? `file:${relative(ROOT, abs)}`;
  }

  const body = {
    name: entry.name,
    version: entry.version,
    kind: entry.kind,
    entity: entry.entity,
    description: entry.description,
    upstreamRef: entry.upstreamRef ?? null,
    derivesFrom: entry.derivesFrom ?? null,
    source,
    jsonSchema,
  };

  if (dryRun) {
    console.log(`· ${entry.name} v${entry.version} (${entry.kind}) ← ${entry.file ?? source}`);
    continue;
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/api/schemas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`✗ ${entry.name}: 连不上 ${baseUrl} — ${e.message}`);
    console.error(`  console 起来了吗？端口对吗？（--url 可覆盖）`);
    failed++;
    continue;
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ ${entry.name} v${entry.version}: HTTP ${res.status}`);
    console.error(`  ${text.slice(0, 300)}`);
    if (res.status === 400 && text.includes("different content")) {
      console.error(`  → 该 name+version 已登记且内容不同。schema 一经引用即不可改，`);
      if (entry.bookGenerated) {
        const bookName = entry.name.replace(/^book-(input|output)-/, "");
        console.error(
          `    请把 resource/playbooks/${bookName}.json 里的 paramSchemaRef/outputSchemaRef 版本号加 1（如 "...@2"），再重跑本脚本。`,
        );
      } else {
        console.error(`    请在 scripts/register-schemas.mjs 里把 ${entry.name} 的 version 加 1。`);
      }
    } else if (res.status === 400) {
      console.error(`  → 本条 manifest 违反了注册表的契约规则，改这里而不是放宽后端校验。`);
    }
    failed++;
    continue;
  }

  const row = JSON.parse(text);
  console.log(`✓ ${row.name} v${row.version} (${row.kind}/${row.entity ?? "-"}) → ${row.id}`);
  console.log(`  hash=${row.contentHash.slice(0, 12)}… source=${row.source}`);
}

for (const entry of DEFAULT_SCHEMA_RECORDS) {
  if (dryRun) {
    console.log(`· 初始 SchemaRecord ${entry.schemaName}@${entry.schemaVersion} ← ${entry.file}`);
    continue;
  }
  try {
    const listRes = await fetch(`${baseUrl}/api/schema-records?schemaName=${encodeURIComponent(entry.schemaName)}`);
    if (!listRes.ok) throw new Error(`查询失败: HTTP ${listRes.status} ${await listRes.text()}`);
    const existing = await listRes.json();
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`· ${entry.schemaName} 已有 ${existing.length} 条有效 SchemaRecord，跳过初始化`);
      continue;
    }

    const data = JSON.parse(await readFile(resolve(ROOT, entry.file), "utf8"));
    const createRes = await fetch(`${baseUrl}/api/schema-records`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaName: entry.schemaName, schemaVersion: entry.schemaVersion, data }),
    });
    const text = await createRes.text();
    if (!createRes.ok) throw new Error(`创建失败: HTTP ${createRes.status} ${text.slice(0, 300)}`);
    const row = JSON.parse(text);
    console.log(`✓ 初始 SchemaRecord ${entry.schemaName}@${entry.schemaVersion} → ${row.id}`);
  } catch (e) {
    console.error(`✗ 初始 SchemaRecord ${entry.schemaName}@${entry.schemaVersion}: ${e.message}`);
    failed++;
  }
}

if (dryRun) {
  console.log(`\n(dry-run) 共 ${SCHEMAS.length} 份，未发送任何请求`);
  process.exit(0);
}
console.log(failed ? `\n${failed}/${SCHEMAS.length} 份登记失败` : `\n全部 ${SCHEMAS.length} 份已登记`);
process.exit(failed ? 1 : 0);
