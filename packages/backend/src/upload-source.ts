import { basename, extname, isAbsolute, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { UPLOAD_MAX_BYTES } from '@bcp/shared';
import type { UploadSource } from '@bcp/shared';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchPublicUrl, PublicUrlRefused, type PublicFetchDeps, type PublicFetchResponse } from "./public-fetch.js";

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

/** Test seams for name resolution and the address policy; production uses the
 *  system resolver and refuses every non-public address. */
export type UploadSourceDeps = PublicFetchDeps;

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
    const res = await downloadUpload(url, deps);
    return {
      filename: source.filename || url.split("/").pop()?.split(/[?#]/)[0] || "upload",
      mimeType: source.mimeType || String(res.headers["content-type"] ?? "").split(";")[0]?.trim() || guessMime(url),
      dataBase64: res.body.toString("base64"),
      bytes: res.body.length,
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

async function downloadUpload(url: string, deps: PublicFetchDeps): Promise<PublicFetchResponse> {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    let retryable = false;
    try {
      const res = await fetchPublicUrl(
        url,
        // A same-origin Referer on every hop, so hotlink checks pass on the host that serves the file.
        { headers: (hop) => ({ Referer: hop.origin + '/', 'User-Agent': UPLOAD_UA }), timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: UPLOAD_MAX_BYTES },
        deps,
      );
      if (res.status < 200 || res.status >= 300) {
        retryable = RETRYABLE_STATUS.has(res.status);
        throw new Error(`HTTP ${res.status}${res.url !== url ? ` (redirected to ${res.url})` : ''}`);
      }
      return res;
    } catch (error) {
      // A refused address or an oversized file is the same on every attempt.
      if (error instanceof PublicUrlRefused) throw error;
      const cause = error instanceof Error ? error.cause : undefined;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code)
        : cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
      const transient = retryable || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) ||
        /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ECONNABORTED)$/.test(code);
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
