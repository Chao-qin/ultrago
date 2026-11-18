import assert from "node:assert/strict";
import { test } from "node:test";
import { materializePlaybookUpload } from "./playbook-upload.js";

test("derives upload attachments from canonical relative image paths", () => {
  const result = materializePlaybookUpload({
    css: "#detail-stage",
    attachmentsFrom: [{ localPath: "images/detail/0.jpg" }, { localPath: "images/detail/1.jpg" }],
    attachmentBaseDir: "/workspace/product",
  });

  assert.deepEqual(result, {
    css: "#detail-stage",
    attachments: [
      { localPath: "/workspace/product/images/detail/0.jpg" },
      { localPath: "/workspace/product/images/detail/1.jpg" },
    ],
  });
});

test("prefers a canonical URL and falls back to its relative local path", () => {
  const result = materializePlaybookUpload({
    attachmentFrom: {
      url: "https://cdn.example.com/products/main.jpg",
      sourceUrl: "https://source.example.com/products/main.jpg",
      localPath: "images/main/0.jpg",
    },
    attachmentBaseDir: "/workspace/product",
  });

  assert.deepEqual(result, {
    attachments: [{ url: "https://cdn.example.com/products/main.jpg" }],
  });

  const fallback = materializePlaybookUpload({
    attachmentFrom: { localPath: "images/main/0.jpg" },
    attachmentBaseDir: "/workspace/product",
  });

  assert.deepEqual(fallback, {
    attachments: [{ localPath: "/workspace/product/images/main/0.jpg" }],
  });

  const urls = materializePlaybookUpload({
    attachmentsFrom: [{ url: "https://cdn.example.com/products/main.jpg" }],
  });
  assert.deepEqual(urls, { attachments: [{ url: "https://cdn.example.com/products/main.jpg" }] });
});

test("does not upload a canonical source URL when its local processed file exists", () => {
  const result = materializePlaybookUpload({
    attachmentFrom: {
      url: "https://source.example.com/products/main.jpg",
      sourceUrl: "https://source.example.com/products/main.jpg",
      localPath: "images/main/0.jpg",
    },
    attachmentBaseDir: "/workspace/product",
  });

  assert.deepEqual(result, {
    attachments: [{ localPath: "/workspace/product/images/main/0.jpg" }],
  });
});

test("filters canonical spec values without images before upload", () => {
  const result = materializePlaybookUpload({
    name: "批量上传规格图",
    attachmentsFrom: [
      { values: [
        { value: "红色", imageUrl: "https://cdn.example.com/red.jpg" },
        { value: "蓝色" },
        { value: "绿色", imageUrl: "https://cdn.example.com/green.jpg" },
      ] },
    ],
  });

  assert.deepEqual(result, {
    name: "批量上传规格图",
    attachments: [
      { url: "https://cdn.example.com/red.jpg" },
      { url: "https://cdn.example.com/green.jpg" },
    ],
  });
});

test("rejects a canonical attachment path that escapes its product directory", () => {
  assert.throws(
    () => materializePlaybookUpload({
      attachmentsFrom: [{ localPath: "../../outside.jpg" }],
      attachmentBaseDir: "/workspace/product",
    }),
    /escapes attachmentBaseDir/,
  );
});

test("每一条 Upload 派发路径都必须先 materialize —— 漏一条就是往页面里塞空文件", async () => {
  // 这是一条【接线】断言，不是行为断言，因为坏掉的正是接线：
  // materializePlaybookUpload 本身一直是对的，internal-runner（Console/Flow）也一直在调；
  // 而 browser-mcp 的 MCP run_playbook 路径从来没调过 —— 于是同一本书走 Flow 能发，
  // 走 run_playbook 时 `attachmentFrom` 原样透传给扩展，扩展拿不到 dataBase64，
  // 构造出 `new File([], "upload", {type:"application/octet-stream"})`。
  // 抖店回「上传图片仅支持JPG、JPEG、PNG格式」，而书这边只看到
  // `no 200 response for /product/img/batchupload` —— 与真因隔着整条链路
  // （2026-09-07 实测：同一张图用 upload_file 工具直传，200 通过）。
  //
  // 行为断言挡不住这一类：两条路径各自看都"正确"，错的是少了一条。
  // 这条断言能证伪的是「某条派发路径把 materialize 删了/忘了」，
  // 不能证明它被放在了正确的位置 —— 位置由上面那些行为断言 + 真实跑一遍来保。
  const { readFile } = await import("node:fs/promises");
  const dispatchers = ["browser-mcp.ts", "internal-runner.ts"];
  for (const file of dispatchers) {
    const src = await readFile(new URL(file, import.meta.url), "utf8");
    if (!/RpcMethod\.Upload/.test(src)) continue;
    assert.match(
      src,
      /materializePlaybookUpload/,
      `${file} 会派发 RpcMethod.Upload，却没有 materializePlaybookUpload —— ` +
        `书里的 attachmentFrom/attachmentsFrom 会原样透传，页面收到的是空文件`,
    );
  }
});
