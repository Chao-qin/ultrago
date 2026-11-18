# Console Web UI/UX 统一整改 Spec

日期：2026-09-06 · 范围：`packages/console/web/src`（14 页面 + 14 组件）· 组件库 antd v5

## 0. 摸排结论（问题清单，含证据）

### A. 列表页形态散乱
| 页面 | 页头标题 | 副标题 | 操作区 | 含已删除 | 搜索 | Table size | pagination |
|---|---|---|---|---|---|---|---|
| Books.tsx:179 | ✅ | ❌ | 右侧 | Switch+文字 | ✅ 320px | middle | 无 |
| Runs.tsx:78 | ✅ | ❌ | **左侧内联**（违规） | Switch+文字 | ❌ | middle | 无 |
| Schedules.tsx:326 | ✅ | ✅ | 右侧 | Switch+文字 | ❌ | middle | 无 |
| Scripts.tsx:152 | ✅ | ✅ | 右侧 | **Button 切换**（Scripts.tsx:161，唯一异类） | ❌ | middle | 无 |
| Flows.tsx:134 | ❌（用 Tag 冒充副标题） | ❌ | 左侧 | Switch+文字 | ❌ | small | 无 |
| Schemas.tsx:172 | ❌ 无页头 | ❌ | 左侧 | Switch+文字 ×2 | ❌ | small | 无 |
| SchemaRecords.tsx:146 | ❌ 无页头；根 div 自带 padding:24（与 .console-content 24px **双重内边距**） | ❌ | 左侧 | **Switch checkedChildren 形态** | ❌ | small | {pageSize:20} |
| BookDetail.tsx:108 | ✅ | ❌ | 右侧 | — | — | small | 10/small |

### B. Select 缺 showSearch 清单（用户要求：所有下拉都能搜）
| 位置 | 下拉 | 选项量级 |
|---|---|---|
| SchemaSelect.tsx:260 | 注册 Modal · 角色 | 少 |
| ParamForm.tsx:67 | enum 参数 | **可能大** |
| DeliveryForm.tsx:45,46,47,48 | format / method / channel / on | 少 |
| CronSelector.tsx:162,174,186,198 | 分钟(60)/小时(25)/日期(32)/星期(8) | **大** |
| Scripts.tsx:267 | 语言 | 少 |
| SchemaRecords.tsx:149 | Schema 筛选 | **大**（随注册表增长） |
| SchemaRecords.tsx:280 | 编辑器 · Schema Name | **大** |
| Schedules.tsx:531 | 目标类型 | 少 |
| Schedules.tsx:644 | 模式 | 少 |
| Schemas.tsx:176 | 角色筛选 | 少 |
| Schemas.tsx:383 | 编辑器 · 角色 | 少 |
| FlowEditor.tsx:1443 | 批量连接 · 目标节点 | **大** |
| FlowEditor.tsx:1558 | 分支操作符 | 少 |
| FlowEditor.tsx:2809 | boolean 常量 | 2 |

已有 showSearch（保持）：SchemaRefSelect / FieldTypeSelect / ArrayItemTypeSelect（SchemaSelect.tsx:313/387/453）、Schedules book/flow/script（547/562/577）、timezone（639）、FlowEditor book/flow 绑定（1285/1299）。

### C. 虚拟列表滚动重复项
antd Select 的虚拟列表只测一种行高。行高不齐（一行文本 + 两行 label 混排）的列表滚动时会出现**重复渲染/留白错位**。SchemaSelect.tsx:145 已用 `virtual:false` 修过一处，但这是每个调用点各修一次的补丁，无法保证下一个 Select 不复发。

### D. Dashboard 现状
Dashboard.tsx：4 张统计卡 + 手写柱状图（固定 7 天）+ 最近运行表 + 失败 Timeline。stats.service.ts 仅提供 7 天 perDay，无 Book 维度聚合；范围写死，无时间范围切换。

## 1. 统一规范（P0）

### 1.1 新共享组件
- **`components/PageHeader.tsx`**：`{ title, subtitle?, actions? }`。左标题+副标题，**右 actions 只放操作控件**（新建/注册/重新扫描等按钮）；所有页面（含 Dashboard/Schemas/Flows/SchemaRecords/Runs）统一用它。详情页（BookDetail 等）保留返回按钮行，标题区同样用 PageHeader。
- **`components/FilterBar.tsx`**：表格顶行，放**全部筛选条件**（SearchInput + 筛选下拉 + 显示已停用/含已删除开关），左对齐一排、可换行。职责切分：**筛选在表格顶，操作在右上角**——不许把筛选塞进页头 actions，也不许表格顶行只留一个孤零零的搜索框。
- **`components/BcpSelect.tsx`**：antd Select 的唯一入口，全项目替换。
  - 默认 `showSearch: true` + `optionFilterProp: "label"`（可用 `optionFilterProp="search"` 覆盖，Registry 类 option 已带 search 字段）。
  - 默认 `virtual: false`——根治 C 类滚动重复项；注释写明理由（行高不齐 + antd 虚拟列表单行高测量）。当前最大列表（分钟 60、注册表几百）非虚拟渲染成本可接受，搜索才是导航手段。
  - 其余 props 全透传。
- **`components/DeletedToggle.tsx`**：`Switch size="small" + "含已删除"` 文字，消灭三种形态（Switch+文字 / checkedChildren / Button）。

### 1.2 列表页模板（8 个列表页统一）
```
<PageHeader title subtitle actions={右侧：仅操作按钮}/>
<FilterBar>（SearchInput + 各筛选 Select + 开关，全部筛选条件一排）
<PageTable size="middle" .../>（表格体内部滚动，页面不拉长）
```
- 逐页整改：Runs（switch 移右侧）、Flows（补页头，去 Tag 冒牌副标题）、Schemas（补页头）、SchemaRecords（补页头、**去掉根 div padding:24**）、Scripts（Button→DeletedToggle）、Books/Schedules（换 PageHeader/DeletedToggle）。
- 新增客户端搜索：Schedules（name/description/target 名）、Scripts（name/description）、Flows（name/description）、Schemas（name/title/description）、SchemaRecords（schemaName/source）。Books 已有。
- Table size 统一 `middle`（详情页 Card 内嵌表保持 `small`）。

### 1.3 BcpSelect 替换清单
B 节全部 14 处 + 已有 showSearch 的 9 处调用点统一改为 BcpSelect（删除重复的 showSearch/optionFilterProp 样板）。ParamForm enum、CronSelector 数值列、FlowEditor 节点/操作符全部覆盖，**不得遗漏**。

## 2. Dashboard 分析页升级（P1）
- **时间范围**：Segmented 7/14/30 天，前端切换，`/api/stats/overview?days=N`（stats.service `overview(days=7)`，perDay/成功率/排行共享同一范围；默认 7 兼容旧调用）。
- **Book 运行排行**：stats.service 新增按 bookId 聚合（次数、成功数、成功率），取 Top 8，卡片内小表 + Progress 条。
- **趋势图**：保留零依赖手写柱图，升级为 success/failed 堆叠 + 图例 + 网格线 + hover 提示，宽度自适应范围天数。
- **统计卡**：保持 4 张（Books / 24h Runs / 成功率 / 运行中），数值与所选范围联动的两项（成功率、失败）标注范围。

## 3. 非目标
- 不动后端除 stats.service/controller `days` 参数外的任何逻辑。
- 不引入图表库、不改路由结构、不动 Studio/iframe、不改 RunDetail/FlowRunDetail 信息架构。
- 不改 i18n / 主题（浅色）。

## 4. 验收
1. `grep -rn "<Select " web/src` 仅出现在 BcpSelect.tsx 内部。
2. 所有页面有 PageHeader；含已删除只有 DeletedToggle 一种形态；SchemaRecords 无双 padding。
3. Table size：列表页全 middle。
4. Dashboard 有范围切换 + Book 排行。
5. `pnpm -F console build` + typecheck + 既有测试通过；浏览器硬刷逐页检查。
6. **派独立子 agent 对照本 spec 逐条查漏**，漏项补齐后才算完成。

---

## 5. 2026-09-10 追加整改

> 本节是**追加**，不改写上面的原始 spec——那是 09-06 当时的判断与验收记录。
> 凡与下文冲突处，以本节为准。

### 5.1 §1.2 的列表页模板已代码化

原先它是一段文字约定，九个列表页各自手工拼装。现在有 `components/PageShell.tsx`：

```tsx
<PageShell title subtitle actions={右上角仅操作按钮} filters={<>筛选控件</>}>
  <PageTable … />
</PageShell>
```

约定变成默认值，偏离才需要动手写。它**不接管表格**——运行记录在筛选与表格之间夹着 Tabs，硬性规定"表格放这里"会把那一页挡在门外。

### 5.2 `PageTable` 接管空 / 错 / 载三态

新增 `query` prop，一次接上 loading / error / retry：

```tsx
<PageTable query={schemas} empty={{ title: …, description: …, action: … }} … />
```

原先每页手写三行，其中 `error` 那行**九个列表页一行都没写**——后端挂掉时表格渲染空占位符，和"这里本来就没数据"完全一样。这是运维台最糟的失败形态，所以把它收成一个必须传的东西。

### 5.3 §2 的 Dashboard 描述已作废

> ⚠️ **本小节本身也已被 §5.6 取代**。下面记的是同日更早一版的两层结构，
> 当天晚些时候整个面板按端点重做过一次。保留原文是为了让「为什么会走到
> §5.6」有迹可循，不作为现状描述。

原文写"统计卡保持 4 张（Books / 24h Runs / 成功率 / 运行中）"。现在是两层：

- 上层三块「需要注意」：失败数（带走势线）/ 成功率（带环形）/ 运行中（带状态点），左侧色条编码严重程度
- 下层一条「背景量」：Books · 24h 运行 · LLM 调用 / 失败 / P95 / token
- Book 排行改为**按失败数排**的健康度条形列表（原先按运行次数排，只会把跑得最多的顶上来，而跑得多且全绿的那个恰恰不需要看）
- 新增「即将触发」：面板此前每一块都在讲已经发生的事

趋势图仍是零依赖手写（§3 非目标），新增悬停读数与零运行日的基线。**曾经叠过一条成功率折线，已删**：堆叠柱的绿色占比本就是成功率，那条线冗余，且跨过零运行日连出的斜线暗示了不存在的趋势。

### 5.4 §3「不引入图表库」这条已推翻：引入 ECharts

那条非目标是在图表只是配角时定的。现在仪表盘是交付物本身，手写柱图在坐标轴、悬停、空数据、响应式上持续欠账——已经踩了一个：`preserveAspectRatio="none"` 的非等比缩放把圆形标记拉成扁椭圆。

已引入 `echarts@6` + `echarts-for-react@3`，两条纪律：

1. **按需注册，清单即库存。** `components/ChartImpl.tsx` 只对 `echarts/core` 注册 bar / line / grid / tooltip / legend / canvas。加新图表类型就在那份 import 清单里加——它就是这个 console 用到了什么的账本。
2. **必须懒加载。** ECharts 即使按需注册仍有 ~566KB，而十二个页面里只有仪表盘用得到。`components/Chart.tsx` 是 `React.lazy` 壳，实现在 `ChartImpl.tsx`（同 FlowScriptPanel 对 ScriptEditor 的做法）。

   ⚠️ **陷阱**：从懒加载模块里 `export { X } from "./ChartImpl"` 会把整个实现拽回主 chunk，拆分白做（实测主包纹丝不动地停在 2154KB）。所以坐标轴默认值单独放在不碰 echarts 的 `components/chart-axis.ts`。改动这三个文件后务必核对 `pnpm -F @bcp/console-web build` 的产物：**主包应停在 ~1584KB，`ChartImpl-*.js` 应是独立 chunk**。

### 5.5 §4 验收补充

- `grep -rn "onRetry={() => void" web/src/pages` 应为空（接线已收敛进 `query`）
- 列表页不应再出现裸 `<div className="page-fill">` + `<PageHeader>` 手工拼装

### 5.6 Dashboard 按端点重做（取代 §5.3）

§5.3 那版是在既有结构上做加法。这一版是从「**有哪些端点** × **操作者进来想知道什么**」重新推的，结论是原来的组织方式本身不对。

#### 补上四块从没上过面板的数据

| 数据 | 端点 | 之前 |
|---|---|---|
| 未处理事件 30 条，其中验证码 22 次 | `browser-events/stats` 的 `unacknowledged` + `byKind` | 一个字都没提 |
| 流程运行（21 次里 15 次失败） | `flows[].runs` | 完全不存在 |
| LLM 逐渠道成败（一条渠道 5 调用 5 全错） | `llm-calls/stats` 的 `byChannel` | 完全不存在 |
| 已中止 59 条 | `runs?status=escalated` | 被归进灰色的「其他」 |

最后一条是**贴错标签**：`overview.perDay` 只给 `count/success/failed`，剩下那部分是「已中止 + 已取消 + 运行中」混在一起，拿它冒充任何一种都是编数据。已中止必须单独查。

对一台驱动真实浏览器的机器，「未处理事件 30 条、其中 22 个是验证码」几乎是第一位的事实。一个不提它的运维面板，缺的不是一块卡片。

#### 分两段，因为这是两个子系统

§5.3 那版把 Book / 流程 / LLM 渠道三张健康度并排摆着，看起来像同一类东西——其实前两个是「被执行的目标」，后一个是「执行时依赖的基础设施」。**它们坏了要做的事完全不同**（改剧本 vs 换渠道/加额度），混在一起读的人不知道该顺哪条线索往下走。

- 顶部状态条（横跨两段）：后端 / 数据库 / LLM 网关 / 队列 —— 只回答「现在还能不能跑」
- 段一 **自动化执行**：跑了什么、成了没有、哪个剧本在坏、什么等着人处理
- 段二 **LLM 网关**：调了多少、哪条渠道在拖后腿、花了多少 token

段与段之间有一条带标签的分隔线（`.section-title`）。换子系统必须让读的人知道换了话题，否则下面的指标会被用上一段的判断去读。

#### 配色是算出来的，不是选出来的

跑校验器（OKLab + 色觉模拟）后才定的四个色槽：

| 槽 | 值 | 说明 |
|---|---|---|
| 成功 | `#039855` | |
| 已中止 | `#7839EE` | **紫，不是橙** |
| 失败 | `#D92D20` | |
| 其他 | `#667085` | 中性槽，不参与色相校验 |

最初的「失败 `#D92D20` / 已中止 `#DC6803`」被判 **normal-vision ΔE 10.5，硬性不及格**——两个色挨在同一根堆叠柱里，**全色觉的人都分不出来**。换成紫色后 ΔE 34.8、色盲模拟 28.1，全项通过。

紫色语义上也更对：已中止不是「更严重的失败」，是**另一类事**——门禁条件没达成、于是有序停下，该查的是站点或选择器，不是崩溃栈。

> **纪律**：新增任何图表配色前先跑校验器。这类判断眼睛给不出答案。

#### 单轴：删掉 §5.4 那版加的成功率折线

§5.3 删过一次手写版的折线（理由是冗余 + 假趋势 + 标记变形）。§5.4 换 ECharts 之后我又加了一条**走右轴**的——那是图表的头号反模式：两条不同量纲的线共用一张图，交叉点毫无意义，读者却会把它读成关系。

已删。成功率有自己的位置（牌子上的环形），而且堆叠柱里绿色的占比本来就是它。**这条是硬规则：不做双 y 轴。** 两个不同量纲的度量 → 两张图，或索引到同一基准。

#### bento 错落布局

此前用 antd Row/Col：每行一条横带、带内卡片等高、带与带边界对齐——规则栅格读起来像一张方格表，每块都在说「我一样重要」，于是没有一块告诉你先看哪。

改为 12 列显式网格 + 固定行高（92px + 16px gap，跨 N 行 = 92N + 16(N−1)），块跨不同行数：趋势 7×4、牌子 3×2 / 2×2、健康度 4×3 / 5×3 / 3×3。边界互相咬合而不是对齐成横带，尺寸差本身就是阅读顺序。

**两个踩过的坑（改布局前先读）**：

1. 窄屏塌缩**不能** `grid-column: span N !important` 一刀切。那会把每块都拉成整宽、堆成一列到底——比规则栅格更差。改为三档显式跨度：`--col` / `--col-md`，md 档同样保持错落（大块 8、小块 4、健康度 6）。
2. 断点**不要定在 1500**。侧栏占 200px，1254px 的窗口内容区还有 ~1030px，12 列每列 ~72px，7 列的图仍有 600px 完全够用。定高了会在还宽敞的时候提前塌成横带。现为 1200 / 820 两档。

#### 动态填充

`grid-auto-flow: row dense`：任何一块因无数据被条件渲染掉，后面的块自动补位而不留洞。LLM 段在窗口内零调用时**整段不渲染**——常年空着的卡片只会训练人略过它。

实测：隐藏「事件构成」后 Book / 流程 / 即将触发 三块位置均发生位移（是补位，不是留洞）。

#### 验收补充（并入 §4）

- `grep -rn "yAxisIndex" web/src/pages` 应为空 —— 没有双轴
- 新增图表配色后必须跑过校验器，且 normal-vision 最差相邻对 ΔE ≥ 15
- 改动 bento 跨度后，在 **1254px 与 1440px 两个宽度**各看一眼：块边界不应对齐成横带
- 拆分仍然成立（**判关系，不判数字**）：build 产物里 `ChartImpl-*.js` 必须是独立 chunk，且主包不含 echarts。数字会随其它改动漂——§5.4 当时写的「~1584KB」在本次重做后已是 1566KB，正是这个原因。可跑：

  ```sh
  pnpm -F @bcp/console-web build
  ls packages/console/dist-web/assets/ | grep -q '^ChartImpl-' && echo OK   # 独立 chunk 还在
  grep -l "echarts" packages/console/dist-web/assets/main-*.js && echo "❌ echarts 漏进主包"
  ```
