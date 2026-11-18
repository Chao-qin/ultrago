/** 图床（image bed）模块的数据类型。
 *
 * 移植自 packages/server/src/image（project-source），原实现基于 axios +
 * @nestjs/swagger + class-validator；本仓 console 三个都没有，因此 DTO 退化成
 * 纯 interface，校验改为在 service 里手工做（与 main.ts 里"No global
 * ValidationPipe"的既有取舍一致）。HTTP 调用改用 Node 20 的全局 fetch。 */

export interface GitHubImageBedConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** 仓库内的根目录前缀，例如 `images`。留空表示放仓库根。 */
  pathPrefix: string;
  /** 自定义 CDN 域名，配置后优先用它拼 URL（末尾不要带斜杠）。 */
  customDomain: string;
}

export interface UploadOptions {
  /** 远程文件名。不给则按 `YYYYMMDD_HHMMSS_hash.ext` 生成。 */
  remoteName?: string;
  /** 仓库内的子目录，会拼在 pathPrefix 之后。 */
  subDir?: string;
  /** commit message。 */
  message?: string;
  /** 允许覆盖已存在的远程文件（需要带上原文件的 sha）。默认 false。 */
  overwrite?: boolean;
}

export interface UploadResult {
  success: boolean;
  /** jsDelivr（或自定义域名）链接。 */
  cdn_url?: string;
  /** raw.githubusercontent 直链。 */
  github_url?: string;
  /** GitHub 文件页。 */
  html_url?: string;
  /** 回落到本服务的代理下载地址（私有仓库也能取到字节）。 */
  download_url?: string;
  markdown?: string;
  remote_path?: string;
  sha?: string;
  size?: number;
  error?: string;
  error_code?: string;
}

export interface BatchUploadResult {
  results: Array<UploadResult & { file: string }>;
  summary: { total: number; success: number; failed: number };
}

export interface FileEntry {
  /** 仓库内的完整路径。 */
  path: string;
  name: string;
  size: number;
  sha: string;
  cdn_url: string;
  github_url: string;
  html_url: string;
  download_url: string;
}

export interface DownloadedFile {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export interface VerifyResult {
  valid: boolean;
  repo_name?: string;
  private?: boolean;
  default_branch?: string;
  source?: "env";
  error?: string;
}

export type UploadErrorCode =
  | "FILE_NOT_FOUND"
  | "INVALID_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "FILE_EXISTS"
  | "TOKEN_INVALID"
  | "RATE_LIMITED"
  | "REPO_NOT_FOUND"
  | "NETWORK_ERROR"
  | "UNKNOWN_ERROR"
  | "BED_NOT_CONFIGURED";
