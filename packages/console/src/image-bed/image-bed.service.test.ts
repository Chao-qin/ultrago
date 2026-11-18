import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ImageBedConfigService } from "./image-bed.config.js";
import {
  GitHubImageBedService,
  IMAGE_BED_MAX_BYTES,
  assertSafeRemotePath,
  buildCdnUrl,
  buildMarkdown,
  buildRemotePath,
  buildRawUrl,
  guessMime,
  sanitizeSegment,
  sanitizeSubDir,
  validateUpload,
} from "./github-image-bed.service.js";
import { ImageBedService, generateRemoteName } from "./image-bed.service.js";
import type { GitHubImageBedConfig } from "./image-bed.types.js";

const CONFIG: GitHubImageBedConfig = {
  token: "tok_test",
  owner: "acme",
  repo: "bed",
  branch: "main",
  pathPrefix: "images",
  customDomain: "",
};

/** 只提供 bed 真正用到的两个方法，避免测试读取真实环境变量。 */
function stubConfig(over: Partial<GitHubImageBedConfig> = {}) {
  const cfg = { ...CONFIG, ...over };
  return {
    get: () => cfg,
    tryGet: () => cfg,
  } as unknown as ImageBedConfigService;
}

type Call = { url: string; init?: RequestInit };
/** 按 method + url 前缀分派的假 fetch。未匹配的请求直接 500，让漏配立即暴露。 */
function fakeFetch(routes: Record<string, Response | ((c: Call) => Response)>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [key, value] of Object.entries(routes)) {
      const [m, frag] = key.split(" ");
      if (m !== method) continue;
      if (u.includes(frag)) return typeof value === "function" ? value({ url: u, init }) : value;
    }
    return new Response("unrouted", { status: 500 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function bedWith(routes: Record<string, Response | ((c: Call) => Response)>, over: Partial<GitHubImageBedConfig> = {}) {
  const bed = new GitHubImageBedService(stubConfig(over));
  const { impl, calls } = fakeFetch(routes);
  bed.fetchImpl = impl;
  return { bed, calls };
}

// ────────────────────────────────────────────────────────────
//  纯函数
// ────────────────────────────────────────────────────────────

test("类型与体积在上传前就被拒，不打到 GitHub", () => {
  assert.equal(validateUpload("a.exe", 10).error_code, "INVALID_FILE_TYPE");
  assert.equal(validateUpload("a", 10).error_code, "INVALID_FILE_TYPE");
  assert.equal(validateUpload("a.png", 0).error_code, "FILE_TOO_LARGE");
  assert.equal(validateUpload("a.png", IMAGE_BED_MAX_BYTES + 1).error_code, "FILE_TOO_LARGE");
  assert.equal(validateUpload("a.png", 10).valid, true);
  assert.equal(validateUpload("a.JPG", 10).valid, true, "扩展名大小写不敏感");
});

test("文件名被压成单个安全段，路径穿不出去", () => {
  assert.equal(sanitizeSegment("../../etc/passwd"), "passwd");
  assert.equal(sanitizeSegment("C:\\Users\\me\\photo.png"), "photo.png");
  assert.equal(sanitizeSegment(".."), "");
  assert.equal(sanitizeSegment("报告 2026.png"), "报告 2026.png");
  assert.equal(sanitizeSegment("a/b/c.png"), "c.png");
  assert.equal(sanitizeSegment('a"b<c>d|e:f?g*h.txt'), "abcdefgh.txt");
});

test("远程路径由 prefix + subDir + name 拼成，空段自动跳过", () => {
  assert.equal(buildRemotePath(CONFIG, "articles/2026-09", "a.png"), "images/articles/2026-09/a.png");
  assert.equal(buildRemotePath(CONFIG, undefined, "a.png"), "images/a.png");
  assert.equal(buildRemotePath({ ...CONFIG, pathPrefix: "" }, "", "a.png"), "a.png");
});

test("子目录保留多层结构，不会被压成最后一段", () => {
  assert.equal(sanitizeSubDir("articles/2026-09"), "articles/2026-09");
  assert.equal(sanitizeSubDir("/articles/2026-09/"), "articles/2026-09");
  // 穿目录的段被丢掉而不是被拼进路径
  assert.equal(sanitizeSubDir("../../etc"), "etc");
  assert.equal(sanitizeSubDir("a//b"), "a/b");
  assert.equal(sanitizeSubDir(""), "");
});

test("CDN 直链默认走 jsDelivr，配了自定义域名就用它", () => {
  assert.equal(
    buildCdnUrl(CONFIG, "images/a.png"),
    "https://cdn.jsdelivr.net/gh/acme/bed@main/images/a.png",
  );
  assert.equal(buildCdnUrl({ ...CONFIG, customDomain: "https://img.acme.com" }, "images/a.png"), "https://img.acme.com/images/a.png");
  assert.equal(buildRawUrl(CONFIG, "images/a.png"), "https://raw.githubusercontent.com/acme/bed/main/images/a.png");
});

test("markdown 对图片是 ![]()，对普通文件是 []()", () => {
  assert.equal(buildMarkdown(CONFIG, "images/a.png", "a.png"), "![a.png](https://cdn.jsdelivr.net/gh/acme/bed@main/images/a.png)");
  assert.equal(buildMarkdown(CONFIG, "images/a.pdf", "a.pdf"), "[a.pdf](https://cdn.jsdelivr.net/gh/acme/bed@main/images/a.pdf)");
});

test("下载/删除的 path 必须是仓库内相对路径", () => {
  assert.equal(assertSafeRemotePath("images/a.png"), "images/a.png");
  assert.throws(() => assertSafeRemotePath(""), /不能为空/);
  assert.throws(() => assertSafeRemotePath("/etc/passwd"), /相对路径/);
  assert.throws(() => assertSafeRemotePath("images/../../secret"), /非法/);
  assert.throws(() => assertSafeRemotePath("C:\\secret"), /相对路径/);
});

test("生成的远程名带日期前缀 + 随机后缀，扩展名保留", () => {
  const a = generateRemoteName("photo.PNG");
  assert.match(a, /^\d{8}_\d{6}_[0-9a-f]{8}\.png$/);
  assert.notEqual(a, generateRemoteName("photo.PNG"), "同秒并发不应撞名");
});

test("mime 按扩展名猜，认不出就兜 octet-stream", () => {
  assert.equal(guessMime("a.png"), "image/png");
  assert.equal(guessMime("a.jpg"), "image/jpeg");
  assert.equal(guessMime("a.bin"), "application/octet-stream");
});

// ────────────────────────────────────────────────────────────
//  上传
// ────────────────────────────────────────────────────────────

test("上传：先查 sha（404）再 PUT，返回三种链接", async () => {
  const { bed, calls } = bedWith({
    "GET /repos/acme/bed/contents/images/a.png": new Response("nope", { status: 404 }),
    "PUT /repos/acme/bed/contents/images/a.png": json({
      content: { sha: "sha123", size: 42, html_url: "https://github.com/acme/bed/blob/main/images/a.png" },
    }),
  });

  const r = await bed.upload({ bytes: Buffer.from("pix"), filename: "a.png" }, { remoteName: "a.png" });

  assert.equal(r.success, true);
  assert.equal(r.sha, "sha123");
  assert.equal(r.remote_path, "images/a.png");
  assert.equal(r.cdn_url, "https://cdn.jsdelivr.net/gh/acme/bed@main/images/a.png");
  assert.equal(r.download_url, "/api/files/download?path=images%2Fa.png");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init?.method, "PUT");
});

test("上传：远程已存在且未开 overwrite → FILE_EXISTS，不发起 PUT", async () => {
  const { bed, calls } = bedWith({
    "GET /repos/acme/bed/contents/images/a.png": json({ sha: "old" }),
    "PUT /repos/acme/bed/contents/images/a.png": json({ content: { sha: "x", size: 1, html_url: "" } }),
  });

  const r = await bed.upload({ bytes: Buffer.from("pix"), filename: "a.png" }, { remoteName: "a.png" });

  assert.equal(r.success, false);
  assert.equal(r.error_code, "FILE_EXISTS");
  assert.ok(!calls.some((c) => c.init?.method === "PUT"), "不该有写请求");
});

test("上传：开 overwrite 时把原 sha 带给 GitHub", async () => {
  const { bed, calls } = bedWith({
    "GET /repos/acme/bed/contents/images/a.png": json({ sha: "old" }),
    "PUT /repos/acme/bed/contents/images/a.png": json({ content: { sha: "new", size: 3, html_url: "" } }),
  });

  const r = await bed.upload({ bytes: Buffer.from("pix"), filename: "a.png" }, { remoteName: "a.png", overwrite: true });

  assert.equal(r.success, true);
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.sha, "old", "覆盖必须带原 sha，否则 GitHub 会 422");
  assert.ok(body.content.length > 0);
});

test("上传：401 映射成 TOKEN_INVALID 而不是抛异常", async () => {
  const { bed } = bedWith({
    "GET /repos/acme/bed/contents/images/a.png": json({ message: "Bad credentials" }, 401),
  });
  const r = await bed.upload({ bytes: Buffer.from("pix"), filename: "a.png" }, { remoteName: "a.png" });
  assert.equal(r.success, false);
  assert.equal(r.error_code, "TOKEN_INVALID");
  assert.match(r.error!, /Bad credentials/);
});

test("上传：403 且命中 rate limit 时单独报 RATE_LIMITED", async () => {
  const { bed } = bedWith({
    "GET /repos/acme/bed/contents/images/a.png": new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-ratelimit-reset": "1700000000" },
    }),
  });
  const r = await bed.upload({ bytes: Buffer.from("pix"), filename: "a.png" }, { remoteName: "a.png" });
  assert.equal(r.error_code, "RATE_LIMITED");
});

test("上传本地文件：不存在 / 类型不支持都在读盘阶段被拒", async () => {
  const { bed, calls } = bedWith({});
  const missing = await bed.uploadFile("/definitely/not/here.png");
  assert.equal(missing.error_code, "FILE_NOT_FOUND");
  assert.equal(calls.length, 0, "不该打到 GitHub");
});

test("上传本地文件：读盘后走同一条上传链路", async () => {
  const dir = path.join(tmpdir(), `bcp-bed-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "shot.png");
  writeFileSync(file, Buffer.from("image-bytes"));
  try {
    const { bed, calls } = bedWith({
      "GET /repos/acme/bed/contents/images/shot.png": new Response("nope", { status: 404 }),
      "PUT /repos/acme/bed/contents/images/shot.png": json({ content: { sha: "s1", size: 11, html_url: "" } }),
    });
    const r = await bed.uploadFile(file, { remoteName: "shot.png" });
    assert.equal(r.success, true);
    assert.equal(r.remote_path, "images/shot.png");
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────
//  下载 / 列举 / 删除 / 校验
// ────────────────────────────────────────────────────────────

test("下载走 raw 媒体类型，并带上 Authorization（私有仓库也能取）", async () => {
  const { bed, calls } = bedWith({
    "GET /repos/acme/bed/contents/images/a.png": new Response(Buffer.from("PNGDATA"), {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  });
  const file = await bed.download("images/a.png");
  assert.equal(file.bytes.toString(), "PNGDATA");
  assert.equal(file.filename, "a.png");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Accept, "application/vnd.github.raw");
  assert.equal(headers.Authorization, "Bearer tok_test");
});

test("列举只返回文件，目录被过滤，且带上可下载链接", async () => {
  const { bed } = bedWith({
    "GET /repos/acme/bed/contents/images": json([
      { type: "file", name: "a.png", path: "images/a.png", sha: "s1", size: 10, html_url: "h1" },
      { type: "dir", name: "2026-09", path: "images/2026-09", sha: "s2", size: 0, html_url: "h2" },
    ]),
  });
  const items = await bed.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "a.png");
  assert.equal(items[0].download_url, "/api/files/download?path=images%2Fa.png");
});

test("列举：目录不存在（404）当作空列表，而不是错误", async () => {
  const { bed } = bedWith({ "GET /repos/acme/bed/contents/nope": new Response("nope", { status: 404 }) });
  assert.deepEqual(await bed.list("nope"), []);
});

test("删除：先取 sha，再带着 sha 发 DELETE", async () => {
  const { bed, calls } = bedWith({
    "GET /repos/acme/bed/contents/images/a.png": json({ sha: "s1" }),
    "DELETE /repos/acme/bed/contents/images/a.png": new Response(null, { status: 200 }),
  });
  const r = await bed.remove("images/a.png");
  assert.deepEqual(r, { success: true, remote_path: "images/a.png" });
  const body = JSON.parse(String(calls[1].init?.body));
  assert.equal(body.sha, "s1");
  assert.equal(body.branch, "main");
});

test("校验：配置缺失返回 valid:false，不抛", async () => {
  const cfg = { ...stubConfig(), tryGet: () => null } as unknown as ImageBedConfigService;
  const bed = new GitHubImageBedService(cfg);
  const r = await bed.verify();
  assert.equal(r.valid, false);
  assert.match(r.error!, /未配置/);
});

test("校验：使用环境变量配置，成功时回仓库信息", async () => {
  const { bed, calls } = bedWith({
    "GET /repos/acme/bed": json({ full_name: "acme/bed", private: true, default_branch: "main" }),
  });
  const r = await bed.verify();
  assert.equal(r.valid, true);
  assert.equal(r.repo_name, "acme/bed");
  assert.equal(r.private, true);
  assert.equal(r.source, "env");
  assert.ok(calls[0].url.includes("/repos/acme/bed"));
});

// ────────────────────────────────────────────────────────────
//  门面 / 配置
// ────────────────────────────────────────────────────────────

test("门面：空 filename / 空 body / 超限都在写盘前被拒", async () => {
  const svc = new ImageBedService(stubConfig(), new GitHubImageBedService(stubConfig()));
  await assert.rejects(() => svc.uploadBytes({ bytes: Buffer.from("x"), filename: "   " }), /filename 不能为空/);
  await assert.rejects(() => svc.uploadBytes({ bytes: Buffer.alloc(0), filename: "a.png" }), /请求体为空/);
  await assert.rejects(() => svc.uploadBytes({ bytes: Buffer.from("a.exe"), filename: "a.exe" }), /不支持的文件类型/);
  await assert.rejects(() => svc.uploadLocalFile({ filePath: "" }), /filePath 不能为空/);
  await assert.rejects(() => svc.uploadLocalBatch({ filePaths: [] }), /不能为空/);
  await assert.rejects(() => svc.uploadLocalBatch({ filePaths: Array(21).fill("/tmp/a.png") }), /最多 20/);
});

test("配置：只读取 IMAGE_BED_* 环境变量", () => {
  const saved = { ...process.env };
  try {
    process.env.IMAGE_BED_TOKEN = "token";
    process.env.IMAGE_BED_OWNER = "owner";
    process.env.IMAGE_BED_REPO = "repo";
    const svc = new ImageBedConfigService();
    const found = svc.tryGet();
    assert.equal(found?.token, "token");
    assert.equal(found?.owner, "owner");
    assert.equal(found?.repo, "repo");
  } finally {
    process.env = saved;
  }
});

test("配置：describe 不泄露完整 token", () => {
  const d = new ImageBedConfigService().describe();
  assert.ok(d.tokenHint === "" || d.tokenHint.startsWith("…"), "token 只留掩码");
});
