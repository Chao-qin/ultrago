import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ImageBedConfigService } from "./image-bed.config.js";
import type {
  BatchUploadResult,
  DownloadedFile,
  FileEntry,
  GitHubImageBedConfig,
  UploadOptions,
  UploadResult,
  VerifyResult,
} from "./image-bed.types.js";

// ────────────────────────────────────────────────────────────
//  允许的扩展名 / 体积上限
// ────────────────────────────────────────────────────────────

export const SUPPORTED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif",
  ".pdf", ".txt", ".md", ".json", ".csv", ".zip",
]);

/** 20MB。卡这个数不是 GitHub 的限制（contents API 到 100MB 才拒），而是
 * jsDelivr 的限制：gh 上超过 20MB 的文件它不缓存，上传成功也拿不到 CDN 直链。 */
export const IMAGE_BED_MAX_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif",
]);

const REQUEST_TIMEOUT_MS = 30_000;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".json": "application/json",
  ".csv": "text/csv; charset=utf-8", ".zip": "application/zip",
};

// ────────────────────────────────────────────────────────────
//  错误类型
// ────────────────────────────────────────────────────────────

/** 一次 GitHub API 调用失败的完整结论。原实现把结果挂在 Error 的 `_handled` /
 * `_result` 私有字段上再 throw，读起来像黑魔法；这里直接给一个带 result 的
 * Error 子类，调用方 `catch` 到就能拿到可直接返回的 UploadResult。 */
export class GitHubApiError extends Error {
  constructor(readonly result: UploadResult) {
    super(result.error ?? result.error_code ?? "github api error");
    this.name = "GitHubApiError";
  }
}

// ────────────────────────────────────────────────────────────
//  GitHub 图床服务
// ────────────────────────────────────────────────────────────

@Injectable()
export class GitHubImageBedService {
  private readonly logger = new Logger(GitHubImageBedService.name);

  /** 可替换，仅为单测注入假实现；生产走全局 fetch。 */
  fetchImpl: typeof fetch = globalThis.fetch;

  // 必须显式 @Inject：本仓 dev 走 tsx（esbuild），它不实现 emitDecoratorMetadata，
  // 靠 TS 反射元数据的隐式注入在 dev 下会静默拿到 undefined（生产 tsc 编译反而
  // 正常，属于"只在 dev 崩"的坑）。
  constructor(@Inject(ImageBedConfigService) private readonly config: ImageBedConfigService) {}

  // ══════════════════════════════════════════════════════════
  //  上传
  // ══════════════════════════════════════════════════════════

  async upload(
    input: { bytes: Buffer; filename: string },
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    const validation = validateUpload(input.filename, input.bytes.length);
    if (!validation.valid) {
      return this.logFailure(input.filename, undefined, fail(validation.error_code!, validation.error!));
    }

    const cfg = this.config.get();
    const remoteName = sanitizeSegment(options.remoteName || input.filename);
    const remotePath = buildRemotePath(cfg, options.subDir, remoteName);

    // 先看远程有没有同名文件：有 sha 才能覆盖，没有 sha 时 PUT 会被 422 拒。
    let existingSha: string | null = null;
    try {
      existingSha = await this.getFileSha(remotePath, cfg);
    } catch (e) {
      if (e instanceof GitHubApiError) return this.logFailure(input.filename, remotePath, e.result);
      throw e;
    }
    if (existingSha && !options.overwrite) {
      return this.logFailure(
        input.filename,
        remotePath,
        fail("FILE_EXISTS", `远程文件已存在: ${remotePath}（传 overwrite=true 可覆盖）`),
      );
    }

    try {
      const payload: Record<string, string> = {
        message: options.message || `upload: ${remoteName} via bcp image-bed`,
        content: input.bytes.toString("base64"),
        branch: cfg.branch,
      };
      if (existingSha) payload.sha = existingSha;

      const data = await this.request<{ content: { sha: string; size: number; html_url: string } }>(
        "PUT",
        `/repos/${cfg.owner}/${cfg.repo}/contents/${remotePath}`,
        cfg,
        payload,
      );

      return {
        success: true,
        cdn_url: buildCdnUrl(cfg, remotePath),
        github_url: buildRawUrl(cfg, remotePath),
        html_url: data.content.html_url,
        download_url: downloadUrl(remotePath),
        markdown: buildMarkdown(cfg, remotePath, remoteName),
        remote_path: remotePath,
        sha: data.content.sha,
        size: data.content.size,
      };
    } catch (e) {
      return this.logFailure(input.filename, remotePath, toResult(e));
    }
  }

  /** 传本地绝对路径的上传——原实现的主入口，保留给"文件已经在磁盘上"的场景。 */
  async uploadFile(
    filePath: string,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    if (!filePath || !existsSync(filePath)) {
      return this.logFailure(filePath, undefined, fail("FILE_NOT_FOUND", `文件不存在: ${filePath}`));
    }
    const stats = statSync(filePath);
    const bytes = readFileSync(filePath);
    if (stats.size > IMAGE_BED_MAX_BYTES || bytes.length > IMAGE_BED_MAX_BYTES) {
      return this.logFailure(filePath, undefined, fail("FILE_TOO_LARGE", `文件过大: ${(stats.size / 1024 / 1024).toFixed(1)}MB（上限 20MB）`));
    }
    return this.upload({ bytes, filename: path.basename(filePath) }, options);
  }

  async uploadBatch(
    filePaths: string[],
    options: Omit<UploadOptions, "remoteName"> = {},
  ): Promise<BatchUploadResult> {
    const results: Array<UploadResult & { file: string }> = [];
    for (let i = 0; i < filePaths.length; i++) {
      const fp = filePaths[i];
      const result = await this.uploadFile(fp, options);
      results.push({ file: fp, ...result });
      // 间隔 500ms，避免连打触发 GitHub 的 secondary rate limit。
      if (i < filePaths.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    return {
      results,
      summary: {
        total: filePaths.length,
        success: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
    };
  }

  // ══════════════════════════════════════════════════════════
  //  下载 / 列举 / 删除 / 校验
  // ══════════════════════════════════════════════════════════

  /** 取回远程文件的字节。用 contents API 的 raw 媒体类型而不是拼
   * raw.githubusercontent.com：前者带 Authorization，私有仓库同样能取到。 */
  async download(remotePath: string): Promise<DownloadedFile> {
    const cfg = this.config.get();
    const safe = assertSafeRemotePath(remotePath);
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${safe}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new GitHubApiError(await apiError(res));
    const bytes = Buffer.from(await res.arrayBuffer());
    const filename = path.basename(safe);
    return { bytes, contentType: guessMime(filename), filename };
  }

  /** 单个文件的元信息（sha / size / 各种 URL）。不存在返回 null。 */
  async stat(remotePath: string): Promise<FileEntry | null> {
    const cfg = this.config.get();
    const safe = assertSafeRemotePath(remotePath);
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${safe}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await this.fetchImpl(url, { headers: this.jsonHeaders(cfg), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubApiError(await apiError(res));
    const data = (await res.json()) as { sha: string; size: number; name: string; path: string; html_url: string };
    return toEntry(cfg, data);
  }

  /** 列出某个目录下的文件。prefix 默认取配置里的 pathPrefix。 */
  async list(prefix?: string): Promise<FileEntry[]> {
    const cfg = this.config.get();
    const target = (prefix ?? cfg.pathPrefix ?? "").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${target}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await this.fetchImpl(url, { headers: this.jsonHeaders(cfg), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) return [];
    if (!res.ok) throw new GitHubApiError(await apiError(res));
    const data = (await res.json()) as Array<{
      type: string; sha: string; size: number; name: string; path: string; html_url: string;
    }>;
    if (!Array.isArray(data)) return [];
    return data.filter((d) => d.type === "file").map((d) => toEntry(cfg, d));
  }

  async remove(remotePath: string): Promise<{ success: boolean; remote_path: string }> {
    const cfg = this.config.get();
    const safe = assertSafeRemotePath(remotePath);
    const sha = await this.getFileSha(safe, cfg);
    if (!sha) throw new GitHubApiError(fail("FILE_NOT_FOUND", `远程文件不存在: ${safe}`));
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${safe}`,
      {
        method: "DELETE",
        headers: this.jsonHeaders(cfg),
        body: JSON.stringify({ message: `delete: ${path.basename(safe)}`, sha, branch: cfg.branch }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new GitHubApiError(await apiError(res));
    return { success: true, remote_path: safe };
  }

  /** 使用唯一的环境变量配置验证连通性。 */
  async verify(): Promise<VerifyResult> {
    const cfg = this.config.tryGet();
    if (!cfg) return { valid: false, source: undefined, error: "图床未配置：缺少 IMAGE_BED_TOKEN / OWNER / REPO" };

    try {
      const res = await this.fetchImpl(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, {
        headers: this.jsonHeaders(cfg),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return { valid: false, source: "env", error: (await apiError(res)).error };
      const data = (await res.json()) as { full_name: string; private: boolean; default_branch: string };
      return {
        valid: true,
        source: "env",
        repo_name: data.full_name,
        private: data.private,
        default_branch: data.default_branch,
      };
    } catch (e) {
      if (e instanceof GitHubApiError) return { valid: false, source: "env", error: e.result.error };
      return { valid: false, source: "env", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ══════════════════════════════════════════════════════════
  //  私有
  // ══════════════════════════════════════════════════════════

  private async getFileSha(remotePath: string, cfg: GitHubImageBedConfig): Promise<string | null> {
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${remotePath}?ref=${encodeURIComponent(cfg.branch)}`,
      { headers: this.jsonHeaders(cfg), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubApiError(await apiError(res));
    return ((await res.json()) as { sha: string }).sha;
  }

  private jsonHeaders(cfg: GitHubImageBedConfig): Record<string, string> {
    return {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private async request<T>(method: string, urlPath: string, cfg: GitHubImageBedConfig, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${urlPath}`, {
      method,
      headers: this.jsonHeaders(cfg),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new GitHubApiError(await apiError(res));
    return (await res.json()) as T;
  }

  private logFailure(filename: string, remotePath: string | undefined, result: UploadResult): UploadResult {
    this.logger.error(
      `图床上传失败 [${result.error_code ?? "UNKNOWN_ERROR"}] ${filename} -> ${remotePath ?? "N/A"}: ${result.error ?? "未知错误"}`,
    );
    return result;
  }
}

// ────────────────────────────────────────────────────────────
//  纯函数（导出以便单测）
// ────────────────────────────────────────────────────────────

export function validateUpload(filename: string, size: number): { valid: boolean; error_code?: string; error?: string } {
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error_code: "INVALID_FILE_TYPE",
      error: `不支持的文件类型: ${ext || "(无扩展名)"}（支持: ${[...SUPPORTED_EXTENSIONS].join(", ")}）`,
    };
  }
  if (size <= 0) return { valid: false, error_code: "FILE_TOO_LARGE", error: "文件内容为空" };
  if (size > IMAGE_BED_MAX_BYTES) {
    return {
      valid: false,
      error_code: "FILE_TOO_LARGE",
      error: `文件过大: ${(size / 1024 / 1024).toFixed(1)}MB（上限 20MB）`,
    };
  }
  return { valid: true };
}

/** 远程路径 = pathPrefix/subDir/name，三段都去掉分隔符与 `..`，保证拼出来的
 * 路径既不会跳出前缀目录，也不会因为用户输入带斜杠而多出一层。 */
export function buildRemotePath(cfg: GitHubImageBedConfig, subDir: string | undefined, name: string): string {
  return [cfg.pathPrefix, sanitizeSubDir(subDir ?? ""), sanitizeSegment(name)].filter(Boolean).join("/");
}

/** 子目录**允许有多层**（`articles/2026-09`），所以逐段清洗后保留层级，
 * 而不是像文件名那样只取最后一段——否则 `subDir=articles/2026-09` 会被压成
 * `2026-09`，用户指定的归档目录直接丢失。 */
export function sanitizeSubDir(raw: string): string {
  return (raw ?? "")
    .split(/[\\/]/)
    .map((seg) => sanitizeSegment(seg))
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

/** 只保留文件名本身：去掉目录分隔符、跨平台的非法字符、以及前导点（防 `..`）。 */
export function sanitizeSegment(raw: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, "").replace(/^\.+/, "").trim();
  return cleaned.slice(-120);
}

export function buildCdnUrl(cfg: GitHubImageBedConfig, remotePath: string): string {
  if (cfg.customDomain) return `${cfg.customDomain}/${remotePath}`;
  return `https://cdn.jsdelivr.net/gh/${cfg.owner}/${cfg.repo}@${cfg.branch}/${remotePath}`;
}

export function buildRawUrl(cfg: GitHubImageBedConfig, remotePath: string): string {
  return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${remotePath}`;
}

export function downloadUrl(remotePath: string): string {
  return `/api/files/download?path=${encodeURIComponent(remotePath)}`;
}

export function buildMarkdown(cfg: GitHubImageBedConfig, remotePath: string, name: string): string {
  const url = buildCdnUrl(cfg, remotePath);
  return IMAGE_EXTENSIONS.has(path.extname(remotePath).toLowerCase()) ? `![${name}](${url})` : `[${name}](${url})`;
}

export function guessMime(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

/** 下载/删除/stat 的入参：必须是仓库内的相对路径。绝对路径、`..`、`\` 全部拒绝。 */
export function assertSafeRemotePath(remotePath: string): string {
  const raw = (remotePath ?? "").trim();
  if (!raw) throw new BadRequestException("path 不能为空");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new BadRequestException("path 必须是仓库内的相对路径");
  }
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === "..")) {
    throw new BadRequestException(`path 非法: ${remotePath}`);
  }
  return parts.join("/");
}

export function toEntry(cfg: GitHubImageBedConfig, data: { sha: string; size: number; name: string; path: string; html_url: string }): FileEntry {
  return {
    path: data.path,
    name: data.name,
    size: data.size,
    sha: data.sha,
    cdn_url: buildCdnUrl(cfg, data.path),
    github_url: buildRawUrl(cfg, data.path),
    html_url: data.html_url,
    download_url: downloadUrl(data.path),
  };
}

function fail(error_code: string, error: string): UploadResult {
  return { success: false, error_code, error };
}

function toResult(e: unknown): UploadResult {
  if (e instanceof GitHubApiError) return e.result;
  return fail("NETWORK_ERROR", `网络错误: ${e instanceof Error ? e.message : String(e)}`);
}

/** 把 GitHub 的错误响应翻译成带 error_code 的结论。原实现逐 status 手写，这里
 * 保持同样的映射表，只是数据源从 axios error 换成 fetch Response。 */
async function apiError(res: Response): Promise<UploadResult> {
  let message = "";
  try {
    message = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    message = "";
  }
  const detail = message || res.statusText || "";
  switch (res.status) {
    case 401:
      return fail("TOKEN_INVALID", `Token 无效或已过期: ${detail}`);
    case 403:
      if (detail.toLowerCase().includes("rate limit")) {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetTime = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "未知";
        return fail("RATE_LIMITED", `API 频率超限，将于 ${resetTime} 恢复`);
      }
      return fail("TOKEN_INVALID", `无权限: ${detail}`);
    case 404:
      return fail("REPO_NOT_FOUND", `仓库或文件不存在: ${detail}`);
    case 409:
      return fail("FILE_EXISTS", `文件冲突: ${detail}`);
    case 422:
      return fail("FILE_TOO_LARGE", `文件太大或内容无效: ${detail}`);
    default:
      return fail("UNKNOWN_ERROR", `GitHub API 错误 (${res.status}): ${detail}`);
  }
}
