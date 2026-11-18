#!/usr/bin/env node
/**
 * 把类目采集产物压成 `.json.gz`，并删掉明文 —— 采集 book 跑完后的收尾步骤。
 *
 *   pnpm reports:compress            # 压缩 + 删明文
 *   pnpm reports:compress --keep     # 压缩但保留明文（想手工看原文时用）
 *   pnpm reports:compress --check    # 只报告状态，不动文件
 *
 * **为什么必须压。** GitHub 对单文件是 100 MiB 硬上限（超过直接拒收 push），而属性产物
 * 122 MB。压后 13.3 MB。三份合计 177 MB → 14.1 MB：
 *   类目树   2.5 MB →  0.2 MB (15.9×)
 *   属性   122.1 MB → 13.3 MB ( 9.2×)
 *   资质    44.0 MB →  0.6 MB (69.4×)   ← 4236 个类目只有 448 种不同的资质块，重复度极高
 *
 * **为什么压完要删明文。** 两份同时存在时「哪份是真的」就成了要猜的事。读取侧
 * （category_capture.py / category-capture.mjs）的规则是「明文优先、回退 .gz」——
 * 那条规则只为覆盖「刚采完还没压」这个过渡态，不是让两份长期共存。删掉明文，
 * 过渡态就真的只是过渡态。
 *
 * 明文已在 .gitignore 里，所以采集完不压也不会误提交；但也就永远进不了仓库。
 */
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  "reports/doudian-category-tree.json",
  "reports/doudian-category-properties.json",
  "reports/doudian-category-qualification.json",
];

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const checkOnly = argv.includes("--check");
const mb = (n) => (n / 1048576).toFixed(1).padStart(6);

let acted = 0;
let missing = 0;
for (const rel of FILES) {
  const plain = resolve(ROOT, rel);
  const gz = `${plain}.gz`;
  const hasPlain = existsSync(plain);
  const hasGz = existsSync(gz);

  if (!hasPlain && !hasGz) {
    console.log(`  ✗ ${rel} —— 明文与 .gz 都不存在，先跑采集 book`);
    missing++;
    continue;
  }
  if (!hasPlain) {
    console.log(`  ·  ${rel}.gz  ${mb(statSync(gz).size)} MB  （只有 .gz，无需处理）`);
    continue;
  }
  const before = statSync(plain).size;
  if (checkOnly) {
    console.log(`  ?  ${rel}  ${mb(before)} MB 明文待压缩${hasGz ? "（.gz 也在，会被覆盖）" : ""}`);
    acted++;
    continue;
  }
  await pipeline(createReadStream(plain), createGzip({ level: 9 }), createWriteStream(gz));
  const after = statSync(gz).size;
  if (!keep) unlinkSync(plain);
  console.log(
    `  ✓ ${rel}  ${mb(before)} MB → ${mb(after)} MB  (${(before / after).toFixed(1)}×)` +
      (keep ? "  明文保留（--keep）" : "  明文已删"),
  );
  acted++;
}

if (missing) {
  console.error(`\n${missing} 份产物缺失 —— 跑 run_playbook({name:"doudian-category-schema",mode:"auto"}) 采集`);
  process.exit(1);
}
console.log(checkOnly ? `\n--check：${acted} 份待压缩` : `\n完成，${acted} 份已处理`);
