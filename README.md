# UltraGo

Open-source MCP browser automation for AI agents, powered by a browser extension that operates your real browser.

一套**本地 RPA 栈**：纯浏览器扩展驱动你**真实的**浏览器，能力以 **MCP 工具**的形式暴露给任意 MCP 客户端，
可重复的任务用 **book（剧本）** 录一次、按参数回放，再由一个 **Console 管理后台** 做排期、编排与产物落地。

三个不可动摇的约束决定了它的全部设计：

| 约束 | 后果 |
| --- | --- |
| **纯扩展，坚决不用 CDP / `chrome.debugger`** | 所有动作靠合成事件（pointer / mouse / keyboard）+ DataTransfer。拿不到 response body、驱动不了原生文件对话框与 OS 级拖拽 |
| **MCP-only，无内置 agent** | 「怎么驱动浏览器」写进 MCP 的 `instructions`（`initialize` 时下发），任何连上来的客户端自动继承，与模型无关 |
| **MV3 service worker 会被强制回收** | 连续性靠持久化与重连补发，不靠内存 |

---

## 架构

```
              MCP 客户端（Claude Code / 任意 MCP client）
                          │  Streamable-HTTP  http://127.0.0.1:8788/mcp
                          ▼
 Console Web (React)  ┌──────────────────────────────────────────────┐
   http://…:8790 ────►│  @bcp/backend（单个 Node 进程）              │◄── @bcp/weclaw
   NestJS + Prisma    │   · MCP 工具层：51 个浏览器工具              │    微信 sidecar
   + SQLite           │   · InternalRunner   :8789 /internal         │    :18011
   剧本 / 排期 /      │   · PlanRunner + book 回放引擎               │
   流程编排 / 契约    │   · BrowserSetupService（浏览器生命周期）    │◄── @bcp/llm
      │      ▲        │   · WS Server        :8787                   │    LLM 网关 :11435
      │      │        └───────────────────┬──────────────────────────┘
      │      └── 产物回灌                 │  WS-RPC（token 握手 + 心跳 + 断线补发）
      │   POST /internal/deliveries/ingest│
      ▼                                   ▼
 resource/db/console.db          ┌─────────────────────────────────────┐
 resource/records/               │  浏览器扩展（Chrome MV3 / Firefox） │
 reports/                        │   · Service Worker：RPC 派发 / 保活 │
                                 │   · 按需注入 bcpDomRuntime          │
                                 │   · 侧边栏：连接状态 + 设置         │
                                 └──────────────┬──────────────────────┘
                                                ▼ chrome.tabs / chrome.scripting
                                        你本机真实的浏览器
```

**一次调用的路径**：MCP 客户端调 `/mcp` 上的工具 → backend 经 dispatcher 发出 WS `rpc_request` →
service worker 用扩展 API 执行 → 回 `rpc_response` → 结果连同 `↳ changed:` / `⚠ Verify gate` 一起回给客户端。

**Console 不碰浏览器**：它是 backend `InternalRunner` 的 loopback HTTP 客户端（`POST /internal/run` 起剧本、
轮询进度），浏览器始终由 backend 独占。

---

## 快速开始

### Windows：桌面客户端（推荐，不用装开发环境）

1. 安装 `UltraGo-<版本>-win-x64-setup.exe`（自行构建见 [`packages/desktop/README.md`](packages/desktop/README.md)）。
2. 打开客户端，点「准备工作台」：数据库、服务、内置模板全部自动完成。
3. 「连接浏览器」：按提示加载扩展；点「在桌面创建快捷方式」，以后用桌面上的「Chrome（UltraGo）」打开 Chrome。
4. 「接入 AI 助手」：选 Claude Desktop / Cursor / Codex 等，客户端直接写好 MCP 配置。

### 从源码运行（macOS / Linux / 开发者）

先装好 Node.js 22、pnpm 10 和 [uv](https://docs.astral.sh/uv/getting-started/installation/)。

```bash
pnpm run init                          # 依赖、Python 环境、.env、数据库
pnpm start                             # 构建并启动 backend + console；首次启动自动补齐工作台数据
pnpm --filter @bcp/extension build     # 然后在 chrome://extensions 加载 packages/extension/.output/chrome-mv3（见下方「装扩展」）
claude mcp add --transport http ultrago http://127.0.0.1:8788/mcp
pnpm doctor                            # 逐项检查，缺什么、怎么补都会写出来；pnpm doctor --fix 自动补能补的
```

默认只启动浏览器自动化需要的部分，扩展用内置 token 直接连上，不用填任何配置。
微信桥（`BCP_WECLAW_ENABLE=1`，需要 Go 1.25+ 和微信扫码）和本地模型（`BCP_LLM_ENABLE=1`）在 `.env` 里按需打开。

### 用你自己的 Chrome：必须带两个启动参数

任务窗口通常开在后台，被你的前台窗口挡住。Chrome 默认把完全被遮挡的窗口当成后台：`document.hidden=true`、
动画帧停摆 —— 弹窗 / 抽屉的离场动画卡在第一帧永远关不掉、截图读不回、React 输入不落地。
扩展注入的 keep-awake 垫片只接管定时器，救不了这个，**只有启动参数能治**。
这两个参数只在 Chrome **启动时**生效，所以：

- `managed` 模式和 `launch_browser`（Chrome 没在运行时）会自动带上；
- Windows 桌面客户端可以一键在桌面生成带参数的「Chrome（UltraGo）」快捷方式；
- Chrome 已经在运行却没带参数时，`page_state` 会直接提示「Chrome 没在渲染这个窗口」，`pnpm doctor` 也会查出来。

需要手动加时（你自己的 Chrome）：

```
--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows
```

前者只作用于 Windows（mac 上带着无害），后者两个平台都要。

**Windows**

1. 右键 Chrome 快捷方式 → 属性 → 「目标」改成：
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory="Default" --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows
   ```
   `--profile-directory` 填你的配置目录名（`chrome://version` 里 Profile Path（个人资料路径）的最后一段），顺带跳过选账号界面。
   任务栏上固定的图标是另一个快捷方式，要单独改，或者只用改过的那个启动。
2. **彻底退出 Chrome**：任务管理器里一个 `chrome.exe` 都不剩（或 cmd 执行 `taskkill /F /IM chrome.exe`，网页里未提交的表单会丢）。
   建议在 设置 → 系统 关掉「关闭 Google Chrome 后继续运行后台应用」，否则关掉所有窗口进程也还在，
   双击快捷方式只会让老进程开个新窗口，参数全部被忽略。
3. 双击改好的快捷方式。

**macOS**

1. `Cmd+Q` 彻底退出（mac 上关窗口不会退出 Chrome），确认 `pgrep -x "Google Chrome"` 没有输出。
2. 终端启动：
   ```bash
   open -a "Google Chrome" --args --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows
   ```
   Chrome 还在运行时 `--args` 会被忽略；从 Dock 图标启动不带参数。
3. 长期使用可以在 `~/.zshrc` 加个别名，以后都用它启动：
   ```bash
   alias chrome-bcp='open -a "Google Chrome" --args --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows'
   ```

**验证（两个平台一样）**

- `chrome://version` 的 Command Line（命令行）里能看到这两个参数，且**没有 `--restart`**。
  有 `--restart` 说明这个进程是 Chrome 自己重启出来的（更新后重启、`chrome://flags` 的重新启动），沿用的是旧命令行。
  Chrome 自动更新之后先看一眼这里，参数丢了就按上面步骤重来。
- 实测：让 agent 在后台窗口里 `eval` 读 `document.hidden`，应为 `false`，且 `requestAnimationFrame` 在正常触发。

### Python 环境

Python 由 `.python-version` 固定版本，依赖在 `pyproject.toml` 中声明、由 `uv.lock` 锁定。
依赖覆盖图片处理使用的 Pillow，以及现有评论导出脚本使用的 openpyxl。
`pnpm python:setup` 使用 uv 管理的解释器，在项目 `.venv` 中安装依赖；`.venv` 不提交到 Git。
这个命令只初始化 Python，不操作数据库或 Node 依赖，也不启动服务。

```bash
pnpm python:setup     # 新检出、项目移动或 Python 依赖更新后执行
pnpm python:check     # 核对版本，并实际生成一张图片检测拼图
pnpm test:python      # 环境隔离、预处理、图片处理的离线回归测试
pnpm python .claude/skills/product-preprocess/scripts/preprocess_wrapper.py < input.json
```

流程命令以 `python` 或 `python3` 开头时，Console 会通过 `scripts/python.sh` 使用项目环境；
已有流程不需要重新同步数据库。入口保留命令参数、工作目录和标准输入，并让 Python 子进程优先使用同一环境。
手动运行项目脚本也使用 `pnpm python ...`，不要直接调用系统 `python3`。
显式指定解释器路径或通过自定义 shell 启动 Python 的命令由其作者管理，不会被自动改写。

启动整栈及执行 Python 流程前会检查项目环境；环境缺失或版本与锁定值不符时，明确提示执行
`pnpm python:setup`，不会自动安装或回退到系统 Python。
`pnpm start` 在构建前检查，`pnpm restart` 在停止现有服务前检查；检查失败时保留正在运行的服务。
初始化会验证 Pillow 的 28 号字体接口及实际拼图，确保视觉检测中的 `SLOT` 编号可正常生成。
`pnpm test:python` 不包含需要真实 LLM 网关的 `test_llm_client.py`。
CI 会先准备同一套锁定环境，再运行 Python 和流程测试。

升级依赖时先修改声明，再运行 `uv lock --managed-python` 更新 `uv.lock`，随后运行
`pnpm python:setup`、`pnpm test:python` 和 Console 流程测试。只提交版本声明与锁文件，不提交解释器和安装目录。

### 商品预处理预算

商品预处理默认使用动态预算。类目和属性处理按实际模型调用推进，每次调用保留 240 秒请求上限；
图片下载按单张的请求及重试预算推进，上传按待上传图片数分配时间。下载、裁剪和类目判断不会消耗后续检测的预算。

图片检测在实际拼图完成后计算预算：每批最多 6 张图片，每批分配 180 秒；非空标题和描述分别按每 4,000 个字符
一个单元分配 180 秒。总检测预算为所有批次和文本单元的预算之和，重试也使用这份阶段预算。
由于客户端并发不代表模型服务能并行推理，单个图片请求按同批并发请求数量增加排队时间额度，并受阶段剩余时间限制。
例如 22 张图片组成 4 批，加一段短标题，检测预算为 900 秒，从检测阶段开始计时。

命令脚本可在 stderr 输出 `BCP_BUDGET_V1 {"stage":"image-detection","remainingMs":930000}`，
声明当前剩余工作预计需要的时间；Python 入口仅在流程提供 `BCP_FLOW_BUDGET_PROTOCOL=1` 时发送。
执行器按声明延长初始 `timeoutMs`，但不会复活已超时的进程，也不会超过进程启动后 30 分钟的安全上限。
内联脚本、试运行和没有声明工作预算的命令保持原来的超时限制。
Python 会为阶段收尾额外预留 30 秒；失败检测仍然阻止发布，不会因预算调整而跳过。

模型请求通过 `X-BCP-Request-Timeout-Ms` 将当前预算传给网关，网关以同一请求时限控制上游；
没有该请求头的调用仍默认 240 秒，上限为 30 分钟。Python API 显式传入 `llm_budget_seconds` 或设置
`BCP_LLM_BUDGET` 时仍可施加额外总时限。更新这部分代码后需同时重新编译 Console 和 LLM 网关，再重启服务。

`pnpm start` 起来后：

| 服务 | 地址 | 说明 |
| --- | --- | --- |
| MCP 端点 | `http://127.0.0.1:8788/mcp` | 任何 MCP 客户端连这里 |
| 扩展 WS | `ws://localhost:8787` | 扩展握手用，token 默认 `bcp-dev-token` |
| Console 管理后台 | `http://127.0.0.1:8790` | Web UI + REST API |
| backend 内部 API | `http://127.0.0.1:8789` | 仅 loopback，Console 专用，不在 MCP 面上 |
| WeClaw 微信 sidecar | `127.0.0.1:18011` | 默认关闭，`BCP_WECLAW_ENABLE=1` 打开 |
| LLM 网关 | `http://127.0.0.1:11435/v1` | **OpenAI 协议**，多渠道（本地 / 云 / 自定义适配器）；默认关闭，`BCP_LLM_ENABLE=1` 打开 |

**装扩展**：

```bash
pnpm --filter @bcp/extension build          # 产物：packages/extension/.output/chrome-mv3
pnpm --filter @bcp/extension build:firefox  # Firefox 版
```

Chrome：`chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选
`packages/extension/.output/chrome-mv3`（**不是** `chrome-mv3-dev`，那是 `wxt` dev server 写的另一份）。
每次重新构建后要在扩展卡片上点一下重新加载（↻），Chrome 不会自己感知解压目录的变化。
扩展加载即自动连接，与侧边栏是否打开无关；点工具栏图标开侧边栏可看连接状态、改后端地址与 token。

**接上 agent**：

```bash
claude mcp add --transport http ultrago http://127.0.0.1:8788/mcp
```

然后直接派任务，例如「打开 news.ycombinator.com，列出前 5 条标题」。服务端会在连接时下发用法说明，
不需要你再粘系统提示词。

**其它启动方式**：

```bash
pnpm dev              # 只跑 backend（tsx watch，不含 console / weclaw）
pnpm start:no-weclaw  # 整栈但强制跳过 WeClaw（即使 .env 里打开了）
pnpm kill             # 关掉 pnpm start 拉起的全部服务
pnpm restart
```

---

## 包一览

| 包 | 运行时 | 职责 |
| --- | --- | --- |
| `@bcp/shared` | 同构（多为类型） | 线协议 SSOT：RPC 方法契约、快照结构、book/step/signal 类型、flow 与 console 契约 |
| `@bcp/backend` | Node ≥ 20 | MCP `/mcp` 服务 + `instructions`、WS server、RPC bridge、PlanRunner、book 回放、浏览器生命周期、InternalRunner |
| `@bcp/extension` | Chrome MV3 / Firefox | Service worker（WS 客户端 + RPC 派发 + 注入 DOM 操作）；侧边栏 = 连接状态与设置 |
| `@bcp/console` | Node ≥ 20（NestJS 10 + Prisma + SQLite） | RPA 管理后台：剧本 / 运行 / 排期 / 流程编排 / 契约与数据 / 图床，含 React Web UI |
| `@bcp/weclaw` | Node ≥ 20 + Go 编译的二进制 | 微信桥 sidecar，把 `wec_*` 发送工具挂到同一个 `/mcp` |
| `@bcp/llm` | Node ≥ 20（零运行时依赖） | LLM 网关：对外一套 OpenAI 协议，背后按渠道表分发到本地 Ollama / LM Studio、url+apikey 云厂商、或自写适配器；兼管本地模型生命周期，随整栈同启同关。**不是可 import 的库，只经 HTTP 访问** |

---

## 浏览器工具（51 个）

工具都注册在 backend 的 MCP 端点上，按域分组：

| 组 | 工具 |
| --- | --- |
| 标签页 / 窗口 | `navigate` `new_tab` `close_tab` `new_window` `close_window` `list_windows` |
| 感知 | `snapshot` `page_state` `read_content` `analyze_page` `screenshot` |
| 动作 | `click` `type_text` `press_key` `scroll` `select_option` `pick_option` `drag` `hover` `right_click` `double_click` `paste_text` `upload_file` `download` |
| 等待 / 导航 | `wait_for` `go_back` `go_forward` `reload` `switch_tab` |
| 网络 / 事件 | `read_network` `set_network_capture` `read_events` `wait_for_event` |
| 计划 / 录制 | `plan` `advance` `plan_status` `plan_abort` `record_stop` |
| 剧本 | `list_playbooks` `run_playbook` `local_eval` `write_file` |
| 多浏览器 / 生命周期 | `browser_state` `use_browser` `claim_tab` `set_browser_mode` `launch_browser` `stop_browser` |
| 兜底 | `eval` `batch` |

WeClaw sidecar 在线时，`wec_status` / `wec_send_text` / `wec_send_image` 出现在同一个端点上。

所有按元素操作的工具（`click` `double_click` `right_click` `hover` `type_text` `paste_text` `upload_file` `pick_option` 及 `batch` 的步骤）共用同一套定位参数：`ref`，或描述（`text` / `role` / `name` / `css`，可加 `near` / `exact` / `nth`），或坐标 `x,y`。

不可逆 / 对外动作（提交、支付、发布、删除、发送）要求 `confirm:true`，且必须是用户任务里明确要的；
意图不清就停下来报告，不替用户确认。

### 核心循环：perceive → act → verify

服务端 `instructions` 是这套纪律的 SSOT（`packages/backend/src/browser-mcp-instructions.ts`），要点：

- **按最便宜的读法选工具**：`page_state`（就绪 / 焦点 / 表单可提交性 / 对话框 / 滚动锁 / 自上次以来的 `changed`）→
  `snapshot`（带 `[ref]` 的可操作元素树）→ `analyze_page`（全量：状态 + 树 + 可见文本 + 截图 + 标签页，贵，页面陌生或连续两三次动作没反应时才升级）。
- **快照元素带状态与视觉层**：`[hidden]` `[disabled]` `[clickable]` `[invalid: …]` `(scrollable)`，
  以及 `@dialog:<名>` / `@fixed-top` 等层标记——DOM 嵌套说不出「这个 modal 盖住了整屏」，层标记能。
- **验证不能省**：变动类工具会追加一行 `↳ changed:`（URL 变化、元素增减、对话框打开、新错误、动作证据），
  出现 `⚠ Verify gate` 就必须在下一个动作前重新读页面。界面文字会骗人，确认「真的存到服务器了」要用
  `read_network` 看 2xx。
- **拦截要认得出**：验证码 / 风控是唯一不该重试的中断，会以 `⚠ CAPTCHA / risk-control` 出现在
  `changed` 行、`page_state` 与 `captcha_appeared` 事件里；正解是停下来告诉用户，`wait_for_event` 等
  `captcha_cleared` 再继续。这个服务从不尝试破解挑战。

### 多步任务：plan / advance

`plan` 注册一个有序计划，每步自带 `verify`（结构化断言：url 含 X、文本存在 / 不存在、某个可交互元素的
名字 / 勾选 / 可用 / 取值、自本步开始以来某 URL 的 2xx、无页面错误、页面已静默、对话框已开、表单可提交，
以及 `evalCheck`）与 `onFail`（retry / rescan / escalate，默认 escalate）。
`advance` **自己重新读页面**判定，验不过就不放行。它只判不做，动作仍由 agent 执行。

默认这道门是自愿的；`BCP_FORCE_PLAN=on` 会把它变成硬要求——没有活跃计划就拒绝一切改动性动作。

### 重复任务：录一次，换参数回放

给 `plan` 传 `record: {paramNames, paramValues}`，每个 `advance` 过的步骤会自动捕获动作，
计划跑完 `record_stop` 存成 `resource/playbooks/<name>.json`（跑歪了用 `plan_abort` 丢掉重录）。

回放：`list_playbooks` 看已有剧本与各自要什么参数，`run_playbook(name, params)` 把 `{{slot}}` 填好加载成计划。

- `mode:"assisted"`（默认）：仍由 agent 逐步执行，但动作直接读步骤的 `action` 字段，不用重新推导。
- `mode:"auto"`：零 agent 介入地跑完，只在 `risk:"confirm"` 步骤（每次都停，无法预授权）、
  `assert` / `visualAssert` 判断、没有录到动作的步骤处暂停。暂停后按提示处理，
  再用 `resumePlanId` 续跑同一次运行（默认沿用开始时的模式）。某一步重试耗尽则本次运行结束、
  标签页关闭，不能续跑，修好原因后重新开始。

剧本里也能放**后端侧**步骤：`local_eval`（在 backend 进程里跑 JS，读本次运行的前序结果）
和紧随其后的 `write_file`（把上一步的值写进 `reports/`），它们和点击、输入一样会被录进剧本、在 auto 回放里执行。

现有剧本（`resource/playbooks/`，10 本）：

| Book | 步数 | 用途 |
| --- | --- | --- |
| `1688-offer-snatch` | 13 | 指定 1688 offer URL，采集 SKU / 主图 / 详情图 |
| `1688-random-offer-snatch` | 16 | 首页 → 随机类目 → 随机商品的尽力采集版 |
| `baidu-hot-search` | 5 | 独立工作窗口采百度热搜 / 民生 / 财经三榜，校验后写 `reports/` |
| `doubao-ask` | 11 | 豆包网页问答：监听 `/chat/completion` SSE 解析，不读 DOM |
| `doudian-category-schema` | 3100 | 抖店类目数据的唯一采集入口：类目树下钻 + 逐叶子 getSchema，出三份产物 |
| `doudian-publish-canonical` | 35 | 抖店发商品第一段：5 张主图 + 标题 + 类目 → 进商品信息表单 |
| `doudian-image-text-publish` | 21 | 抖店图文创作发布（挂车 / 非挂车，dry-run 与 publish 两种落点） |
| `doudian-after-watch-config` | 14 | 给已发布图文补承接商品与看后搜词 |
| `doudian-freight-templates` | 6 | 采集当前店铺全部运费模板关键字段 |
| `doudian-shopprofile` | 5 | 采集店铺资料与发布配置快照 |

### 多浏览器与协作

多个浏览器（甚至 Chrome + Firefox）可以同时在线，各自有稳定的 `instanceId`，互相隔离：

- `browser_state` 是全景读：每个浏览器 × 模式 × 窗口（哪个是 OS 前台）× 标签页，外加**其它会话**占用了哪些标签页。
- `use_browser` 只切换**你这个会话**的目标，别的 MCP 会话保持各自的目标——多个 agent 可以并行驱动不同浏览器。
- 共用一个浏览器时，`new_tab({claim:true})` 或 `claim_tab` 给你的会话圈一个专属标签页，
  之后省略 `tabId` 的工具只打你自己的页。跨会话的 claim 互相可见。
- `set_browser_mode` 设成 `manual` 表示**用户本人正在用这个浏览器**：此后不能切标签页、不能无 `tabId` 动手、
  截图也不再抢前台。用户交回来时设回 `auto`。
- 拓扑变化（上下线、模式切换、claim 变化、目标变化、窗口开关、验证码出现 / 解除）以事件推送，
  搭在返回值里 piggyback，`wait_for_event` 可以阻塞等，不用轮询。
- `launch_browser` 拉起并等握手完成：`user` 模式用你自己的浏览器与配置（backend 永不接管），
  `managed` 模式起一个 backend 自有 profile 并预装扩展（仅 Chrome）。`stop_browser` 只停 managed 实例，且要 `confirm:true`。

---

## Console 管理后台

`http://127.0.0.1:8790`（NestJS 10 + Prisma + SQLite；Web 端 React 18 + Vite + antd 6 + TanStack Query + `@xyflow/react` + CodeMirror）。

**页面**：仪表盘 · Books（剧本） · Runs（运行记录，含步骤级明细） · Schedules（cron 排期）·
Flows（流程编排画布）与 Flow Runs · Scripts（内联可调度脚本）· Schemas（契约注册表）·
Schema Records（按契约落地的数据）· Database（内嵌 Prisma Studio）· Settings。

**服务端模块**：

| 模块 | 路由 | 职责 |
| --- | --- | --- |
| Books | `api/books` | 剧本元数据 CRUD + `rescan` 手动重扫 |
| Filesync | — | 扫 `resource/playbooks/*.json` upsert 成 `Book` 行；**只读文件，从不回写 JSON** |
| Runs | `api/runs` | 入队去重与参数校验 → 并发租约推进状态机 → 产物落地 → 投递（file / print / webhook / message，可重投） |
| Scheduler / Schedules | `api/schedules` | 每分钟 tick，用 `CronLease` 做 DB 分布式锁；排期目标可以是 book / flow / script |
| Flows | `api/flows`、`api/flow-runs` | 编排图（节点 = book / script / http / transform / subflow）的 CRUD、校验、触发、取消与续跑 |
| Scripts | `api/scripts` | 内联脚本 CRUD + 试跑，与 flow 共用子进程沙箱 |
| Schemas / SchemaRecords | `api/schemas`、`api/schema-records` | `name@version` 契约注册表（同版本内容不可变）+ 按契约落地的数据行，含软删与恢复 |
| Records | `api/records/:name` | **只读**下发运行产出的非 JSON 文件 |
| Uploads | `api/uploads` | 控制台选的附件暂存到 `resource/uploads/`，供 book 以 `localPath` 引用 |
| ImageBed | `api/files` | GitHub 仓库 + jsDelivr 图床：上传 / 下载 / 批量 / 元信息 / 删除 / 校验 |
| Browser | `api/browser` | status / setup / stop，纯代理到 backend 内部 HTTP |
| Studio / Stats / Health | `api/studio`、`api/stats`、`api/health` | 内嵌 Prisma Studio 的 BFF、仪表盘统计、DB + backend 合并健康检查 |

**数据模型**（`packages/console/prisma/schema.prisma`）：`Book` `Script` `Schedule` `Run` `StepRun`
`DeliveryRun` `CronLease` `Schema` `SchemaRecord` `Flow` `FlowRun` `FlowNodeRun` `FileAsset`。
数据库文件在 `resource/db/console.db`。

> ⚠️ Console **没有任何鉴权层**，且默认绑 `0.0.0.0`——能连上这个端口的人就能触发剧本、改排期、删数据。
> 只在可信网络里开；要收回 loopback 就设 `CONSOLE_HOST=127.0.0.1`。

---

## 磁盘约定

| 路径 | 内容 |
| --- | --- |
| `resource/playbooks/` | book JSON（真相源；Console 只读不回写）+ `__fixtures__/`（从真实站点抓下来的脱敏响应流，给 `check:books` 离线回放） |
| `resource/db/console.db` | Console 的 SQLite |
| `resource/records/` | 运行产出的非 JSON 文件（内容哈希 + 安全名） |
| `resource/uploads/` | 控制台上传的附件 |
| `resource/flow-runs/` | flow 运行输出 |
| `reports/` | book 的 `write_file` 落点与投递产物；大产物用 `pnpm reports:compress` 压成 `.json.gz` |
| `~/.bcp/browser/` | managed 模式的浏览器 profile 与扩展产物（backend 自有，可用 `BCP_BROWSER_ROOT` 改） |

---

## 配置

配置集中在仓库根 `.env`（`scripts/backend.sh` 与 backend 都读它），也可以用进程环境变量覆盖。

**Backend**

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `BCP_PORT` | `8787` | 扩展 WS 端口 |
| `BCP_HOST` | `127.0.0.1` | WS 绑定地址；设 `0.0.0.0` 让远程浏览器直连（此时务必设真 token） |
| `BCP_MCP_PORT` | `8788` | MCP `/mcp` HTTP 端口（始终 loopback） |
| `BCP_TOKEN` | `bcp-dev-token`（留空即用它） | 握手共享密钥，必须与扩展侧边栏一致；扩展内置的也是这个值，所以单机留空即可。`BCP_HOST` 对外暴露前务必改成随机长串 |
| `BCP_RPC_TIMEOUT_MS` | `30000` | 单个浏览器动作的超时 |
| `BCP_ALLOWED_DOMAINS` / `BCP_BLOCKED_DOMAINS` | 空 | 导航白 / 黑名单（逗号分隔）；`javascript:` `data:` `file:` 等协议一律拒绝 |
| `BCP_EVAL` | 开 | 页面内任意 JS 的 `eval` 工具（MAIN world）与 `evalCheck`；设 `off` 关闭。桌面客户端在准备页的“允许页面脚本”中开关，运行中切换立即生效 |
| `BCP_LOCAL_EVAL` | 开 | `local.eval` 步骤和 `local_eval` 工具（在 **backend 进程**里跑 JS，影响面比页面 eval 更大）；设 `off` 关闭。桌面客户端在准备页的“允许本机脚本”中开关，运行中切换立即生效 |
| `BCP_FORCE_PLAN` | 关 | 设 `on` 后，没有活跃计划就拒绝一切改动性动作 |
| `BCP_SCREENSHOT_DIR` | 空 | 截图 `savePath` 允许写入的额外目录；系统临时目录始终允许。桌面客户端在准备页选择 |
| `BCP_INTERNAL_PORT` / `BCP_INTERNAL_TOKEN` | `8789` / `bcp-internal-dev-token` | Console 用的 loopback 内部接口 |
| `BCP_BROWSER_ROOT` | `~/.bcp/browser` | managed 浏览器 profile 与扩展产物的根目录 |
| `BCP_WECLAW_ENABLE` | 关 | 设 `1` 启动 WeClaw sidecar（需要 Go 1.25+，启动时要微信扫码）。`BCP_WECLAW_DISABLE=1` 仍可强制关闭 |
| `BCP_EVENT_WEBHOOK` | 空 | 填一个地址后，验证码出现 / 解除、浏览器掉线会**主动 POST** 给它（详见下方"实时事件推送"）|

开关取值 `on` / `1` / `true` / `yes`（不分大小写）都算开启；两个 eval 开关默认开启，写 `off` / `0` / `false` / `no` 才关闭。关闭后，`resource/playbooks/` 下靠 `browser.eval` / `local.eval` 读结构化数据的剧本
在关闭状态会 fail-closed 而不是静默降级。

### 实时事件推送（`BCP_EVENT_WEBHOOK`）

有些事只在**发生的当下**才有价值——撞上验证码、浏览器掉线。验证码候选是 DOM 预估，**不会出现在任何给 agent
的输出里**（快照、`↳ changed:`、`page_state`、事件搭载、`read_events` / `wait_for_event` 都不带），只走这条推送通道。

填上 `BCP_EVENT_WEBHOOK=http://127.0.0.1:9000/hook`，这几类事件发生时后端会**主动 POST** 过去：

| 事件 | 何时 | 带截图 |
| --- | --- | --- |
| `captcha_appeared` | 本地视觉模型确认受控标签页存在验证码 / 人机验证拦截 | ✅，压缩 JPEG |
| `captcha_cleared` | 已成功推送的拦截消失 | — |
| `browser_offline` | 某个浏览器断开 | — |

请求体就是事件本身，外加一个可选的 `screenshot`（data URL）：

```json
{
  "kind": "captcha_appeared",
  "tabId": 12,
  "ts": 1757400000000,
  "seq": 42,
  "browser": "chrome-1",
  "summary": "challenge PAGE detected (tencent, high) — url 像验证页",
  "detail": {
    "kind": "page", "confidence": "high", "vendor": "tencent",
    "evidence": ["url 像验证页", "页面很空:3 个可点元素"],
    "frameId": 0, "url": "https://…/verify", "title": "安全验证"
  },
  "screenshot": "data:image/jpeg;base64,…"
}
```

验证码通知流程：DOM 规则产生候选 → 等待 800ms 渲染稳定 → 截图等比例缩至最长边 1280px（小图不放大）、
JPEG 质量 0.75 → 本地视觉模型复核 → 仅明确为真时推送。图片超过 1 MiB 时忽略该候选，不发送原图。
后台标签页在自动模式下临时激活后截图，再恢复同一窗口的原标签页，不主动聚焦窗口。
截图与 MCP 切页串行执行；手动模式不切换后台标签页，无法取得目标截图时仍忽略通知。
普通登录、短信 / 邮箱 / 2FA 验证码输入框不作为人机验证挑战。

复核复用 `BCP_LLM_URL`（默认 `http://127.0.0.1:${BCP_LLM_PORT:-11435}`）的 `/v1/models` 和
`/v1/chat/completions`。只选择所有来源均为本机 Ollama / LM Studio 的模型，不回退远程模型。
本地模型需要支持图片输入；发现模型和复核共用 30 秒超时。后台日志记录忽略原因。

边界：

- **只发一次，不重投**。这条通道的价值就是「现在」——十分钟后补送成功的验证码提醒，验证码早过期了。
  需要「一定送达」的结果通知,用剧本的 `deliveries`(那条路有 SQLite 队列和重试)。
- **无法确认就不推送**。模型判否、不确定、超时、返回无效格式，或截图 / 压缩失败时，忽略本次验证码事件，
  后续解除事件也不推送。模型不可用期间可能漏报。
- **不使用其他标签页的截图**。`captureVisibleTab` 只能拍窗口里当前显示的标签页；目标在后台时，忽略该候选。
- **丢弃过期复核**。复核期间验证码解除、页面导航、标签页关闭或浏览器掉线，都会使对应候选失效。
  完整导航在开始时通过 `navigation_started` 失效，SPA 的 history / hash 变化也覆盖；原 `navigation` 仍表示加载完成。
- **保持通知顺序**。同一浏览器、标签页和 frame 的通知按顺序发送，前一轮解除不会落在下一轮出现之后。
- **地址不做内网校验**。它来自你本机的配置，`127.0.0.1` 正是预期用法。（剧本里的 webhook 地址可能来自别人写的
  剧本，那条路仍然禁止内网地址。）

**Console / LLM / WeClaw**

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `CONSOLE_PORT` / `CONSOLE_HOST` | `8790` / `0.0.0.0` | Console 监听地址 |
| `DATABASE_URL` | `file:../../../resource/db/console.db` | Prisma 相对路径按 **schema 目录**解析 |
| `BCP_INTERNAL_URL` | `http://127.0.0.1:8789` | Console 找 backend 内部接口的地址 |
| `IMAGE_BED_TOKEN` / `_OWNER` / `_REPO` / `_BRANCH` / `_PATH_PREFIX` | 无 | GitHub 图床配置，改完重启 Console 生效 |
| `BCP_LLM_ENABLE` | `0` | 设 `1` 启动 LLM 网关与本地模型 |
| `BCP_LLM_PROVIDER` | `auto` | `auto` 按机器档选，或显式 `ollama` / `lmstudio` |
| `BCP_LLM_PORT` | `11435` | 网关对外的 OpenAI 端口（`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/models`） |
| `BCP_LLM_HOST` | `127.0.0.1` | 网关监听地址。**改成别的就等于对外提供服务**，此时请先签发 API key（见下） |
| `BCP_LLM_OLLAMA_PORT` / `BCP_LLM_LMSTUDIO_PORT` | `11437` / `11436` | 本地后端各自的内部端口，只有适配器连它们 |
| `BCP_LLM_MODEL` / `BCP_LLM_NUM_CTX` | `qwen3.5:4b` / `32768` | 本地 Ollama 渠道的模型与上下文窗口 |
| `BCP_LLM_CALL_RETENTION_DAYS` | `30` | 调用日志保留天数，每天 04:00 清理；`0` 关掉清理 |
| `WECLAW_API_ADDR` | `127.0.0.1:18011` | WeClaw sidecar HTTP 地址 |

扩展侧：侧边栏 ⚙ 设置可改后端地址与 token，存在 `chrome.storage.local`。

---

## WeClaw（微信桥）与 LLM 网关

**WeClaw** 是可选 sidecar，由 backend 拉起并守护，把 `wec_*` 发送工具挂在同一个 `/mcp` 上。
`pnpm start` 会从源码编译**带 `external_delivery` 补丁**的二进制，因此整栈机器需要 **Go 1.25+**（外加 git 与网络）——
这跟操作系统无关，任何装了 Go 的机器都能编。`pnpm --filter @bcp/weclaw install:bin` 下的是上游预编译版，**不含**该特性；
默认不启用：不设 `BCP_WECLAW_ENABLE=1` 就整个跳过（不编、不需要 Go、不用扫码）。

**@bcp/llm** 是一个小型 LLM 网关。对外只有一套 **OpenAI 协议**（`http://127.0.0.1:11435/v1`），背后是一张渠道表：

```
                      ┌─ adapter: ollama   ──► 托管 Ollama    :11437   （options.num_ctx）
OpenAI 客户端 ──► 网关 ├─ adapter: lmstudio ──► LM Studio      :11436
     :11435/v1        ├─ adapter: openai   ──► url + apikey 的云厂商（可配多条）
                      ├─ adapter: opencode ──► opencode CLI（子进程，非 HTTP）
                      └─ adapter: <你写的> ──► 任何非标准渠道
```

适配器有两种形态：**HTTP**（`buildRequest` / `parseResponse` / `parseStreamFrame`，网关管传输）和
**direct**（`kind:"direct"` + `invoke`，自己管传输，产出一个完成的 OpenAI 响应）。后者是为 `opencode`
这种「答案从 stdout 来」的通道存在的——HTTP 形态**结构上表达不了**它。direct 通道没有 baseUrl，也没有真流式
（网关把整段答案重切成 chunk 发给要 `stream` 的调用方）。

**没有特权路径**：本地 Ollama / LM Studio 和你自己写的适配器实现的是同一个接口、注册进同一张表——
把 Ollama 变成 OpenAI 的正是那个 ollama 适配器。请求按 `model` 字段路由到渠道 id。

渠道配在 `packages/llm/channels.json`（**进仓**，文件头 `_readme` 里有字段说明）。密钥写 `env.NAME` 引用，
真值放 `.env`——注意 `.env` 也是进仓的，写进去的 key 会进提交历史。删掉 channels.json 也能跑：
网关会按硬件档推导出一条名为 `local` 的本地渠道，全新 clone 零配置可用。

新增一个适配器 = 在 `src/adapters/custom/` 放一个文件，default 导出一个 `Adapter`：HTTP 形态是
`{ name, buildRequest, parseResponse, parseStreamFrame }`，子进程等非 HTTP 形态是 `{ name, kind:"direct", invoke }`。
不用改任何核心文件；同名时你的实现覆盖内置的。

**厂商私有参数怎么传？** 平铺在请求体顶层——这就是 OpenAI SDK 的 `extra_body`（它把内容合并到 body 根层级，
线上并没有 `extra_body` 这个 key），也是 vLLM 文档给 `guided_json` / `repetition_penalty` 的写法：

```python
client.chat.completions.create(model="local", messages=[...],
                               extra_body={"repeat_penalty": 1.15, "keep_alive": "10m"})
```

各适配器的落点是**规则**不是猜测：`openai` / `lmstudio` 原样透传；`ollama` 把未知键放进它的 `options` 袋子，
`keep_alive` 这类顶层参数除外，而 `user` / `n` / `tool_choice` 这些 OpenAI 专有的路由字段会被拦下不外泄。
需要恒定的值（如 `numCtx`）写进渠道 `options`；请求里显式发的同名参数**覆盖**渠道默认。

> ⚠️ 上下文窗口是**渠道配置**，不是请求参数。OpenAI 协议没有这个字段（窗口是模型属性），Ollama 的 `/v1` 因此
> 也收不了，默认会掉回 2048 并静默截断输入。所以 ollama 渠道走原生 `/api/chat`，把 `numCtx` 落成 `options.num_ctx`。

**同一个模型名配多条渠道 = 多把 key 自动分摊 + 自动 failover。** 请求在同名渠道间轮询落地；
某一条失败时按错误类型决定去留：429 / 5xx / 网络错**换下一条重试**，400 / 401 / 404 直接返回
（同一个请求换谁都是这个答案，重试只会把一个清楚的错误变成 N 个）。**流式响应一旦开始写出就不再重试**——
状态行和分片已经在线上了，拼接出来的答案会读起来像一个完整的答案。连续失败 3 次的渠道被**排到候选末尾**
冷却 30 秒（不是剔除：全都病了时仍然得试一条，否则降级的模型就变成消失的模型）。每一次尝试各记一条调用日志，
否则「一半时间 429、另一半被重试救回来」的上游在监控页上看着完全健康。

**限流、别名、花费、鉴权**都在 Console 的 LLM 页（「访问与限流」「渠道管理」）里配，落到同一个
`channels.json` / `keys.json`：

| 能力 | 配在哪 | 说明 |
| --- | --- | --- |
| 渠道并发上限 | 渠道的 `maxConcurrency` | 上游的属性（本机 Ollama 共享显存、云厂商有 RPM） |
| 全局并发上限 | 顶层 `limits.maxConcurrency` | 本机的属性。超限**排队等待**而非 429——批处理宁可等，而每个请求自带的 `X-BCP-Request-Timeout-Ms` 就是它愿意等多久 |
| 用途别名 + 备胎链 | 顶层 `aliases` | `"task.vision": ["首选", "备胎"]`，让调用方写用途而不是写死模型。首选的所有渠道都失败时自动落到下一个。**链上任何一个指向不存在的模型都会让网关拒绝启动**，不会等到调用时才 404 |
| 花费核算 | 渠道的 `pricing` | 照厂商价格页填「每 100 万 token」。不填 = 该渠道不核算（显示「—」，**不是 0**）。多币种**分开统计，永不合成一个数** |
| 能力标签 | 渠道的 `capabilities` | 人工声明、仅供挑选：网关既不据它路由也不据它拒绝请求 |
| 入站 API key | `packages/llm/keys.json`（**不进仓**） | 只存 sha256，明文仅在签发那一次返回。每把可单独设**有效期 / 每分钟请求数 / 并发上限 / 可用模型白名单** |

**鉴权没有开关，有没有 key 本身就是开关**：一把启用中的 key 都没有 → 网关不鉴权（全新 clone 零配置可用，
也是现在单机自用的形态）；签发第一把之后，除 `allowLoopback`（默认开）放行的本机调用外都要带
`Authorization: Bearer <key>`。把 `BCP_LLM_HOST` 改成非 loopback 却一把 key 都没签发时，启动会明确警告。

每把 key 的四项限制各管一件事：**有效期**到点即拒（所有 key 都过期时网关**继续鉴权**、拒绝所有，
而不是退回「没有 key = 敞开」）；**每分钟请求数**是滑动窗口，超限回 429 + `Retry-After`，纯内存重启归零；
**并发上限**与渠道级、全局级组成三层闸；**可用模型白名单**空着 = 全部可用，它是一个**候选过滤器**而不是
前置检查——别名的备胎链因此绕不过它，failover 只在这把 key 被允许的模型里切换。

**key 可以随时回显与复制**：认证只看 sha256，但明文也留一份，所以 Console 上点一下眼睛就能看到完整 key、
一键复制、或用「接入」直接摆出 Base URL / API Key / Model 三件套。默认打码是为了挡截图与屏幕共享，不是因为
取不到。明文**不随列表返回**，只在你点「显示」时经 `/admin/keys/<id>/secret` 取一次。

> 这里一度只存哈希。哈希防的是「服务端被拖库」，而这里没有服务端——`keys.json` 与 `channels.json` 同机、同
> 用户、同 `0600`，而后者本来就存着明文的上游 key。代价却是实打实的：key 一丢只能吊销重签，而重签意味着去
> 改每一个用到它的客户端。**升级前签发的 key 只有哈希**，界面会如实标成「取不回明文」，不假装。

每把 key 还有**测试**按钮：用它的明文真打一次网关自己的 `/v1/chat/completions`，于是鉴权、有效期、每分钟
上限、并发闸、模型白名单、路由与上游被同一发全部覆盖。从内部直调只能证明「上游活着」，恰好绕开这把 key 上
的每一项限制——也就绕开了人真正想验证的东西。

调用方用 `X-BCP-Caller: <名字>` 自报家门，它会落进调用日志——那是唯一能回答「**哪条流程**在超时 / 在烧钱」
的维度（`channel` / `model` 回答的是「打给谁」）。不带时回落到那把 key 的名字。

命令：

```bash
pnpm llm:setup    # 首次安装与拉模型
pnpm llm:pull     # 拉 / 更新模型
pnpm llm:migrate  # 破坏性迁移（删旧模型，需三重确认）
curl http://127.0.0.1:11435/v1/models   # 有哪些渠道，各自背后是什么模型（不打上游，永远秒回）
curl http://127.0.0.1:11435/health      # 逐渠道探活；任一上游不可达 → 503 并指名道姓
curl http://127.0.0.1:11435/admin/runtime  # 闸上多少在飞/排队、哪条渠道正被降级（纯内存，不打上游）
```

**配置写错会拒绝启动，不会带病运行。** 渠道表里的未知键、拼错的键、类型不对的 option 一律在启动时报错并给出建议
（`unknown key "num_ctx" — did you mean "numCtx"?`）。这条不是洁癖：`numCtx` 少写一个大写字母，
上下文窗口就会无声回落到 Ollama 的 2048 并截断输入——正是这个适配器存在的理由被一个字符重新打开。

**opencode 渠道**把一个编码 agent 当纯 LLM 用，靠四层隔离（每层都实测过，少一层就串味）：
`tools:{"*":false}` 让请求体里没有 tools；`--dir` 指向仓库内的 `packages/llm/opencode-sandbox/`
而不是你的项目；`HOME` 换到 `scripts/.opencode-home/`，否则 `~/.claude/CLAUDE.md` 会整个混进 system prompt
（实测：不隔离时模型会在答案末尾附上契约里的条款编号）；`XDG_CONFIG_HOME`/`XDG_DATA_HOME` 仍指向真实位置，
否则找不到 provider 配置与登录凭据。

**每个**请求都拿到一个**一次性沙盒**（跑完即删）。参考脚本是直接覆写共享的 `system.md` 并自己标注
「并发跑会互相覆盖」——网关要并发服务，那等于两个调用方在对方的指令下作答，所以这里不能照抄。

沙盒里的 system prompt 是**组合**出来的，不是二选一：`opencode-sandbox/system.md` 的**基础设施前言**
（「你没有工具、别输出伪工具调用」，即 `tools:{"*":false}` 的散文版）永远在前，调用方的 `system` 消息
追加在后。前言**刻意不含任何风格意见**——没给 system 的调用方期望的是模型默认行为，不是网关的口味；
从前那句「不复述问题、不解释推理过程、不输出计划」就是被静默强加的人格，已经删掉。
要换前言用渠道 option `systemPreamble`。
首次调用会慢（opencode 在空 HOME 里初始化，实测 ~3.5 分钟），之后是正常速度。

同理，ollama 渠道对**做不到**的 OpenAI 特性（`n>1`、`logprobs`、`logit_bias`、`tool_choice≠auto`）直接报错，
而不是默默降级；只有纯元数据字段（`user` / `store` / `metadata` / `service_tier`）才继续忽略——忽略它们不改变答案。

---

## 开发与校验

pnpm monorepo（Node ≥ 20，pnpm 10）。

```bash
pnpm -r typecheck        # 全仓类型检查
pnpm -r build            # 全仓构建（extension 走 vite/wxt 真打包）
pnpm test                # 各包 node:test 单测
pnpm check:dom           # 扩展 DOM runtime 回归：真代码注入真 Chromium 执行
pnpm check:books         # book 内联 JS 回归：用 __fixtures__ 的真实响应流离线跑
pnpm check:convergence   # console.db 结构不变量
pnpm check:soft-delete   # 每处针对软删模型的 Prisma 查询是否显式表态
pnpm reports:compress    # 把类目采集大产物压成 .json.gz
```

两条自动化防线值得单独说，因为它们跑的是**真代码**而不是逻辑复制品：

- **`check:dom`** 用 esbuild 打包真实的 `bcpDomRuntime` 并注入真实 Chromium 执行。
  被测的是浏览器自身行为（value sanitization、布局、hit-test），jsdom 顶不了。缺工具链时 **exit 2**，不静默放行。
- **`check:books`** 覆盖 book 里那几千字符的内联 JS（塞在 JSON 字符串里，既没有类型检查也没有 lint）。
  输入是 `resource/playbooks/__fixtures__/` 下从真实站点抓的原始响应流。缺 fixture 时 **exit 2**。

**仍然没有自动化的**：service worker 保活、RPC 投递去重、MCP 契约端到端、跨标签页编排——
靠 typecheck + build + 接线核对 + 手测兜着。

**新增一个 DOM 动作 = 五处接线**：`shared` 的 `RpcMethod` + 契约 → `dom-runtime` 的 op 联合 + case →
service worker 的 DOM_OP + `runRpc` case → backend 注册工具 →（必要时）补 `BROWSER_INSTRUCTIONS`。
漏一处类型检查未必报错，要靠全链核对。

### SSOT 指针

| 关注点 | 位置 |
| --- | --- |
| 运行时「怎么驱动浏览器」总说明 | `packages/backend/src/browser-mcp-instructions.ts` → `BROWSER_INSTRUCTIONS` |
| MCP 工具注册（按域分组） | `packages/backend/src/browser-mcp-tools-*.ts` |
| RPC 契约（方法 / 参数 / 返回 / 快照结构） | `packages/shared/src/index.ts` → `RpcMethod` / `RpcContracts` / `SnapshotElement` |
| book / step / 信号门 类型 | `packages/shared/src/index.ts`（`PlanStep` / `StepVerify` / `Playbook`）、`book-signals.ts`、`book-actions.ts` |
| DOM 执行（注入函数，自包含无 import） | `packages/extension/src/content/dom-runtime.ts` → `bcpDomRuntime` |
| 派发 / 注入 / 去重 / 保活 | `packages/extension/src/entrypoints/background.ts` |
| Console 数据模型 | `packages/console/prisma/schema.prisma` |

---

## 线协议

一条 WebSocket，一条逻辑通道——扩展是纯粹的浏览器执行器。

- **RPC 通道**：backend → 扩展 `rpc_request`；扩展 → backend `rpc_response`。
- **握手**：扩展发 `hello { protocolVersion, role, token }`，backend 回 `welcome`（通过）或 `reject`（token / 版本不对）。
- **心跳**：backend 每 15s `ping`，扩展 `pong`；容忍连续漏 pong（宽限窗口盖过 MV3 的 30s 复活窗口），
  超限则断开、扩展带退避重连。
- **至少一次投递**：断线重连会重发在途 RPC，service worker 按 id 去重——否则丢了响应的 click / navigate 会执行两次。

---

## 能力边界（诚实说明）

- **合成事件永远 `isTrusted:false`**。点击与输入会派发完整的、符合规范顺序的 pointer / mouse / keyboard 事件链，
  带真实坐标与 React 原生 value setter，能过掉只做朴素检查的站点。但把 `isTrusted` 变成 `true`
  **没有 CDP / `chrome.debugger` 就做不到**——这是纯扩展方案的天花板，不是 bug。
  以 `isTrusted` 设卡、需要 trusted-only API（剪贴板、全屏、WebAuthn）、或跑行为学习 / 指纹反爬
  （DataDome / Akamai / Cloudflare）的站点，不在射程内。
- **纯 CSS `:hover` 展开的弹层触发不了**。`realClick` / `realHover` 已经沿 composed-tree 祖先链补发
  `pointerenter` / `mouseenter`（不冒泡的那两个），能救回把监听器绑在外层包裹元素上的组件库；
  但没有 JS 监听器、纯靠 `:hover` 伪类的弹层，任何合成事件都匹配不上。
- **原生文件对话框驱动不了**。`upload_file` 走公网 URL（服务端 fetch，带同源 Referer 防盗链）或本机路径，
  底层注入 `input.files`，≤ 25MB；要求真实用户手势的上传控件会拒绝，且**没有 `drag` 兜底**
  （`drag` 的 DataTransfer 不携带文件），只能交回用户手动传。
- **拿不到 response body**。`read_network` 只有元数据（URL / 方法 / 状态 / 时序）。
  计划步骤的 `bodyIncludes` 是例外——那一步会临时开启抓取。
- **被遮挡的后台窗口会被 Chrome 停掉渲染**，弹窗关不掉、截图读不回。页面里的 JS 救不了，
  只能靠启动参数，见「快速开始 → 用你自己的 Chrome：必须带两个启动参数」。
- **DOM 工具需要可注入的页面**：`chrome://` 与新标签页不行。
- **快照够不到 closed shadow root 与跨源 iframe**（open shadow root 与同源 iframe 可以，子帧 ref 带 frameId 前缀）。
- **面板无关**：浏览器动作跑在 service worker 里，侧边栏关着照样能驱动；
  WS 心跳在连接期间保活，`chrome.alarms` 看门狗（30s）负责在被回收后复活并重连。

自动化运行时页面上会出现一枚角标（「UltraGo 正在操作此页面 · 停止」），
它的**停止**按钮（侧边栏里也有）会在随后几秒内拒绝一切浏览器动作。

---

## 相关文档

- `docs/book-lifecycle.md` — book 的生命周期
- `docs/console-file-api.md` — Console 文件 / 图床 API
- `docs/console-web-ui-unify.md` — Console Web UI 统一约定
- `docs/doudian-category-properties-collection.md` — 抖店类目属性采集
- `docs/issues/` — 逐条问题记录与结论

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
