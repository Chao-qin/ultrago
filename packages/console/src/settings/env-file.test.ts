import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEnvUpdates,
  groupOf,
  isSecretKey,
  maskValue,
  parseEnvFile,
  validateEnvUpdate,
} from "./env-file.js";

/** Shaped after the real `.env`: a section header, a multi-line explanatory
 *  comment, a commented-out assignment kept as documentation, a blank-line
 *  separated group, and a value with `:` and `/` in it. */
const SAMPLE = `# Browser Control Protocol 配置
BCP_PORT=8787
BCP_TOKEN=bcp-dev-token

# Console 管理后台
# Prisma resolves relative file: paths relative to the schema directory
DATABASE_URL=file:../../../resource/db/console.db
# BCP_INTERNAL_URL=http://127.0.0.1:8789
BCP_HOST=0.0.0.0

IMAGE_BED_TOKEN=ghp_secretsecretsecret
`;

test("没有任何改动时，文件逐字节回到原样", () => {
  assert.equal(applyEnvUpdates(SAMPLE, { NOT_IN_FILE_AT_ALL: "x" }).includes("NOT_IN_FILE_AT_ALL=x"), true);
  // 只改已有键 → 行结构不动，其余每个字节都该原样在
  const out = applyEnvUpdates(SAMPLE, { BCP_PORT: "8787" });
  assert.equal(out, SAMPLE);
});

test("末尾没有换行的文件，只改值时也不会被补上换行", () => {
  const noEol = "A=1\nB=2";
  assert.equal(applyEnvUpdates(noEol, { A: "9" }), "A=9\nB=2");
});

test("改已有键：只换右边，缩进和 = 前后的空格保留", () => {
  const text = "  SPACED   =   old\nPLAIN=old\n";
  const out = applyEnvUpdates(text, { SPACED: "new", PLAIN: "new" });
  assert.equal(out, "  SPACED   =new\nPLAIN=new\n");
});

test("注释、空行、被注释掉的赋值，全部原样留在文件里", () => {
  const out = applyEnvUpdates(SAMPLE, { BCP_HOST: "127.0.0.1" });
  assert.ok(out.includes("# Browser Control Protocol 配置"));
  assert.ok(out.includes("# BCP_INTERNAL_URL=http://127.0.0.1:8789"));
  assert.ok(out.includes("# Prisma resolves relative file: paths relative to the schema directory"));
  assert.ok(out.includes("\n\n# Console 管理后台"), "空行没了");
  assert.ok(out.includes("BCP_HOST=127.0.0.1"));
});

test("新键追加到末尾的新增区，且只加一个区头", () => {
  const out = applyEnvUpdates(SAMPLE, { NEW_A: "1", NEW_B: "2" });
  assert.equal(out.match(/由 Console 设置面板新增/g)?.length, 1);
  assert.ok(out.endsWith("# ── 由 Console 设置面板新增 ──\nNEW_A=1\nNEW_B=2\n"));
  // 原有内容一个不少
  assert.ok(out.startsWith(SAMPLE.trimEnd()));
});

test("同一个键出现两次时，两处都改 —— dotenv 取最后一个，留下旧的会让生效值是旧值", () => {
  const dup = "PORT=1\n# 中间隔一段\nPORT=2\n";
  assert.equal(applyEnvUpdates(dup, { PORT: "9" }), "PORT=9\n# 中间隔一段\nPORT=9\n");
});

test("被注释掉的赋值不算一个条目", () => {
  const keys = parseEnvFile(SAMPLE).map((e) => e.key);
  assert.deepEqual(keys, ["BCP_PORT", "BCP_TOKEN", "DATABASE_URL", "BCP_HOST", "IMAGE_BED_TOKEN"]);
});

test("注释块归属：空行会断开，不会把上一段的说明挂到下一个键头上", () => {
  const entries = parseEnvFile(SAMPLE);
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.deepEqual(byKey.BCP_PORT.comments, ["# Browser Control Protocol 配置"]);
  // BCP_TOKEN 紧跟在 BCP_PORT 后面，中间没有注释 → 不该继承上一个的
  assert.deepEqual(byKey.BCP_TOKEN.comments, []);
  assert.deepEqual(byKey.DATABASE_URL.comments, [
    "# Console 管理后台",
    "# Prisma resolves relative file: paths relative to the schema directory",
  ]);
  // 被注释掉的赋值算 BCP_HOST 的说明
  assert.deepEqual(byKey.BCP_HOST.comments, ["# BCP_INTERNAL_URL=http://127.0.0.1:8789"]);
  // 空行断开后，IMAGE_BED_TOKEN 头上什么都没有
  assert.deepEqual(byKey.IMAGE_BED_TOKEN.comments, []);
});

test("值原样保留，不做 dotenv 的去引号 —— 去了就得原样写回去，否则改的是没人碰过的行", () => {
  const entries = parseEnvFile('QUOTED="a b"\nURL=file:../../x.db\nEMPTY=\n');
  assert.equal(entries[0].value, '"a b"');
  assert.equal(entries[1].value, "file:../../x.db");
  assert.equal(entries[2].value, "");
});

test("行号是 1 起的，指得回原文件", () => {
  assert.equal(parseEnvFile(SAMPLE).find((e) => e.key === "BCP_PORT")?.line, 2);
});

test("值里有换行必须被拒 —— 否则一行会被拆成两行、凭空多出一个变量", () => {
  assert.match(validateEnvUpdate("A", "1\nB=2") ?? "", /换行/);
  assert.match(validateEnvUpdate("A", "1\r\n") ?? "", /换行/);
  assert.equal(validateEnvUpdate("A", "1"), null);
});

test("变量名必须是 dotenv 读得回来的形状", () => {
  assert.equal(validateEnvUpdate("BCP_PORT", "1"), null);
  assert.equal(validateEnvUpdate("_X1", "1"), null);
  assert.notEqual(validateEnvUpdate("1BAD", "1"), null);
  assert.notEqual(validateEnvUpdate("HAS-DASH", "1"), null);
  assert.notEqual(validateEnvUpdate("HAS SPACE", "1"), null);
  assert.notEqual(validateEnvUpdate("", "1"), null);
});

test("密钥判定窄到只盖真密钥：MODEL_KEY 的值是公开模型 id，不该被打码", () => {
  assert.equal(isSecretKey("IMAGE_BED_TOKEN"), true);
  assert.equal(isSecretKey("BCP_TOKEN"), true);
  assert.equal(isSecretKey("BCP_INTERNAL_TOKEN"), true);
  assert.equal(isSecretKey("SOME_SECRET"), true);
  assert.equal(isSecretKey("DB_PASSWORD"), true);
  assert.equal(isSecretKey("BCP_LLM_LMSTUDIO_MODEL_KEY"), false);
  assert.equal(isSecretKey("BCP_PORT"), false);
});

test("打码留得下认得出的头尾，短值整个盖掉", () => {
  assert.equal(maskValue(""), "");
  assert.equal(maskValue("short"), "••••••");
  assert.equal(maskValue("ghp_abcdefghijklmn"), "ghp••••••mn");
  assert.ok(!maskValue("ghp_abcdefghijklmn").includes("abcdefghijkl"));
});

test("分组：更具体的前缀先命中，BCP_LLM_ 不会被 BCP_ 吃掉", () => {
  assert.equal(groupOf("BCP_LLM_PORT"), "本地 LLM");
  assert.equal(groupOf("BCP_LLM_LMSTUDIO_GPU"), "本地 LLM");
  assert.equal(groupOf("BCP_PORT"), "Browser Control Protocol");
  assert.equal(groupOf("IMAGE_BED_TOKEN"), "图床");
  assert.equal(groupOf("WECLAW_BIN"), "weclaw");
  assert.equal(groupOf("CONSOLE_PORT"), "Console 管理后台");
  assert.equal(groupOf("DATABASE_URL"), "Console 管理后台");
  assert.equal(groupOf("HOME"), "其他");
});
