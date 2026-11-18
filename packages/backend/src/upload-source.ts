import { basename, extname, isAbsolute, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { UPLOAD_MAX_BYTES } from '@bcp/shared';
import type { UploadSource } from '@bcp/shared';
import { setTimeout as delay } from 'node:timers/promises';
import { domainAllowed } from "./config.js";

export { UPLOAD_MAX_BYTES };
export type { UploadSource };

const UPLOAD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".pdf": "application/pdf",
};

export interface ResolvedUploadSource {
  filename: string;
  mimeType: string;
  dataBase64: string;
  bytes: number;
}

export interface UploadSourceDeps {
  /** Test seam; production deliberately defaults to the backend's fetch. */
  fetch?: typeof fetch;
  /** Test seam for public-host DNS validation; production uses real DNS. */
  lookup?: (hostname: string) => Promise<{ address: string }>;
}

export async function resolveUploadSources(sources: UploadSource[], deps: UploadSourceDeps = {}): Promise<ResolvedUploadSource[]> {
  return Promise.all(sources.map((source) => resolveUploadSource(source, deps)));
}

/** Resolve a declarative URL/local-path source into the low-level upload payload. */
export async function resolveUploadSource(source: UploadSource, deps: UploadSourceDeps = {}): Promise<ResolvedUploadSource> {
  const hasUrl = typeof source.url === "string" && source.url.length > 0;
  const hasLocalPath = typeof source.localPath === "string" && source.localPath.length > 0;
  if (Number(hasUrl) + Number(hasLocalPath) !== 1) throw new Error("give exactly one of `url` or `localPath`");

  if (hasUrl) {
    const url = source.url!;
    const d = domainAllowed(url);
    if (!d.ok) throw new Error(d.reason);
    await assertPublicHttpUrl(url, deps.lookup ?? lookup);
    const { resp, buf } = await downloadUpload(url, deps.fetch ?? fetch);
    return {
      filename: source.filename || url.split("/").pop()?.split(/[?#]/)[0] || "upload",
      mimeType: source.mimeType || resp.headers.get("content-type")?.split(";")[0]?.trim() || guessMime(url),
      dataBase64: buf.toString("base64"),
      bytes: buf.length,
    };
  }

  const abs = resolve(source.localPath!);
  const st = await stat(abs).catch((e: unknown) => e as NodeJS.ErrnoException);
  if (st instanceof Error || !st.isFile()) {
    const why =
      st instanceof Error
        ? st.code === "EACCES"
          ? "this backend process may not read it (EACCES) — chmod it, or copy it somewhere the backend can read"
          : `nothing is there (${st.code ?? "stat failed"})`
        : st.isDirectory()
          ? "that is a DIRECTORY — pass the file inside it"
          : "that is not a regular file";
    const rebased = isAbsolute(source.localPath!)
      ? ""
      : ` — "${source.localPath}" is relative, so it was resolved against THIS BACKEND's working directory (${process.cwd()}); pass an absolute path`;
    throw new Error(
      `localPath ${abs}: ${why}${rebased}. The file has to exist on the machine running this backend, ` +
        `not on the machine running your MCP client — if it only exists on yours, upload it with \`url\` instead.`,
    );
  }
  if (st.size > UPLOAD_MAX_BYTES) throw new Error(`file too large (${st.size}B > ${UPLOAD_MAX_BYTES}B cap)`);
  const buf = await readFile(abs);
  return {
    filename: source.filename || basename(abs) || "upload",
    mimeType: source.mimeType || guessMime(abs),
    dataBase64: buf.toString("base64"),
    bytes: buf.length,
  };
}

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 15000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function downloadUpload(url: string, fetchImpl: typeof fetch): Promise<{ resp: Response; buf: Buffer }> {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    let retryable = false;
    try {
      const resp = await fetchImpl(url, {
        headers: { Referer: new URL(url).origin + '/', 'User-Agent': UPLOAD_UA },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!resp.ok) {
        retryable = RETRYABLE_STATUS.has(resp.status);
        await resp.body?.cancel();
        throw new Error(`HTTP ${resp.status}${resp.url && resp.url !== url ? ` (redirected to ${resp.url})` : ''}`);
      }
      const declared = Number(resp.headers.get('content-length') || 0);
      if (declared > UPLOAD_MAX_BYTES) {
        await resp.body?.cancel();
        throw new Error(`file too large (${declared}B > ${UPLOAD_MAX_BYTES}B cap)`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > UPLOAD_MAX_BYTES) throw new Error(`file too large (${buf.length}B > ${UPLOAD_MAX_BYTES}B cap)`);
      return { resp, buf };
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
      const transient = retryable || (error instanceof Error && error.name === 'TimeoutError') ||
        /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_BODY_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/.test(code);
      if (!transient || attempt === DOWNLOAD_ATTEMPTS) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
        throw new Error(`download ${url} failed after ${attempt} attempt(s): ${message}${code ? ` [${code}]` : ''}${detail ? `; ${detail}` : ''}. Backend download; browser focus does not affect this request.`, { cause: error });
      }
      // 只重试下载，文件成功读取后才交给页面，重试不会重复上传。
      await delay(300 * attempt);
    }
  }
  throw new Error(`download ${url}: retry budget exhausted`);
}

function guessMime(pathOrUrl: string): string {
  return MIME_BY_EXT[extname(pathOrUrl.split(/[?#]/)[0]).toLowerCase()] || "application/octet-stream";
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return (
      p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }
  const low = ip.toLowerCase();
  return low === "::1" || low === "::" || low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd");
}

async function assertPublicHttpUrl(raw: string, lookupImpl: (hostname: string) => Promise<{ address: string }>): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("must be an absolute http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("refusing to fetch a loopback address");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("refusing to fetch a private/loopback/link-local address");
    return;
  }
  const { address } = await lookupImpl(host);
  if (isPrivateIp(address)) throw new Error("refusing to fetch a host that resolves to a private/internal address");
}
