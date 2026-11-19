# 桌面内测客户端（Windows / macOS）

本包实现独立的准备中心，管理 backend、Console 与可选模型网关（本机 Ollama 或云 API）。每轮服务使用操作系统分配的端口，用户不填写端口；已有 Chrome 通过 Native Messaging 找到当前客户端。多租户、自动更新和正式签名发行不属于本轮内测；Ollama 由用户自己下载安装，本机模型只在用户点击后才下载。

## 维护者准备

以下命令请你自己执行。`pnpm install` 更新锁文件并运行仓库已有的生成步骤；后续 build 会编译源文件，其中 shared / extension 会重新生成契约，Console 会生成 Prisma client。请在 Windows x64 上准备发行产物，确保 Prisma 引擎匹配 Windows。AI 不代执行这些生成步骤。

```text
pnpm install
pnpm --filter @bcp/shared build
pnpm --filter @bcp/weclaw build
pnpm --filter @bcp/backend build
pnpm --filter @bcp/llm build
pnpm --filter @bcp/console build
pnpm --filter @bcp/console-web build
pnpm --filter @bcp/extension build
pnpm desktop:start
```

构建连接宿主需要维护者安装 Go，最终用户不需要。打包命令会先重新编译随包的 shared、weclaw、backend、llm、Console 服务端、Console 前端和扩展，安装包里不会出现旧的编译产物；依赖安装和 Console 的 Prisma client 仍按上面的步骤准备。打包命令：

```text
pnpm desktop:package:win
```

输出目录为 `packages/desktop/release/`。此命令构建 Windows 原生消息宿主、下载与当前 Prisma 版本匹配的 Windows 引擎、暂存用户已生成且 schema 一致的 Prisma client，再制作 NSIS 内测安装包并审计包内资源。不会运行数据库迁移，也不发布到外部服务。代码签名需在正式发行阶段配置；不能把未实机验证的安装包称为正式可售版本。

Windows 维护机直接生成安装器；Linux 维护机先生成应用目录，再使用固定摘要的官方 `electronuserland/builder` Wine 镜像生成同一 NSIS 安装器，需要可用的 Docker。首次运行会拉取镜像；生成安装器的容器禁网，仓库只读，只有发行目录和构建缓存可写。

本版本号为 0.1.7，打包产物为 `UltraGo-0.1.7-win-x64-setup.exe`，支持选择安装目录，并生成桌面和开始菜单快捷方式。应用、窗口、准备页及安装器使用重新设计的桌面图标，源稿与设计要求见 `docs/brand/desktop-app-icon-v2.md`。只跳过代码签名，保留主程序图标与产品信息写入。

0.1.6 将引导收敛为准备工作台、连接浏览器、开始使用三个主步骤，移除装饰侧栏、重复标题与示例预览。模型和 AI 助手独立为可选设置，准备失败仍可修正模型；切换时保留草稿。正常日志默认收起，首次失败才自动展开，恢复后收起。连接组件在准备时自动注册到当前用户的 HKCU，失败才显示修复入口；不需要管理员权限，扩展加载和目标浏览器确认仍由用户完成。

成功进入工作台后保存完成状态。再次启动自动恢复服务，原浏览器重连后直接打开工作台；原浏览器离线时停在连接步骤，恢复异常回到准备页显示原因。再次启动时，客户端以只读方式打开数据库，读取 `_prisma_migrations` 中已完成的迁移，与随包迁移目录比对。全部已应用就跳过 `migrate deploy` 和备份；读不到迁移记录，例如表不存在或文件损坏，就照常迁移。只有存在待执行迁移时才备份，同一批待执行迁移只备份一次：迁移失败后重试，不会让半迁移状态的副本挤掉迁移前的备份。`backups/` 下自动生成的备份只保留最近 5 份，其他目录不动。浏览器服务、工作台服务和模型网关并行启动。升级前已保存浏览器选择的旧配置也会恢复；新用户仅确认浏览器尚未进入工作台时，不标记完成。浮动按钮可拖动，松手后吸附最近的上、下、左、右边缘，位置按窗口比例保存，窗口缩放后仍在可见范围。空闲 8 秒后沿当前边缘收起并淡化，悬停或键盘聚焦唤醒。顶部原生菜单已移除，浮动菜单提供准备页、工作台、缩放、托盘和退出；主页面编辑与缩放快捷键保留。

修复 Windows 报告写入将正常路径误判为越界的问题：路径判断使用当前平台的相对路径和父目录段，百度 Markdown 与 1688 JSON 共用此修复。产物登记同时拒绝跨盘路径；截图、文本导出和文件交付允许合法的双点前缀文件名，但仍拒绝真正的父目录越界。检查文件是否存在时不再把权限或 I/O 错误当成文件不存在。

扩展 `welcome` 握手现在同时更新内部连接状态和通知，修复工具栏为 ON、新打开面板却一直 Connecting 的状态分叉；面板先订阅再取快照，忽略过期响应，并在可见时同步状态。升级安装后，请在 `chrome://extensions` 重新加载已安装的解压扩展，使 Chrome 使用新后台脚本。

内置两本现有原版模板：`baidu-hot-search` 采集三类热点榜并输出 Markdown；`1688-offer-snatch` 按商品链接采集规格、价格、库存和图片，可选导出 JSON。用户准备工作台时安装缺失模板并注册精确版本的输入/输出契约，已有自定义文件保留。随包原版执行定义允许工作台运行所需的本地整理脚本；Console 冻结后的交付目标不参与代码信任比较，修改脚本或参数契约即失去该例外。此例外仅用于工作台 InternalRunner，外部助手直接 `run_playbook` 仍遵循原有执行策略；没有放开任意 MCP 页面脚本或本地脚本。未实际执行两本采集任务或写入数据库。1688 登录和验证码需用户处理。

最小化或关闭窗口会收起到系统托盘；已启动的服务与 MCP 继续运行，单击托盘图标恢复原窗口，右键选择“退出应用（停止本地服务）”才结束客户端。系统托盘不可用时保留普通窗口行为。准备页显示检查环境、准备数据、启动服务、检查模板四项实际进度，完成后明确引导连接 Chrome；日志移除终端颜色控制码。模型方式切换立即显示对应表单与未保存提示。工作台运行时保存只重启模型网关，浏览器服务、工作台服务和浏览器连接都不受影响；未准备或准备失败时，保存后点击准备生效。上游 API Key 只交给模型网关进程。

工作台服务和模型网关在就绪后意外退出时，客户端只重启这一个服务，1 分钟内最多 3 次，超过才回到准备页；进入工作台后的激活状态会保留，浏览器连接不受影响。浏览器服务（backend）不会自动重启：它退出后，执行中的任务状态随之丢失，工作台会把这些任务重新排队，可能重复操作浏览器。所以仍然回到准备页，由用户恢复。

“接入 AI 助手”面板里的“允许页面脚本（eval）”默认开启：助手可以在已登录的页面里执行任意脚本，用来读页面数值、做计算校验，也包括 `evalCheck` / `evalUntil` 和录制回放中的脚本步骤。风险较高，可以随时关闭，关闭后在运行中的后端立即生效，不用重启。“允许本机脚本（local eval）”同样默认开启：模板和助手可以在本机后台运行脚本，整理采集结果（生成表格、报告）。脚本运行在独立的 `node:vm` 沙箱里：结果以 JSON 文本进出，沙箱里拿不到任何宿主对象，所以接触不到本机文件和进程（此前可以通过 `results.constructor.constructor` 拿到宿主进程，已修复并有回归测试）。但 Node 官方不把这类沙箱当作严格的安全边界，风险仍高于页面脚本，可以随时关闭，立即生效。脚本必须同步返回结果，返回 Promise 会被拒绝。同一面板可以选择“截图保存目录”，截图的 `savePath` 就能直接写到那个文件夹（例如助手的工作区）；系统临时目录始终允许。注意：桌面客户端会自己生成后端进程的环境变量，所以在助手 MCP 配置里写 `env`（例如 `BCP_EVAL`）不会生效，请在这里设置，`BCP_LOCAL_EVAL` 同理。

准备页底部的“开机时在托盘自动恢复”默认关闭，只在安装版中可用，开启后写入当前用户的 Windows 开机启动项。在任务管理器或系统设置里禁用后，开关会显示为关闭；卸载时会删除该启动项，升级时保留。开机启动时，已完成准备且托盘可用就不弹窗口，直接在后台恢复服务；首次使用、托盘不可用或恢复失败时显示窗口。

0.1.4 修复内置只读示例页面定义缺失导致的 400，并显示接口返回的错误原因。重新准备时仅升级与旧内置示例完全一致的文件；用户修改过或无效的模板保留原样。首次体验使用当前随包模板。工作台列表统一标题、筛选和表格边界，去除侧栏重复的当前工作区卡片。

维护机还需安装 uv 与 tar，用于准备固定 SHA-256 的 Windows Python 3.11.15 发行文件。依赖由 `uv export --frozen` 从已有锁文件导出，安装匹配 Windows x64 / CPython 3.11 的轮子并校验哈希；不会更新 Python 锁文件。最终用户不需要 uv、tar、Node.js、Python 或 Bash。

如确实需要免安装版本，可以单独构建 ZIP：

```text
pnpm desktop:package:win:zip
```

ZIP 同样使用品牌图标。请把整份 ZIP 解压到固定目录，不能单独复制其中的 EXE；扩展和连接宿主都位于同目录的 resources 中。构建产物排除开发缓存、开发配置、数据库及凭据文件。

## macOS 安装包

macOS 包只能在 Mac 上构建：dmg 与代码签名都依赖 macOS 自带工具。维护机需要 Go（编译连接组件）、uv 与 tar（准备随包 Python），以下命令请你自己执行：

```text
pnpm install
pnpm desktop:package:mac
```

它依次构建工作区、为 Apple 芯片（arm64）与 Intel（x64）各编译一份连接组件、下载对应的 Prisma 引擎与固定 SHA-256 的 Python 3.11.15，然后输出 `release/UltraGo-<版本>-mac-arm64.dmg`、`-mac-x64.dmg` 和同名 zip，并对两个 `UltraGo.app` 做包内容审计，对本机架构那个再做一次运行时检查。各平台专用文件按 `${arch}` 只放进对应的包。

签名：设置了 `CSC_NAME`（钥匙串里的 Developer ID 名称）或 `CSC_LINK`（证书文件）时按 Developer ID 正常签名；都没设置时做 ad-hoc 签名，否则 Apple 芯片拒绝运行。ad-hoc 签名的包从网上下载后会被系统拦下，第一次需要右键「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/UltraGo.app`。要给外部用户顺畅安装，需要 Apple 开发者账号做 Developer ID 签名和公证（notarize），本版未配置公证。

与 Windows 的差异：

- 连接组件注册写在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ultrago.desktop.json`（Chrome 读取当前用户连接组件的位置），不写注册表。
- 「在桌面创建快捷方式」在桌面生成 `Chrome（UltraGo）.app`，它用 `open -a` 带渲染参数打开已安装的 Chrome；和 Windows 一样，要先按 ⌘Q 彻底退出 Chrome 再用它打开，参数才生效。
- 托盘在菜单栏；开机启动写入系统登录项，开机后在后台恢复。
- 本机模型：从访达打开的应用看不到 `/usr/local/bin` 和 Homebrew 的 PATH，所以另外查找 `/usr/local/bin`、`/opt/homebrew/bin` 与 `Ollama.app` 里的 `ollama`。

本仓库的开发机是 Linux，macOS 包没有在真实 Mac 上构建和运行过；首次发布前请在 Apple 芯片与 Intel 各一台 Mac 上按「用户首次使用」走一遍。

## 用户首次使用

1. 安装并打开客户端，点击“准备工作台”。产品会在 `%APPDATA%\UltraGoDesktop` 初始化专用数据库和模板，不读取开发机数据库或 `.env`。需要迁移时，已有数据库先备份到同目录的 `backups/`，最多保留最近 5 份。
2. 连接组件已自动准备。按指引在 `chrome://extensions` 加载随包扩展。如果只连接了一个 Chrome，且之前没有确认过浏览器，客户端会自动探测并确认它，直接进入下一步；有多个 Chrome 时由用户选择。已确认的浏览器离线时不会换成别的浏览器。只有自动注册失败才需要点击“修复连接组件”。本版本是内测渠道，正式商店链接尚未发布，上架步骤见 `docs/desktop-chrome-web-store.md`。
3. AI 模型（可跳过）。页面先说明模型用来做什么、不设置会失去什么，再三选一：
   - **本机模型（推荐）**：客户端检测 Ollama——没装就打开官方下载页，装好后自动检测到（也查 `%LOCALAPPDATA%\Programs\Ollama`，刚装完 PATH 未刷新也能找到）；装了没运行可一键启动 `ollama serve`；然后由用户点击下载 `qwen3.5:4b`，显示实际大小与进度，可取消，失败可续传。两项都就绪后才能启用，网关写入一条本机 ollama 渠道（`numCtx` 8192）。它是验证码提醒的前提：任务被验证码挡住时，截图只交给本机模型确认后在工作台「事件通知」提醒，不发到云端。
   - **云 API**：填写自己的 HTTPS 服务地址、模型名称与 API Key；地址末尾的 `/v1` 会规范为现有网关需要的上游根地址。Key 经系统安全存储加密保存。云模型不用于验证码提醒。
   - **暂不设置**：任务卡在验证码时不会提醒，需要模型的脚本和流程无法运行；浏览器连接、采集模板和外部 AI 助手不受影响。
4. 接入 AI 助手（可跳过）：勾选本机检测到的助手一键接入，或复制配置手动接入。
5. 开始使用：汇总各项设置，跳过的步骤显示后果并可一键回去设置；运行示例读取虚构商品清单，或进入工作台。内置百度和 1688 模板无需模型；1688 登录或验证码由用户处理。目标离线时不自动切换其他资料。

步骤按固定顺序排列，底部只有「上一步」和「下一步：<步骤名>」两个按钮，可跳过的步骤写明「跳过」。工作台服务启动后，顶栏在每一步都提供「进入工作台」；Chrome 尚未连接也能进入查看数据与报告，任务要连接后才能运行。拖动吸附的浮动菜单只在工作台页面显示，准备页不显示。

## 随包运行环境

| 环境或组件 | 本版交付情况 |
| --- | --- |
| Node.js | Electron 45.2.3 内置 Node 24.22.2，服务、CLI 和内联 TypeScript 使用随包运行时 |
| Python | Windows x64 CPython 3.11.15，位于 `resources/runtime/python/`，Python 命令直接调用随包解释器 |
| Python 依赖 | Pillow 12.3.0、openpyxl 3.1.5、et-xmlfile 2.0.0，与已有锁文件一致 |
| Prisma | 随包生成客户端、CLI 与版本匹配的 Windows 引擎 |
| React / React DOM | Studio 后端也静态导入它们，本版补齐生产依赖及 scheduler 闭包 |
| Chrome | 用户安装并持有；客户端提供官方入口和扩展安装引导 |
| WeClaw / ComfyUI / ffmpeg | 未随包启用，本轮浏览器运行链路不依赖它们 |

桌面脚本默认在用户数据目录运行，不使用 ASAR 内目录作为 cwd。`python` / `python3` 命令直接使用随包解释器，`node` / `nodejs` 和内联 TypeScript 使用 Electron 的 Node 模式。自定义脚本、店铺资料、分类目录及其业务输入由用户提供，不会复制开发机的数据和凭据。Python 是命令节点的运行环境，内联语言仍为 TypeScript。

打包时还会提取真实 ASAR 到独立临时目录，检查整个服务入口的静态依赖且禁止借用包外模块，再用 Electron 实际导入 Studio 模块并执行无数据库的 TypeScript 检查。不会启动 Console 或执行其生命周期钩子。

## 接入外部 AI 助手

准备完成后，“一切就绪”这一步会列出本机检测到的 AI 助手，并直接带到“接入 AI 助手”面板；工作台仪表盘在服务已就绪、还没有助手连上且没有本轮的接入失败时，右上角入口显示为“接入 AI 助手”，否则显示“连接诊断”。面板顶部列出 Claude Desktop、Claude Code、Codex、OpenCode、Cursor、VS Code 和 Trae。只有检测到且能从这里接入的助手可以勾选，勾选并点击“接入所选助手”后才会动手，每个助手单独显示结果；某个助手检测出错只影响它自己那一行。检测与接入方式都取自各助手的官方文档：

- Cursor、VS Code、Trae：看系统是否注册了它们的链接协议（`cursor://`、`vscode://`、`trae://`），接入时打开官方安装链接，由助手自己展示服务器并询问是否添加。Trae 国内版的链接格式未找到官方说明，暂不支持。
- Claude Code、Codex、OpenCode：按 PATH 查找命令，另外查看安装器文档给出的位置（npm 全局命令在 `%AppData%\npm`，Claude Code 安装器放在 `%USERPROFILE%\.local\bin`）。Windows 不会更新已运行进程的 PATH，客户端开机自启后才装的助手只能这样找到。接入时运行它们自己的命令。Claude Code 是 `claude mcp add -s user ultrago -- <程序> --mcp-stdio`；它不允许重名，所以先删除用户级的同名旧条目（删除失败只说明原本没有）。Codex 是 `codex mcp add ultrago -- <程序> --mcp-stdio`，同名条目由它自己覆盖。OpenCode 是 `opencode mcp add --global ultrago -- <程序> --mcp-stdio`：不加 `--global` 它会写进客户端工作目录下的项目配置，用户自己的项目读不到；加上后写入全局配置，已有的注释和其他服务器保留，同名条目被覆盖（已用 OpenCode 2.2.6 在隔离目录实测）。OpenCode 1.x（npm 上的 `latest` 仍是 1.x）不认 `--global`，会打印用法说明并失败；它的 `mcp add` 总是写全局配置，所以接入前先读 `opencode --version`，1.x 去掉 `--global`（已用 1.17.0、1.19.5 实测，同样保留注释、覆盖同名条目）。1.16 及更早的 `mcp add` 只能交互使用，不接受命令参数（1.1.4、1.15.0、1.16.0 实测会打印用法说明并失败），这时不再运行它，直接提示升级或改用手动接入里的 OpenCode 1.x 配置。npm 在 Windows 上把命令装成 `.cmd`，需经 `cmd.exe /d /v:off /s /c` 运行；每个参数都加引号，含 `"`、`%` 或换行的路径拒绝传递，避免被 cmd 改写。cmd 自己的报错按系统代码页（中文 Windows 为 GBK）解码后显示。
- Claude Desktop：看 `%APPDATA%\Claude` 或应用商店安装包是否存在，接入时合并写入官方文档给出的 `%APPDATA%\Claude\claude_desktop_config.json`。原文件先备份为同目录的 `.bak-<时间>`，只增改 `mcpServers.ultrago`，其他服务器和字段保持不变；文件无法解析时拒绝写入，不覆盖。应用商店（MSIX）版 Claude Desktop 实际读取的配置位置在不同版本间变过多次，写入上述路径可能根本不生效，所以检测到 `%LOCALAPPDATA%\Packages\Claude_*` 或 `%LOCALAPPDATA%\Claude-Data` 时，列表里显示原因、不可勾选，提示改用下方复制配置。

面板下方的“手动接入其他助手”仍支持通用 stdio、Claude Desktop、Cursor、OpenCode 1.x 和 OpenCode 2.x：展示本机程序路径、参数、专用配置、官方安装入口及接入步骤，由用户把复制的配置合并到助手中，保留已有服务器。配置包含稳定的客户端路径与 `--mcp-stdio`，不包含端口或密钥；桥接进程读取当前用户的运行描述文件，连接本轮动态服务。

“检查助手启动链路”实际启动独立 stdio 进程，验证握手和工具列表，不调用浏览器工具，也不冒充外部助手已连接。Windows 配置指向随包的 `resources/native/bcp-native-host.exe --mcp-stdio`；这个控制台启动器以独立管道调用 Electron 的 Node 模式，不依赖系统 Node，也不使用 GUI 程序的默认标准流。升级后请从客户端重新复制配置到 Workbuddy 等助手，替换原来的主程序启动命令，再重新连接。

仪表盘和客户端连接诊断分别展示服务、Chrome 与 MCP 助手状态。助手完成真实握手后显示其客户端名称和工具数；独立自检不计入外部连接。关闭输入流会清理桥接进程，停止心跳并上报断开；缺失心跳超过 35 秒显示离线，重连成功覆盖同助手的历史错误。启动错误保存在 `logs/mcp-last-error.log`，连接诊断包含当前状态，正常准备日志仍保持收起。仪表盘顶部去除时钟和宣传区域，以紧凑状态栏提供连接诊断入口。

使用时保持本客户端打开、Chrome 已确认。客户端重启或恢复服务后，桥接进程会按新的运行描述文件自动重连，助手里无需重新连接：心跳每 10 秒检查一次描述文件；工具调用遇到旧连接时，最多在 30 秒内等待客户端就绪。新会话会丢失之前选定的目标浏览器和认领的标签页。所以，只要旧会话里执行过工具调用，会话被替换后的下一次工具调用就会先重连，再明确报告“会话已重置、这次调用没有执行”，由助手重新确认目标后再调用。这次报告发出后 1.5 秒内到达的工具调用（同一轮并行发出的那批）同样拒绝，防止其中某个调用在没有认领的新会话上执行。会话替换的原因可能是客户端重启、心跳发现运行描述变化，或响应流中断；被取消的调用空闲到 fetch 响应体超时，不算中断。旧会话没有执行过工具调用时，没有可丢失的状态，未送达的调用会直接在新会话上执行。工具列表请求总是透明重发。中途断开的调用可能已经执行，会立即报错，不会重发，避免点击执行两次。升级前已经在运行的旧桥接进程没有这个能力，升级后需要在助手里重连一次。助手自身的模型、账号及费用与本客户端云 API 分开。仅有远程 HTTP 接口、无法启动本地命令的网页版助手，需要其自身支持本地桥接。Chrome 扩展显示版本 0.1.7。从 0.1.7 起，扩展连接客户端时会比较自身版本和随包扩展版本：版本不同时会从磁盘重新加载一次，每组版本组合只重载一次，防止循环。扩展版本必须和客户端版本同步递增，打包前的 `desktop:check` 发现两者不一致时会报错，`--source` 模式只警告。仍在运行 0.1.6 扩展的用户没有这段逻辑，升级到 0.1.7 时需要最后一次在 `chrome://extensions` 手动重新加载。绿色勾号只代表浏览器链路，不代表 Workbuddy 已连接。

接入格式核对来源：[通用与 Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[Cursor](https://cursor.com/docs/mcp)、[Cursor 安装链接](https://cursor.com/docs/context/mcp/install-links)、[VS Code 安装链接](https://code.visualstudio.com/api/extension-guides/ai/mcp)、[Trae 安装链接](https://docs.trae.ai/ide/mcp-server-install-links)、[Claude Code](https://code.claude.com/docs/en/mcp)、[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[OpenCode 2.x](https://opencode.ai/docs/mcp-servers/)。Claude Code、Codex 与 OpenCode 的重名行为另在隔离目录里实测过。OpenCode 2.x 使用 `mcp.servers`，不能直接套用其他客户端的 `mcpServers` 配置；1.x 把服务器名直接放在 `mcp` 下。两种写法不能混用：1.1.4、1.15.0、1.18.0 读到 `mcp.servers` 会判整份配置无效（1.19.5 能兼容读取），2.x 文档写明服务器名不再直接放在 `mcp` 下，所以手动接入按版本分成两项。

工作台浮动菜单“准备与连接”可随时返回。准备阶段暂不启动排期与旧投递恢复；进入工作台后才激活。恢复服务会使本轮连接失效并重新发现，不自动重跑已开始的任务。原有开发脚本和 `.env` 编辑入口在桌面模式下不可使用，模型配置在准备中心管理。

准备过程中显示已等待时间，正常日志始终默认收起；失败才自动展开。初始化命令最多等待 120 秒，失败显示原因和进程最近输出，按钮变为“重试准备”。可点击“复制诊断”或“打开日志目录”查看 `%APPDATA%\UltraGoDesktop\logs\desktop.log`；上一轮保留为 `desktop.previous.log`。日志保留有界的最近输出，并对进程凭据进行流式脱敏。

诊断区可复制稳定的 MCP stdio 启动配置，配置中不含端口或凭据。MCP 客户端重新启动桥接进程时重新发现本轮服务；运行中恢复整个服务组后，已运行的桥接进程会自动重连。用户 Chrome 始终由用户持有，退出客户端不关闭 Chrome。

## 安全验证与实际限制

以下检查不启动真实 Console，也不运行迁移：

```text
pnpm desktop:test
pnpm desktop:check
node scripts/test-desktop-ui.mjs
node scripts/test-desktop-electron.mjs
node scripts/test-extension-status-ui.mjs
node scripts/test-desktop-login-launch.mjs
go test packages/desktop/native/host.go packages/desktop/native/mcp.go packages/desktop/native/host_test.go
```

UI 检查通过独立浏览器与桥接替身验证五步导航、前置条件、失败恢复与草稿保留；`test-desktop-electron.mjs` 仅在 Linux 使用独立 Xvfb 和配置目录，验证真实 Electron 首次加载、重载、配置复制、浮动菜单、空闲左移淡化、缩放、生产 IPC 的 sender/frame 拒绝、关闭收起、恢复同一窗口及退出关闭入口，并调用最小化事件处理器，不点击准备工作台。重复退出的清理等待由延迟替身测试覆盖。这些检查不代表 Windows 原生最小化、托盘显示、注册表或数据库链路已验证。`desktop:check` 检查源代码语法及打包资源是否存在，不证明编译产物的新鲜度或安装包可用。

真实数据库初始化、模板注册和运行记录持久化由用户亲自点击安装包验收。AI 不触发这些写入，也不运行 `prisma migrate` / `seed`。

正式交付门禁仍包括：Windows 干净机首装与重启、用户目录权限、Native Messaging 注册与卸载、扩展 SW 回收、多个 Chrome profile、默认端口被占、进程异常退出、Prisma 引擎、包内秘密文件排除及真实 Electron 交互。后续正式发行另验签名、扩展商店渠道与更新恢复。
