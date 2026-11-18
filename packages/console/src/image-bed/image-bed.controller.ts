import { Body, Controller, Delete, Get, Inject, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { ImageBedService } from "./image-bed.service.js";
import { guessMime } from "./github-image-bed.service.js";

/** 图床文件 API。
 *
 * `POST /upload` 的 body 是**裸字节**（main.ts 在该路径上先挂了 express.raw），
 * 文件名等元信息走 query —— 与既有 /api/uploads 的做法一致，省掉 multipart
 * 依赖，也不会撞 1mb 的 JSON 上限。
 *
 * 其余端点都是 JSON。路径参数一律用 query 传（`?path=`），不用 `/:path`，
 * 因为仓库内的路径本身带斜杠，放进 path segment 既难转义又容易和
 * `/download`、`/verify` 这类固定端点打架。 */
@Controller("api/files")
export class ImageBedController {
  constructor(@Inject(ImageBedService) private readonly files: ImageBedService) {}

  // ── 上传 ────────────────────────────────────────────────

  @Post("upload")
  upload(
    @Body() body: Buffer,
    @Query("filename") filename?: string,
    @Query("subDir") subDir?: string,
    @Query("remoteName") remoteName?: string,
    @Query("overwrite") overwrite?: string,
  ) {
    return this.files.uploadBytes({
      bytes: body,
      filename: filename ?? "",
      subDir,
      remoteName,
      overwrite: overwrite === "true",
    });
  }

  /** 文件已经在本机磁盘上（例如 book 跑完产出的截图）时用它，避免前端多传一遍。 */
  @Post("upload-local")
  uploadLocal(
    @Body() body: { filePath?: string; subDir?: string; remoteName?: string; overwrite?: boolean },
  ) {
    return this.files.uploadLocalFile(body ?? {});
  }

  @Post("upload-batch")
  uploadBatch(@Body() body: { filePaths?: string[]; subDir?: string; overwrite?: boolean }) {
    return this.files.uploadLocalBatch(body ?? {});
  }

  // ── 下载 ────────────────────────────────────────────────

  /** 代理下载：服务端带 token 去 GitHub 取字节再吐给调用方。私有仓库也能取到，
   * 且调用方不需要持有 token。`?dl=1` 时加 Content-Disposition: attachment。 */
  @Get("download")
  async download(@Query("path") remotePath: string, @Query("dl") dl: string, @Res() res: Response): Promise<void> {
    const file = await this.files.download(remotePath ?? "");
    res.setHeader("Content-Type", file.contentType || guessMime(file.filename));
    res.setHeader("Content-Length", String(file.bytes.length));
    if (dl === "1" || dl === "true") {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);
    } else {
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.filename)}"`);
    }
    res.end(file.bytes);
  }

  /** 只看元信息（sha / size / 三种 URL），不取字节。 */
  @Get("meta")
  async meta(@Query("path") remotePath: string) {
    const entry = await this.files.stat(remotePath ?? "");
    return entry ?? { exists: false, path: remotePath };
  }

  @Get()
  list(@Query("prefix") prefix?: string) {
    return this.files.list(prefix);
  }

  // ── 删除 / 校验 / 配置 ──────────────────────────────────

  @Delete()
  remove(@Query("path") remotePath: string) {
    return this.files.remove(remotePath ?? "");
  }

  @Get("verify")
  verify() {
    return this.files.verify();
  }

  /** 当前生效配置（token 打码）。 */
  @Get("config")
  config() {
    return this.files.describe();
  }

  @Get("limits")
  limits() {
    return this.files.limits();
  }
}
