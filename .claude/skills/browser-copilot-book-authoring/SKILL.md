---
name: ultrago-book-authoring
description: ultrago（agentchrome）项目里编写 / 修改 / 录制 book（resource/playbooks/*.json 剧本）的正确写法与反模式。覆盖 step 五槽（gate 前置门 / action / after 动作后果门 / verify 后置断言 / onFail）、六种等待的区分与各自归属、eval 内 bcpWait 原语（禁止手写轮询）、每条规则的执法者与违规存量、verify 禁止副作用、定位锚点优先级（按站点普查而非 role）、"确认为空 vs 没找到"的区分、跨步骤状态不得藏在 window.__。当在 agentchrome 仓库编写 book、录制剧本、改 playbook JSON、加 gate/signal/verify、写 browser.eval 代码、或 book 跑挂了要排查时使用。中文触发词 - "book" / "剧本" / "playbook" / "录制" / "写一本书" / "改 book" / "run_playbook" / "gate" / "signal" / "verify" / "evalCheck" / "browser.eval" / "bcpWait" / "bcpDeadline" / "采集脚本" / "抖店发布" / "1688 采集" / "步骤门" / "就绪信号" / "等待页面" / "book 跑挂了" / "步骤失败".
metadata:
  type: project
---

# 写 book 的正确姿势

> 所有规则都附真实数据，数字来自 `node scripts/census-books.mjs`（只读，随时可复跑）。
> 本轮：**2026-09-09 / 10 本 book / 3226 步 / 6330 个 eval 站点**。
> **数字会随 book 增删而过时**——复跑那个脚本比相信这里的数字可靠。上一版写的是
> 7 本 / 3187 步，其中 §0 的核心前提已经漂到离谱（见下），而没有人发现。

## 0. 先建立正确的心智模型

**eval 是这个系统的主干，不是逃生舱。** 实测 `browser.eval` **3160 次（占全部步骤 98%）**
vs `browser.click` **2 次**。这些 book 做的事是「打开页面 → 注入 JS 读写 DOM → 落盘」，
**不是点点点**。所以不要为了"少用 eval"把 DOM 操作硬拆成 click 步骤——那样更慢更脆。

> 上一版这里写的是「eval 45 次 vs click 3 次，占比 29%~75%」。结论没变（而且更极端了），
> 但那组数字来自 7 本 book 的时代。**一条规则的结论正确，不代表它的依据还活着**——
> 这就是 §11 存在的理由。

但主干就要有主干的纪律，下面每一条都是。

## 0.5 规则 → 违规存量 → 执法者（先看这张表）

**写进本文 ≠ 会被遵守。** 一条规则的实际采用率取决于两件事：有没有机器执法，
以及作者能不能在决策的那一刻检索到它。下表是全文地图，也是诚实声明。

| 规则 | 违规存量（2026-09-09） | 执法者 |
|---|---|---|
| §3 手写轮询（循环头带钟） | **75** | ✅ `check:books` · HAND_POLL |
| §3 无限循环 + 钟 | 0 | ✅ `check:books` · HAND_POLL_INF |
| §3 裸 `setTimeout` | 25 | ⚠️ 无单独 lint（等待预算那条会捎带） |
| §3.5 手抄可见性判据 | 0（09-14 清零：81 处 → `bcpDom.visible`） | ✅ `check:books` · 「DOM 原语不手抄」 |
| §3.5 手抄指针点击序列 | 0（09-15 清零：最后 3 处「形态各异」的其实都只是 `press` 的子集） | ✅ 同上（基线已空，任何新增立刻 FAIL） |
| §3.5 自己声明 `bcpDom` | 0 | ✅ `check:books`（与 `bcpWait` 同一条 lint） |
| §3.5 signal 判据用了该路径没有的注入名 | 0（09-15 修：`bcpDom` 已注入 signal） | ✅ `check:books` · signal 那一圈四条 |
| §3.5 signal 判据里派发事件 | 0 | ✅ 同上 · 「判据不动页面」 |
| §3.5 手抄 `innermost` | 0（09-15 清零：10 处定义逐字节相同，换成一层适配器，19 个调用点没动） | ❌ 无 lint —— 靠 review |
| §3.5 手抄文件投递 / 原生 setter | 0（09-15 清零：3 份互相矛盾的文件投递 + **7** 处 value 描述符 → `bcpDom.setFiles` / `setValue`） | ✅ `check:books` · HANDROLLED_INJECT |
| §3.5 手写 hover 序列 | 0（09-15：先普查出 3 处，再清零——「没数就别定基线」不该变成「永远不定」） | ✅ `check:books` · HANDROLLED_HOVER |
| §3.5 纯 CSS `:hover` 弹层 | 不适用 | ⛔ **物理打不开**，不是违规 —— 见 §3.5 末尾 |
| §5 verify 只含弱谓词 | 38 / 3226 | ✅ `check:books` · WEAK_VERIFY |
| §4 verify 带副作用 | **10 / 3160** | ❌ 无 —— 纯靠自觉 |
| §5.5 开窗步骤 verify 含等待判据 | 0 / 10（已清零） | ❌ 无 —— 靠 review |
| §6 定位锚点：`[data-module]` 占比 | 7%（class 占 34%） | ❌ 无 |
| §7 区分「确认为空」vs「没找到」 | 未量化（判据难自动化） | ❌ 无 |
| §8 写 `window.__` 跨步骤状态 | **30** | ❌ 无 |
| §9 不可逆步骤标 `risk:"confirm"` | **0 次使用** | ❌ 无 —— 这道保护至今空转 |
| §1 把「需要等待的条件」写进 verify（该进 `after`） | 未量化（evalCheck 不透明，静态测不出） | ❌ 无 —— 2026-09-16 实测造成 4/4 恒定误诊 |
| §1 `optional` 标在没有槽位的步骤上（等于没标） | 1（`doudian-after-watch-config` 已修） | ❌ 无 —— 靠 review |

怎么用它：

- **写 book 时**——❌ 那几行是没人替你兜底的，自己盯紧。
- **改这个 skill 时**——加一条规则先问「谁来执法」。只有文字没有 lint 的规则，
  会重复 §3 的命运：白纸黑字写着，仓库里违反 75 次。
- **❌ 就是待办清单**——下一条该给谁写 lint，按存量从大到小挑。

## 1. step 的五个槽，各管一段时间

```
[gate]  →  action  →  [after]  →  verify  →  [onFail]
 开始前     执行       后果出现     检查       失败处置
```

| 槽 | 语义 | 失败后果 |
|---|---|---|
| `gate` | 页面就绪，**可以开始了** | 超时 = 没开始，**不烧 maxRetries**，动作不执行 |
| `action` | 做这件事 | — |
| `after` | **我这下生效了**（新增字段） | 超时 = 做了没落地，**算步骤失败，烧 maxRetries** |
| `verify` | 瞬时检查，**不等待** | 失败走 onFail |
| `onFail` | retry / rescan / escalate | — |

### 最常犯的错：用 verify + retry 当轮询

```jsonc
// ✗ 错：点了提交，请求还在飞，verify 立刻检查必然失败，
//       靠 onFail:retry 反复重试来"等" —— 重试预算被当成轮询循环用
{ "action": { "method": "browser.click", "params": { "text": "保存" } },
  "verify": { "networkOk": { "urlIncludes": "/save" } },
  "onFail": "retry", "maxRetries": 5 }

// ✓ 对：用 after 等后果，verify 只做检查
{ "action": { "method": "browser.click", "params": { "text": "保存" } },
  "after":  { "all": ["saveRequestDone"] },
  "verify": { "networkOk": { "urlIncludes": "/save" } },
  "onFail": "retry", "maxRetries": 1 }
```

`after` 用的是和 `gate` 完全相同的信号词汇表（`pages.<page>.signals` 里的命名信号，
`{all:[...]}` / `{any:[...]}`），只是等待时机在 action 之后。

### 第二常犯的错（同一枚硬币的背面）：把「需要等待的条件」写进 verify

上面那条是**滥用重试预算去等**；这一条是**根本没等**。症状完全不同，而且伪装性强得多：
它不会表现成"重试很多次"，而是**恒定失败，且报错指向一个跟真因毫无关系的方向**。

2026-09-16 实测（`doudian-after-watch-config` 选品搜索）：

```jsonc
// ✗ 错：「搜索结果到位」要等好几拍（默认列表 → 中间态 → 结果），却放在 verify 里
"verify": { "evalCheck": { "code": "…列表里有没有这个 ID…" } }
```

| 时刻 | action | verify |
|---|---|---|
| T | 判到命中，返回 `ok:true` | — |
| T+162ms | — | 看到的还是**默认那 10 条** → false |

4/4 恒定失败。而外部只看到一行原始 evalCheck 代码，于是我一路误判成「这个商品不符合提报
要求」，跑去查商品好评率、翻违规记录——**判据没错，槽位错了**。

```jsonc
// ✓ 对：判据挪进 after（会等），verify 只留能自证动作本身、且不需要等的
"after":  { "all": ["searchApplied"] },
"verify": { "evalCheck": { "code": "…搜索框里还是那个 code…" } }
```

**自查一句话：写每条 verify 之前问「这个判据需要等吗？」——需要等就属于 `after`。**

**谁来执法**：`packages/shared/src/book-signals.ts` 有 `WAITING_VERIFY_KEYS`（`elementName` /
`textPresent` / `settled` …），但它**只用在 §5.5 那条**（`newWindow`/`newTab` 非幂等步骤），
而且**不覆盖 `evalCheck`**——evalCheck 不透明，静态看不出它是不是等待型。所以这一条目前 ❌ **无执法**。

一个可落地的 lint 候选（形状已被今天这次证实）：**`verify.evalCheck` 的代码与某个 signal 的
`script` 判据逐字相同** → 几乎必然是判据放错了槽。今天那两行一字不差。

### `optional` 只对槽位解析生效 —— 标在没有槽位的步骤上等于没标

`PlanStep.optional` 的语义是「这一步的 `{{slot}}` 填不上时整步丢弃」，**只对槽位解析生效**。
同一本书里，作者给三步中的两步标了 `optional` 想表达「按入参跳过」，但其中一步**根本没有槽位**，
于是那个意图静默失效了很久，表现为「某条入参路径从来没跑通过」。

想表达「按入参跳过」，正确位置是**门里的短路**（`condition.any` 里加一条读 `window.__` 入参的
判据），不是 `optional`。

## 2. 六种等待，别混成一种（决策入口就在这张表，不用往下翻）

**你要等的东西属于哪一行，答案连同签名都在这里。** 上一版这张表只有四行、且不含
`until`，而 `until` 恰恰是最常用的一种 —— 于是作者按表查不到自己的场景，就自己写了
循环。75 处手写轮询里的绝大多数属于第 ③ 行。

| 等什么 | 归属 | 怎么写 | 实际用量 |
|---|---|---|---|
| ① **导航就绪**（页面从空到能用） | `gate` | `pages.<page>.signals` 里的命名信号 | — |
| ② **动作后果**（我这下生效了） | `after` | 同上，只是时机在 action 之后 | — |
| ③ **等某个条件/元素出现** ←最常用 | eval 内 | `await bcpWait.until(fn, maxMs, pollMs)` → truthy 值；超时 → `null` | 33 |
| ④ **等列表涨停**（懒加载/无限滚动） | eval 内 | `await bcpWait.grew(countFn, opts)` → 不再增长后的计数 | **0** |
| ⑤ **等网络/DOM 静下来** | eval 内 | `await bcpWait.netIdle(quietMs, maxMs)` / `bcpWait.domQuiet(...)` → `true` 静了 / `false` 仍忙 | **1 / 0** |
| ⑥ **退避**（等一下再试） | eval 内 | `await bcpWait.sleep(ms)`，永不超过 `bcpDeadline` | 16 |

③～⑥ 全部受 `bcpDeadline` 约束，**全部返回结果而不抛异常**——"没等到"意味着什么由
book 自己决定。

**④⑤ 那三个 0/1 不是"用不上"，是"没人知道"。** 它们挂在引擎注入页面的监听上
（`netIdle` 读在途请求集合 `__bcpWaitNet`、`domQuiet` 读引擎的 MutationObserver），
**eval 里手写循环根本够不到那些信号**——手写只能轮询 DOM 去近似，近似不出来。
所以看到 ④⑤ 的场景别硬写，那是白费力气还不准。

**①和②的判据方向是相反的**：①等页面「静下来」，②等页面「动起来再静下来」。
所以**永远不要拿 `settled` 去验证一个点击**——点了提交、请求还没发出去时页面正是静的，
`settled` 立刻通过，等于没等（learn 2026-09-02）。

## 3. eval 里的等待：用 bcpWait，不要手写轮询

> 选型和签名见 §2 那张表（那是唯一入口）。这节只讲**为什么不能自己写**，
> 以及最常犯的那个错。

### 最常犯的错：手写轮询 —— 75 处

上一版这节标题写的是「不要手写 `setTimeout`」，反例是 `await new Promise(r => setTimeout(r, 250))`。
实测：`setTimeout` 只有 **25** 次，而循环头带钟的手写轮询有 **75** 次。
**规则挡住的是次要形态，主要形态从定义上就溜过去了**——读完那版，作者回头看自己的
`while (Date.now() < DL)` 会真心觉得没违规：没用 setTimeout、不是固定硬等、还有钟。

真实反例（`doudian-publish-canonical` step 20 原文，不是构造的玩具）：

```js
// ✗ 错：手写轮询。有钟、有退避、看着很规矩，但它在重新实现 bcpWait.until
const VERDICT = Date.now() + 7000;
while (Date.now() < VERDICT && Date.now() < DL) {
  if (editorOpen() || rejected()) break;
  await sleep(500);
}
if (!editorOpen() && !rejected()) { /* 超时分支 */ }

// ✓ 对：上限、间隔、判据全都原样，只是交给引擎
const ok = await bcpWait.until(() => editorOpen() || rejected(), 7000, 500);
if (!ok) { /* 超时分支 —— until 返回 null，语义明确 */ }
```

差别不在行数：

- 手写的只受自己那个 `VERDICT` 约束；`bcpWait.*` 额外被 `bcpDeadline` **二次封顶，跑不飞**
- 手写的「没等到」要靠循环结束后再判一次；`until` 直接把 `null` 交给你
- §2 的 ④⑤ 两类信号，手写**根本够不到**（它们挂在引擎注入的监听上）

`pnpm check:books` 现在拦这条：新增的手写轮询直接 FAIL，存量 75 处冻结在基线里，
修一处就从基线删一行。

### 绝不要自己声明 `bcpWait` / `bcpDeadline`

运行时按「参数最多 → 最少」的阶梯编译：先试 `(bcpDeadline, bcpWait)`，你若声明了同名
绑定就是重复声明 SyntaxError，于是**静默退到更少的参数档**——之后代码里所有
`bcpWait.xxx` 都成了对不存在的全局取属性，ReferenceError，而且要跑到那一行才炸。

要局部别名就换个名字。⚠️ 现有 book 里那些 `DL` / `sleep` 局部变量**正是上面那 75 处
手写轮询的残留**，不是范例——别照抄。

`pnpm check:books` 有两条 lint 卡这个：禁止声明注入名 + 用了 `bcpWait` 就必须能在带这
两个参数的档位下编译。

`netIdle` 会自动剔除超过 10 秒的在途请求——因为挂起的请求（ERR_TIMED_OUT 能挂一分钟）
会让"空闲"永远不成立，这正是 learn 2026-09-02 那次 networkIdle 门等满 30 秒的根因。

## 3.5 eval 里的 DOM 操作：用 bcpDom，不要手抄

和 §3 同一个形状的问题，只是换了个对象：`bcpWait` 之前是 75 处手写轮询，
`bcpDom` 之前是 **71 处手抄的 `vis` + 32 处手抄的 `press`**。

`browser.eval` 注入三个原语（和 `bcpWait` 走同一条通道，同样被 `check:dom` 在真
Chromium 里跑过）：

| 原语 | 签名 | 替代掉的手抄 |
|---|---|---|
| `bcpDom.visible(el)` | → boolean | 那 71 处 `const vis = e => {...}` |
| `bcpDom.press(el)` | 完整指针序列，含祖先链 `pointerenter` 补发 | 那 32 处 `const press = ...` |
| `bcpDom.hover(el)` | 只把指针移上去，**不按下** | 手写的 mouseover/mouseenter 序列 |
| `await bcpDom.click(el, {timeoutMs})` | **带重试**的点击 → `{ok, attempts, reason}` | — |
| `bcpDom.innermost(root, text, opts?)` | → **数组**（注意不是单个） | 各书自写的 `innermost` |
| `bcpDom.setValue(el, v)` | 走原型 setter 写值，**不发任何事件** | 手抄的 `getOwnPropertyDescriptor(...'value')` |
| `bcpDom.setFiles(el, files)` | 装 DataTransfer + 原型 setter + `input`/`change` 各一次 → **落地的文件数** | 3 份互相矛盾的文件投递 |

⚠️ **`setValue` 故意不发事件**：哪个事件能让框架重新读这个字段是 book 的判断
（多数控件 `input`、`<select>` 要 `input`+`change`、`_valueTracker` 那处两个都不该发，
否则两个查询会赛跑——learn 2026-09-14）。原语替你发事件，那个场景就没法表达了。
**`setFiles` 相反,它必须发**：投递文件本来就只有"发 input+change"这一种可用序列，
而三份手抄恰恰在这里分化（两处直接 `el.files = …` 会被 React 丢弃、一处只发 `change`）。
它还**返回真正落地的文件数**——框架把写入丢掉时那里是 0，那正是「传上去了」和
「我以为传上去了」的分界。

### 两条注入路径给的东西不一样

`bcpDom` 现在 **signal 的 `script` 叶子里也能用**（2026-09-15 补上），但两条路径注入的
集合不同 —— 代码看起来一模一样，跑起来不是：

| | step 的 `browser.eval` | signal 的 `script` 叶子 |
|---|---|---|
| `bcpDeadline` / `bcpWait` | ✅ | ❌ 门是**同步谓词**，等待归门的 `timeoutMs` 管 |
| `bcpDom` | ✅ 全部 | ✅ 只该用 `visible` / `innermost` |
| `bcpDom.press/hover/click` | ✅ | ⛔ lint 拒 —— 门每次 DOM 变动都重新求值，在判据里派发事件 = 不可预期次数的副作用 |
| 编译形态 | 表达式 → 失败退语句块 | **只有表达式**，没有回退 |

**这条是拿事故换来的**：v8 把书里 81 处手抄判据换成 `bcpDom.visible` 时连 signal 里的
6 处一起换了，而当时 signal 路径一个都不注入 —— 门恒 `blocked: bcpDom is not defined`，
整本 `doudian-publish-canonical` 卡在第 8 步，而一小时前它刚跑完 33/33。语法检查看不见
（自由标识符永远是合法 JS），只能靠 lint 按路径判 + `check:dom` 在真浏览器里跑一次真叶子。

### `press` 和 `click` 什么时候用哪个

这是 eval 环境和 MCP 工具的能力差。**MCP 的 `click` 工具**走 `reachTarget`：等元素可见可用 →
滚动进视野（轮换对齐方式）→ 命中测试 → 不过就重试 → 超时才报 `click intercepted`。
**eval 里的代码一步都不走这条路**，它是一次同步派发。

| | `press(el)` | `await click(el)` | MCP `click` 工具 |
|---|---|---|---|
| 等可见 / 可用 | ❌ | ✅ | ✅ |
| 滚动进视野 | ❌ | ✅ 轮换对齐 | ✅ 轮换对齐 |
| 命中失败重试 | ❌ | ✅ | ✅ |
| 命中失败时 | **照发**，返回 `false` | 不发，继续重试 | 重试→抛错 |

- **元素已经稳定在屏幕上、你只是在一次 eval 里连点很多个**（匹配 21 行规格那种）→ `press`，最快
- **可能被遮罩/弹层盖着，或刚展开还在动** → `await click`，它会等
- **这一步本身就是「点一下然后看结果」** → 别在 eval 里做，拆成独立 step 用 MCP `click` 工具，
  那样才有 verify 和 `↳ changed:` 兜底

⚠️ **`press` 的返回值必须看**。命中失败时它**照样派发**（32 处存量调用依赖这个行为不变），
只是把判断交给你——`false` 意味着「你点的位置上盖着别的东西，事件虽然发了，但用户看到的
不是这个」。忽略它就退回了 CLAUDE.md 记载的那个旧 bug：被盖住的点击报告成功。

⚠️ **别拿 `press` 自己写重试循环**——它无条件派发，循环三次就点三次。要重试就用 `click`，
它只在命中测试通过时才发。`check:dom` 的 V-click-no-double 钉住这条。

`hover` 和 `press` 的差别只在后半段：前者发到 `pointermove/mousemove` 为止，后者接着发
`pointerdown/mousedown/pointerup/mouseup/click`。**悬浮出来的删除按钮用 `hover` 探，
别用 `press`**——按下去就真删了。

两者都会**沿祖先链补发 `pointerenter`/`mouseenter`**。这不是锦上添花：这两个事件不冒泡，
真实鼠标会在光标路径上每一层都发一次，而 Naive UI / Element / Ant 普遍把 trigger 监听器
挂在比命中节点更外层的包裹元素上——不补发，菜单就是不出来，而现象长得像「我的定位写错了」
（learn 2026-08-19）。`check:dom` 的 V-hover-ancestor / V-press-ancestor 钉住这条。

### hover 的天花板：纯 CSS `:hover` 弹层，谁也打不开

合成事件只能触发 **JS 监听器**。弹层如果是纯靠 CSS `:hover` 伪类展开的（没有任何
addEventListener），`bcpDom.hover` 发再多事件也不会让它展开——浏览器不会因为一个
`isTrusted:false` 的事件进入 hover 匹配状态。

这和「原生文件对话框驱动不了」同级，是**纯扩展方案的物理限制**，唯一能做到的是 CDP 级输入
注入，而本项目坚决不用 CDP。所以：**菜单死活不出来时，先怀疑它是不是纯 CSS 的**，
别在定位器上耗时间。绕法只有让页面自己改状态（找到控制展开的 class 或 aria-expanded），
或者退回去让用户手动操作。

### 为什么不能自己写 `vis`：五份手抄给出五个答案

2026-09-14 普查：71 处手抄分化成 **5 种互不一致的变体**。拿 CSS/HTML 能隐藏元素的
**22 种成因**做矩阵（脚本已固化成 `check:dom` 的 V 组），与 Playwright 的定义比：

| 变体 | 分歧 | 代表性错法 |
|---|---|---|
| 只查 `width>0 && height>0` | 2/22 | — |
| 只查 `width>0`（不看高） | 3/22 | 展开动画中 80×0 的面板判成可见 |
| 只看几何不看 style | 4/22 | `visibility:hidden` 判成可见（它尺寸照常保留） |
| 查 `aria-hidden` 不看尺寸 | **10/22** | **祖先 `display:none` 判成可见**——元素根本不在渲染树里 |

而且**五份全都答错** `content-visibility:hidden` 和未展开的 `<details>`——
`getComputedStyle` 根本看不到这两个，只有 `checkVisibility()` 能。

### 判据是什么（别自己推导，照抄这条）

```js
el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })
  && rect.width > 0 && rect.height > 0
```

三个反直觉但**刻意**的点：

- **`opacity:0` 算可见**。它照常占布局、照常接收点击，你点得到。Playwright 同样这么判。
- **`aria-hidden=true` 算可见**。那说的是「别念给读屏软件」，不是视觉隐藏。要判可访问性
  另说，别混进 `visible`。
- **视口外的 `content-visibility:auto` 算可见**。判不可见会死锁：找不到的行也没法滚过去。

### `innermost` 返回数组，不是单个

那 10 处手抄（`doudian-after-watch-config` 8 处、`doudian-image-text-publish` 2 处）
**2026-09-15 已清零**，改法值得记：10 份定义**逐字节相同**，于是换成一层适配器
——判据交给 `bcpDom.innermost`，只留本书原有的选择规则，**19 个调用点一行未动**：

```js
const innermost = (root, text) => {
  const m = bcpDom.innermost(root, text, { exact: true, selector: 'button,div,span,a' });
  m.sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length);
  return m[0] ?? null;
};
```

两个参数都不能省：`selector` 不传会默认 `*`（命中面变宽，可能挑到别的元素），
`exact` 不传是**包含**匹配（「确定」会匹配到「确定并发布」）。
**别直接把调用点改成数组**——`!!innermost(...)` 这种写法一旦换成数组就变成 `!![]` = **恒真**，
门和判据会静默全通过。这正是"换返回类型要连调用逻辑一起改"的意思。

**新代码别抄那个适配器**：`[0]` 是为了保持旧行为不变才留的，它按后代数排序取第一个——
那是**静默选择**，正是 2026-09-08 那次「点到行容器、返回 ok:true、下一步才炸」的形状。
新写的直接面对命中集合：

```js
// ✗ 旧：三个同名按钮时闷头点第一个
const btn = innermost(drawer(), '选择商品');

// ✓ 新：命中几个是你要面对的事实
const hits = bcpDom.innermost(drawer(), '选择商品', { exact: true });
if (hits.length !== 1) return { ok: false, reason: `命中 ${hits.length} 个，锚点不够` };
bcpDom.press(hits[0]);
```

### 绝不要自己声明 `bcpDom`

和 §3 同款机制：运行时按「参数最多 → 最少」阶梯编译，你声明同名绑定 = 重复声明
SyntaxError → **静默退档** → 之后所有 `bcpDom.xxx` 变成 ReferenceError。
`check:books` 已把 `bcpDom` 加进那条 lint。

## 4. verify 是只读的，写了副作用就是 bug

契约原文（`shared/src/index.ts`）：**`READ-only — do NOT mutate (that would forge the very evidence)`**

普查发现 **10 / 3160 段** evalCheck 带副作用（`.click(` / `scrollTop=` / `scrollIntoView` /
写 `window.__`），其中数段用 `.click()` + `return false` 触发引擎重试来驱动遍历循环——
**把"验证失败重试"劫持成了 while**。

真实位置（自己去看，别只读这段描述）：`1688-offer-snatch` step 2 写 `window.__bcp1688`、
step 5 改 `scrollTop`、step 6 调 `scrollIntoView`；`1688-random-offer-snatch` step 7~12
在 verify 里 `.click(`。

> ⚠️ 数这个数字时**必须**把 `==` / `===` 排除掉：`window.__take === 'function'` 是**读**不是写。
> 不排除的话那 3040 处只读探针会被全判成副作用 —— 实测差别是 10 vs 3051，
> 一个 34 倍的假警报。`scripts/census-books.mjs` 里的判据已经排了。

```js
// ✗ 错：verify 里点击、滚动、写状态
"verify": { "evalCheck": { "code": "(() => { ...采集...; nx.click(); return false })()" } }

// ✓ 对：遍历留在 action 的 eval 里（那部分是对的），verify 只断言结果
"action": { "method": "browser.eval", "params": { "code": "/* 遍历所有组合，return 结果 */" } },
"verify": { "evalCheck": { "code": "(() => (window.__result?.length ?? 0) > 0)()" } }
```

## 5. verify 不要用 noErrors / settled 冒充

普查发现 **38 / 3226 步的 verify 只含弱谓词**（`actionSucceeded` / `noErrors` / `settled` 的任意组合）。这类 verify：

- `noErrors` = 没抛错；`settled` = 资源加载完；`actionSucceeded` = 调用返回了
- **三者都成立，仍然可能点错了完全不相干的元素**——它们不证明「做对了」，只证明「没炸」
- 判断一条 verify 够不够实，用 `verifyIsSubstantive()`（`packages/backend/src/verify-strength.ts`）：
  只含这三个弱谓词就返回 false。它曾经是 locator 自愈的运行时守门（弱 verify 的步骤不许把
  学到的维度写回 book），自愈那套已于 2026-09-05 移除——放宽一个 locator 会让它匹配到更多
  东西，"恢复"可能把步骤打到作者根本没指的元素上并把点错报告成成功。判据本身留了下来，
  现在是 authoring / lint 用的判断，不再是运行时行为。

问自己一句：**「我下一步要用的东西在不在？」**——那才是这一步该验的。

优先级：`networkOk`（最强，能证明真到了服务器，加 `bodyIncludes` 还能识破 "200 但 `{code:500}`"）
> `textPresent` / `elementName` / `elementValue` > `urlIncludes` > `evalCheck` > 弱三件。

`networkOk` 全仓只用了 5 次 / 3232 个谓词——**它被严重低估了**，写保存/提交类步骤优先用它。

## 5.5 非幂等动作的 verify 里，绝不能放「需要等待才成立」的判据

`onFail: "retry"` 的语义是 **agent 重做这个动作**（`playback.ts` 原文：*"this loop
redoes the same action itself"*）。所以这一步的动作重做一次会不会多产生一个副作用，
决定了它的 verify 能不能包含要等 DOM 渲染的判据。

**2026-09-05 实测的踩坑**：`doudian-publish-canonical` step 0

```jsonc
// ✗ 之前
"action": { "method": "browser.newWindow", ... },
"verify": { "urlIncludes": "/ffa/g/create", "settled": true, "elementName": "商品正面图" },
"onFail": "retry", "maxRetries": 3
```

`elementName: "商品正面图"` 是**页面就绪**判断，抖店慢一点就不成立 → `retry` →
**重做 newWindow → 又开一个窗口**。一次 run 最多 1+3 = **4 个窗口**，而且要等 run
收尾 `closeTrackedTabs` 才被逐个关掉。跑三次就是十几个窗口。

```jsonc
// ✓ 之后：verify 只证明「动作做成了」，就绪交给门
"verify": { "urlIncludes": "/ffa/g/create", "actionSucceeded": true }

// 就绪判据搬到 signal —— 门超时不烧重试预算、动作根本不执行，所以等待失败不会多开窗口
"createReady": { "all": [{ "urlIncludes": "/ffa/g/create" }, { "textPresent": "商品正面图" }] }
```

**判定规则**：

| 动作重做一次 | verify 里可以放等待类判据吗 |
|---|---|
| 多一个窗口 / 多一次提交 / 多传一份文件（**非幂等**） | ❌ 绝不。就绪判断放 `gate`，verify 只留能自证动作本身的（`actionSucceeded` / `urlIncludes` / `networkOk`） |
| 覆盖写、点不到就失败（`type` / `click` / `waitFor`） | ⚠️ 可以，但要知道重试会重做 |
| 有 `networkOk` 自证的（如 `upload` 验 `/batchupload` 200） | ✅ 没问题 —— 请求真没成功时，重试正是对的 |

**自查**：凡是 `browser.newWindow` / `browser.newTab` 的步骤，verify 里出现
`elementName` / `textPresent` / `elementEnabled` / `elementValue` 就是这个坑。
`pnpm check:books` 目前不查这条，靠 review。**实测当前 0 / 10 个开窗步骤中招，坑已清完**
—— 但没有 lint 守着，下一个 `newWindow` 步骤随时可能重蹈（见 §0.5 那张表的 ❌ 行）。

## 6. 定位：按站点普查选锚点，不要迷信 role

**不要默认用 `getByRole`**。中国电商站大量 `<div class="btn">` 做按钮，`<div>` 的隐式 role 是
generic，实测全仓 `role`/`aria` 选择器只有 17 个（占 querySelector 的 4%）。

正确做法是**为每个站做一次锚点普查**，找出它自己提供的稳定锚点：

| 站点 | 已发现的稳定锚点 |
|---|---|
| 1688 | `[data-module="od_title"]` / `od_sku_selection` / `od_picture_gallery` / `od_product_description`（业务模块名，改样式不动它） |
| 通用兜底 | 用户可见文本 / `[title]` / `[placeholder]`（改了用户就不认识了，所以稳） |

实测 **459** 个 `querySelector` 里只有 **31 个（7%）**用了 `data-module`，**158 个（34%）**
用了易变 class —— **这个比例应该反过来**。（上一版记的是 336 / 31 / 156：分母涨了，
`data-module` 的绝对数一个没涨，占比反而从 9% 掉到 7%。）

**绝不做梯度降级**：找不到就换一个更宽的选择器继续跑，会静默操作到错误的元素。
宁可响亮失败，也不要猜。加锚点（AND 组合）比换锚点安全。

## 7. 找不到元素时，区分「确认为空」和「没找到」

```js
// ✗ 错：这两件完全不同的事产出相同结果
if (!sku) return true;   // 是「这个商品本来就没有 SKU」还是「选择器失效了」？

// ✓ 对：用正交信号取证，把原因交出来
if (!sku) {
  const hint = /规格|颜色分类|尺码/.test(document.body.innerText);
  return hint ? { ok: false, why: 'sku-selector-broken' }   // 有迹象却找不到 = 挂了
              : { ok: true,  why: 'no-sku-module' };         // 确认这商品就是没有
}
```

这是全仓**最危险**的一类问题：改版 → 选择器失效 → 静默 `return true` → `noErrors` 通过
→ 写出一个空报告，全程绿灯，没有人知道。**成功地产出错误结果，比任务失败严重得多。**

配套：采集类 book 落盘前必须断言条数 > 0，空结果直接失败，不要写文件。

## 8. 跨步骤状态不要藏在 window.__

`browser.eval` 跑在**页面的 MAIN world**，`window.__acc` 这类变量的生命周期是
**「这个 tab 的这个文档」**——比 tab 生命周期还短：

| 场景 | 变量还在吗 |
|---|---|
| A tab 写的，B tab 读 | ❌ 完全不共享 |
| 同 tab 硬导航 / `browser.reload` | ❌ **window 重建，全丢** |
| 同 tab SPA 路由（pushState） | ✅ 保留 |

所以：**book 里如果有 `browser.reload` 或会触发跳转的步骤，它之前所有 `window.__` 累加器都会清零。**
写 `window.__x = window.__x || {}` 这种"有就复用没有就新建"是必要的防御，但它掩盖了丢失。

优先把结果通过 eval 的**返回值**交出去（引擎会记进 run 结果），而不是留在页面里。

## 9. 提交前自检清单

- [ ] 每个定位类步骤的 verify 都不是 `{noErrors, settled}` 或 `{actionSucceeded}`
- [ ] 没有任何 `verify.evalCheck` 里出现 `.click(` / `scrollTop=` / `scrollIntoView` / 写 `window.__`
- [ ] 没有用 `onFail: retry` + 高 `maxRetries` 来"等"某件事（那件事应该写成 `after`）
- [ ] `newWindow` / `newTab` 步骤的 verify 里没有等待类判据（见 §5.5，重试会多开窗口）
- [ ] eval 里没有**手写轮询**（`while`/`for` 循环头带 `Date.now()`）也没有裸 `setTimeout`——用 `bcpWait`（§2 选型表）
      —— 这条现在由 `pnpm check:books` 执法，新增会直接 FAIL
- [ ] 保存/提交/发布类步骤用了 `networkOk`，不是只看 UI 文案
- [ ] 找不到元素的分支区分了「确认为空」和「没找到」
- [ ] 采集类 book 空结果会失败，不会写出空文件
- [ ] 不可逆步骤（提交/删除/支付/发布）标了 `risk: "confirm"`
      —— 实测全仓 **0 次使用**，包括真的会发布商品的那本，这道保护目前是空转的

## 10. 已知的结构缺口（写 book 时绕不过去，别浪费时间找）

- **没有退避重试**：`maxRetries` 是立即重跑。需要退避就在 eval 里 `bcpWait.sleep`。
- **步骤没有输出字段**：eval 的产出只能靠返回值进 run 结果，或者留在页面里（见 §8）。
- **JSON 里没有 if / while / forEach**：分支和循环就写在 eval 内部——这是正确的，
  不要试图把它们拆成步骤（每项一次 RPC 往返，慢一个量级）。
- **内联 JS 无 typecheck 无 lint**：2026-09-04 出过格式化器补尾分号导致 17 个代码块
  静默退化的事故。改内联 JS 后务必跑 `pnpm check:books`。

## 12. React 文件输入组件的特殊处理

React 的文件输入组件（`<input type="file">`）自己装了 `files` 访问器来监听文件变更。
**直接 `el.files = dt.files` 会被识别为外部修改并 `reset()`**，文件丢失，而且不报错。

### 正确做法：一行，交给原语

```js
// ✗ 错：直接赋值，React 会 reset（而且不报错，表现成「抖店说上传失败」）
el.files = dt.files;

// ✗ 也错：自己抄一份原生 setter —— 这正是 lint 拦的形态
const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;

// ✓ 对：
const landed = bcpDom.setFiles(el, [new File([csv], 'sku-import.csv', { type: 'text/csv' })]);
if (!landed) return { ok: false, reason: '文件没落地（控件把写入丢了）' };
```

原生 setter、`input`+`change` 的顺序、以及「读回真正落地了几个」都在原语里，
被 `check:dom` 的 **V-set 组**在真 Chromium 里跑过——那组里最要紧的一条是给元素装一个
自己的 `files` 访问器（框架守卫从这里看就长这样），断言它**没有被触发**。

### 这一节为什么改写过（2026-09-15）

上一版教的就是"自己抄原生 setter"，于是仓库里长出了 **3 份互相矛盾的文件投递**：
两处直接赋值、一处走原生 setter；事件也是两处 `input`+`change`、一处只发 `change`。
谁都没错到报错，只是有的能用有的不能，而**没有任何东西能判定哪份是对的**——
后来是拿引擎自己的 upload op 当权威才裁决掉的（那次还顺带让一条测试红了一天）。
**教一个手抄配方，就是在造下一次分化。** 能写进原语的配方，就不该写进 skill 的代码块。

## 参考

- 运行时"怎么驱动"的 SSOT：`packages/backend/src/browser-mcp.ts` → `BROWSER_INSTRUCTIONS`
- 契约：`packages/shared/src/index.ts`（`PlanStep` / `StepVerify` / `Locator`）、
  `packages/shared/src/book-signals.ts`（`SignalCondition` / `SignalGate`）
- `bcpWait` 实现与回归：`packages/extension/src/content/dom-runtime.ts` → `bcpWaitFactory`，
  `pnpm check:dom` 的 W1~W5 用例
- 已经按本文写法改过的真实例子（照着抄）：`1688-offer-snatch` step 3、
  `1688-random-offer-snatch` step 2/3/7/8 —— 都是「手写轮询 → `bcpWait.until`，
  上限与间隔保持原值」这一种改法
- 纠错流水账（动手前先读）：`.agent/learn.md`

## 11. 重新普查（本文数字过时了就跑这个）

上面每条规则后面的数字都是某次普查的快照，改动一多就会漂。**直接跑：**

```bash
node scripts/census-books.mjs      # 只读，不写任何文件
```

它输出的正是 §0.5 那张表 + 动作分布 + 等待原语采用率 + 锚点分布 + **一份真实反例清单**
（写 skill 时从那里抄，别构造玩具代码）。

> 上一版这里只有一段伪代码注释描述「该数什么」，于是复核成本高到没人做 ——
> 结果 §0 的核心前提（eval vs click 的比例）漂了四天没人发现。
> **「给方法」不等于「能被执行」，和 §0.5 说的是同一件事。**

判断规则是否还成立，看的是**比例**不是绝对值：eval 是不是仍然压倒 click（是→本文的
「eval 是主干」前提成立）、弱 verify 占比在不在降、`class` 选择器有没有让位给 `data-module`。
