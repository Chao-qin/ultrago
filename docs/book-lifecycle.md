# Book 生命周期体系设计(出入参 + 执行后回调)

> 状态:设计定稿,待实施。参考 GitHub Actions 官方语义(outputs/artifacts 分离、workflow_run 事件驱动)。
> 涉及包:shared(契约)、backend(引擎/事件)、console(展示/调度)、weclaw(微信投递)。

---

## 1. 总体架构:声明层 / 执行层 / 产出层

```
┌────────────────────────────────────────────────────────────┐
│ 声明层 · Book 契约(playbooks/*.json)                        │
│   name / goal / params(入参 schema) /                       │
│   outputSchema(出参数据契约) / deliveries(投递契约) / steps   │
└──────────────────────┬─────────────────────────────────────┘
                       │ validate + instantiate({{slot}} 填充)
┌──────────────────────▼─────────────────────────────────────┐
│ 执行层 · 播放引擎(backend/playback.ts)                      │
│   PlanRunner + runAutoPlayback                              │
│   · 步骤执行 perceive→act→verify                           │
│   · 数据流 priorResults → local.*                          │
│   · 资源回收 cleanupStaleTabs / closeTrackedTabs           │
│   · 唯一收口 onFinish(终态:success/escalated/failed/cancelled)│
└──────────────────────┬─────────────────────────────────────┘
                       │ run_finished 事件(EventStore 广播)
┌──────────────────────▼─────────────────────────────────────┐
│ 产出层 · 订阅者 / 投递执行器                                 │
│   delivery:file     → 落盘(执行中完成,事件附路径)            │
│   delivery:message  → wec_send_text(微信,经 weclaw)        │
│   delivery:db       → 入库器(消费 outputSchema 字段)        │
│   delivery:print    → 打印到 run 详情                        │
│   delivery:webhook  → HTTP POST 结果到外部 URL              │
│   (按 delivery.on 分流:success / failure / any)            │
└─────────────────────────────────────────────────────────────┘
```

原则:**声明层只描述,执行层只跑,产出层只投递**。任何一层不跨职责。

---

## 2. Book 声明模型(契约)

```ts
interface Playbook {
  name: string;
  goal: string;
  description?: string;
  version?: string;                 // 预留
  /** 入参契约:每个 {{slot}} 的 JSON Schema。缺省 [] = 无入参。已有。 */
  params?: BookParamSchema[];
  /** 出参数据契约:book 最终产出的数据结构。缺省 = void(无数据,只记状态)。 */
  outputSchema?: JsonSchema;
  /** 投递契约:产出数据送到哪。缺省 [] = 不投递(纯状态记录)。 */
  deliveries?: Delivery[];
  steps: PlanStep[];                // 已有
}

type Delivery =
  | { kind: "file";    path: string; overwrite?: "overwrite" | "error" | "rename"; on?: RunConclusion }
  | { kind: "message"; channel: "wechat"; template?: string; on?: RunConclusion }
  | { kind: "db";      table?: string; mode?: "insert" | "upsert"; on?: RunConclusion }
  | { kind: "print";   format?: "text" | "markdown"; on?: RunConclusion }
  | { kind: "webhook"; url: string; method?: "POST" | "PUT"; on?: RunConclusion };

/** GitHub workflow_run.conclusion 分流同款。默认 "success"。 */
type RunConclusion = "success" | "failure" | "cancelled" | "any";
```

关键语义:

- **outputSchema 与 deliveries 解耦**:`outputSchema` 回答"产出了什么数据",`deliveries` 回答"数据送到哪"。GitHub 的 outputs(键值数据)与 artifacts(文件)正是这样分开的——**文件/微信/入库/打印不是"出参类型",是投递通道**;
- **无产出的 book 零声明成本**:不写 `outputSchema` + `deliveries: []` → 执行完只落 run 记录,这就是"执行后什么都不产出、只记录状态"的形态;
- **deliveries 的字段可含 `{{slot}}`**:与 steps 一样在 instantiate 时用本次入参填充;
- **`on` 分流**:默认只在 success 投递;声明 `on: "failure"` 可做失败告警;`any` 全投。与 GitHub `if: conclusion == 'success'` 语义一致。

### 出参数据(outputs)从哪来

约定:book 的产出数据 = **最后一个 `local.eval` 步骤的返回值**(它通常就是 fail-closed 校验 + 组装的那一步,如 baidu-hot-search 的 step4)。引擎收口时从 `PlaybackStepResult[]` 取该值作为 `outputs`。若声明了 `outputSchema` 但运行中没有产出 → 事件里 `outputs` 为 undefined,投递执行器按"无数据"处理并告警。

---

## 3. Run 生命周期状态机(终态才发事件)

```
queued → pending → running ─┬→ success        (全部步骤通过)
                            ├→ escalated     (onFail 预算耗尽)
                            ├→ failed        (动作抛错 / 异常)
                            ├→ cancelled     (用户取消)
                            └→ 暂停态:needsConfirm / needsJudge / noAction
                                 (可 resumePlanId 续跑,不发事件)
```

- **终态**(success / escalated / failed / cancelled)→ 引擎收口 → 发 `run_finished`;
- **暂停态**不发事件(未终结,resume 后继续,结束于哪个终态就在哪个终态发一次)。

---

## 4. 事件体系(run_finished)

```ts
interface RunFinishedEvent {
  kind: "run_finished";
  ts: number;
  planId: string;
  bookName: string;
  trigger: "manual" | "schedule" | "mcp";
  status: "success" | "escalated" | "failed" | "cancelled";
  ranSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
  outputs?: unknown;          // 按 outputSchema 形状
  deliveries: Delivery[];     // 已实例化 {{slot}} 的本 book 投递声明
}
```

EventStore 扩展:

- 新事件类型 `run_finished`(现有 EventStore 只承载浏览器拓扑事件);
- 新注册 API:`eventStore.onRunFinished(listener)`——订阅者模式,新投递执行器 = 加一个监听器,引擎/通道零改动;
- `wait_for_event`(已有工具)天然可等 run_finished,agent 也能订阅。

---

## 5. 引擎收口(onFinish)

`playback.ts` 的 `runAutoPlayback` 加可选参数(引擎不依赖 EventStore,纯回调,与 cleanup 收敛同原则):

```ts
interface RunFinishInfo {
  planId: string;
  status: "success" | "escalated" | "failed" | "cancelled";
  ranSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
  results: PlaybackStepResult[];
}

runAutoPlayback(runner, planId, call, steps, opts?: {
  onFinish?: (info: RunFinishInfo) => void | Promise<void>;
  /** 本 book 的投递声明(已实例化),随事件带出 */
  deliveries?: Delivery[];
})
```

触发位置(三处收口):

1. `playLoop` 返回 `complete` → onFinish(status: success);
2. 返回 `escalate` → onFinish(status: escalated)(在资源清理之后);
3. catch(动作抛错)→ onFinish(status: failed)(在清理之后、rethrow 之前);
4. cancel(plan 已 abort)→ onFinish(status: cancelled),投递执行器按 `on` 过滤(默认不投)。

通道接线:console 的 internal-runner 与 MCP 的 run_playbook 各自传入 onFinish = **组装 RunFinishedEvent 发到 EventStore**(带上本 book 的 deliveries、trigger、耗时)。

---

## 6. 校验规则(FilesyncService scan / run 前)

| 声明 | 步骤证据 | 结果 |
|---|---|---|
| delivery: file | steps 无 `local.writeFile` | warning「声明了文件投递但没有写文件步骤」 |
| delivery: message/db | outputSchema 缺省(void) | warning「没有数据可投递」 |
| outputSchema 声明 | steps 无 `local.eval` 产出步骤 | warning「声明了产出但没有组装步骤」 |
| delivery.on | 不在 success/failure/any | error,拒绝保存 |
| steps/deliveries 出现未声明 {{slot}} | params 无此键 | error(现有部分校验扩展) |

校验结果进 console 的 book 详情「契约体检」区,不阻断执行(除 error 级)。

---

## 7. Console 展示

- **Book 列表/详情**:产出徽标(`📄 文件 / 💬 微信 / 🗄 入库 / 🔗 webhook / — 无`)+ 投递摘要 + 契约体检警告;
- **Run 详情**:
  - 状态时间线(已有);
  - 产出区:文件(可下载)、print 内容、微信发送结果、webhook 响应码;投递执行结果回写 run(如 `deliveryResults` JSON);
- **参数表单**:已有;deliveries 声明只读展示。

---

## 8. 实施清单(已完成)

**阶段 1 · 声明模型(契约层) · 已完成**
- [ ] `shared/src`:Playbook 加 `outputSchema` / `deliveries`;新增 `Delivery` / `RunConclusion` 类型;
- [ ] `backend/playbook.ts`:`validatePlaybookParams` 扩展(校验 delivery.on、未声明 slot);
- [ ] `playbooks/*.json`:4 个现有 book 补 `deliveries`(file 投递,path 用 {{slot}});
- [ ] `console`:Book 表加 `deliveriesJson` / `outputSchemaJson` 字段,FilesyncService 同步,详情页徽标。

**阶段 2 · 事件收口(执行层) · 已完成**
- [ ] `backend/playback.ts`:`onFinish` 参数 + 三处收口 + RunFinishInfo;
- [ ] `backend/event-store.ts`:`run_finished` 事件类型 + `onRunFinished` 订阅 API;
- [ ] `backend/internal-runner.ts` / `browser-mcp.ts`:onFinish 接线(组装事件,带 deliveries/trigger/耗时)。

**阶段 3 · 投递执行器(产出层) · 已完成**
- [ ] 新建 `backend/deliveries.ts`(或 console 服务):`run_finished` 订阅者,按 `deliveries + on` 执行:
  - file:执行中已落盘,事件附路径(核对存在);
  - print:写入 run 详情产出区;
  - webhook:HTTP POST(超时/重试 1 次,失败记入 deliveryResults);
  - message(wechat):调 weclaw `wec_send_text`(template 支持 {{outputs.xxx}} 插值)。
- [ ] run 详情记录 `deliveryResults`(每项 kind/status/result/error)。

**阶段 4 · 后续能力**
- [x] delivery: db 使用统一 JSON output 表，按 `(table, planId)` 唯一键支持 insert/upsert；不做 outputSchema 列级映射。
- [ ] book 链式触发(`run_finished` 订阅者触发另一 book,借鉴 workflow_run,链深 ≤3)。

---

## 11. 入参 / 出参消费现状与 spec 补丁

> 核实日期 2026-08-22。本节是"三处消费是否对齐"的现状体检 + 补齐要求,必须随阶段 1 一起做。

### 11.1 现状体检(三处消费入参)

| 消费点 | 现状 | 缺口 |
|---|---|---|
| console 手动触发 `TriggerDialog` | ✅ schema 驱动动态表单;读 `schema.default` 作 initialValue + placeholder;支持 type(boolean→Switch、number→InputNumber、enum→Select) | book 声明里大多**没写 default**;类型只认 string/number/integer/boolean/enum,不含 min/max 之外的更多关键字 |
| console 定时器 `ScheduleFormDialog` | ✅ 使用与手动触发相同的 schema-driven 参数表单；后端 enqueue 统一补 default/校验 | schedule 存储仍为 JSON，这是持久化格式而非 UI 输入方式 |
| MCP `run_playbook`(`validatePlaybookParams`) | ⚠️ 只校验 required 缺失 / number 类型 / 未知参数 | 不补 default;不认 boolean/enum/min/max/pattern |
| console 后端 `internal-runner.handleStart` | ⚠️ 原样收 string params | 不校验、不补 default |
| **出参(全部三处)** | ✅ backend/console 已接通 outputs/deliveries，UI 展示声明和运行结果 | db 使用通用 JSON output；链式触发仍未实现 |

### 11.2 spec 补丁(必须落实)

**P1 — 入参 default 统一建模**
- `BookParamSchema` 增加顶层 `default?: string | number | boolean`(第一类字段,不再只藏 `schema.default`);
- 兼容读取:`param.default ?? schema.default`(顶层优先,JSON Schema 内兜底);
- 后端在 `instantiateSteps` **之前**用 default 补齐缺省的可选参数——MCP 路径 agent 不传、定时器未填时,default 同样生效。

**P2 — 入参类型化归一(后端统一,不只靠前端)**
- 前端 `stringifyValues` 已把 boolean→"true"/"false"、number→字符串;后端 `validatePlaybookParams` + `fillSlots` 前按 `schema.type` 做同一套归一,堵住"false 变 true"(learn.md 已记)和 number 精度问题;
- `validatePlaybookParams` 补 boolean/enum/min/max/pattern 校验(与前端 rulesFor 对齐)。

**P3 — 抽公共 `ParamForm` 组件,schema 驱动**
- 把 `TriggerDialog` 的表单渲染抽成 `ParamForm`(吃 `ParamSchema[]`,输出 `Record<string,string>`,含 default 自动填充、类型化控件、校验);
- **手动触发 + 定时器 + 未来 webhook/链式触发 全部复用**——定时器 `paramsJson` 手填改为 `ParamForm`,切 book 即动态生成,default 自动带出。

**P4 — 出参默认值**
- deliveries 各字段的默认值同样进声明(不藏实现):`on` 默认 `"success"`、file 的 `overwrite` 默认 `"overwrite"`、print 的 `format` 默认 `"markdown"`;
- `ParamForm` 若涉及出参(如 overwrite)按 enum/default 渲染下拉,与入参同构。

**P5 — 三处消费对齐**
- console 详情页 / internal-runner / MCP run_playbook 三处统一:补 default、归一类型、消费 deliveries 声明与投递结果,行为一致,不各自为政。

### 11.3 验收标准

- 切任意 book:手动触发与定时器弹窗都出现**同一套** schema 驱动表单,default 自动填充;
- 不填可选参数直接触发 → 后端按 default 生效,结果与显式填 default 一致;
- 出参(含默认值)在 console 详情可见,MCP run_playbook 同步返回与事件流都带投递结果;
- 定时器不再要求手填 JSON(除非 book 无声明参数)。

---

## 9. 设计决策记录(为什么)

| 决策 | 理由 |
|---|---|
| outputSchema 与 deliveries 分开 | GitHub outputs vs artifacts 同构;避免"文件/微信/库"混成出参类型 |
| 事件驱动而非回调注册 | GitHub workflow_run 同构;新投递器 = 加监听器,零侵入 |
| 引擎不依赖 EventStore | 引擎纯执行,通道管事件;与 cleanup 收敛到引擎同一原则 |
| 暂停态不发事件 | 未终结;终态才发,一次 run 至多一条 run_finished |
| delivery.on 分流 | GitHub conclusion 分流同款;支持失败告警场景 |
| outputs = 最后一个 local.eval 返回值 | 它是事实上的"组装 + fail-closed 校验"步,产出形状最完整 |
| default 放顶层 BookParamSchema 字段 | 第一类契约,不藏 schema 内;表单/后端/定时器三处同源读取 |

---

## 10. 边界与安全

- `delivery: webhook` 的 url 必须 https 且校验来源(仅允许本机声明的 book,禁止来自未信任来源的 book 触发任意 URL)——与 eval/写文件的守卫同一信任模型(BCP_LOCAL_EVAL / reports 目录守卫);
- `delivery: message` 走 weclaw,受 `BCP_WECLAW_DISABLE` 与微信登录态约束;发送失败不影响 run 状态(投递层错误只写 deliveryResults);
- 投递执行器全部 best-effort + 超时上限(如 10s),绝不阻塞或改变 run 终态。

---

## 12. 已定案语义(2026-08-22 拍板)

| 议题 | 决定 | 落地含义 |
|---|---|---|
| cancelled 投递 | `on` 扩为 `success \| failure \| cancelled \| any`,默认 `success` | 取消默认不投;声明 `on:"cancelled"` / `on:"any"` 才在取消时投,行为向后兼容 |
| 投递可靠性 | 第一版 best-effort + 结果写 run 详情;webhook 幂等键(planId+delivery 序)+ 1 次重试 + 10s 超时 | 不做跨重启持久化队列(留阶段 4);投递失败仅写 deliveryResults,不改 run 终态 |
| 旧 book 迁移 | scan 自动推断 deliveries:有 `local.writeFile` → 推断 `{kind:"file", path:<步骤 params.path>}`;有 `local.eval` 无 writeFile → 无投递 | 推断结果写 warning 提示显式化,不阻断;4 个现有 book 无需手动补 |
