import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateOutput } from "@bcp/shared";
import { MAP_STATE_KEY, readMapState } from "./flow-exec.js";
import { RecordsService } from "../records/records.service.js";
import { FlowRunnerService, INLINE_OUTPUT_LIMIT, keepTail, scriptEnv } from "./flow-runner.service.js";
import type { ScriptOutcome } from './flow-runner.service.js';

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

interface NodePatch {
  status?: string;
  errorMessage?: string | null;
  outputJson?: string | null;
}

class FakePrisma {
  patches: NodePatch[] = [];
  checkpoint: string | null = null;
  constructor(
    private readonly runRow: { status: string; errorMessage: string | null } | null,
    private readonly record: Record<string, unknown> | null,
  ) {}

  readonly run = { findUnique: async () => this.runRow };
  readonly schemaRecord = {
    findFirst: async ({ where }: any) => (where.source === "run:run_1" ? this.record : null),
  };
  readonly flowNodeRun = {
    // flowRunId / nodeId are what `storeOutput` needs to know where a product
    // too big for its row should go; without them it can only keep it inline.
    findUnique: async () => ({ startedAt: new Date(), flowRunId: "flowrun_test", nodeId: "n1", outputJson: this.checkpoint }),
    update: async ({ data }: any) => {
      this.patches.push(data);
      return data;
    },
    updateMany: async ({ data }: any) => {
      this.patches.push(data);
      return { count: 1 };
    },
  };
}

/** `syncBookNode` is where the flow decides a book node's verdict; drive the
 *  real method rather than a re-implementation of its rules. */
async function sync(prisma: FakePrisma): Promise<NodePatch> {
  // `syncBookNode` touches neither the enqueue/dispatcher pair nor the schema
  // registry, so those stay null — a null that a test reaches is a test that
  // was wrong about which collaborators the method under test actually uses.
  const service = new FlowRunnerService(prisma as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never);
  await (service as unknown as { syncBookNode(row: unknown): Promise<void> }).syncBookNode({
    id: "node_row_1", nodeId: "n1", nodeType: "book", status: "running", runId: "run_1", outputJson: null,
  });
  assert.equal(prisma.patches.length, 1, "the node must be settled exactly once");
  return prisma.patches[0];
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { data: null, fileName: null, url: null, contentType: "application/json", bytes: 0, schemaErrors: null, ...over };
}

test('book output is consumed directly from its checkpoint without a schema record', async () => {
  const prisma = new FakePrisma({ status: 'success', errorMessage: null }, null);
  prisma.checkpoint = JSON.stringify({ outputs: { product: 'minimal' }, outputSchemaErrors: '[]' });
  const patch = await sync(prisma);
  assert.equal(patch.status, 'success');
  assert.deepEqual(JSON.parse(patch.outputJson!).outputs, { product: 'minimal' });
});

test('a checkpoint contract violation stops downstream execution', async () => {
  const prisma = new FakePrisma({ status: 'success', errorMessage: null }, null);
  prisma.checkpoint = JSON.stringify({ outputs: { number: 'wrong' }, outputSchemaErrors: '["$.number must be number"]' });
  const patch = await sync(prisma);
  assert.equal(patch.status, 'failed');
  assert.match(patch.errorMessage!, /number/);
});

test('failed book completion preserves accepted output for failure delivery and diagnosis', async () => {
  const prisma = new FakePrisma({ status: 'failed', errorMessage: 'close failed' }, null);
  prisma.checkpoint = JSON.stringify({ outputs: { receipt: 'accepted' }, outputSchemaErrors: '[]' });
  const patch = await sync(prisma);
  assert.equal(patch.status, 'failed');
  assert.equal(Object.hasOwn(patch, 'outputJson'), false);
  assert.deepEqual(JSON.parse(prisma.checkpoint).outputs, { receipt: 'accepted' });
});

test("a contract violation is fatal inside a flow, even though the run succeeded", async () => {
  // A standalone run only RECORDS a violation. A flow node must fail on it:
  // the value is about to be fed to the next endpoint, and passing on data
  // already known to be wrong makes a downstream node fail somewhere unrelated
  // — or quietly succeed on garbage.
  const prisma = new FakePrisma(
    { status: "success", errorMessage: null },
    record({ data: '{"reply":7}', bytes: 11, schemaErrors: JSON.stringify(["reply: expected string"]) }),
  );
  const patch = await sync(prisma);
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /产出不满足 outputSchema/);
  assert.match(String(patch.errorMessage), /expected string/);
});

test("'nobody could check this' does not fail the node — it is not a violation", async () => {
  // The reported bug: `schemaErrors` mixes violations with the validator's own
  // admission that a schema reached beyond the supported subset, and judging by
  // length alone failed the node over data that CONFORMS. Built from the real
  // validator so the entry is the real sentence, not a hand-typed lookalike.
  // `format` is what still lands in the notice bucket. It used to be `minItems`,
  // which ajv genuinely checks now — the fixture is built by calling the real
  // validator precisely so this kind of drift shows up as a failing
  // precondition rather than as a test quietly asserting nothing.
  const notice = validateOutput({ type: "object", properties: { items: { type: "string", format: "uri" } } }, { items: "https://example.com" });
  assert.equal(notice.length, 1, `precondition: conforming data still yields one entry — ${JSON.stringify(notice)}`);
  const prisma = new FakePrisma(
    { status: "success", errorMessage: null },
    record({ data: '{"items":"https://example.com"}', bytes: 30, schemaErrors: JSON.stringify(notice) }),
  );
  const patch = await sync(prisma);
  assert.equal(patch.status, "success", `an unchecked notice must not fail the node: ${patch.errorMessage}`);
  assert.deepEqual(JSON.parse(String(patch.outputJson)).outputs, { items: "https://example.com" });
});

test("a real violation alongside an unchecked notice still fails, and the count is violations only", async () => {
  const mixed = validateOutput({ type: "object", properties: { items: { type: "string", format: "uri" } } }, { items: 7 });
  assert.equal(mixed.length, 2, `precondition: one violation + one notice — ${JSON.stringify(mixed)}`);
  const prisma = new FakePrisma(
    { status: "success", errorMessage: null },
    record({ data: '{"items":7}', bytes: 11, schemaErrors: JSON.stringify(mixed) }),
  );
  const patch = await sync(prisma);
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /\/items must be string/);
  assert.doesNotMatch(String(patch.errorMessage), /not fully checked/, "the notice must not be quoted as a breach");
});

test("an empty violation list is a pass, not a failure", async () => {
  const prisma = new FakePrisma({ status: "success", errorMessage: null }, record({ data: '{"reply":"hi"}', bytes: 14, schemaErrors: "[]" }));
  const patch = await sync(prisma);
  assert.equal(patch.status, "success");
  assert.deepEqual(JSON.parse(String(patch.outputJson)), { outputs: { reply: "hi" }, status: "success" });
});

test("the contract branch passes its data column on as the node's value", async () => {
  const prisma = new FakePrisma(
    { status: "success", errorMessage: null },
    record({ data: '{"items":[{"id":"a"}]}', bytes: 22, schemaName: "product", schemaVersion: 1 }),
  );
  const patch = await sync(prisma);
  assert.deepEqual(JSON.parse(String(patch.outputJson)).outputs, { items: [{ id: "a" }] });
});

test("a file-branch product under the inline limit is read back, not handed on as a pointer", async () => {
  // Four of the six live books still have a null Book.outputSchemaRef and so
  // land on the file branch, so if this returned {url: …} instead of the value,
  // every book→book flow through one of them would start feeding its downstream
  // node a pointer where its input used to be.
  const records = new RecordsService();
  const payload = JSON.stringify({ items: [{ id: "a" }, { id: "b" }] });
  const stored = records.save(Buffer.from(payload, "utf8"), "run_1.json", "application/json");
  try {
    const prisma = new FakePrisma(
      { status: "success", errorMessage: null },
      record({ fileName: stored.fileName, url: stored.url, bytes: stored.size }),
    );
    const patch = await sync(prisma);
    assert.equal(patch.status, "success");
    assert.deepEqual(JSON.parse(String(patch.outputJson)).outputs, { items: [{ id: "a" }, { id: "b" }] });
  } finally {
    rmSync(path.join(MONOREPO_ROOT, "resource/records", stored.fileName), { force: true });
  }
});

test("a non-JSON file-branch product keeps the {value} shape a scalar output always had", async () => {
  const records = new RecordsService();
  const stored = records.save(Buffer.from("# 报告\n\n正文", "utf8"), "run_1.md", "text/markdown");
  try {
    const prisma = new FakePrisma(
      { status: "success", errorMessage: null },
      record({ fileName: stored.fileName, url: stored.url, bytes: stored.size, contentType: "text/markdown" }),
    );
    const patch = await sync(prisma);
    assert.deepEqual(JSON.parse(String(patch.outputJson)).outputs, { value: "# 报告\n\n正文" });
  } finally {
    rmSync(path.join(MONOREPO_ROOT, "resource/records", stored.fileName), { force: true });
  }
});

test("above the inline limit the node gets the pointer, and nothing that looks like a payload", async () => {
  const prisma = new FakePrisma(
    { status: "success", errorMessage: null },
    record({ fileName: "deadbeef-run_1.json", url: "/api/records/deadbeef-run_1.json", bytes: INLINE_OUTPUT_LIMIT + 1 }),
  );
  const patch = await sync(prisma);
  assert.equal(patch.status, "success");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).outputs, {
    url: "/api/records/deadbeef-run_1.json", fileName: "deadbeef-run_1.json", contentType: "application/json", bytes: INLINE_OUTPUT_LIMIT + 1,
  });
});

test("a row pointing at bytes that are gone fails the node instead of succeeding on a pointer", async () => {
  const prisma = new FakePrisma(
    { status: "success", errorMessage: null },
    record({ fileName: "0000000000000000-never-written.json", url: "/api/records/x", bytes: 12 }),
  );
  const patch = await sync(prisma);
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /产出读取失败/);
});

test("a run that landed no record settles the node with no outputs", async () => {
  const prisma = new FakePrisma({ status: "success", errorMessage: null }, null);
  const patch = await sync(prisma);
  assert.equal(patch.status, "success");
  assert.deepEqual(JSON.parse(String(patch.outputJson)), { outputs: {}, status: "success" });
});

test("a failed run still fails the node without consulting any record", async () => {
  const prisma = new FakePrisma({ status: "failed", errorMessage: "backend exploded" }, null);
  const patch = await sync(prisma);
  assert.equal(patch.status, "failed");
  assert.equal(patch.errorMessage, "backend exploded");
});

test("a contract-bearing product over the limit reaches a downstream node as a pointer, like any other file row", async () => {
  // `planOutputRecord` now sends a resolvable-ref payload past
  // INLINE_OUTPUT_LIMIT to the FILE branch, so `schemaName` non-null and
  // `data` null is a combination this method really receives — before the size
  // ceiling it could not happen. The first test here is `data`, so the contract
  // name must not change the answer: no `data`, over the limit, pointer.
  const prisma = new FakePrisma(
    { status: "success", errorMessage: null },
    record({
      fileName: "deadbeef-run_1.json",
      url: "/api/records/deadbeef-run_1.json",
      bytes: INLINE_OUTPUT_LIMIT + 1,
      schemaName: "book-output-nonempty-string",
      schemaVersion: 1,
    }),
  );
  const patch = await sync(prisma);
  assert.equal(patch.status, "success");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).outputs, {
    url: "/api/records/deadbeef-run_1.json",
    fileName: "deadbeef-run_1.json",
    contentType: "application/json",
    bytes: INLINE_OUTPUT_LIMIT + 1,
  });
});

test("a contract-bearing file product under the limit is still read back as a value", async () => {
  // The other half: landing a small contract payload to a file cannot happen
  // through planOutputRecord, but a file row that names a contract can arrive
  // here from `landArtifact` or a re-landed row, and the size — not the
  // contract — is what decides whether it is read back.
  const records = new RecordsService();
  const payload = JSON.stringify({ reply: "hi" });
  const stored = records.save(Buffer.from(payload, "utf8"), "run_small_contract.json", "application/json");
  try {
    const prisma = new FakePrisma(
      { status: "success", errorMessage: null },
      record({ fileName: stored.fileName, url: stored.url, bytes: stored.size, schemaName: "book-output-nonempty-string", schemaVersion: 1 }),
    );
    const patch = await sync(prisma);
    assert.deepEqual(JSON.parse(String(patch.outputJson)).outputs, { reply: "hi" });
  } finally {
    rmSync(path.join(MONOREPO_ROOT, "resource/records", stored.fileName), { force: true });
  }
});

// ── script 节点：进程拿到什么、产出被不被检查、环境给不给 ──────────────────

/** Drive the real `startScriptNode` against a real child process and wait for
 *  the node row to settle. Spawning for real is the point: the things being
 *  asserted here (what lands on stdin, which env survives) are properties of
 *  the spawn call, and a fake that stands in for the process would be asserting
 *  the fake. */
async function runScript(
  config: Record<string, unknown>,
  inputs: Record<string, unknown>,
  outputSchema: unknown = null,
  inputSchema: unknown = null,
): Promise<NodePatch> {
  const prisma = new FakePrisma(null, null);
  const service = new FlowRunnerService(prisma as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never);
  (service as unknown as { startScriptNode(n: unknown, r: unknown, i: unknown, c: unknown): void }).startScriptNode(
    { id: "n1", type: "script", position: { x: 0, y: 0 }, config },
    { id: "row_1", nodeId: "n1", nodeType: "script", status: "running", runId: null, outputJson: null },
    inputs,
    // `startNode` pre-resolves both citations and hands the pair down, so the
    // spawn path never awaits the registry from inside a process callback.
    { input: inputSchema, output: outputSchema },
  );
  for (let i = 0; i < 400 && prisma.patches.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(prisma.patches.length, 1, "节点必须恰好落一次终态");
  return prisma.patches[0];
}

/** A one-liner run through this same node binary — no interpreter to install. */
const nodeScript = (body: string) => ({ command: [process.execPath, "-e", body] });

test("script: stdin 收到的就是契约描述的那个对象,不多包一层", async () => {
  // 端口 id = 契约字段名,resolveInputs 按端口 id 建 key,所以进程读到的与
  // inputSchema 同形。此前只有一个 `input` 端口,进程收到的是 {"input":{...}},
  // 而没有任何地方写着这件事 —— 这正是「不知道入参怎么消费」的来源。
  const patch = await runScript(
    nodeScript('let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(s.trim()))'),
    { title: "耳夹", price: 9.9 },
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { title: "耳夹", price: 9.9 });
});

test("script: command 中的 $name 由入参同名字段替换", async () => {
  // command 模式也能消费契约了 —— argv 里 `$title` 这种槽位会被同名入参的值
  // 替换掉,而不是作为字面字符拼到命令里。这条是与 flowInput 端口一一对应的,
  // 此前完全做不到,于是 command 模式没有任何「绑定到入参」的途径。
  // 用 $-free 的 sentinel value 验证 spawn 时 argv 真收到了替换后的值,
  // 同时避开 source 字符串被 bash 重新解析的边缘情况。
  const patch = await runScript(
    { command: [process.execPath, "-e", 'console.log(JSON.stringify({argv: process.argv.slice(1), hits: process.argv.includes("__TITLE__")}))', "$title"] },
    { title: "__TITLE__" },
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  const out = JSON.parse(String(patch.outputJson)).output;
  assert.equal(out.hits, true, `argv 必须包含替换后的 "__TITLE__", 实际: ${JSON.stringify(out.argv)}`);
});

test("script: $name 在入参里没有 → spawn 失败并指明缺失字段名", async () => {
  // 缺失 token 必须 fail loudly,绝不能替换为空串或 `undefined` 静默放过去 —— 那
  // 比报错更难查,跑完会发现进程接到了一个它根本不知道是什么的 argv。
  const patch = await runScript(
    { command: [process.execPath, "-e", 'console.log(1)', "$missing"] },
    { title: "耳夹" },
  );
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /missing/);
});

test("script: $name 不会替换一半匹配的串($ 开头必须是完整 token)", async () => {
  // `$1` / `$x.y` / 裸 `$` 是 shell 写法的常见形态,不能被「看到 $ 就换」的简单
  // 替换错杀。token 语法限定 `^\$[A-Za-z_][A-Za-z0-9_]*$`,其它一切原样保留。
  // sentinel 值让测试不依赖 argv 索引,直接断"哪一段被替换、哪一段原样"
  const patch = await runScript(
    // argv 里既有该被原样放行的 `$1`,也有该被替换的 `$title`,对照看
    // 最后一项放的是 `__TITLE__`(替换后的值),倒数第二项必须是 `$1`(原样)
    { command: [process.execPath, "-e", 'const argv = process.argv.slice(1); console.log(JSON.stringify({raw: argv[argv.length-2], replaced: argv[argv.length-1]}))', "$1", "$title"] },
    { title: "__TITLE__" },
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { raw: "$1", replaced: "__TITLE__" });
});

test("script: 产出违反自己声明的 outputSchema,节点失败而不是把脏数据传下去", async () => {
  // 与 book 通道同一条 fail-closed 规则(见 syncBookNode)。script 通道此前
  // 完全不检查 —— 「契约被执行」对一种端点成立、对另一种不成立。
  const patch = await runScript(
    nodeScript('console.log(JSON.stringify({reply: 7}))'),
    {},
    { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] },
  );
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /产出不满足 outputSchema/);
});

test("script: 产出满足契约就照常放行", async () => {
  const patch = await runScript(
    nodeScript('console.log(JSON.stringify({reply: "好"}))'),
    {},
    { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] },
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
});

test("script: 日志随便打,取的仍是最后一行,且进程内存不被撑爆", async () => {
  const patch = await runScript(
    nodeScript('for(let i=0;i<2000;i++)console.log("noise "+i);console.log(JSON.stringify({ok:true}))'),
    {},
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { ok: true });
});

for (const interpreter of ['python', 'python3']) {
  test(`script: ${interpreter} uses the project environment and preserves cwd, stdin and argv`, async () => {
    const patch = await runScript({
      command: [interpreter, '-c', [
        'import json, os, subprocess, sys',
        'from PIL import ImageFont',
        'font = ImageFont.load_default(size=28)',
        'child_prefix = subprocess.check_output(["python3", "-c", "import sys; print(sys.prefix)"], text=True).strip()',
        'print(json.dumps({"prefix": sys.prefix, "childPrefix": child_prefix, "cwd": os.getcwd(), "input": json.load(sys.stdin), "arg": sys.argv[1], "fontSize": font.size}))',
      ].join('\n'), '$title'],
      cwd: 'scripts',
    }, { title: '商品 with spaces' });
    assert.equal(patch.status, 'success', patch.errorMessage ?? '');
    assert.deepEqual(JSON.parse(String(patch.outputJson)).output, {
      prefix: path.join(MONOREPO_ROOT, '.venv'),
      childPrefix: path.join(MONOREPO_ROOT, '.venv'),
      cwd: path.join(MONOREPO_ROOT, 'scripts'),
      input: { title: '商品 with spaces' },
      arg: '商品 with spaces',
      fontSize: 28,
    });
  });
}

test("scriptEnv: console 自己的密钥不进子进程", () => {
  process.env.BCP_TEST_FAKE_SECRET = "token-should-not-leak";
  try {
    const env = scriptEnv();
    // 这个进程加载了仓库的 .env;整份传下去等于每个脚本都能读凭证。
    assert.equal(env.BCP_TEST_FAKE_SECRET, undefined, "白名单之外的一律不给");
    assert.equal(env.PATH, process.env.PATH, "但解释器还得找得到");
  } finally {
    delete process.env.BCP_TEST_FAKE_SECRET;
  }
});

test("keepTail: 留的是尾巴,因为结果在最后一行", () => {
  assert.equal(keepTail("abc", 10), "abc");
  assert.equal(keepTail("abcdefghij", 4), "ghij");
});

test("script: 内联只写函数体,读参数和打印结果都不用自己写", async () => {
  // 作者写的就是下面这一行。stdin 解析、结果序列化、「结果必须是 stdout 最后
  // 一行且另起一行」这套协议全部由骨架代劳 —— 这些样板每次都一样,而写错的
  // 样子与「节点坏了」无法区分。
  const patch = await runScript(
    { language: "ts", source: "return { doubled: (params as { n: number }).n * 2 };" },
    { n: 21 },
    { type: "object", properties: { doubled: { type: "integer" } }, required: ["doubled"] },
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { doubled: 42 });
});

test("script: 内联代码跑在沙箱里,读不到脚本目录以外的文件", async () => {
  // S8 的全部意义。它防的不是操作者本人 —— 能打开这个面板的人本来就有这台机器
  // 的 shell。它防的是**来源**:内联代码经常是粘来的或模型生成的,写它的人和跑它
  // 的人不是同一个。Node 自己的 --permission 挡住 fs / 子进程 /
  // worker / 原生插件,而且 Mac、Linux、Windows 行为一致、零新依赖。
  // 注意不是 node:vm(官方明写不是安全机制),也不是 vm2(2023 年因逃逸 CVE 停维护)。
  // 覆盖面见下一条:网络不在其中。
  const patch = await runScript(
    {
      language: "ts",
      // 动态 import:body 落在 handler 函数体内,顶层 import 语句在那里非法。
      source: 'const fs = await import("node:fs");\ntry { fs.readFileSync("/etc/passwd", "utf8"); return { escaped: true }; }\ncatch (e) { return { blocked: (e as { code?: string }).code }; }',
    },
    {},
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { blocked: "ERR_ACCESS_DENIED" }, "逃出去就说明沙箱没生效");
});

test("script: 沙箱也挡住起子进程", async () => {
  const patch = await runScript(
    {
      language: "ts",
      source: 'const cp = await import("node:child_process");\ntry { cp.execSync("id"); return { escaped: true }; }\ncatch (e) { return { blocked: (e as { code?: string }).code }; }',
    },
    {},
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { blocked: "ERR_ACCESS_DENIED" });
});

test("script: 内联代码里随便打日志,不影响结果被取到", async () => {
  const patch = await runScript(
    { language: "ts", source: 'console.log("正在处理");\nconsole.log("还在处理");\nreturn { ok: true };' },
    {},
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { ok: true });
});

test("script: 内联代码的产出照样要过 outputSchema", async () => {
  const patch = await runScript(
    { language: "ts", source: "return { reply: 7 } as never;" },
    {},
    { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] },
  );
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /产出不满足 outputSchema/);
});

test("script: 不再支持的语言被明确拒绝,而不是默默按 TS 跑", async () => {
  const patch = await runScript({ language: "python", source: 'return {"a": 1}' } as never, {});
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /不支持的脚本语言/);
});

test("script: 既没内联代码也没命令,说清楚是哪种没配", async () => {
  const patch = await runScript({}, {});
  assert.equal(patch.status, "failed");
  assert.match(String(patch.errorMessage), /既没有内联代码也没有命令/);
});

// ── 试运行：和正式跑同一条执行通道 ─────────────────────────────────────────

/** `dryRunScript` 是公开方法,直接调。schemas 传 null —— 只要 config 里没有
 *  引用,resolveSchemaCitation 就不会碰它;被碰到就说明这个测试对依赖判断错了。 */
function dryRunner(): { dryRunScript(config: unknown, params: Record<string, unknown>, signal?: AbortSignal): Promise<ScriptOutcome> } {
  return new FlowRunnerService(
    new FakePrisma(null, null) as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never,
  ) as never;
}

test("试运行: 直接跑面板上的代码,不需要先存流程", async () => {
  const outcome = await dryRunner().dryRunScript(
    { language: "ts", source: "const p = params as { a: number; b: number };\nreturn { sum: p.a + p.b };" },
    { a: 40, b: 2 },
  );
  assert.equal(outcome.ok, true, String(outcome.error ?? ""));
  assert.deepEqual(outcome.output, { sum: 42 });
  assert.ok(typeof outcome.durationMs === "number");
});

test("试运行: 脚本报错时,把 stderr 原样交回去给人看", async () => {
  // 试运行的全部价值就在于「告诉我它到底怎么了」,所以失败路径比成功路径更
  // 重要:吞掉 stderr 等于把人打回去猜。
  const outcome = await dryRunner().dryRunScript(
    { language: "ts", source: 'throw new Error("样例入参不对");' },
    {},
  );
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.stderr), /样例入参不对/);
  assert.match(String(outcome.error), /退出码 1/);
});

test("试运行: 产出契约照样生效,和正式跑同一套判定", async () => {
  const outcome = await dryRunner().dryRunScript(
    {
      language: "ts",
      source: "return { reply: 7 };",
      // 直接内联契约走不通(dryRunScript 只认注册表引用),所以这里验的是
      // 「没有引用时不校验」——契约生效那半由正式跑的用例覆盖,两者同一函数。
    },
    {},
  );
  assert.equal(outcome.ok, true, String(outcome.error ?? ""));
  assert.deepEqual(outcome.output, { reply: 7 });
});

test('试运行: 入参契约在执行代码前拒绝错误类型', async () => {
  const outcome = await dryRunner().dryRunScript(
    {
      language: 'ts',
      source: 'return { ok: true };',
      inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    },
    { count: 'not-a-number' },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCategory, 'input');
  assert.match(String(outcome.error), /^入参不满足 inputSchema/);
});

test('试运行: 语法错误映射到用户函数体并隐藏临时文件路径', async () => {
  const outcome = await dryRunner().dryRunScript(
    { language: 'ts', source: 'const value = ;\nreturn value;' },
    {},
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCategory, 'syntax');
  assert.equal(outcome.errorLocation?.line, 1, JSON.stringify(outcome));
  assert.doesNotMatch(`${outcome.error}\n${outcome.stderr}`, /bcp-flow-script-|\/tmp\//);
  assert.match(String(outcome.error), /脚本第 1 行/);
});

test('试运行: 权限、模块和网络错误提供可操作分类', async () => {
  const permission = await dryRunner().dryRunScript(
    { language: 'ts', source: "await import('node:fs').then((fs) => fs.readFileSync('/etc/passwd'));\nreturn {};" },
    {},
  );
  assert.equal(permission.errorCategory, 'permission');

  const moduleLoad = await dryRunner().dryRunScript(
    { language: 'ts', source: "await import('package-that-does-not-exist-for-script-test');\nreturn {};" },
    {},
  );
  assert.equal(moduleLoad.errorCategory, 'module');

  const network = await dryRunner().dryRunScript(
    { language: 'ts', source: "await fetch('http://127.0.0.1:1');\nreturn {};" },
    {},
  );
  assert.equal(network.errorCategory, 'network');
});

test("试运行: 配置不是对象就明确拒绝,不去 spawn 什么东西", async () => {
  await assert.rejects(() => dryRunner().dryRunScript("rm -rf /", {}), /需要一份 script 节点配置/);
  await assert.rejects(() => dryRunner().dryRunScript(null, {}), /需要一份 script 节点配置/);
});

test('试运行: 用户停止后会终止仍在运行的脚本进程', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = dryRunner().dryRunScript(
    { language: 'ts', source: 'await new Promise((resolve) => setTimeout(resolve, 10_000));\nreturn { late: true };' },
    {},
    controller.signal,
  );
  setTimeout(() => controller.abort(), 30);
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.error), /已停止/);
  assert.ok(Date.now() - startedAt < 2_000, 'stopping a trial should not wait for its normal timeout');
});

// ── 大产出落文件：outputJson 存指针而不是整份 payload ───────────────────────

test("产出超过内联上限时落文件,行里只留指针", async () => {
  // 每个 dispatcher tick 都会重读已完成节点的产出来解析出边,所以一份几 MB 的
  // 产物会被每秒重解析五次。Prisma 那列的注释从写下起就描述了 $ref 形态,
  // 代码却一直无条件整份塞进去。
  const prisma = new FakePrisma(null, null);
  const service = new FlowRunnerService(prisma as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never);
  const big = { items: Array.from({ length: 40000 }, (_, i) => ({ id: i, name: "商品" + i })) };
  const raw = JSON.stringify(big);
  assert.ok(raw.length > INLINE_OUTPUT_LIMIT, `前提:样本要真的超限(${raw.length}B)`);

  await (service as unknown as { finishNode(id: string, s: string, r: unknown): Promise<void> })
    .finishNode("row_big", "success", { output: big });

  const stored = JSON.parse(String(prisma.patches[0].outputJson));
  assert.equal(typeof stored.$ref, "string", "行里存的是指针");
  assert.equal(stored.bytes, raw.length);
  assert.ok(String(stored.$ref).startsWith("resource/flow-runs/"), stored.$ref);
  // 指针不是空头支票:文件里得是那份产物,且读得回来。
  const readBack = await (service as unknown as { readOutput(j: string | null): Promise<unknown> })
    .readOutput(prisma.patches[0].outputJson ?? null);
  assert.deepEqual(readBack, big);
  rmSync(path.join(MONOREPO_ROOT, "resource/flow-runs/flowrun_test"), { recursive: true, force: true });
});

test("产出没超限就照旧内联,不平白多出一个文件", async () => {
  const prisma = new FakePrisma(null, null);
  const service = new FlowRunnerService(prisma as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never);
  await (service as unknown as { finishNode(id: string, s: string, r: unknown): Promise<void> })
    .finishNode("row_small", "success", { output: { ok: true } });
  assert.equal(prisma.patches[0].outputJson, '{"ok":true}');
});

test("指针指向仓库外一律拒绝,数据库行不是信任边界", async () => {
  const service = new FlowRunnerService(new FakePrisma(null, null) as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never);
  const readOutput = (service as unknown as { readOutput(j: string | null): Promise<unknown> }).readOutput.bind(service);
  await assert.rejects(() => readOutput(JSON.stringify({ $ref: "/etc/passwd" })), /读不出来/);
  await assert.rejects(() => readOutput(JSON.stringify({ $ref: "../../../etc/passwd" })), /读不出来/);
});

// ── 全局执行名额 ───────────────────────────────────────────────────────────

/** 两条流程各有一个就绪的 book 节点。够驱动真实的 `advance()`——这条不变量
 *  的落点在那里,不在 planDispatch:后者一直是对的,只是被每条 run 各问了一遍。 */
class TwoRunPrisma {
  started: string[] = [];
  private readonly nodes: Array<Record<string, unknown>>;
  /** 已取消的那条 run 的 id —— 它的 book 行永远停在 running。 */
  static readonly DEAD = "r_cancelled";
  /** 父 run 的真实记录,假 count 要按它求值 —— 只判「where 里有没有 flowRun 这个
   *  键」的假货,在「把 cancelled 加进白名单」这种变异下照样绿,那就等于没测。 */
  private readonly parents: Record<string, { status: string; deletedAt: Date | null; flowDeletedAt: Date | null }> = {
    r1: { status: "running", deletedAt: null, flowDeletedAt: null },
    r2: { status: "running", deletedAt: null, flowDeletedAt: null },
    [TwoRunPrisma.DEAD]: { status: "cancelled", deletedAt: null, flowDeletedAt: null },
  };
  constructor(private readonly graphSnapshot: string, cancelledNodeStatus = 'cancelled') {
    this.nodes = ["r1", "r2"].map((flowRunId) => ({
      id: `${flowRunId}_row`, flowRunId, nodeId: "b1", nodeType: "book",
      status: "pending", runId: null, outputJson: null, startedAt: null, deletedAt: null,
      // `iteration` is not decoration: the visibility filter keeps rows whose
      // iteration is null, and `undefined` is not null — a fake missing a
      // column the engine reads is a fake that tests something else.
      iteration: null,
    }));
    this.nodes.push({
      id: "dead_row", flowRunId: TwoRunPrisma.DEAD, nodeId: "b1", nodeType: "book",
      status: cancelledNodeStatus, runId: "run_dead", outputJson: null, startedAt: new Date(), deletedAt: null,
      iteration: null,
    });
  }
  readonly flowRun = {
    // 只返回活着的 run —— 与真实的 where 一致,已取消那条不在其中。
    findMany: async () => ["r1", "r2"].map((id) => ({
      id, status: "running", graphSnapshot: this.graphSnapshot, paramsJson: "{}", mode: "auto",
      nodes: this.nodes.filter((n) => n.flowRunId === id),
    })),
    update: async () => ({}),
    updateMany: async () => ({ count: 1 }),
    findUnique: async () => ({ startedAt: new Date(), queuedAt: new Date(), flow: { outputSchema: null } }),
  };
  readonly flowNodeRun = {
    // 关键:跨所有 run 统计,而不是只看当前这条。
    // 按 where **逐条**求值,包括父 run 的 status 白名单。上一版只判
    // `where.flowRun` 这个键存不存在,于是「把 cancelled 加进白名单」「删掉
    // status 条件」两种变异都照样绿 —— 断言只证明了「有个 flowRun 键」,
    // 而用例名承诺的是「已取消的不占名额」。
    count: async ({ where }: any) => {
      const parents = this.parents;
      return this.nodes.filter((n) => {
        if (n.status !== where.status || !where.nodeType.in.includes(n.nodeType)) return false;
        if (where.deletedAt === null && n.deletedAt !== null) return false;
        const parent = parents[n.flowRunId as string];
        const cond = where.flowRun;
        if (!cond) return true;
        if (cond.status?.in && !cond.status.in.includes(parent.status)) return false;
        if (cond.deletedAt === null && parent.deletedAt !== null) return false;
        if (cond.flow?.deletedAt === null && parent.flowDeletedAt !== null) return false;
        return true;
      }).length;
    },
    findMany: async ({ where }: any) =>
      this.nodes.filter((n) => !where?.flowRunId || n.flowRunId === where.flowRunId),
    findUnique: async ({ where }: any) => this.nodes.find((n) => n.id === where.id) ?? null,
    update: async ({ where, data }: any) => {
      const row = this.nodes.find((n) => n.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.nodes.filter((row) => (!where.id || row.id === where.id) &&
        (!where.status || (where.status.in ? where.status.in.includes(row.status) : row.status === where.status)));
      rows.forEach((row) => Object.assign(row, data));
      return { count: rows.length };
    },
  };
  readonly run = { update: async () => ({}), findUnique: async () => null };
}

test("F2: 两条流程同时就绪,全局也只放行一个会做事的节点", async () => {
  // 浏览器是独占资源:Chrome 对被遮挡的窗口停止渲染,两个 book 同时跑正是
  // 「可复现的运行变成偶发失败」的来路。名额此前是每条 flow run 各算一份,
  // 于是 N 条并发的流程就是 N 个浏览器。
  const graph = JSON.stringify({
    nodes: [{ id: "b1", type: "book", position: { x: 0, y: 0 }, config: { bookId: "bk" } }],
    edges: [],
  });
  const prisma = new TwoRunPrisma(graph);
  const enqueued: string[] = [];
  const enqueue = { enqueue: async ({ dedupeKey }: any) => { enqueued.push(dedupeKey); return { run: { id: `run_${enqueued.length}` } }; } };
  const service = new FlowRunnerService(
    prisma as never, enqueue as never, null as never, new RecordsService(), null as never, null as never, null as never,
  );
  (service as unknown as { reconciled: boolean }).reconciled = true;

  await service.advance();

  assert.equal(enqueued.length, 1, `同一拍里只该派发一个 book，实际 ${enqueued.length} 个：${enqueued.join(", ")}`);
});

test('F2: 已取消父运行的节点未确认停止时仍保留名额', async () => {
  const graph = JSON.stringify({
    nodes: [{ id: "b1", type: "book", position: { x: 0, y: 0 }, config: { bookId: "bk" } }],
    edges: [],
  });
  const prisma = new TwoRunPrisma(graph, 'running');
  const enqueued: string[] = [];
  const enqueue = { enqueue: async ({ dedupeKey }: any) => { enqueued.push(dedupeKey); return { run: { id: `run_${enqueued.length}` } }; } };
  const service = new FlowRunnerService(
    prisma as never, enqueue as never, null as never, new RecordsService(), null as never, null as never, null as never,
  );
  (service as unknown as { reconciled: boolean }).reconciled = true;

  await service.advance();

  assert.equal(enqueued.length, 0, '终止未确认时不能复用浏览器名额');
});

test("script: 沙箱**不**封网络——把这条已知边界钉住,而不是假装它不存在", async () => {
  // 冷 panel 抓到的:代码注释、面板文案、注入进每个脚本头部的那句话,四处都写着
  // 「网络被封」,而 Node 22 根本没有网络权限档(--allow-net 是 bad option,v25 才有)。
  // 更糟的是那次改动把原本正确的橙色告警换成了这句假话 —— 比不改更危险。
  //
  // 所以这条断言的方向是反的:它断言网络**是通的**。将来把运行时提到带 --allow-net
  // 的 Node 并真封上,这条会变红 —— 那时红的是提醒去更新四处文案,不是回归。
  const patch = await runScript(
    {
      language: "ts",
      source:
        'const net = await import("node:net");\n' +
        'return await new Promise((res) => {\n' +
        '  const srv = net.createServer();\n' +
        '  srv.on("error", (e: { code?: string }) => res({ listen: e.code ?? "err" }));\n' +
        '  srv.listen(0, "127.0.0.1", () => { srv.close(); res({ listen: "OPEN" }); });\n' +
        '});',
    },
    {},
  );
  assert.equal(patch.status, "success", patch.errorMessage ?? "");
  assert.deepEqual(
    JSON.parse(String(patch.outputJson)).output,
    { listen: "OPEN" },
    "网络若真被封了,说明运行时换了——去把 interpreterFor / 面板 / 骨架三处文案一起改",
  );
});

test("试运行: 拒绝 command,否则它就是一个无鉴权的任意执行接口", async () => {
  // 逃逸链:内联代码在沙箱里但网络是通的 → fetch 打本机 console 的
  // /api/flows/script/dry-run → 传 {config:{command:[...]}} → 命令模式不套沙箱
  // → 拿到 console 用户完整权限。
  //
  // 这道门关掉的是**最短**的一条,不是全部:同样无鉴权的 `POST /api/flows` +
  // `POST /api/flows/:id/trigger` 可以落一张带 command 节点的图再触发它,两次
  // 请求换掉一次,结果等价。真正的边界是给 loopback API 加鉴权,那件事还没做。
  // 这里写清楚,是因为上一版在同一位置写过「不必给 loopback 加鉴权」——把一句
  // 可证伪的安全结论固化进注释,下一个维护者就会据此认为逃逸面已经闭合。
  await assert.rejects(
    () => dryRunner().dryRunScript({ command: ["/bin/sh", "-c", "id"] }, {}),
    /试运行只跑内联代码/,
  );
});

test("script: 临时目录取 realpath,否则 macOS 上每个内联节点都跑不起来", async () => {
  // --allow-fs-read 是按解析后的路径匹配的,而 macOS 的 os.tmpdir() 在 /var 下,
  // /var 是指向 private/var 的符号链接 —— 不 realpath 就会授权一条 Node 永远
  // 看不到的路径,进程在 resolveMainPath 里就 ERR_ACCESS_DENIED 了。
  const { realpathSync, mkdtempSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(path.join(tmpdir(), "bcp-symlink-probe-"));
  mkdirSync(path.join(base, "real"));
  symlinkSync("real", path.join(base, "link"));
  const original = process.env.TMPDIR;
  process.env.TMPDIR = path.join(base, "link");
  try {
    const patch = await runScript({ language: "ts", source: "return { ok: 1 };" }, {});
    assert.equal(patch.status, "success", `符号链接 TMPDIR 下也必须跑得起来：${patch.errorMessage}`);
    assert.deepEqual(JSON.parse(String(patch.outputJson)).output, { ok: 1 });
  } finally {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
    rmSync(base, { recursive: true, force: true });
    void realpathSync;
  }
});

// ── map：失败的那一轮必须仍然可见 ───────────────────────────────────────────

test("map: 失败的 map 行仍然读得出下标 —— 否则整条 run 会挂死", async () => {
  // 实跑抓到的 bug。finishNode 在只给 error 时把 outputJson 写成 null，于是
  // map 的 $map 状态被抹掉 → mapIndexes 回落到 0 → 可见的变成第 0 轮(成功的
  // 那一轮) → 下游 collect 被当成 ready，而 collect 又被排除在 dispatch 之外,
  // 于是永远 pending，run 卡在 running 不结束。
  const { mapIndexes } = await import("./flow-runner.service.js");
  const graph = { nodes: [{ id: "m", type: "map", position: { x: 0, y: 0 }, config: {} }], edges: [] } as never;

  const withState = mapIndexes(
    [{ nodeId: "m", iteration: null, outputJson: JSON.stringify({ [MAP_STATE_KEY]: { items: ["a", "b"], index: 1, results: [], failed: [] } }) }],
    graph,
  );
  assert.equal(withState.get("m"), 1, "失败时状态必须跟着一起写下来");

  const wiped = mapIndexes([{ nodeId: "m", iteration: null, outputJson: null }], graph);
  assert.equal(wiped.get("m"), 0, "状态没了就只能回落到 0 —— 这正是当初挂死的形态");
});

test("map: failMap 把状态与错误一起落盘,并顺手把 collect 收口", async () => {
  // 上一条只测了 mapIndexes 这个「机制」,没穿过真正写盘的那条路 —— 于是把
  // failMap 的 output 改成 undefined(还原 bug)它照样绿。这条补上那一段。
  const patches: Array<Record<string, unknown>> = [];
  const prisma = {
    flowNodeRun: {
      findUnique: async () => ({ startedAt: new Date(), flowRunId: "r1", nodeId: "m" }),
      update: async ({ where, data }: any) => { patches.push({ id: where.id, ...data }); return data; },
      updateMany: async ({ where, data }: any) => { patches.push({ id: where.id, ...data }); return { count: 1 }; },
      findFirst: async () => ({ id: "collect_row", status: "pending" }),
    },
  };
  const service = new FlowRunnerService(prisma as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never);
  const state = { items: ["a", "b", "c"], index: 1, results: ["A"], failed: [] };

  await (service as unknown as { failMap(f: string, m: string, c: string, e: string, s?: unknown): Promise<void> })
    .failMap("r1", "map_row", "collect_1", "第 2 项处理失败（共 3 项）", state);

  const mapPatch = patches.find((p) => p.id === "map_row")!;
  assert.equal(mapPatch.status, "failed");
  assert.match(String(mapPatch.errorMessage), /第 2 项/);
  // 关键:状态必须跟着错误一起写下去,否则下标回落到 0,可见的变成成功的那一轮,
  // collect 永远 ready-but-never-dispatched,run 卡死。
  assert.equal(
    readMapState(JSON.parse(String(mapPatch.outputJson)))?.index,
    1,
    "错误行也要带着 $map 状态,否则整条 run 会挂",
  );

  const collectPatch = patches.find((p) => p.id === "collect_row")!;
  assert.equal(collectPatch.status, "skipped", "collect 必须由控制器收口 —— 通用调度够不到它");
});

// ── 节点抛异常 = 节点失败，不是整条流程挂死 ────────────────────────────────

test("a node that throws fails that node, instead of hanging the run at running", async () => {
  // This is the defect class, not one node's bug. A branch comparing against a
  // number reached `.trim()` and threw; the row had already been marked
  // `running`, so the exception unwound past it to the tick's catch and the run
  // stayed `running` FOREVER — one log line every 200ms into a file nobody
  // reads, while the console showed a node that had simply never finished.
  //
  // Whatever the next bug in any node type turns out to be, it has to arrive as
  // a failed node carrying its message, not as an unkillable run.
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    flowNodeRun: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { id: "n1" };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      },
      findUnique: async () => ({ id: "n1", flowRunId: "r1", nodeId: "boom", iteration: null, startedAt: new Date() }),
    },
  };
  const service = new FlowRunnerService(prisma as never, null as never, null as never, new RecordsService(), null as never, null as never, null as never);

  // `transform` with an expression that blows up inside the runner is the
  // smallest way to reach the same path a branch did.
  const node = { id: "boom", type: "branch", position: { x: 0, y: 0 }, config: { cases: [{ id: "a", left: "$", op: "gt", right: {} }] } };
  await (service as never as { startNode(r: unknown, n: unknown, row: unknown, i: unknown): Promise<void> }).startNode(
    { id: "r1", paramsJson: "{}", mode: "auto" },
    node,
    { id: "n1", nodeId: "boom", status: "pending" },
    { input: Symbol("not comparable") },
  );

  const final = updates.at(-1)!;
  assert.notEqual(final.status, "running", `节点不能停在 running：${JSON.stringify(updates)}`);
  assert.equal(final.status, "failed");
  assert.ok(String(final.errorMessage ?? "").length > 0, "失败必须带上原因,否则和挂死一样查不了");
});
