/**
 * 抖店类目采集产物的读取适配层（JS 侧）—— 与 Python 侧
 * `.claude/skills/product-preprocess/scripts/category_capture.py` 是同一套规则的两份实现。
 *
 * 为什么需要它：2026-09-03 采集口径从「挑 10 个字段 + options 压成二元组」改为
 * 【原样保留抖店返回的结构】，产物形状随之变了两处：
 *
 *   旧: { "<叶子id>": { name, path, props: [ {id, name, required, ..., options: [[vid, vname], ...]} ] } }
 *   新: { source, endpoint, capturedAt, stats, legend, failures, kind,
 *         data: { "<叶子id>": { name, path, collection, category_properties: <getSchema 原样> } } }
 *
 * 新结构里属性项用 `label`（不是 `name`），options 是 `[{value_id, value_name, additions}]`。
 * 下游（发布 book 的入参、入库脚本）读的都是旧形状，所以归一放在读取入口做一次。
 *
 * 两份实现而不是一份的理由：Python 侧在 skill 里、JS 侧在 scripts 里，跨语言共享一份
 * 需要引入运行时依赖或代码生成，成本高于这几十行。**代价是必须同步改** —— 谁改了字段
 * 映射，另一份也要改；这条写在两边的注释里，而不是靠记性。
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** 给一个 `.json` 路径，返回实际该读的文件（`.json` 或 `.json.gz`）。
 *
 *  产物进 git 时是 gzip 的：属性 122MB 超过 GitHub 单文件 100 MiB 的硬上限，压后 13.3MB
 *  （资质 44MB → 0.6MB，类目树 2.5MB → 0.2MB，合计 177MB → 14.1MB）。
 *
 *  **谁优先**：明文 `.json` 存在就用它 —— 它是采集 book 刚写出来的新鲜产物，压缩是之后
 *  单独一步（`pnpm reports:compress`，压完会删掉明文）。所以「两个都在」只是压缩前的过渡态，
 *  此时用新鲜的那份才对。新克隆的仓库里只有 `.gz`，走回退分支。
 *  与 Python 侧 category_capture.resolve_capture_path 是同一条规则，改一边要改两边。 */
export function resolveCapturePath(path) {
  if (existsSync(path)) return path;
  const gz = `${path}.gz`;
  if (existsSync(gz)) return gz;
  throw new Error(`${path} 与 ${gz} 都不存在 —— 先跑采集 book，或从仓库取回 .gz`);
}

export function readCapture(path) {
  const real = resolveCapturePath(path);
  return real.endsWith(".gz") ? gunzipSync(readFileSync(real)).toString("utf8") : readFileSync(real, "utf8");
}

/** 新形状的判据：顶层同时有 data 与 kind。不按文件名判 —— 同一个路径在迁移前后装的是
 *  两种东西，按名字判等于假设「文件没被换过」。 */
export function isNewCapture(doc) {
  return !!doc && typeof doc === "object" && doc.data && typeof doc.data === "object" && "kind" in doc;
}

/** 一个属性项：getSchema 原样 → 旧的内存形状（+ raw）。
 *  字段对应：name ← label（迁移最容易踩的一处）；options ← [{value_id,value_name}] 压回二元组。 */
export function normalizePropItem(item) {
  const add = item.additions ?? {};
  const group = add.prop_group ?? {};
  const options = item.options ?? [];
  return {
    id: item.id == null ? null : String(item.id),
    name: item.label ?? "",
    required: !!item.required,
    hidden: !!item.hidden,
    ui: add.ui_type ?? "",
    ptype: add.property_type ?? "",
    important: add.important_type ?? 0,
    group: group.name ?? "",
    optionCount: options.length,
    options: options.map((o) => [o.value_id, o.value_name]),
    // 原始项：rules / placeholder / required_tips / available / disabled /
    // additions.diy_type / options[].additions 都在这里，新需求直接取，不必再改一次形状。
    raw: item,
  };
}

/** 一个叶子类目条目：新形状 → 旧的内存形状（+ collection + raw）。旧形状原样返回。 */
export function normalizePropsEntry(entry) {
  if (!entry) return entry;
  if (Array.isArray(entry.props)) return { collection: { ok: true }, ...entry };
  const cp = entry.category_properties ?? null;
  return {
    name: entry.name,
    path: entry.path,
    collection: entry.collection ?? { ok: true },
    props: (cp?.items ?? []).map(normalizePropItem),
    raw: cp,
  };
}

/** 读属性采集产物 → { meta, byLeaf }。
 *  meta 带 capturedAt/stats —— 入库脚本要靠它判断「库里这条是哪一代」。 */
export function loadPropsCapture(path) {
  const doc = JSON.parse(readCapture(path));
  if (!isNewCapture(doc)) {
    const byLeaf = {};
    for (const [cid, e] of Object.entries(doc)) byLeaf[cid] = normalizePropsEntry(e);
    return { meta: { capturedAt: null, stats: null, legacy: true }, byLeaf };
  }
  const byLeaf = {};
  for (const [cid, e] of Object.entries(doc.data)) byLeaf[cid] = normalizePropsEntry(e);
  return { meta: { capturedAt: doc.capturedAt, stats: doc.stats, failures: doc.failures, legacy: false }, byLeaf };
}

/** 读资质采集产物 → { meta, byLeaf }。资质是 2026-09-03 才开始采的，没有旧形状要兼容，
 *  所以原样返回、不做归一化 —— 没有既有调用点依赖某个特定形状，凭空造一层映射只会
 *  多一处要维护的假设。 */
export function loadQualificationCapture(path) {
  const doc = JSON.parse(readCapture(path));
  const data = isNewCapture(doc) ? doc.data : doc;
  const byLeaf = {};
  for (const [cid, e] of Object.entries(data)) {
    byLeaf[cid] = {
      name: e.name,
      path: e.path,
      collection: e.collection ?? { ok: true },
      qualification: e.qualification ?? null,
    };
  }
  return { meta: { capturedAt: doc.capturedAt ?? null, stats: doc.stats ?? null, failures: doc.failures, legacy: !isNewCapture(doc) }, byLeaf };
}

/** 该类目【必须提供且我们提供不了】的资质项。
 *  三个条件缺一不可：抖店会下发一批 required=false 的可选资质（赠品资质、报关单等），
 *  把它们也算进来会把 3% 的阻断面积放大成一大片。
 *  ⚠ entry 未采集成功时返回空数组，但那【不代表没有要求】—— 调用方必须先看 collection.ok。 */
export function blockingQualifications(entry) {
  const items = entry?.qualification?.items ?? [];
  return items.filter((i) => i.required && !i.hidden && i.available !== false);
}
