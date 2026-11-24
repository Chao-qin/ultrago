import "reflect-metadata";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import dotenv from "dotenv";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import express from "express";
import { UPLOAD_MAX_BYTES, desktopHttpGuard, desktopReady, runtimePort } from "@bcp/shared";
import { desktopPolicyGuard } from "./settings/desktop-policy.js";
import { AppModule } from "./app.module.js";
import { IMAGE_BED_MAX_BYTES } from "./image-bed/github-image-bed.service.js";
import { PrismaExceptionFilter } from "./prisma/prisma-exception.filter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 8790;
// Bind on all interfaces so the console is reachable from another machine
// (e.g. a browser on the developer's laptop hitting this host over the LAN /
// an SSH-forwarded network). There is NO auth layer in front of the API —
// whoever can reach this port can trigger books, edit schedules and delete
// rows. Set CONSOLE_HOST=127.0.0.1 to put it back on loopback only.
const DEFAULT_HOST = "0.0.0.0";
// The DB lives under the monorepo's resource/ dir with the other on-disk
// inputs (playbooks, uploads). Anchored on __dirname rather than
// process.cwd() so it survives `pnpm start` from the monorepo root OR from
// the package dir.
const DEFAULT_DB_PATH = path.resolve(__dirname, "../../../resource/db/console.db");
// Prisma resolves a relative `file:` URL against the SCHEMA directory, so a
// relative DATABASE_URL from .env means this, not cwd.
const PRISMA_SCHEMA_DIR = path.resolve(__dirname, "../prisma");
const WEB_DIST = process.env.BCP_CONSOLE_WEB_DIR || path.resolve(__dirname, "../dist-web");

async function main(): Promise<void> {
  // Load .env from monorepo root (if present) so DATABASE_URL / port can be
  // customized without exporting them every time.
  if (process.env.BCP_DESKTOP !== '1') dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const port = runtimePort(process.env.CONSOLE_PORT, DEFAULT_PORT);
  const host = process.env.CONSOLE_HOST || DEFAULT_HOST;
  // Resolve the DB path to an ABSOLUTE file: URL before exporting it to
  // DATABASE_URL. A relative URL means different files to different readers:
  // Prisma resolves it against the schema directory, while everything that
  // just strips `file:` and opens the path (this function's mkdirSync,
  // StudioService) resolves it against process.cwd(). Normalizing once here
  // is what makes them agree regardless of where the process was launched.
  // An empty DATABASE_URL counts as unset — `FOO= node …` is how a caller
  // opts out of an inherited value, and forwarding "" just makes Prisma fail
  // schema validation instead.
  const configured = process.env.DATABASE_URL || undefined;
  const dbPath = configured?.startsWith("file:")
    ? `file:${path.resolve(PRISMA_SCHEMA_DIR, configured.slice("file:".length))}`
    : (configured ?? `file:${DEFAULT_DB_PATH}`);
  process.env.DATABASE_URL = dbPath;

  if (dbPath.startsWith("file:")) {
    mkdirSync(path.dirname(dbPath.slice("file:".length)), { recursive: true });
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["log", "warn", "error"],
  });
  app.use(desktopHttpGuard);
  app.use(desktopPolicyGuard);
  app.enableShutdownHooks();

  // Mount static React build at / and let the SPA's hash router handle
  // anything that isn't /api/*. We don't use history API fallback because
  // hash router is simpler and works the same under any subpath.
  const apiPassthrough: import("express").RequestHandler = (req, _res, next) => {
    if (req.method === "GET" && req.path === "/health") return next();
    return next();
  };
  // Attachment uploads carry the file itself as the body (see
  // UploadsController). Parse them as raw bytes BEFORE the JSON parser, or a
  // picked file would be measured against the 1mb JSON limit.
  app.use("/api/uploads", express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES }));
  // Same shape for the image bed: POST /api/files/upload takes raw bytes.
  // Mounted on that exact subpath rather than on /api/files — express matches
  // a `use` path on SEGMENT boundaries, so the JSON siblings
  // /api/files/upload-local and /api/files/upload-batch still reach the JSON
  // parser below.
  app.use("/api/files/upload", express.raw({ type: () => true, limit: IMAGE_BED_MAX_BYTES }));
  app.use("/api/schema-records", express.json({ limit: "5mb" }));
  // Browser-event ingest carries a full-viewport PNG inline as a base64 data
  // URL, so it needs its own limit — and unlike the two above, getting this
  // one wrong loses data rather than just failing a request. The backend's
  // webhook is one-shot with no retry (event-webhook.ts says so in its header):
  // a 413 here means that captcha notification is gone for good, and the only
  // trace is one `[event-webhook] … failed: HTTP 413` line on the other side.
  //
  // The number: a measured 1920×911 capture of the DeepSeek login page was
  // 58KB of PNG → ~78KB base64, already most of the 100kb default that
  // /internal routes would otherwise inherit from Nest's built-in parser. A
  // dense, image-heavy page is an order of magnitude past that. 8mb is chosen
  // to sit above a worst-case full-page capture (~5MB PNG → ~6.7MB base64)
  // rather than to be a round number.
  app.use("/internal/browser-events", express.json({ limit: "8mb" }));
  // LLM 网关的调用日志。**必须显式挂**——上面那段注释说 /internal 路由会继承
  // Nest 内置 parser，实测并非如此：没有这一行时 `@Body()` 拿到的是 `{}`，
  // 每条日志都落成一行默认值（channel 变 "(unrouted)"、耗时 null），而且
  // 全程没有任何报错。摄入端是 fire-and-forget，对面连一行 warn 都不会打。
  //
  // 2mb：一条记录里最大的是两段预览，各截到 4000 字符（llm-calls.service.ts
  // 的 MAX_PREVIEW_CHARS），中文最坏按 3 字节算也就 24KB。2mb 是给"以后想把
  // 完整 body 也存进来"留的余量，不是按当前形状卡的。
  app.use("/internal/llm-calls", express.json({ limit: "2mb" }));
  // 投递桥。**这一行迟到了**：`/internal/deliveries` 从加进来就没挂过 parser，
  // 于是 `@Body()` 一直是 `{}`，摄入口对每次投递回 400「runId is required」，
  // 而 console-delivery-client 只在 2xx 后 unlink —— 结果是产物在
  // reports/.delivery-outbox/ 里一直堆着（发现时 173 个，最老的 9-3）。
  // .gitignore 里记的「commit ece077e 把 412 个文件整目录提交进去」是同一个
  // 病的另一次发作，当时只当成"没清理"处理了。
  //
  // 5mb：投递 payload 是 book 跑完的终态快照，比一条日志大得多；与
  // /api/schema-records 同量级。
  app.use("/internal/deliveries", express.json({ limit: "5mb" }));
  app.use("/api", express.json({ limit: "1mb" }), apiPassthrough);

  // Validation pipe is opt-in per route via @Body decorators; we don't
  // override the global default. Disable CORS — the React build is served from
  // this same origin, so the browser never makes a cross-origin call. (This
  // held when we bound loopback-only and still holds now that DEFAULT_HOST is
  // 0.0.0.0: the reason is same-origin, not the bind address.)
  // (No global ValidationPipe — installs of class-validator just to make
  //  the pipe's decorator pass-through happy is not worth it for v1.)
  //
  // One global filter IS installed, and it is not a reversal of the line
  // above: it adds no dependency and changes no response that already had a
  // status. `@Catch` is narrowed to Prisma's known-request errors, which
  // otherwise reach Nest with no `statusCode` and become 500s — the same
  // answer for "you created a duplicate" as for a real bug. Unmapped codes
  // still produce exactly that 500. See the filter for the allowlist.
  app.useGlobalFilters(new PrismaExceptionFilter());

  // Serve the React build AFTER all API routes so API 404s aren't shadowed.
  app.useStaticAssets(WEB_DIST, { prefix: "/" });
  // SPA fallback: any non-/api GET that doesn't match a static file returns
  // the React app's index.html. The browser hash router then handles routing.
  const spaFallback: import("express").RequestHandler = (req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/")) return next();
    if (req.path.startsWith("/internal/")) return next();
    res.sendFile(path.join(WEB_DIST, "index.html"));
  };
  app.use(spaFallback);

  await app.listen(port, host);
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('Console did not bind');
  desktopReady('console', { console: `http://127.0.0.1:${address.port}` });
  Logger.log(`Console listening on http://${host}:${address.port}`, "Bootstrap");
  Logger.log(`SQLite: ${dbPath}`, "Bootstrap");
  Logger.log(`Static web: ${WEB_DIST}`, "Bootstrap");
}

main().catch((e) => {
  console.error("[console] fatal:", e);
  process.exit(1);
});
