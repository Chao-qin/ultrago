---
name: doubao-search
description: Use when WebSearch/WebFetch 无果时，通过浏览器打开豆包网页版提问获取信息。适用于中国生态（抖音/小红书/飞书/1688/拼多多等）、近期事件、不确定事实的二次验证。中文触发:问豆包、豆包搜索、搜索豆包、去豆包查、豆包问一下。English triggers: ask doubao, search doubao, doubao query, check with doubao, use doubao to search.
---

# 豆包搜索

当 WebSearch/WebFetch 找不到可靠信息时，用 `doubao-ask` playbook 静默驱动豆包网页版提问，获取第二来源验证。

**不要手动 navigate/点击"新对话"/找输入框/按 Enter/等待动画**——这条路踩过的坑（TipTap 编辑器只认框架 keymap、Chrome 原生窗口遮挡检测导致后台标签页拒绝提交、后台标签页 DOM 渲染滞后读出空结果）都记在 `.agent/learn.md` 2026-08-21 各条里，`doubao-ask` playbook 已经把这些坑填平，直接复用即可。

**结果来自 API 流，不读回答 DOM**（2026-08-23 改版）：playbook 用 fetch hook 抓同源 `/chat/completion` 的 SSE 并自行解析，因此后台/被遮挡窗口的 DOM 渲染滞后不再影响取数。豆包把一条回复拆成三路 event 累加，且会在改协议时静默变形——解析器对未识别 event / 未消费 block / 流未正常结束一律**硬失败**，绝不交残缺答案；回归见仓库根 `pnpm check:books`。

## 适用场景

- 中国生态内容（抖音/小红书/飞书/1688/拼多多等）
- WebSearch 搜不到或结果不可靠
- 需要中文语境下的深度解答
- 近期事件、政策、价格等时效性信息

## 工作流程

### 1. 确认 playbook 存在

`list_playbooks` 确认 `doubao-ask` 在列（参数：`message` / `conversationId` / `attachments` / `outputFile` / `requireJson`）。若不存在，说明本机 playbook 未同步，报告给用户，不要退回手动点击方式。

### 2. 组装调用参数

- `message`：直接传问题文本，例如 `"今天广州天气怎么样？"`。不要拼接 JavaScript，也不要调用 `JSON.stringify`。
- `conversationId`：可选。新提问留空；追问时传上次结果中的 `.conversationId`。
- `attachments`：可选数组。每项传 `{type:"image"|"file", url:"https://..."}` 或 `{type:"image"|"file", localPath:"/absolute/path/..."}`，可选 `filename` / `mimeType`。后端负责读取和上传，不传 CSS、ref 或 JS。
- `outputFile`：可选的 `reports/` 相对路径，建议 `doubao/<主题slug>-<YYYYMMDD-HHmmss>.json`，避免和历史查询撞名

### 3. 运行

`run_playbook(name:"doubao-ask", mode:"auto", params:{message, conversationId:"", attachments:[], outputFile})`。`mode:"auto"` 全程零 agent 介入。

**窗口行为（2026-08-23 改）**：工作窗口**在前台打开**，发送成功后立刻自动最小化，占用用户前台仅数秒。不能改回后台打开——`restoreFocus` 会把它压到用户窗口之后，而用户主窗口最大化时那等同于**被完全遮挡**，Chrome 的 occlusion tracking 与最小化同等处理、冻结渲染，元素永远等不到 `visible`，`composerReady` 必然超时（详见 `.agent/learn.md` 2026-08-23）。等待回复上限 300s，SSE 结束即短路。

若中途暂停（`resumePlanId` 出现在返回里），按返回消息里的指引处理后调用 `run_playbook(resumePlanId:...)` 续跑，不要重新起一轮——旧窗口可能还开着，重开会泄漏窗口。

### 4. 取回答案

playbook 完成后读 `reports/<outputFile>` 的 `.reply` 字段（已经过滤掉用户自己发的气泡，不会把提问原文当成回答）；`.conversationId` 留着给后续追问续用。

## 前置条件

- 本机 `.env` 需要 `BCP_EVAL=on` 且 `BCP_LOCAL_EVAL=on`（playbook 内部靠 `browser.eval`/`local.eval`/`local.writeFile` 完成注入、抓流和落盘）；本项目 `.env` 已默认开启，换机器部署时若 `run_playbook` 报 eval 被禁用，先确认这两个变量。

## 错误处理

- `reply` 为空（DOM 和 SSE 流都读不到）→ playbook 内部已 fail-closed 抛错，`run_playbook` 会报错并停在那一步；先怀疑登录失效，通过 `wechat-ask` skill 通知用户，不要静默重试
- `"doubao refused the message after 4 submit rounds"` → 输入框内容没清空，通常是页面异常（如需要登录），报告给用户而非无限重试
- 停在某一步且提示 "no recorded action" 或 "exhausted retry" → 按返回消息里的指引处理，再用 `resumePlanId` 续跑

## 注意事项

- **问题要具体**：不要问太宽泛的问题，豆包的回答质量取决于问题质量
- **验证结果**：豆包的回答也需要交叉验证，不能直接当作事实
- **不要过度依赖**：这是 WebSearch 的补充，不是替代
- 静默后台窗口跑，不抢用户前台焦点，可以和用户当前正在做的事并行，无需等它跑完再继续别的操作
