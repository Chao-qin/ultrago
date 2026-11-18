# 抖店类目属性采集 — 接口契约与方法

> ⚠️ **2026-09-03 起本文档描述的是【历史口径】。** 采集已改为 book：
> `resource/playbooks/doudian-category-schema.json` —— 一次爬取、一个快照、三份产物
> （类目树 / 类目属性 / **类目资质**），`scripts/doudian-collect-category-properties.js`
> 已退化为指路桩。本文档第 1–3 节（接口契约、请求体踩坑、返回结构）仍然成立且仍是权威；
> 第 4–5 节描述的采集脚本与产出字段已被取代，变更点：
>
> | | 旧（本文档 §5） | 新 |
> |---|---|---|
> | 属性项 | 挑 10 个字段 | **原样保留**（补回 rules 57% / placeholder 100% / required_tips 28% / additions.diy_type 100% / options[].additions 58%） |
> | options | `[value_id, value_name]` 二元组（为压体积） | `[{value_id, value_name, additions}]` 原样 |
> | 属性项名字段 | `name` | `label` ← 迁移最容易踩这里 |
> | 采集失败的类目 | 整条丢掉 | **也落库**，带 `collection.ok:false` + 错误原文 + 原因 |
> | 类目资质 | 从未采集 | 新增 `reports/doudian-category-qualification.json` |
> | 文件顶层 | 直接是 cid 字典 | `{source, endpoint, capturedAt, stats, legend, failures, kind, data}` |
> | 体积 | 23 MB | 属性 122 MB + 资质 44 MB |
>
> 读这两份产物请一律走适配层，不要直接解形状：
> Python `.claude/skills/product-preprocess/scripts/category_capture.py`、
> JS `scripts/lib/category-capture.mjs`。
> 校验跑 `python3 scripts/validate-doudian-category-capture.py`。

> 与 `resource/playbooks/doudian-category-tree.json`（类目树）配套：类目树给出 4275 个叶子类目，
> 本文给出「每个叶子类目有哪些类目属性」的采集口径。
> 采集日期：2026-08-27。数据源为抖店商家后台（同源 cookie 鉴权），非开放平台 API。

## 1. 结论：类目属性藏在发布表单 schema 里

抖店新版发布页是 **schema 驱动**的（`addWithSchema` / `editWithSchema`），
没有独立的「取类目属性」接口 —— 类目属性是**按类目下发的发布表单 schema 的一个字段**：

```
POST /product/tproduct/getSchema?appid=1&_bid=ffa_goods
     → data.model.category_properties.items[]   ← 这就是该类目的全部类目属性
```

端点是从发布页自己的 chunk 里读出来的，不是猜的：

| chunk | 暴露的端点 |
|---|---|
| `async/445.*.js`（发布表单核心） | `getSchema` · `getCategoryDetail` · `addWithSchema` · `editWithSchema` · `partialEditWithSchema` |
| `async/4001.*.js` | `categoryOptionsN` · `getCategoryDetail` |
| `async/4476.*.js` | `searchCategoryN` · `tradeOptionsN` · `getCategoryDocument` |
| `async/526.*.js` | `getCascadeList` · `propertyFeedback` 系列 |

CDN 前缀：`https://lf3-fe.ecombdstatic.com/obj/ecom-cdn-default/cyborg_v2/ffa-goods/static/js/`

> ⚠️ `addWithSchema` / `editWithSchema` / `partialEditWithSchema` 是**写接口**，采集流程绝不触碰。
> 本采集只用 `getSchema`（读表单定义）与 `categoryOptionsN`（读类目树）。

## 2. 请求契约

`getSchema` 的 request body 不能自己拼 —— 服务端要求一整个 `context`。
下面这份是**从页面真实请求里抓下来的**（在发布页手动选一次类目，patch `window.fetch` 捕获），
复用时只需替换 `context.category_id`：

```jsonc
{
  "context": {
    "category_id": "1000001549",        // ← 只改这里；注意是【字符串】，传 number 会报「类目ID必传」
    "biz_identity": "xiaodian",
    "business_code": "xiaodian",
    "capability_codes": ["standard_capability"],
    "ability": [],
    "gray_components": [ /* 149 项组件白名单，含 category_properties —— 缺了它属性不下发 */ ],
    "feature": { "can_use_new_step_mode": "true", "not_first_render": "1", "session_publish_id": "…" },
    "identity_extension": "{\"Data\":{}}",
    "operation_type": "select_normal,normal",
    "product_id": "0",
    "shop_id": "…",
    "token": "…", "n_token": "…",
    "version": "v1_v8_v9_v10_v11_v12",
    "model_type": "", "fast_publish_type": "", "operation_list": []
  },
  "model": { /* 当前表单值，取模板里的原样即可 */ }
}
```

**踩过的坑**（都会返回失败而不是降级）：

| 传法 | 结果 |
|---|---|
| `{category_id: 1000001549}` | `code 500 类目ID必传` |
| `{context:{category_leaf_id: …}}` | `code 500 类目ID必传` |
| `{context:{category_id: 1000001549}}`（number） | `code 10002 参数错误` |
| 完整 context + `category_id` 为字符串 | `code 0` ✅ |

另外发现一条便利入口：`https://fxg.jinritemai.com/ffa/g/create?category_leaf_id=<叶子id>`
会自动选中该类目并进入表单（页面代码里 `getCategoryDetail` 那段读的就是这个 URL 参数）。

## 3. 返回结构

`data.model.category_properties`：

```jsonc
{
  "id": "category_properties",
  "items": [                              // ← 该类目的属性列表
    {
      "id": "2108",                       // 属性 ID（全平台通用，2108 = 玩具类型）
      "label": "玩具类型",                 // 属性名
      "required": true,
      "hidden": false,
      "placeholder": "请选择",
      "options": [                        // 可选值枚举
        { "value_id": "12429",  "value_name": "电玩具" },
        { "value_id": "167520", "value_name": "粘土玩具" }
      ],
      "additions": {
        "property_type": …,               // 属性类型
        "ui_type": …,                     // 控件类型（含 multi 表示多选）
        "important_type": 1,              // 重要度（影响「重要属性未填写」提示）
        "prop_group": { "name": … },      // 属性分组
        "measure_templates": [], "diy_type": 0, "industry_type": 0
      }
    }
  ],
  "actions": [ /* property_refresh 等联动刷新，走 refetchSchema */ ]
}
```

注意：**品牌类属性的 options 不在这里**（品牌是搜索式加载，走 `brandPrefix` / 独立接口），
`getSchema` 只给出属性本身。级联属性的下级值走 `getCascadeList`。

## 4. 采集脚本

见 `scripts/doudian-collect-category-properties.js`。在**抖店发布页已选好任一类目**的标签页里执行：
它先用 `categoryOptionsN` 逐层下钻拿到全部叶子（cid=0 起，`is_leaf` 为终止条件），
再对每个叶子跑一次 `getSchema` 抽取 `category_properties.items`。

实测口径（2026-08-27，店铺「demo-shop」）：

| 指标 | 值 |
|---|---|
| 叶子类目总数 | 4275（与 `reports/doudian-category-tree.json` 完全一致，交叉验证通过） |
| 成功取到属性 | 4236 |
| 失败 | 39，全部为 `code 500 创建商品前置校验失败` |
| 并发 / 耗时 | 6 并发，776 秒（约 13 分钟），无风控拦截 |
| 原始体积 | 约 23 MB（保留全部选项枚举） |

**那 39 个失败不是技术故障，也不是随机的**：39 个里 **38 个是刀具 / 利器类目** ——
单刀片、磨刀机、剑道、刃具、瓷砖推刀、电锯、气动螺丝刀、刀剑及配件、美工刀、剪刀、修眉刀、
手动剃须刀、美发剪、脱毛工具、切削工具系统、户外刀具全系（瑞士军刀 / 工兵斧 / 刀鞘 / 磨刀工具）、
雪茄剪、园艺刀剪锯、手动剃头刀、裁缝剪、军刀卡、餐饮厨具刀具全系（菜刀 / 斩骨刀 / 厨房剪刀 / 西餐刀）、
磨刀器、冲锉刨锯锉刀锉。剩下 1 个是「有价券/有价券」（另一类特殊资质）。

即抖店对**管制刀具类目**有平台级准入限制，需专门资质报白后才能发布，
后端在下发发布表单 schema 之前就先做了这道校验，所以拿不到属性定义。
同一店铺重试多少次都是同样结果，不必重试；要补齐得先给店铺开通对应类目资质。

完整缺失清单跑 `python3 scripts/validate-doudian-category-capture.py` 会打印。

### 数据画像（已通过校验脚本核实）

| 指标 | 值 |
|---|---|
| 属性条目总数（跨类目重复计） | 43,775 |
| **唯一属性 id 数** | **3,251** |
| 必填属性条目 | 12,743（占 29.1%） |
| 隐藏属性条目 | 0 |
| 选项条目总数 | 847,293 |
| 零属性的类目 | 0（每个类目至少 1 个属性） |
| 每类目平均属性数 | 10.3 |

出现频次最高的属性（分母 4236 个类目）：

| 次数 | 属性 | 覆盖率 |
|---|---|---|
| 4236 | 品牌 | **100%** —— 每个类目都要求品牌 |
| 2070 | 产地 | 48.9% |
| 1728 | 型号 | 40.8% |
| 1484 | 货号 | 35.0% |
| 1423 | 生产企业名称 | 33.6% |
| 1243 | 材质 | 29.3% |
| 856 | 功能 | 20.2% |
| 814 | CCC证书编号 | 19.2% |
| 741 | 上市时间 | 17.5% |
| 724 | 组合件数 | 17.1% |

「品牌」100% 覆盖但它的 `options` 恒为空（走搜索式加载，见 §3），
所以做自动填表时品牌必须走单独的品牌接口，不能指望这份数据。

一致性校验结果：与类目树的 leaf id 对齐**零偏差**（多出 0、path 不一致 0），
`optionCount` 与 `options` 实际长度**处处相符**。

## 5. 属性抽取字段

脚本对每个叶子类目产出：

```jsonc
{
  "<叶子类目id>": {
    "name": "工具材料",
    "path": "玩具/创意手工玩具/工具材料",
    "props": [
      {
        "id": "2108", "name": "玩具类型",
        "required": true, "hidden": false,
        "ui": "…", "ptype": "…", "important": 1, "group": "…",
        "optionCount": 5,
        "options": [["12429", "电玩具"], ["167520", "粘土玩具"]]
      }
    ]
  }
}
```

`options` 用 `[value_id, value_name]` 二元组而非对象，纯粹为压体积 —— 23MB 里绝大部分是它。
若只需要「有哪些属性」而不需要枚举值，去掉 `options` 后体积约 3-5 MB。
