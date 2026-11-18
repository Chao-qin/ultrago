#!/usr/bin/env node
/**
 * 生成 resource/playbooks/doudian-category-schema.json —— 抖店「类目属性 + 类目资质」全量采集 book。
 *
 * 为什么要生成而不是手写：数据取回必须分片，而分片数是被两条硬约束夹出来的，不是风格选择。
 *
 *   1. browser.eval 的返回值在扩展侧被截断：packages/extension/src/entrypoints/background.ts
 *      的 EVAL_MAX_LEN = 200_000 字符，超了直接 `value.slice(0, maxLen)` + `truncated: true`。
 *   2. 实测全字段体积 155.5MB（4236 个叶子类目，2026-09-03 实跑）。
 *
 *   155.5MB / 190KB ≈ 800 片。手写 800 个近乎相同的步骤不可维护，所以由本脚本生成。
 *
 * 为什么必须是 book 而不是让 agent 自己取：
 *   book 的步骤返回值走 runner 落盘，不经过 agent 上下文；agent 自己取 155MB 等于往上下文里
 *   灌约 4000 万 token。这条才是「采集必须做成 book」的真正原因 —— 不是分片数，是上下文。
 *
 * 只读：全程只调 categoryOptionsN（GET）与 getSchema（POST，读表单定义）。
 * 绝不触碰 addWithSchema / editWithSchema / partialEditWithSchema 等写接口。
 *
 *   node scripts/gen-doudian-schema-book.mjs
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "resource/playbooks/doudian-category-schema.json");

/** 单片上限。EVAL_MAX_LEN 是 200_000；留 5% 余量给 JSON 字符串转义（中文在 JSON.stringify
 *  里是 \uXXXX 还是原样取决于序列化路径，宁可留够）。 */
const CHUNK_CAP = 190_000;
/** 分片数固定在 book 里（步骤数不能运行时决定），片长由页面按 ceil(len/N) 反算，
 *  所以没有空转步骤；真超了 CHUNK_CAP 就报错而不是交出被截断的数据。 */
/* 片数按【实测原样体积】定，不是按估算：2026-09-03 跑批当场量到
   资质 42,262,405 字节 / 属性 115,000,026 字节（合计 157.3MB，与全量测量 155.5MB 对得上）。
   我一度按「资质约 6.5MB」设 N_QUAL=60，结果片长 704,374 直接超上限 —— 那 6.5MB 是
   【去重后】的数字（448 种不同资质块的池子），不是原样逐类目存的体积。教训：片数只能
   由原样体积推，去重体积是另一回事。 */
/* 片数按【容量】给，不按「刚好够这一轮」给。实测转义膨胀 1.231×，单片上限 190,000，
   所以每片最多承载 190000/1.231 ≈ 154,346 原始字符；容量 = 片数 × 154,346。
   2026-09-03 实测体积：资质 42.3MB / 属性 115.0MB。下面的片数留出约 3.6× / 2.7× 余量 ——
   抖店类目表逐年增长，容量该按「几年不用管」定，不该按「这一轮刚好够」定。
   注意：容量不足【不会】导致数据被裁剪（PREPARE 会逐片真序列化校验，超限就撤掉 __take
   并报错、一个文件都不写），它只会让整轮失败。留余量是为了少一次白跑，不是为了防丢数据。 */
const N_TREE = 40; // 容量 ~6.2MB（当前约 2MB）
const N_QUAL = 1000; // 容量 ~154MB（当前 42.3MB）
const N_PROPS = 2000; // 容量 ~309MB（当前 115.0MB）
/** 采集泵的步数。实测 4275 叶 / 6 并发 / 785 秒，每步约 45 秒有效工作 → 约 18 步。
 *  给 40 步是留一倍余量；跑完后的步骤原地返回 finished，不花钱。 */
const N_PUMP = 40;

const SEED_LEAF = "1000001549"; // 玩具/创意手工玩具/工具材料 —— 只用来让页面自己发一次 getSchema
/** 种子类目的全路径。选哪个类目不重要，重要的是「选中」这个动作会让页面发出一次真实的
 *  getSchema —— 那个请求体就是模板。写死而不参数化：它是本 book 的内部脚手架，不是入参。 */
const SEED_PATH = ["玩具", "创意手工玩具", "工具材料"];

const gate = { all: ["formReady"] };
/** 分片步专用的【便宜】门。1000 多个分片步如果都挂 formReady（含 settled），
 *  每一步都要重新判一次 DOM 静默 —— 那是按秒计的开销乘以一千。取片只需要
 *  「__take 已就绪」这一个事实，判它就够。 */
const chunkGate = { all: ["dataReady"] };

/* ── 采集器：爬树 + 可续跑的泵 ───────────────────────────────────────────
   为什么不是「起一个后台任务 + 一道信号门等它」：browser.waitSignal 的【传输层】
   上限是 180 秒（ws-server.ts 的 RPC_TIMEOUT 表，注释写明「3min covers the longest
   declared signal a book may reasonably use」），而全量采集要 13 分钟。在 signal 里
   声明 timeoutMs: 1800000 没用 —— RPC 先超时，实测就是这么挂的。那个上限是有意的
   传输边界，不该为一本 book 去抬。
   所以改成：每一步用注入的 bcpDeadline 自限在一次 eval 预算内，跑完一批就返回，
   下一步接着跑。等待被拆成了推进，没有任何一次调用超过 RPC 边界。 */
const INIT = `(async () => {
  if (!window.__bcpTpl) return { ok: false, reason: "模板未捕获" };
  const DL = bcpDeadline;
  const A = (window.__acc = { phase: "crawl", nodes: [], leaves: 0, todo: 0, done: 0, ok: 0, errs: [], data: {}, finished: false, t0: Date.now() });
  const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } })); };
  const getJSON = (window.__getJSON = async (url, init, tries = 3) => {
    let last;
    for (let a = 0; a < tries; a++) {
      /* 单次请求硬上限。没有它，一个挂住不返回的请求会永久占死一个并发槽 ——
         6 个槽全被占住整轮采集就静止，而进度再也不会前进。 */
      const ctl = new AbortController();
      const hardStop = Date.now() + 30000;
      const timer = setTimeout(() => ctl.abort(), Math.max(0, hardStop - Date.now()));
      try { const j = await (await fetch(url, Object.assign({}, init, { signal: ctl.signal }))).json(); if (j.code === 0) return j; last = new Error("code " + j.code + " " + (j.msg || "")); }
      catch (e) { last = e; }
      finally { clearTimeout(timer); }
      await new Promise((s) => setTimeout(s, 300 * (a + 1)));
    }
    throw last;
  });
  try {
    const cat = async (cid) => (await getJSON("/product/tproduct/categoryOptionsN?cid=" + cid + "&appid=1&_bid=ffa_goods", { credentials: "include", headers: { accept: "application/json" } })).data || [];
    const leaves = [], paths = new Map();
    let frontier = await cat(0);
    if (frontier.length < 20) throw new Error("一级类目只有 " + frontier.length + " 个，像是被截断 —— 拒绝在残缺的树上继续");
    frontier.forEach((c) => { paths.set(c.id, c.name); A.nodes.push(Object.assign({}, c, { path: c.name })); });
    for (let d = 0; d < 8; d++) {
      if (Date.now() > DL) throw new Error("爬类目树在第 " + d + " 层用尽了本步预算 —— 拒绝交出残缺的树");
      const parents = frontier.filter((c) => !c.is_leaf);
      frontier.filter((c) => c.is_leaf).forEach((c) => leaves.push(c));
      if (!parents.length) { frontier = []; break; }
      const next = [];
      await pool(parents, 10, async (p) => {
        const kids = await cat(p.id);
        if (!kids.length) throw new Error("非叶类目 " + p.name + "#" + p.id + " 没有子节点 —— 树不完整");
        for (const c of kids) { const pth = (paths.get(p.id) || "") + "/" + c.name; paths.set(c.id, pth); A.nodes.push(Object.assign({}, c, { path: pth })); next.push(c); }
      });
      frontier = next; A.leaves = leaves.length;
    }
    if (frontier.some((c) => !c.is_leaf)) throw new Error("类目树深于 8 层 —— 爬取被截断");
    A.leaves = leaves.length; A.tCrawlMs = Date.now() - A.t0; A.phase = "schema"; A.todo = leaves.length;
    window.__paths = paths; window.__queue = leaves; window.__qi = 0;
    return { ok: true, 叶子: leaves.length, 节点: A.nodes.length, 爬树毫秒: A.tCrawlMs };
  } catch (e) { A.fatal = String((e && e.message) || e); return { ok: false, reason: A.fatal }; }
})()`;

const PUMP = `(async () => {
  const A = window.__acc;
  if (!A) return { ok: false, reason: "采集未初始化" };
  if (A.fatal) return { ok: false, reason: "采集已中止：" + A.fatal };
  if (A.finished) return { ok: true, finished: true, done: A.done, note: "已跑完，本步空转" };
  const DL = bcpDeadline - 3000; /* 留 3 秒收尾，别让在途请求把整步拖过 eval 上限 */
  const q = window.__queue, paths = window.__paths, getJSON = window.__getJSON;
  const t0 = Date.now();
  const worker = async () => {
    while (Date.now() < DL && window.__qi < q.length) {
      const lf = q[window.__qi++];
      try {
        const body = JSON.parse(JSON.stringify(window.__bcpTpl));
        body.context.category_id = String(lf.id); /* 必须是字符串：传 number 会 code 10002 参数错误 */
        const j = await getJSON("/product/tproduct/getSchema?appid=1&_bid=ffa_goods", { method: "POST", credentials: "include", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
        const m = (j.data || {}).model || {};
        /* 原样保留：不做字段挑选。2026-09-03 之前这里只挑 10 个字段、options 压成二元组，
           把 rules / placeholder / required_tips / available / disabled / additions.diy_type /
           options[].additions 全丢了，qualification 更是从没采过。 */
        A.data[lf.id] = { name: lf.name, path: paths.get(lf.id) || lf.name, category_properties: m.category_properties || null, qualification: m.qualification || null };
        A.ok++;
      } catch (e) {
        /* code 500「创建商品前置校验失败」= 管制刀具等类目的平台准入限制，后端在下发 schema
           之前就拦了，重试无用。实测 39 个，逐条与 2026-08-27 的记录吻合。 */
        A.errs.push({ cid: lf.id, name: lf.name, err: String((e && e.message) || e).slice(0, 160) });
      }
      A.done++;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (window.__qi >= q.length && A.done >= q.length) { A.finished = true; A.ms = Date.now() - A.t0; }
  return { ok: true, finished: !!A.finished, done: A.done, total: q.length, 本步耗时: Date.now() - t0, 失败: A.errs.length };
})()`;

/* ── 把采集结果拼成最终文件内容，并算好片长 ─────────────────────────────── */
const PREPARE = `(() => {
  const A = window.__acc;
  if (!A || !A.finished) return { ok: false, reason: "采集尚未结束" };
  if (A.fatal) return { ok: false, reason: "采集中止：" + A.fatal };
  const meta = {
    source: "抖店商家后台 · 商品发布表单 schema（schema 驱动的发布页，没有独立的「取类目属性」接口）",
    endpoint: "POST /product/tproduct/getSchema?appid=1&_bid=ffa_goods —— request body 取自页面真实请求，只替换 context.category_id（字符串）",
    capturedAt: new Date().toISOString(),
    stats: { leaves: A.leaves, ok: A.ok, failed: A.errs.length, crawlMs: A.tCrawlMs, totalMs: A.ms },
    /* 每条记录都带 collection.ok。没有它，采到的空资质和【没采到】在数据里长得一模一样
       （都是 null），下游只能靠猜 —— 而「猜」正是这份数据存在的理由要消灭的东西。 */
    legend: {
      "collection.ok=true": "该类目的 schema 已成功取回；category_properties / qualification 为 null 表示抖店确实没下发这一段。",
      "collection.ok=false": "该类目【未能采集】，字段为 null 不代表抖店没有这些要求 —— 见 collection.error / collection.reason。不要把它当成「无属性 / 无资质」使用。"
    },
    failures: A.errs
  };
  /* 未采到的类目【也要落库】，并如实写明为什么没采到 —— 跳过它们会让 4275 个叶子
     悄悄变成 4236，下游按「类目不存在」处理，比记一条失败危险得多。 */
  const why = (err) => /创建商品前置校验失败/.test(String(err))
    ? "抖店在下发发布表单 schema 之前先做平台准入校验，管制刀具等类目需专门资质报白后才可发布；同一店铺重试无用（采集器已重试 3 次）。要补齐得先给店铺开通对应类目资质。"
    : "采集失败，原因见 collection.error。";
  const props = {}, qual = {};
  for (const cid of Object.keys(A.data)) {
    const e = A.data[cid];
    const collection = { ok: true };
    props[cid] = { name: e.name, path: e.path, collection, category_properties: e.category_properties };
    qual[cid] = { name: e.name, path: e.path, collection, qualification: e.qualification };
  }
  for (const f of A.errs) {
    const cid = String(f.cid);
    if (props[cid]) continue; /* 成功过就不该再被标失败；真撞上以成功为准 */
    const path = (window.__paths && window.__paths.get(f.cid)) || f.name;
    const collection = { ok: false, error: f.err, reason: why(f.err) };
    props[cid] = { name: f.name, path, collection, category_properties: null };
    qual[cid] = { name: f.name, path, collection, qualification: null };
  }
  if (Object.keys(props).length !== A.leaves) {
    return { ok: false, reason: "落库条数 " + Object.keys(props).length + " 与叶子数 " + A.leaves + " 对不上 —— 有类目既没成功也没记失败，拒绝写出一份对不上账的文件" };
  }
  /* 类目树也在这里落盘。本 book 为了拿叶子列表本来就完整爬了一遍树（4790 个节点、全字段），
     此前却把它扔掉、让 doudian-category-tree 再爬一遍 —— 同一棵树爬两次，而且两份产物是
     不同时刻的快照，属性/资质里的 cid 可能在树里找不到。现在一次爬取、一个快照、三个文件，
     互相之间天然对得上。形状与原 doudian-category-tree.json 保持一致（source/endpoint/
     capturedAt/stats/tree/flat），下游不用改。 */
  const byId = new Map();
  for (const n of A.nodes) {
    if (byId.has(n.id)) return { ok: false, reason: "类目 id " + n.id + "（" + n.name + "）出现两次 —— 爬取有重叠，拒绝写出" };
    byId.set(n.id, Object.assign({}, n, { is_leaf: !!n.is_leaf, children: [] }));
  }
  const roots = [];
  for (const n of byId.values()) {
    if (n.level === 1) { roots.push(n); continue; }
    const p = byId.get(n.parent_cid);
    if (!p) return { ok: false, reason: "类目 " + n.id + "（" + n.name + "）的父节点 " + n.parent_cid + " 没被采到 —— 树不完整，拒绝写出" };
    p.children.push(n);
  }
  if (roots.length < 20) return { ok: false, reason: "只还原出 " + roots.length + " 个一级类目 —— 像是被截断" };
  for (const n of byId.values()) {
    if (!n.is_leaf && !n.children.length) return { ok: false, reason: "非叶类目 " + n.id + "（" + n.name + "）合并后没有子节点" };
  }
  const byLevel = {}; let leafCount = 0; const flat = [];
  for (const n of byId.values()) { byLevel["L" + n.level] = (byLevel["L" + n.level] || 0) + 1; if (n.is_leaf) leafCount++; }
  for (const n of byId.values()) { const { children, ...bare } = n; flat.push(bare); }
  window.__outT = JSON.stringify({
    source: "抖店商家后台 · 商品发布页类目选择器",
    endpoint: "GET /product/tproduct/categoryOptionsN?cid=<父类目id>（cid=0 取一级类目，按 is_leaf 逐层下钻；同源 cookie 鉴权）。节点【原样】保留，含 enable / industry_status / extra —— extra.is_lack_qualification 就是「该类目缺资质」的现成标志位。",
    capturedAt: meta.capturedAt,
    stats: { total: byId.size, leaves: leafCount, roots: roots.length, byLevel: byLevel, nodeFields: Object.keys(flat[0] || {}) },
    tree: roots,
    flat: flat,
  });
  window.__outQ = JSON.stringify(Object.assign({}, meta, { kind: "category-qualification", data: qual }));
  window.__outP = JSON.stringify(Object.assign({}, meta, { kind: "category-properties", data: props }));
  const CAP = ${CHUNK_CAP};
  const chunk = (s, n) => Math.ceil(s.length / n);
  window.__chT = chunk(window.__outT, ${N_TREE});
  window.__chQ = chunk(window.__outQ, ${N_QUAL});
  window.__chP = chunk(window.__outP, ${N_PROPS});
  /* 下标式取片：同一个 i 取到的永远是同一段，步骤重试不会跳数据（游标式就会）。 */
  window.__take = (which, i) => {
    const s = which === "t" ? window.__outT : which === "q" ? window.__outQ : window.__outP;
    const w = which === "t" ? window.__chT : which === "q" ? window.__chQ : window.__chP;
    return s.slice(i * w, (i + 1) * w);
  };
  /* 【2026-09-03 修】上限必须按【序列化后】的长度判，不能按原始片长判。
     扩展侧的截断发生在 background.ts:1233：s = JSON.stringify(值)，然后 s.length > maxLen
     就 slice。分片返回的是字符串，而分片内容是 JSON 文本、满是双引号，转义后每个 " 变两个字符
     —— 实测膨胀 1.231 倍。原先这里拿原始片长跟 190000 比：190000 的片序列化后是 233900，
     超了 200000 却能通过这道门。它没造成过静默损坏（合并步会逐片查 truncated 并对拼接结果
     JSON.parse），但门算错了就是算错了。
     现在逐片真序列化一遍取最大值 —— 精确，不靠系数估算。1400 片 × 约 140KB 的临时字符串
     用完即回收，在一次 eval 预算内跑得完。 */
  const worst = (which, n) => { let mx = 0, at = -1;
    for (let i = 0; i < n; i++) { const L = JSON.stringify(window.__take(which, i)).length; if (L > mx) { mx = L; at = i; } }
    return { mx: mx, at: at }; };
  const wt = worst("t", ${N_TREE}), wq = worst("q", ${N_QUAL}), wp = worst("p", ${N_PROPS});
  window.__worst = { tree: wt, qual: wq, props: wp, cap: CAP };
  const need = (total, mx, cur, n) => Math.ceil(n * (mx / CAP) * 1.1); /* 按实测膨胀反推需要多少片，多给 10% */
  if (wt.mx > CAP) { delete window.__take; return { ok: false, reason: "类目树第 " + wt.at + " 片序列化后 " + wt.mx + " 字符，超过 " + CAP + "。把 N_TREE 提到 " + need(0, wt.mx, 0, ${N_TREE}) + " 以上再重新生成 book。绝不写出会被截断的分片。" }; }
  if (wq.mx > CAP) { delete window.__take; return { ok: false, reason: "资质第 " + wq.at + " 片序列化后 " + wq.mx + " 字符，超过 " + CAP + "。把 N_QUAL 提到 " + need(0, wq.mx, 0, ${N_QUAL}) + " 以上再重新生成 book。绝不写出会被截断的分片。" }; }
  if (wp.mx > CAP) { delete window.__take; return { ok: false, reason: "属性第 " + wp.at + " 片序列化后 " + wp.mx + " 字符，超过 " + CAP + "。把 N_PROPS 提到 " + need(0, wp.mx, 0, ${N_PROPS}) + " 以上再重新生成 book。绝不写出会被截断的分片。" }; }
  return { ok: true, 类目树字节: window.__outT.length, 资质字节: window.__outQ.length, 属性字节: window.__outP.length,
    类目树片长: window.__chT, 资质片长: window.__chQ, 属性片长: window.__chP,
    类目树最大片_序列化后: wt.mx, 资质最大片_序列化后: wq.mx, 属性最大片_序列化后: wp.mx, 单片上限: CAP,
    类目节点数: byId.size,
    叶子: A.leaves, 落库条数: Object.keys(props).length, 成功: A.ok, 失败: A.errs.length };
})()`;


/** 三份产物共用的合并代码。按【index】挑分片，不按位置 slice ——
 *  2026-09-03 实测教训：results 是「录制数据日志」，只保留恰好观察到一个动作的步骤，
 *  动作数 ≠ 1 或 verify 失败的步骤会被丢掉，所以它与步骤下标【不是】一一对齐的。
 *  按位置取，前面少一条整个窗口就右移一格，最后一片被挤掉 —— 报出来是
 *  「期望 40 个分片，实际 39」，而真正的原因在几百步之外。每条记录自带 index，用它。 */
const mergeCode = (label, first, last, n) => `
const want = [];
for (let i = ${first}; i <= ${last}; i++) want.push(i);
const byIndex = new Map();
for (const r of results) {
  if (!r || typeof r.index !== "number") continue;
  if (r.index < ${first} || r.index > ${last}) continue;
  const v = r.value;
  if (v && typeof v === "object" && v.truncated === true) throw new Error("${label}第 " + r.index + " 片被截断（超过 browser.eval 的返回上限）—— 提高分片数后重新生成 book");
  const sv = v && typeof v === "object" && "value" in v ? v.value : v;
  if (typeof sv !== "string") throw new Error("${label}第 " + r.index + " 片不是字符串：" + JSON.stringify(sv).slice(0, 120));
  byIndex.set(r.index, sv);
}
const missing = want.filter((i) => !byIndex.has(i));
if (missing.length) throw new Error("${label}缺 " + missing.length + " 片，缺的步骤下标：" + missing.slice(0, 20).join(",") + " —— 宁可失败也不写半份文件");
const out = want.map((i) => byIndex.get(i)).join("");
JSON.parse(out); /* 拼完必须仍是合法 JSON —— 这条断言就是「没有丢片/错序」的证明 */
return out;
`;

/* ── 步骤 ─────────────────────────────────────────────────────────────── */
const steps = [];
const push = (goal, action, verify, extra = {}) => steps.push({ page: "doudian", gate, goal, action, verify, onFail: "retry", ...extra });
/** local.* 步骤本身不碰页面，但 v2 要求每一步都归属某个逻辑页并带门（doudian-category-tree
 *  是 v1 所以不受此限）。挂 dataReady：此刻它必然为真，判它几乎不花钱，也不会引入假门。 */
const pushLocal = (goal, action, extra = {}) =>
  steps.push({
    page: "doudian",
    gate: chunkGate,
    goal,
    action,
    /* local.eval 判 noErrors（抛出即失败），local.writeFile 判 actionSucceeded ——
       与 doudian-category-tree 同一写法。空 verify 会被运行时拒收：
       「empty object or "" strings prove nothing and would silently auto-pass」。 */
    verify: action.method === "local.writeFile" ? { actionSucceeded: true } : { noErrors: true },
    onFail: "escalate",
    ...extra,
  });

steps.push({
  page: "doudian",
  goal: "在后台窗口打开抖店商品发布页，并用 ?category_leaf_id= 直接落到已选类目的表单态（这个参数是发布页自己读的，见 docs/doudian-category-properties-collection.md §2）。不抢用户当前窗口焦点。",
  action: { method: "browser.newWindow", params: { url: `https://fxg.jinritemai.com/ffa/g/create?category_leaf_id=${SEED_LEAF}`, focused: false, width: 1600, height: 1000, restoreFocus: true } },
  verify: { evalCheck: { code: `(()=>/\\/ffa\\/g\\/create/.test(location.pathname+location.search))()` } },
  onFail: "escalate",
});

push(
  "装 getSchema 请求体捕获器。getSchema 的 body 服务端要求一整个 context（149 项 gray_components，缺了 category_properties 就不下发属性），自己拼一定被拒 —— 所以只旁观页面自己发的那一次，拿来当模板，之后只替换 context.category_id。监听失败一律吞掉：诊断设施不该影响它观察的流程。",
  { method: "browser.eval", params: { code: `(() => {
  if (window.__bcpCap) return { ok: true, note: "已装过" };
  window.__bcpCap = [];
  const of_ = window.fetch;
  window.fetch = function (input, init) {
    try { const u = typeof input === "string" ? input : (input && input.url) || ""; if (/getSchema/i.test(u)) window.__bcpCap.push((init && init.body) || null); } catch (e) {}
    return of_.apply(this, arguments);
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { try { if (/getSchema/i.test(this.__u || "")) window.__bcpCap.push(b); } catch (e) {} return os.apply(this, arguments); };
  return { ok: true, note: "已装" };
})()` } },
  { evalCheck: { code: "(()=>Array.isArray(window.__bcpCap))()" } },
);

const BOX = `[...document.querySelectorAll("input")].find(i=>/类目关键词|商品名/.test(i.placeholder||""))`;
const ROWS = `[...document.querySelectorAll("[class*=resultItem],[class*=result-item]")].filter(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&r.width>0&&r.height>0})`;

push(
  `打开类目选择弹窗并确认它稳住了。【2026-09-03 实测】新开的 ?category_leaf_id=<id> 页面落在向导第一页（主图/标题/下一步），入口文案是「手动选择类目」，**没有**「修改」—— 后者只在已经选过类目的表单页才出现。所以两种文案都认。判据是「搜索框在」而不是「点过了」：抖店的自动类目匹配是异步的，回来时会重渲染类目区块把刚开的弹窗掀掉。`,
  { method: "browser.eval", params: { code: `(async()=>{ const DL=bcpDeadline; const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(ms,DL-Date.now()))));
 const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&r.width>0};
 const box=()=>${BOX};
 const entry=()=>{const leaf=[...document.querySelectorAll("span,a,button,div")].filter(e=>e.children.length===0&&vis(e));
   return leaf.find(e=>/^手动选择类目$/.test((e.textContent||"").trim()))||leaf.find(e=>/^修改$/.test((e.textContent||"").trim()))};
 let opened=0,torn=0;
 while(Date.now()<DL){ if(box()){ await sleep(1200); if(box())return{ok:true,opened,torn}; torn++; continue; }
   const e=entry(); if(!e){await sleep(400);continue} e.click(); opened++; await sleep(900); }
 return{ok:false,reason:"弹窗打不开或每次都被抖店的自动类目匹配掀掉",opened,torn}; })()` } },
  { evalCheck: { code: `(()=>!!${BOX})()` } },
);

push(
  `按种子类目名「${SEED_PATH[SEED_PATH.length - 1]}」搜索，等结果行真的出现。判据是「搜索出结果了」而不是「框里有字」—— 后者在搜索框还没挂好时也成立，会把失败推到下一步的门上空等。搜索是防抖异步的，没出结果就重打一遍。`,
  { method: "browser.eval", params: { code: `(async()=>{ const DL=bcpDeadline; const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(ms,DL-Date.now()))));
 const rows=()=>${ROWS};
 const leaf=${JSON.stringify(SEED_PATH[SEED_PATH.length - 1])};
 let box=${BOX}; while(!box&&Date.now()<DL){await sleep(300);box=${BOX}}
 if(!box)return{ok:false,reason:"弹窗里没等到类目搜索框"};
 const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
 const type=()=>{ set.call(box,""); box.dispatchEvent(new Event("input",{bubbles:true}));
   set.call(box,leaf); box.dispatchEvent(new Event("input",{bubbles:true})); box.dispatchEvent(new Event("change",{bubbles:true})); };
 let n=0,tries=0;
 while(Date.now()<DL){ type(); tries++;
   while(Date.now()<DL){ await sleep(400); n=rows().length; if(n>0)break; }
   if(n>0)break; }
 if(!n)return{ok:false,reason:"搜索没有返回任何类目结果",typed:leaf,tries};
 return{ok:true,typed:leaf,results:n,tries}; })()` } },
  { evalCheck: { code: `(()=>${ROWS}.length>0)()` } },
);

push(
  `在搜索结果里按全路径精确选中种子类目。选中这一下会触发页面自己的 getSchema —— 这才是本段的真正目的（拿模板），选哪个类目不重要，重要的是那个请求体。页面上的 > 分隔符是独立 DOM 节点、不进 textContent，所以两边都归一化后再比。判据是【捕获到够大的请求体】而不是「点中了」：点中只说明命中了行，不说明请求发出来了。`,
  { method: "browser.eval", params: { code: `(()=>{ const K=/[^\\u4e00-\\u9fa5A-Za-z0-9]/g, norm=s=>String(s||"").replace(K,"");
 const want=norm(${JSON.stringify(SEED_PATH.join(""))});
 const rows=${ROWS}; if(!rows.length)return{ok:false,reason:"类目搜索结果为空"};
 let hit=rows.find(e=>norm(e.textContent)===want); const how=hit?"exact":"includes";
 if(!hit)hit=rows.find(e=>norm(e.textContent).includes(want));
 if(!hit)return{ok:false,reason:"结果里没有匹配的类目路径",want,got:rows.slice(0,5).map(e=>norm(e.textContent))};
 hit.click(); return{ok:true,picked:norm(hit.textContent),how}; })()` } },
  { evalCheck: { code: `(()=>{const K=/[^\\u4e00-\\u9fa5A-Za-z0-9]/g,n=s=>String(s||"").replace(K,"");const want=n(${JSON.stringify(SEED_PATH.join(""))});return [...document.querySelectorAll("[class*=selectedCategory],[class*=selected-category]")].some(e=>n(e.textContent).includes(want));})()` } },
);

/* ── 走到第二页：getSchema 只在进入表单时才发 ──────────────────────────────
   2026-09-03 实测：在第一页搜索并选中类目，只触发 getCategoryDetail，getSchema
   一次都不发。模板拿不到，后面 4000 多次采集就无从谈起。所以必须真的过「下一步」。 */
push(
  "上传一张主图（resource/seed/blank-800.png，800×800，抖店要求不低于 600×600）。【2026-09-03 实测】页面内 canvas + DataTransfer 塞 input.files 驱动不了抖店的上传器 —— 一个上传请求都没发出去；而 browser.upload 这条通道在同样的输入框上是 47/47。所以用仓库里的固定种子图走 browser.upload，不自作聪明。这张图只是为了让「下一步」能过表单校验，商品不会被保存。判据是【出现抖店图床回显】而不是「上传动作没报错」—— 注意图床是 ecombdimg.com，ecombdstatic.com 是 JS/CSS 的 CDN，写错了判据永远不成立。",
  { method: "browser.upload", params: { css: "input[type=file]", nth: 0, attachments: [{ localPath: "resource/seed/blank-800.png" }] } },
  { evalCheck: { code: `(()=>[...document.querySelectorAll("img")].some(i=>/ecombdimg|byteimg|p\\d-aio/.test(i.src||"")&&!/mini-ico/.test(i.src||"")))()` } },
);

push(
  "填一个占位标题。抖店对标题有长度下限（占位符写着 15-60 个字符 / 8-30 个汉字），太短「下一步」会被表单校验拦住。用 React 的原生 setter 赋值再派发 input/change —— 直接改 .value 组件收不到。",
  { method: "browser.eval", params: { code: `(()=>{ const box=[...document.querySelectorAll("input,textarea")]
   .find(i=>/个字符|个汉字/.test(i.placeholder||""));
 if(!box)return{ok:false,reason:"没找到标题输入框"};
 if((box.value||"").length>=15)return{ok:true,note:"已有标题",value:box.value.slice(0,20)};
 const proto=box.tagName==="TEXTAREA"?window.HTMLTextAreaElement:window.HTMLInputElement;
 const set=Object.getOwnPropertyDescriptor(proto.prototype,"value").set;
 const t="类目表单结构采集用占位商品请勿发布";
 set.call(box,t); box.dispatchEvent(new Event("input",{bubbles:true})); box.dispatchEvent(new Event("change",{bubbles:true}));
 return{ok:true,typed:t}; })()` } },
  { evalCheck: { code: `(()=>{const b=[...document.querySelectorAll("input,textarea")].find(i=>/个字符|个汉字/.test(i.placeholder||""));return !!b&&(b.value||"").length>=15;})()` } },
);

push(
  "点「下一步」进入商品信息表单页 —— 这一步才会让页面发出 getSchema。判据是【捕获到够大的请求体】而不是「翻页了」：翻页只说明按钮点中了，模板到没到手是另一回事。",
  { method: "browser.eval", params: { code: `(async()=>{ const DL=bcpDeadline;
 const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(ms,DL-Date.now()))));
 const got=()=>(window.__bcpCap||[]).some(b=>b&&b.length>2000);
 const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&r.width>0};
 const btn=()=>[...document.querySelectorAll("button,[role=button]")].find(e=>vis(e)&&!e.disabled&&/^下一步$/.test((e.textContent||"").trim()));
 let clicks=0;
 while(Date.now()<DL){ if(got())return{ok:true,clicks};
   const b=btn(); if(b){b.click();clicks++;}
   await sleep(800); }
 return{ok:false,reason:"点了「下一步」但没等到 getSchema —— 多半被表单校验拦下（主图或标题没过）",clicks}; })()` } },
  { evalCheck: { code: `(()=>{const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&r.width>0};const has=t=>[...document.querySelectorAll("span,a,button,div")].some(e=>e.children.length===0&&vis(e)&&(e.textContent||"").trim()===t);return has("保存草稿")&&!has("下一步");})()` } },
);

/* ── 第二页上换一次类目 —— 这才是 getSchema 的真正触发点 ───────────────────
   2026-09-03 实测：翻到第二页是【同文档】切换（URL 不变、只有一条 navigation
   记录，页面 patch 存活），但整个过程 getSchema 一次都不发（捕获数 0）。真正
   发它的是第二页上的「修改类目」。判据都盯请求体，不盯 UI 痕迹。 */
push(
  "点「修改」打开改类目确认框。目的不是真换类目，而是让页面自己发一次 getSchema —— 那个请求体就是模板。判据是确认框出现。",
  { method: "browser.eval", params: { code: `(async()=>{ const DL=bcpDeadline;
 const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(ms,DL-Date.now()))));
 const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&r.width>0};
 const dlg=()=>[...document.querySelectorAll("[role=dialog]")].some(d=>vis(d)&&/确认修改|修改类目/.test(d.textContent||""));
 const btn=()=>[...document.querySelectorAll("span,a,button,div")].find(e=>e.children.length===0&&vis(e)&&/^修改$/.test((e.textContent||"").trim()));
 let clicks=0;
 while(Date.now()<DL){ if(dlg())return{ok:true,clicks};
   const b=btn(); if(b){b.click();clicks++;} await sleep(600); }
 return{ok:false,reason:"没等到改类目确认框",clicks}; })()` } },
  { evalCheck: { code: `(()=>[...document.querySelectorAll("[role=dialog]")].some(d=>/确认修改|修改类目/.test(d.textContent||"")))()` } },
);

push(
  "确认「修改类目」—— 这一下触发 getSchema。判据是【捕获到够大的请求体】而不是「弹窗关了」：弹窗关闭只说明点中了，不说明请求发出来了。抖店要求整个 context（149 项 gray_components），所以只认 >2000 字节的那一份。",
  { method: "browser.eval", params: { code: `(async()=>{ const DL=bcpDeadline;
 const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(ms,DL-Date.now()))));
 const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&r.width>0};
 const got=()=>(window.__bcpCap||[]).some(b=>b&&b.length>2000);
 const btn=()=>[...document.querySelectorAll("span,a,button,div")].find(e=>e.children.length===0&&vis(e)&&/^修改类目$/.test((e.textContent||"").trim()));
 let clicks=0;
 while(Date.now()<DL){ if(got())return{ok:true,clicks};
   const b=btn(); if(b){b.click();clicks++;} await sleep(700); }
 return{ok:false,reason:"点了「修改类目」但没捕获到 getSchema 请求体",clicks,捕获数:(window.__bcpCap||[]).length}; })()` } },
  { evalCheck: { code: "(()=>(window.__bcpCap||[]).some(b=>b&&b.length>2000))()" } },
);

push(
  "取出捕获到的真实请求体当模板。页面真实 body 有 5KB 以上（含 149 项 gray_components），精简版会被服务端拒 —— 所以只认 >2000 字节的那一份。",
  { method: "browser.eval", params: { code: `(() => {
  const real = (window.__bcpCap || []).filter((b) => b && b.length > 2000).pop();
  if (!real) return { ok: false, reason: "没有捕获到真实 getSchema 请求体" };
  try { window.__bcpTpl = JSON.parse(real); } catch (e) { return { ok: false, reason: "请求体不是 JSON：" + e.message }; }
  if (!window.__bcpTpl.context || !window.__bcpTpl.context.category_id) return { ok: false, reason: "模板里没有 context.category_id" };
  return { ok: true, 字节: real.length, gray_components: (window.__bcpTpl.context.gray_components || []).length, 种子类目: window.__bcpTpl.context.category_id };
})()` } },
  { evalCheck: { code: "(()=>!!(window.__bcpTpl&&window.__bcpTpl.context&&window.__bcpTpl.context.category_id))()" } },
);

push(
  "爬类目树：categoryOptionsN 从 cid=0 逐层下钻，拿到全部叶子并建好待办队列。节点【原样】留存（含 enable / industry_status / extra，其中 extra.is_lack_qualification 就是「该类目缺资质」的现成标志位）。实测约 11 秒，一次 eval 预算够用；宁可报错也不交残缺的树。",
  { method: "browser.eval", params: { code: INIT } },
  { evalCheck: { code: "(()=>Array.isArray(window.__queue)&&window.__queue.length>1000)()" } },
  { onFail: "escalate" },
);

/* 采集泵：每步在本次 eval 预算内跑一批，跑完就返回，下一步接着跑。
   实测 4275 个叶子、6 并发约 785 秒；一步约 45 秒有效工作 → 约 18 步。
   给到 40 步是留一倍余量：跑完之后的步骤原地返回 finished，不花钱。 */
for (let i = 0; i < N_PUMP; i++) {
  push(
    `采集泵 ${i + 1}/${N_PUMP}：在本步 eval 预算内推进一批叶子（6 并发），跑完即返回。判据只认「泵在正常推进或已跑完」—— 不认「进度到了多少」，因为每步能推多少取决于当时的网络。`,
    { method: "browser.eval", params: { code: PUMP } },
    { evalCheck: { code: "(()=>!!(window.__acc&&(window.__acc.finished||window.__acc.done>0)))()" } },
    { onFail: "escalate" },
  );
}

push(
  "把采集结果拼成两份最终文件内容并算好片长。拆成两个文件是有意的：资质约 6.5MB，是判「这个类目能不能发」真正要用的那份，能直接 load；属性约 149MB 只在建 schemaRecord 时读。片长按 ceil(总长/固定片数) 反算，所以没有空转步骤；一旦超过单片上限就报错，绝不交出被截断的数据。",
  { method: "browser.eval", params: { code: PREPARE } },
  { evalCheck: { code: "(()=>typeof window.__take==='function'&&window.__chQ>0&&window.__chP>0)()" } },
  { onFail: "escalate" },
);

const TREE_FIRST = steps.length;
for (let i = 0; i < N_TREE; i++) {
  push(
    `类目树分片 ${i + 1}/${N_TREE}`,
    { method: "browser.eval", params: { code: `window.__take("t", ${i})` } },
    { evalCheck: { code: "(()=>typeof window.__take==='function')()" } },
    { onFail: "escalate", gate: chunkGate },
  );
}
const TREE_LAST = steps.length - 1;

pushLocal(
  `把 ${N_TREE} 个类目树分片按序拼回。与另两份同一套写法：纯拼接 + JSON.parse 自证完整。`,
  { method: "local.eval", params: { code: mergeCode("类目树", TREE_FIRST, TREE_LAST, N_TREE) } },
);

pushLocal(
  "写 reports/doudian-category-tree.json —— 与属性、资质出自【同一次爬取、同一个快照】，所以三份产物里的 cid 天然对得上。此前这份是由独立的 doudian-category-tree book 另爬一遍产出的：同一棵树爬两次，两份快照取自不同时刻，属性里的 cid 可能在树里找不到。",
  { method: "local.writeFile", params: { path: "doudian-category-tree.json", overwrite: "overwrite" } },
);

const QUAL_FIRST = steps.length;
for (let i = 0; i < N_QUAL; i++) {
  push(
    `资质分片 ${i + 1}/${N_QUAL}`,
    { method: "browser.eval", params: { code: `window.__take("q", ${i})` } },
    { evalCheck: { code: "(()=>typeof window.__take==='function')()" } },
    { onFail: "escalate", gate: chunkGate },
  );
}
const QUAL_LAST = steps.length - 1;

pushLocal(
  `把 ${N_QUAL} 个资质分片按序拼回。纯字符串拼接、不做 JSON.parse —— local.eval 只有 2 秒预算，而分片本来就是同一个 JSON 串的连续切片，拼起来就是它自己。任一片不是字符串即报错，宁可失败也不写半份文件。`,
  { method: "local.eval", params: { code: mergeCode("资质", QUAL_FIRST, QUAL_LAST, N_QUAL) } },
);

pushLocal(
  "写 reports/doudian-category-qualification.json",
  { method: "local.writeFile", params: { path: "doudian-category-qualification.json", overwrite: "overwrite" } },
);

const PROP_FIRST = steps.length;
for (let i = 0; i < N_PROPS; i++) {
  push(
    `属性分片 ${i + 1}/${N_PROPS}`,
    { method: "browser.eval", params: { code: `window.__take("p", ${i})` } },
    { evalCheck: { code: "(()=>typeof window.__take==='function')()" } },
    { onFail: "escalate", gate: chunkGate },
  );
}
const PROP_LAST = steps.length - 1;

pushLocal(
  `把 ${N_PROPS} 个属性分片按序拼回，同上：纯拼接 + JSON.parse 自证完整。`,
  { method: "local.eval", params: { code: mergeCode("属性", PROP_FIRST, PROP_LAST, N_PROPS) } },
);

pushLocal(
  "写 reports/doudian-category-properties.json",
  { method: "local.writeFile", params: { path: "doudian-category-properties.json", overwrite: "overwrite" } },
);

steps.push({
  page: "doudian",
  gate,
  goal: "关闭本次采集用的工作 tab",
  action: { method: "browser.closeTab", params: {} },
  verify: { evalCheck: { code: "(()=>true)()" } },
  onFail: "escalate",
});

const book = {
  name: "doudian-category-schema",
  goal: "抖店类目数据的【唯一】采集入口：一次爬取、一个快照、三份产物。categoryOptionsN 逐层下钻拿到整棵类目树（节点原样，含 enable / industry_status / extra.is_lack_qualification），再对每个叶子发一次 getSchema，把 data.model.category_properties 与 data.model.qualification 原样收下，最后写出 reports/doudian-category-tree.json + doudian-category-properties.json + doudian-category-qualification.json。三份出自同一快照，cid 天然对得上 —— 此前类目树由独立 book 另爬一遍，两份快照取自不同时刻，属性里的 cid 可能在树里找不到；本 book 合并后 doudian-category-tree 那本已冗余。采集失败的类目【也落库】，带 collection.ok:false + 错误原文 + 原因，不跳过。只读接口，绝不触碰 addWithSchema / editWithSchema。本文件由 scripts/gen-doudian-schema-book.mjs 生成，不要手改。",
  schemaVersion: 2,
  params: [],
  pages: {
    doudian: {
      url: "https://fxg.jinritemai.com/ffa/g/create",
      signals: {
        formReady: {
          condition: {
            all: [
              { urlIncludes: "/ffa/g/create" },
              { script: { code: "/商品类目|保存草稿|下一步/.test(document.body.innerText||'')" } },
            ],
          },
          timeoutMs: 60000,
          description:
            "发布页已水合。这道门踩过两次同一个坑，都是【把门绑死在一个预期状态上】：① 一开始写 settled —— 这页 readyState 长期停在 interactive、loading 恒 true（有一批发往 localhost.bytedance.com:6xxxx/getdid 的请求会 ERR_TIMED_OUT，长期挂在在途集合里），settled 到超时都不成立；② 改判「类目入口元素在」—— 结果点完「修改类目」后那个元素消失，门又永远不成立。现在的判据在向导的每个阶段都成立：第一页有「下一步」，第二页有「保存草稿」，改类目态有「商品类目」。门要覆盖所有合法状态，不是覆盖你此刻正看着的那个。",
        },
        dataReady: {
          condition: { all: [{ script: { code: "typeof window.__take === 'function' && window.__chQ > 0 && window.__chP > 0" } }] },
          timeoutMs: 30000,
          description: "分片取数函数已就绪。给 1000 多个分片步用的便宜门 —— 它们不需要重新判 DOM 静默，只需要知道 __take 在。",
        },
      },
    },
  },
  steps,
};

writeFileSync(OUT, JSON.stringify(book, null, 1));
console.log(`写入 ${OUT}`);
console.log(`  步骤 ${steps.length}（资质分片 ${N_QUAL} 片 @ ${QUAL_FIRST}..${QUAL_LAST}，属性分片 ${N_PROPS} 片 @ ${PROP_FIRST}..${PROP_LAST}）`);
console.log(`  单片上限 ${CHUNK_CAP}（EVAL_MAX_LEN=200000 留 5% 余量）`);
