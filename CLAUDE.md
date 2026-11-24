# ultrago — 浏览器自动化开发心得

> 本文件是**开发 / 维护本项目时**的项目级指引(AI 内部层),沉淀"用纯扩展驱动真实 Chrome"踩过的坑。
> — 运行时给 MCP 客户端的"怎么开浏览器"SSOT = `packages/backend/src/browser-mcp-instructions.ts` 里的 `BROWSER_INSTRUCTIONS` + 各工具 `description`(`packages/shared/src/mcp-instructions.ts` 的 `MCP_TOOL_INSTRUCTIONS`),本文件只给指针、不复制。
> — 纠错流水账 = `.agent/learn.md`,**任何改动前先读**。

## 架构一句话

MCP server(Node 后端)暴露 `browser_*` 工具 → WS-RPC → 浏览器扩展后台(Chrome MV3 SW / Firefox MV2 事件页) → 按需 `chrome.scripting.executeScript` 注入自包含函数 `bcpDomRuntime`(ISOLATED world)执行 DOM 操作。**无内置 agent**,任何 MCP 客户端驱动它。**多浏览器可并发在线**(hello 带 browser 标签,后端按标签分会话),工具只打当前目标浏览器,`use_browser` 切目标(会话级,不互相波及);目标粘性,不因别的浏览器(重)连而漂移。

**状态感知分层(2026-08 加):** 页面级 = `page_state`(单次注入拿就绪/焦点/表单/滚动/对话框/changed,`analyze_page` 组合它+树+文本+截图);编排级 = `list_windows`(窗口拓扑+OS 前台)/`browser_state`(浏览器×窗口×tab×mode×跨会话 claim×就绪状态,唯一的浏览器总览;`list_browsers`/`browser_status` 已并入)。**跨会话协调**:claim 走 WsServer 进程级共享注册表(agent 间互见,`setClaimed` 本地+共享双写)。**hook**:拓扑事件(browser_online/offline·mode_changed·claim_changed·target_changed·window_opened/closed)经 EventStore 广播,piggyback + `wait_for_event` 可等,bypass 单浏览器过滤。层级教训见 `.agent/learn.md` 2026-08-12。

## 三条不可动摇的约束(决定了一切设计)

| 约束 | 后果 |
|---|---|
| **纯扩展,坚决不用 CDP** | 所有动作靠**合成事件**(pointer/mouse/keyboard)+ DataTransfer;因此:拿不到 response body、枚举不了 addEventListener 监听器、驱动不了原生文件对话框 / OS 级拖拽 |
| **MCP-only,无内置 agent** | "怎么驱动"的能力必须写进 `BROWSER_INSTRUCTIONS`(initialize 时下发),任何客户端继承;别把它退化成某个 agent 的私有 prompt |
| **MV3 service worker 会被强制回收** | 连续性靠**持久化**(storage / seq 游标),不靠内存;socket.io 缓冲随 SW 死亡一起蒸发(learn 2026-07-21) |

## 核心循环:perceive → act → verify(每一拍都别抢跑)

先读页面 → 动一下 → **验证真的落地了** → 再动。没验证前不许基于假想状态走下一步。

---

## 心得 · 感知(perceive)

- **SPA 的 `readyState:"complete"` ≠ 可读**:HTML 骨架到位但 React/Vue 还没水合,此刻读 body 是空的。就绪判据**两层**:先在 SW 层等 `waitNetworkIdle`(per-tab 在途请求集合空满 500ms;视图未知时立即放行),再在注入层过 `settleDom()`(DOMContentLoaded → body 有实质内容 → MutationObserver 静默,封顶 3s)。**网络信号是主判据,`settleDom` 是兜底**——骨架屏在 XHR 在途时 DOM 一动不动,只看 DOM 静默会自信地返回骨架(learn 2026-07-21 的根因)。Playwright 完全没有 DOM-mutation 就绪判据,只用 lifecycle + networkidle;我们保留 settleDom 仅因为拿不到它那么完整的信号。**静默窗口分两档**:元素增删(决定可交互集合)用 250ms;纯文本变动用 120ms——流式写入已有节点的文本是水合信号必须等,但轮询计数器/时钟同样是 characterData,共用一档会让这类页面每次读都吃满 3s。判"空/异常"前先用**正交信号取证**(httpStatus / GPU / webdriver),别单一空值 → 宏大归因(learn 2026-07-21)。
- **snapshot 只收"可操作元素",带 `[ref]`**。命中面:原生 `a/button/input/textarea/select/summary` + `[role]`/`[contenteditable]`/`[tabindex]` + 老式 `[onclick]` + **`cursor:pointer` 自建 clickable**(标 `[clickable]`)。
- **自建 UI 是主流,别只认原生标签**:React `onClick`/Vue `@click` 是**事件委托**(根节点 addEventListener),DOM 上没有 `onclick` 属性。靠 `cursor:pointer` 启发式捞回手写 `<div>` 按钮;因 cursor **继承**给子孙,取"父不是 pointer"的**最外层**元素才是真正可点击体。
- **元素带视觉层坐标**:DOM 树只有嵌套没有几何(portal 到 body 的 modal 树深度 1 却盖满全屏),故每个元素带 `@dialog:<名>` / `@fixed-top|bottom|left` / 裸 `@fixed`;无标记 = 普通流内容。判层走**祖先包含**(控件通常在 fixed 容器内,自己是 static),不看元素自身 position;爬升用 composed tree(`assignedSlot ?? parentElement ?? host`)——`contains`/`parentElement` 都不跨 shadow 边界,slot 分发的子节点视觉父级是 slot 所在位置而非 light DOM 父级。**感知层不做遮挡检测**:"现在能不能点"只在动作时对单个目标回答(`realClick` 的 `waitActionable` + hit-test **重试**——命中无关元素即判被遮挡,退避重试并轮换滚动对齐,超时才抛 `click intercepted`;此前是静默把事件改派回目标,那会让被盖住的点击报告成功),Playwright 同样把 Receives-Events 放在 `_checkFrameIsHitTarget`、不铺进快照;逐元素 hit-test 比 rect/style 贵一个量级,且 `@dialog:<名>` 已经足够让 agent 判断该操作哪一组。
- **采集不按可见性过滤,回复才折叠**:隐藏/禁用元素都收录进 `SnapshotElement[]`,标 `[hidden]`/`[disabled]`。默认回复只逐行列可见元素,隐藏的在「Hidden right now」里**带 ref 点名**:同一隐藏根下的收成一行(关着的菜单 = 它的容器),落单的各占一行——藏在样式按钮后的 file input 就在这里拿 ref 给 `upload_file`;摘要有 3000 字预算,组按大小在前、落单的随后,超出的只计数,覆盖行写明「点名 X / 只计数 Y」,`query` 能搜到全部;`within`/`query`/`full` 会逐行列出隐藏元素。**列不列只看可见性,不按 tag/role/名字开例外**:判断交给 agent,渲染层只保证每个被省略的元素都能按 ref 找到。别指望 `[hidden]`/`[disabled]` 元素有正常响应(唯一例外就是那个文件输入框)。
- **隐藏分组靠 runtime 补节点,不靠渲染层猜**:关着的菜单常是无 role 的 `<ul>/<div>`,不被采集,子项就没有公共父 ref。runtime 用 `carriesHideRule`(与动作失败时的 `hiddenCause` 同一判据:display/visibility/content-visibility/关着的 details)沿 `parentElement`(与 `parentRef` 同一条边,所以不跨 shadow 边界)找每个隐藏元素**最外层**的隐藏根,遇到「自身可见且不带隐藏规则」的祖先即停(visibility 被子节点覆盖时,真正的成因在下面),藏住 ≥2 个已采集元素且自身未被采集时,把它作为 `hiddenGroup` 元素收进快照,子项经 `parentRef` 自然挂到它下面。它不是控件:默认不列、计数不算、`elementName` 校验与 `pick_option` 都跳过它。
- **覆盖行是全景的可靠入口**:每次 snapshot(含空页、`within` 目标已不在)第一行固定格式写明列了页面多少元素、是哪一段、隐藏多少及其中点名几个、续读/全量的确切调用(参数对象原样给出,不写「同样的过滤条件」);计数只数页面元素,隐藏分组节点不算。分页、`full`、过滤都靠它说清,别再在页尾另写一套提示。
- **ref 跟着元素活,不跟着某次快照活**:runtime 每个文档有一张只增不减的「元素 → ref」WeakMap(`__bcpRefEver`),元素中途不被采集(菜单展开时它的分组容器、暂时没了 pointer 的控件)再回来,拿回原来的 ref。
- **「对你是新的」由后端账本判定**:`snapshot-ledger.ts` 的 `ShownLedger` 按会话 × 浏览器 × 标签页记录每次回复**实际列出**的 ref,增量提示(NEW to you / CHANGED / gone / hidden again)都相对它算,只报事实不替 agent 下结论(没有「消失过半就当新页面」这种阈值);CHANGED 比的是回复里那一行(去掉坐标)的文字,回复显示什么就比什么;续读页(渲染器按实际起点判断,`after` 失效从头重来的不算)不报 NEW;账本不记隐藏分组节点;ref 按文档编号,runtime 每个文档带 `docId`,文档一变该帧记录作废。别再在页面里或别处另记一份「看过什么」——那是 2026-11 之前三套近似互相打架的根因。
- **ref 跟着元素活**:元素还在 ref 就一直有效,重新 snapshot 不改号;元素被移除(虚拟列表回收、portal 重挂载)才失效并报 stale。会变动的内容用描述定位(text/role/name/css),动作时才解析。
- **快照穿透 open shadow root + 所有 iframe**:`allFrames` 逐帧注入再合并,子帧 ref 前缀 frameId(`42_e3`),跨源 frame 的元素也列得出、靠前缀 ref 能操作;但跨源 frame 读不到父级偏移,所以那里的元素**没有视口坐标**。按描述定位、`x,y`、焦点追踪仍只在顶层与同源 frame 内;closed shadow 够不到(无 CDP)。
- **snapshot(便宜)vs analyze_page(全但贵)**:analyze_page = snapshot + 可见文本 + tabs + **截图**,内部 4 个 RPC 并行。默认 snapshot 打紧循环;**新/不熟/视觉/含糊页**、以及**连续 2–3 次动作无反应**时升级到 analyze_page 看全貌。截图 token 很贵,别每步截。

## 心得 · 动作(act)

- **合成事件 `isTrusted===false`**:多数 React/Vue 控件吃;少数强校验"真实用户手势"的不吃——这是纯扩展方案的天花板,不是 bug。
- **点击走完整指针序列**(pointerover/enter → move → down → up → click);`hover` 复用前半段、不 down/up(专为 hover-only tooltip/菜单)。**humanize 抖动在 click/type 上默认关**——合成事件本来就 `isTrusted:false`,抖动买不到任何真实掩护,却每次点击多付约 85-255ms、每字符 35-200ms;只在有人盯屏时显式传 `humanize:true`。**scroll 的 humanize 仍默认开**,那里的节奏是功能性的(驱动懒加载),不是伪装。
- **`pointerenter`/`mouseenter` 不冒泡,命中测试(`deepElementFromPoint`)给的又总是坐标下最深那一个节点**:真实鼠标移动时浏览器会对光标路径上每一层祖先分别派发 enter 事件(outermost → innermost),纯 JS `dispatchEvent` 单点调用不会自动做这件事——于是 hover-only 菜单的触发监听器一旦绑在比命中节点更外层的包裹元素上(常见于 Naive UI/Element/Ant 的 trigger wrapper),会收不到信号,表现成"hover/click 了但下拉菜单不出来"(2026-08-19,详见 `.agent/learn.md`)。`realClick`/`realHover` 已修:沿 composed-tree 祖先链从命中节点走到根,逐层补发 `pointerenter`/`mouseenter`。**修不了的部分**:弹层若纯靠 CSS `:hover` 展开(没有 JS 监听器),任何合成事件都无法触发 `:hover` 伪类匹配——这和"原生文件对话框驱动不了"是同一量级的纯扩展方案天花板,唯一能做到这点的是 CDP 级别的输入注入。
- **下拉分两种**:原生 `<select>` → `select_option`;自定义(Ant/Element/Arco)→ `pick_option`。
- **`upload_file` 吃公网 URL 或本地文件路径**(二选一):`url` 走服务端 fetch(SSRF guard + 同源 Referer/UA 防盗链)、`localPath` 读本机文件;均 ≤25MB,底层复用 RPC `dataBase64` 通道注入 `input.files`。**原生文件对话框驱动不了**;要求 trusted user gesture 的上传控件会拒绝注入——**无 `drag` 兜底**(`drag` 的 DataTransfer 为空、不携带文件),只能回报用户手动传。
- **瞬态 UI(modal/drawer/popup/menu)**:打开即改 DOM,且常 **portal 到根节点**(不在触发器里嵌套)→ 视所有旧 ref 失效,重 snapshot,按 role/name 在整棵新列表里找;`press_key` Escape 关。
- **嵌套滚动**:modal/drawer/list 各有自己的 `(scrollable)` 容器 → `scroll` 传那个 ref,不是 window。**懒加载/无限滚动**:`scroll` → 重 snapshot → 重复,别用"没滚就说找不到"。
- **没 ref 时用 `click({text})`**:点最内层匹配可见文本的元素(冒泡到委托 handler),多个匹配时报错列出、用 `nth`/`near` 选;原 `click_text` 工具已并入(RPC 保留给旧剧本)。
- **不可逆动作要 confirm**:`realClick`/`realType` 对"提交/删除/支付/发送/下单…"风险词要求 `confirm:true`,按描述 / 坐标定位的点击同样过这道门。意图不明就停下报告,别替用户确认。

## 心得 · 验证(verify)

- **读 `↳ changed:` delta**:变动后工具自带一行(URL 变 / ±元素 / dialog 开 / 新错误 / scroll locked / overlay),读它常省一次重 snapshot。
- **`⚠ Verify gate` = 强制重读**:出现即必须在下一动作前重新看页面。
- **界面文字会骗人**:确认 save/submit 真到了服务器(或某个数字是真的),要 `read_network` 看请求 2xx——metadata only,无 body(CDP-free)。
- **高风险节点**(提交/确认/导航/dialog 开/新错误)**必须**重新感知再动,别信可能已陈旧的旧视图。

## 心得 · 传输 / 保活(RPC & MV3)

- **RPC 至少一次投递**:断线重连会 resend 在途 RPC → service worker 按 id 去重(`runRpcOnce`),否则丢了响应的 click/navigate 会**执行两次**(learn 2026-07-21)。
- **心跳别太急**:容忍 3 次漏 pong(~45s 宽限,盖过 SW 30s 复活窗口);SW 每 20s 自发 pong 在挂起线前续命;RpcBridge 进程级持久,断线不 rejectAll、重连 resend。
- **请求/响应类通道断线**:要么重连重发、要么如实报错,**禁止静默丢弃**后让上层空等超时。
- **`eval` 默认开**(`BCP_EVAL=off` 才关;`BCP_LOCAL_EVAL` 同理):任意页 JS blast radius 大,当最后手段。桌面客户端由用户决定、默认开(准备页「允许页面脚本」;`BCP_LOCAL_EVAL` 同理为「允许本机脚本」),经 `/internal/browsers/policy` 在运行中切换——桌面后端的 env 由客户端生成,助手 MCP 配置里的 `env` 到不了它。

## SSOT 指针(改哪读哪)

| 关注点 | 位置 |
|---|---|
| 运行时"怎么驱动"总说明 | `packages/backend/src/browser-mcp-instructions.ts` → `BROWSER_INSTRUCTIONS` |
| 每个工具的 description | `packages/shared/src/mcp-instructions.ts` → `MCP_TOOL_INSTRUCTIONS` |
| MCP 工具注册(按域分组,组装在 `browser-mcp.ts`) | `packages/backend/src/browser-mcp-tools-*.ts` |
| DOM 执行(注入函数,自包含无 import) | `packages/extension/src/content/dom-runtime.ts` → `bcpDomRuntime` |
| RPC 契约(方法 + 参数/返回 + 快照结构) | `packages/shared/src/index.ts` → `RpcMethod` / `RpcContracts` / `SnapshotElement` |
| 派发 / 注入 / 去重 / 保活 | `packages/extension/src/entrypoints/background.ts` |
| 纠错流水账(动手前先读) | `.agent/learn.md` |

## 开发工作流

- pnpm monorepo。校验:`pnpm -r typecheck`、`pnpm -r build`(extension 走 vite 真打包)。
- **`@bcp/shared` 的 build 有副作用**:它是 `playbooks:generate && tsc`,会先把 `resource/playbooks/*.json` 的 params 派生成 `src/generated/{books,schema}.ts` 再编译。所以 build 完 `git status` 冒出 generated 改动 = 有 book 改了参数**却没提交派生类型**,把它一起提交,别 checkout 掉。这条是 2026-09-09 加的:此前 generate 只能手动跑,没有任何机制强制它,于是 09-08 落地的两个 book 同时打红了 CI 的 freshness 与 `pnpm -r test`(ParamSpec census pin 停在 15,真实值 29),两道门红了一天没人知道。前置进 build 之后,任何人只要 build 过就不可能漂移;CI 的 freshness 比对仍然有效(已实测:把过期版本放进 index 再走 build → 仍 FAIL),它防的是「改了 book 但一次都没 build 过就提交」。
- **weclaw 默认关闭**(`BCP_WECLAW_ENABLE=1` 才启用;本地模型同理 `BCP_LLM_ENABLE=1`):首次使用不应要求 Go 和微信扫码。**weclaw 二开二进制**:启用后 `pnpm start` 经 `scripts/backend.sh` 的 `ensure_weclaw_binary` 自动跑 `build-external-delivery.sh` 编【带 `external_delivery` 的 patched 版】,需 **Go 1.25+**(对齐上游 go.mod)+ git + 网络;缺 Go / 版本过低会明确报错并提示安装。跟 Mac 无关,任何装 Go 的机器都能编能跑;`install:bin` 下的是上游原版**不含**该特性;`BCP_WECLAW_DISABLE=1` 整个跳过 weclaw(不编、不需 Go)。
- **两层有自动化回归,其余没有**:
  - `pnpm check:dom` 把**真实的** `bcpDomRuntime` 用 esbuild 打包 + `toString()` 注入真实 Chromium 执行——注入函数"自包含"这条约束(本为 `executeScript` 序列化而设)恰好让真代码路径可测,跑的不是逻辑复制品。jsdom 不行:被测的是浏览器自身行为(value sanitization / 布局 / hit-test)。脚本零新依赖(自行探测机器上已有的 esbuild 与 playwright-core),缺工具时 **exit 2** 而非静默通过。
  - `pnpm check:books` 覆盖 **book 内联 JS**(`browser.eval` / `local.eval` 里那几千字符,塞在 JSON 字符串里,既无 typecheck 也无 lint)。同样直接执行**真实 book 里的真实代码**;输入是 `resource/playbooks/__fixtures__/<book>/*.sse.txt` —— 从真实站点抓下来的原始响应流(已脱敏 `inner_user_ip` / `sec_sender`)。纯 node,无浏览器无网络。缺 fixture 时 **exit 2**。
    - **第三方协议一律以抓到的原始流为准**,不接受"它应该长这样"的推测(2026-08-23 豆包改协议那次教训:靠逐字段试探跑了 5 轮还打到对方风控,直接 dump 原始流 10 分钟就够)。
  - `pnpm check:snapshot` 覆盖 **快照回复的体积**:用后端构建产物里真实的渲染器,渲染 `bench/snapshots/` 下提交的公开页面原始快照(`pnpm --filter @bcp/extension snapshot:capture` 采集:固定 1280×800、滚到顶、zh-CN/Asia/Shanghai,所有 frame 用扩展同一份 `snapshot-merge.ts` 合并,并记下 Chromium 版本与 UA),和 `bench/snapshot-census.json` 基线比:默认回复**变大或变小**超过 5%、页数变了、或列出的元素个数变了都失败——双向是有意的:变小可能是丢了该列的东西,不进基线的缩小也会被下一次回涨悄悄吃掉。另核对每页**正文印出的 ref 与渲染器报给账本的 `shown` 是同一组**(只看体积发现不了「少印了却说列了」)。构建产物比渲染器源码旧时 exit 2,不拿旧渲染器充数。**有意改变时**跑 `node scripts/snapshot-census.mjs --write`,把基线和改动一起提交。登录态页面含店铺数据,只在本机采,不提交。
  - `node scripts/snapshot-task-bench.mjs --checkout <目录> --label <名>` 是 **快照改动的任务基准**(手动,要联网、真实消耗 token):拿被测 checkout 的构建产物起后端 + headless Chromium(一次性 profile,装该 checkout 的扩展),用 `claude -p` 只挂这一个 MCP 跑 `bench/tasks/tasks.json` 的公开页任务,每个任务有确定性的验收(tab URL / 页面状态 / `ANSWER:` 对照现场读值)。**eval 默认关**:开着 agent 会直接读 DOM 绕过快照,测不到渲染器。**任务文本必须冷启动**:只写目标,不点名控件、不描述控件状态、不提示路径——点名就是替 agent 做了感知(第一版点名了,全部快照调用都是按点名的 `query`,默认视图一次没读到);结果里记录每次快照调用形态,默认视图调用数为 0 的结果测不到默认视图的改动。改动快照的默认视图(体积护栏之外的「agent 还做得成吗」)前后各跑一次,成功率不得下降。
  - `pnpm --filter @bcp/backend test` 覆盖 **MCP 契约**:走 `InMemoryTransport` 像真客户端那样 `listTools`/`callTool`,不碰私有字段。钉住 51 个工具的存在、参数名与必填集(含 plan 的 step/verify 嵌套形状),以及会话状态——`use_browser` 的 target 要被别的工具读到、claim 的注入/释放/跨实例隔离/关掉即清理、两会话互不串扰。工具注册按域拆成多个文件后,这层是唯一能证明「55 个工具行为没变」的东西。
  - `pnpm --filter @bcp/extension test` 覆盖两块从 background.ts 抽出来的纯逻辑(抽出的目的就是让它们不需要浏览器也能测,监听器与 MV3 同步注册留在原处):
    - **RPC 投递去重**(`src/rpc-dedup.ts`):同 id 重放、并发重放、**SW 回收后重放**(持久层短路,learn.md 2026-07-21 那个真实故障)、读不落盘、storage 抛错降级、LRU 淘汰。
    - **任务窗口编排**(`src/window-ops.ts`):restoreFocus 必须先快照再创建、把用户窗口提回前面、macOS 兜底按下新窗口、创建后重新 assert bounds(create 时坐标只是建议)、**state 两个方向都显式钉住**(拿到 minimized 会停渲染并重压定时器)、**无 tab 时抛错而不是交回 -1**(那个 sentinel 满足 tabId:number,于是一路无人质疑)。
    - **注入分发与导航 barrier**(`src/inject-dispatch.ts`):snapshot 穿透 iframe 时子帧 ref/parentRef/controls 都要带 frameId 前缀,`docs` 按帧带回文档标识;带前缀的 ref 要路由回原帧;**判定「动作导致了导航」只认本帧的 commit** —— 宣告不算(取消的导航也宣告)、url 前后对比不算(reload / POST 同址会导航却不改 url)、tab.status 不算(全 tab 属性,别的 session 也能置成 loading,它只能让我们等);frame 消失时区分「帧没了→refs 全死」与「帧还在→文档被换」,MUTATING 额外警告可能已落地。
    - **连接与重连**(`src/ws-link.ts`):原生 WebSocket 没有连接超时,卡在 CONNECTING 的要被掐掉;重连不叠加;退避 1s×1.5 封顶 15s,且**只在握手成功时重置**(被拒的连接也会先打开再关掉,在 open 处重置会贴着地板空转);reset() 摘掉 handler 再重建,这是 connect() 唯一能救回一个卡死在 CONNECTING 的连接的路径。
    - **导航等待**(`src/nav-wait.ts`):goBack/goForward/reload 在【发起】时就 resolve,所以触发条件取 onCommitted 不取 tab.status;announce 与 commit 之间 tab 报的是【旧文档】的 complete;宣告了没提交要继续等而不是报 no-op;complete 之前的 title 是旧的,宁可不给;三条路径都盯着监听器泄漏。
    - **网络就绪判据**(`src/net-idle.ts`):未观察过的 tab 必须答 UNKNOWN 而非 idle、完成事件无对应开始时计数不变负、导航丢弃旧文档在途集、长连接超时豁免、挂死请求遗忘、favicon/websocket 不计入、静默窗口从最后活动起算。时钟是注入的,断言的是逻辑不是 sleep。
  - `pnpm --filter @bcp/comfyui check:nodes` 覆盖 **ComfyUI 自带节点**(`packages/comfyui/nodes/bcp`):出图 / 文本模型请求的组装与结果解码、蒙版与透明度方向、重跑用的 seed、`.env` 配置接口的只写不读。用 ComfyUI 的 venv 跑,假客户端替代真实接口;没 setup 时 exit 2。不叫 `test` 是因为 CI 的 `pnpm -r test` 环境里没有 ComfyUI。
  - **仍无自动化的**:跨 tab 编排 / `runRpc` 里剩下的几个大 case(Eval / WaitSignal / PageState),靠 typecheck + build + 接线 grep + `playwright-live-view` noVNC 手测。
  - 新增或修改 DOM 行为 / book 内联 JS **必须**在对应脚本补断言,并做一次**变异**(把修复改坏,确认断言真的变红)——没验证过证伪能力的防线是假防线。
- **新增一个 DOM 动作 = 五处接线**:`shared` RpcMethod+contract → `dom-runtime` op 联合+case → `entrypoints/background.ts` DOM_OP+runRpc case → `browser-mcp-tools-*` 注册工具 →(必要时)补 `BROWSER_INSTRUCTIONS`。漏一处 typecheck 未必报,靠 grep 全链核对。

---

## 反幻觉规则(强制)

**核心原则:不确定就不说,宁可查了再说。**

以下情况**必须先搜索验证再回答**,禁止凭记忆/推测直接输出:

1. **API/库/框架的具体用法、参数、版本** — 先 WebSearch 或 WebFetch 官方文档
2. **近期事件、新闻、政策、价格、版本发布** — 先搜索,训练数据有截止日期
3. **中国生态相关内容**(抖音/小红书/飞书/豆包/1688/拼多多等) — 搜索无果时,用 `/doubao-search` 问豆包
4. **不确定的命令、配置、环境变量** — 先查再给,别猜
5. **任何你只有模糊印象而非确定知道的事实**

**执行方式:**

- 优先用 `WebSearch` / `WebFetch` 搜索权威来源
- 搜索无果或需要中文生态深度解答 → 调用 `/doubao-search` skill 问豆包
- 搜了仍不确定 → 直接说"未找到可靠信息,建议你自行确认",**绝不编造**

**红线:**

- ❌ "应该是..."、"据我所知..."、"一般来说..."(没有来源支撑的断言)
- ❌ 编造 URL、函数名、参数、版本号
- ✅ "搜索结果显示..."、"根据[来源]..."、"未找到确切信息,建议确认"
