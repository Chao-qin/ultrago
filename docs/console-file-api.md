# Console 文件 API（图床）

从 `project-source/packages/server/src/image` 移植而来的 GitHub 图床能力，落在
console 包下成为一套**上传 / 下载文件的 HTTP API**：

`packages/console/src/image-bed/`

| 文件 | 职责 |
| --- | --- |
| `image-bed.types.ts` | 配置、上传结果、文件条目等类型 |
| `image-bed.config.ts` | 唯一读取根目录 `.env` 的 `IMAGE_BED_*` 配置 |
| `github-image-bed.service.ts` | GitHub contents API 封装：上传 / 下载 / 列举 / 删除 / 校验 |
| `image-bed.service.ts` | 门面层，API 只跟它打交道 |
| `image-bed.controller.ts` | REST 端点 |
| `image-bed.service.test.ts` | 27 条单测（假 fetch，不打真实网络） |

## 配置

图床配置唯一来自仓库根目录 `.env` 的 `IMAGE_BED_*` 环境变量；修改后重启 Console 生效。

```dotenv
IMAGE_BED_TOKEN=ghp_xxx
IMAGE_BED_OWNER=your-name
IMAGE_BED_REPO=your-bed
IMAGE_BED_BRANCH=main
IMAGE_BED_PATH_PREFIX=images
IMAGE_BED_CUSTOM_DOMAIN=
```

不支持 `GITHUB_*` 兼容别名，也不支持请求体覆盖配置。未配置时端点返回 400 + 明确提示，
而不是 500。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/files/upload` | **裸字节** body（main.ts 在该子路径挂了 `express.raw`），文件名等走 query：`filename` / `subDir` / `remoteName` / `overwrite` |
| POST | `/api/files/upload-local` | `{filePath, subDir?, remoteName?, overwrite?}` — 文件已在本机磁盘时免二次传输 |
| POST | `/api/files/upload-batch` | `{filePaths[], subDir?, overwrite?}`，单次上限 20 个，逐个间隔 500ms |
| GET | `/api/files` | 列举，`?prefix=` 指定目录（默认配置里的 pathPrefix） |
| GET | `/api/files/download?path=` | **代理下载**：服务端带 token 取字节再吐回；`?dl=1` 加 attachment 头 |
| GET | `/api/files/meta?path=` | 元信息（sha / size / 三种 URL），文件不存在返回 `{exists:false}` |
| DELETE | `/api/files?path=` | 删除远程文件 |
| GET | `/api/files/verify` | 用已保存配置测连通性 |
| GET | `/api/files/config` | 当前生效配置，token 只留后 4 位 |
| GET | `/api/files/limits` | 体积上限与扩展名白名单 |

上传成功返回：

```json
{ "success": true, "cdn_url": "https://cdn.jsdelivr.net/gh/o/r@main/images/20260906_215500_ab12cd34.png",
  "github_url": "https://raw.githubusercontent.com/o/r/main/images/....png",
  "html_url": "https://github.com/o/r/blob/main/images/....png",
  "download_url": "/api/files/download?path=images%2F....png",
  "markdown": "![....png](https://cdn.jsdelivr.net/gh/...)",
  "remote_path": "images/....png", "sha": "...", "size": 12345 }
```

失败返回 `{success:false, error_code, error}`，`error_code` 取值：`FILE_NOT_FOUND` /
`INVALID_FILE_TYPE` / `FILE_TOO_LARGE` / `FILE_EXISTS` / `TOKEN_INVALID` / `RATE_LIMITED` /
`REPO_NOT_FOUND` / `NETWORK_ERROR` / `UNKNOWN_ERROR`。

## 与源实现的差异

1. **HTTP 客户端**：axios → Node 20 全局 fetch（本仓没有 axios 依赖，也不打算加）。
2. **去掉 swagger / class-validator**：本仓 console 两者都没有，DTO 退化成 interface，
   校验在 service 里手工做（与 `main.ts` 里"不装全局 ValidationPipe"的取舍一致）。
3. **删掉百度搜图**（`baidu-image-search` / `search-and-upload`）：那是"按关键词找配图"
   的内容生产能力，不属于文件存储，搬进来只会让存储模块依赖一个无关的第三方站点。
4. **新增下载能力**：源实现只能上传，取回靠拼 CDN 链接。这里加了 `/api/files/download`
   代理——私有仓库没有 token 拿不到字节，代理让调用方无需持有 token；`/api/files`
   列举同理。
5. **体积上限 50MB → 20MB**：卡点不是 GitHub（contents API 到 100MB 才拒），而是
   jsDelivr——gh 上超过 20MB 的文件它不缓存，传上去也拿不到 CDN 直链。
6. **路径参数一律走 query**（`?path=`）而不是 `/:path`：仓库内路径本身带斜杠，
   放进 path segment 既难转义，又容易和 `/download`、`/verify` 这些固定端点抢路由。
7. **不落库**：没有为文件建 Prisma 表。GitHub 仓库本身就是真相源，列举/元数据直接问
   API；多加一层表就要处理"表里有的 GitHub 上没有"这类一致性问题。若将来需要按
   console 侧业务字段检索文件，再考虑加索引表。

## 两个踩过的坑

- **`tsx`（esbuild）不实现 `emitDecoratorMetadata`**：靠 TS 反射元数据的隐式构造函数注入
  在 dev 下会静默拿到 `undefined`，而 `tsc` 编译出的产物正常——只在 dev 崩。所以本模块
  所有构造函数依赖都用显式 `@Inject(...)`。
- **`subDir` 曾被压成最后一段**：`sanitizeSegment("articles/2026-09")` 只取 basename，
  导致用户指定的归档目录丢失。子目录改为逐段清洗后保留层级（`sanitizeSubDir`）。
