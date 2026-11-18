import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ImageBedConfigService } from "./image-bed.config.js";
import {
  GitHubImageBedService,
  IMAGE_BED_MAX_BYTES,
  SUPPORTED_EXTENSIONS,
  assertSafeRemotePath,
  validateUpload,
} from "./github-image-bed.service.js";
import type {
  BatchUploadResult,
  DownloadedFile,
  FileEntry,
  UploadOptions,
  UploadResult,
  VerifyResult,
} from "./image-bed.types.js";

export interface UploadBytesInput {
  bytes: Buffer;
  filename: string;
  subDir?: string;
  remoteName?: string;
  overwrite?: boolean;
  message?: string;
}

/**
 * 图床门面：API 层只跟它打交道，GitHub 的细节（sha、contents API、媒体类型）
 * 都在 GitHubImageBedService 里。
 *
 * 与 project-source 原实现的差异：**删掉了百度搜图**（`baidu-image-search`
 * 与 `search-and-upload`）。那是"按关键词找配图"的能力，属于内容生产，不属于
 * 文件存储；本仓要的是一套上传/下载文件的 API，把它搬进来只会让这个模块依赖
 * 一个跟存储无关的第三方站点。搜索能力需要的话另开模块。
 */
@Injectable()
export class ImageBedService {
  private readonly logger = new Logger(ImageBedService.name);

  constructor(
    @Inject(ImageBedConfigService) private readonly config: ImageBedConfigService,
    @Inject(GitHubImageBedService) private readonly bed: GitHubImageBedService,
  ) {}

  // ══════════════════════════════════════════════════════════
  //  上传
  // ══════════════════════════════════════════════════════════

  async uploadBytes(input: UploadBytesInput): Promise<UploadResult> {
    const filename = (input.filename ?? "").trim();
    if (!filename) throw new BadRequestException("filename 不能为空（用 ?filename= 传原始文件名）");
    if (!input.bytes?.length) throw new BadRequestException("请求体为空，没有可上传的字节");
    if (input.bytes.length > IMAGE_BED_MAX_BYTES) {
      throw new BadRequestException(`文件过大（${input.bytes.length}B > ${IMAGE_BED_MAX_BYTES}B 上限）`);
    }
    const check = validateUpload(filename, input.bytes.length);
    if (!check.valid) throw new BadRequestException(check.error!);

    const options: UploadOptions = {
      subDir: input.subDir,
      remoteName: input.remoteName || generateRemoteName(filename),
      overwrite: input.overwrite,
      message: input.message,
    };
    this.logger.log(`图床上传: ${filename} (${input.bytes.length}B)`);
    return this.bed.upload({ bytes: input.bytes, filename }, options);
  }

  async uploadLocalFile(body: {
    filePath?: string;
    subDir?: string;
    remoteName?: string;
    overwrite?: boolean;
  }): Promise<UploadResult> {
    if (!body?.filePath) throw new BadRequestException("filePath 不能为空");
    return this.bed.uploadFile(body.filePath, {
      subDir: body.subDir,
      remoteName: body.remoteName,
      overwrite: body.overwrite,
    });
  }

  async uploadLocalBatch(body: {
    filePaths?: string[];
    subDir?: string;
    overwrite?: boolean;
  }): Promise<BatchUploadResult> {
    const list = body?.filePaths ?? [];
    if (!Array.isArray(list) || list.length === 0) throw new BadRequestException("filePaths 不能为空");
    if (list.length > 20) throw new BadRequestException("单次批量上传最多 20 个文件");
    return this.bed.uploadBatch(list, { subDir: body.subDir, overwrite: body.overwrite });
  }

  // ══════════════════════════════════════════════════════════
  //  下载 / 列举 / 删除 / 校验
  // ══════════════════════════════════════════════════════════

  async download(remotePath: string): Promise<DownloadedFile> {
    return this.bed.download(assertSafeRemotePath(remotePath));
  }

  async stat(remotePath: string): Promise<FileEntry | null> {
    return this.bed.stat(assertSafeRemotePath(remotePath));
  }

  async list(prefix?: string): Promise<FileEntry[]> {
    return this.bed.list(prefix);
  }

  async remove(remotePath: string): Promise<{ success: boolean; remote_path: string }> {
    return this.bed.remove(assertSafeRemotePath(remotePath));
  }

  async verify(): Promise<VerifyResult> {
    return this.bed.verify();
  }

  /** 当前生效配置（token 打码），给前端显示"你在往哪个仓库传"。 */
  describe() {
    return this.config.describe();
  }

  limits() {
    return { maxBytes: IMAGE_BED_MAX_BYTES, extensions: [...SUPPORTED_EXTENSIONS] };
  }
}

/** `YYYYMMDD_HHMMSS_<8位随机>.<ext>`——沿用原实现的命名：时间前缀让仓库里的
 * 文件按上传顺序排列，随机后缀避免同一秒内的并发上传互相撞名（撞名在不开
 * overwrite 时会被判 FILE_EXISTS 而失败）。 */
export function generateRemoteName(filename: string): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ext = path.extname(filename).toLowerCase();
  return `${ts}_${randomBytes(4).toString("hex")}${ext}`;
}
