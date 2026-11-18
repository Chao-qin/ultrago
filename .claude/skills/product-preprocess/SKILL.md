---
name: product-preprocess
description: 将 1688、淘宝、天猫原始商品 JSON 清洗为 canonical 商品，完成类目属性映射、价格计算及合规检测，供浏览器上架 book 使用。适用于商品预处理、商品数据清洗和上架前数据准备。
---

# 商品预处理

将采集结果清洗为一份 canonical 商品，返回发布条件与业务结果。浏览器发布由 `resource/playbooks/doudian-publish-canonical.json` 执行；预处理不构造 addv2 API 参数。

## 入口与输出

Flow 使用 `scripts/preprocess_wrapper.py`，从 stdin 接收 JSON，从 stdout 返回 JSON。日志写 stderr。

```json
{
  "raw": { "offerId": "采集结果中的 ID" },
  "profile": { "店铺配置": "使用完整 shop-profile 记录" },
  "preprocessConfig": { "配置": "使用完整 product-preprocess-config SchemaRecord" },
  "category": { "kind": "auto" }
}
```

`raw` 必须传完整采集对象。店铺配置应选现有 `shop-profile` 记录；也可以选择包含
`shopProfile` 的 `product-preprocess-config@1` SchemaRecord，由该记录同时决定店铺字段
和预处理策略。编辑或新建 SchemaRecord 即可改变后续运行，不需要修改 Python。`category`
可省略，或指定 `{ "kind": "fixed", "leafId": 123 }`；固定类目仍需通过商品适配检查。

| 输出 | 内容 |
|---|---|
| `canonical` | 清洗后的商品；处理异常时可能为空对象 |
| `publication` | `canPublish`、`canDraft`、`missingRequired` |
| `outcome` | `status`、`label`、`level`、`reason`、`missingRequired` |
| `phaseTimings` | 可选：总耗时及实际执行的阶段耗时 |

商品属性和值 ID 保存在 `canonical.attributes[].doudianValues`；缺项、错误和检测发现保存在 canonical 中。默认不写商品中间文件。独立预处理可显式传 `persist: { "kind": "file", "path": "..." }` 导出结果；组合上架 Flow 不暴露该参数。

独立命令从采集文件读取，默认也只返回 JSON：

```bash
python3 .claude/skills/product-preprocess/scripts/build_doudian_product.py \
  --capture capture.json --shop-profile shop-profile.json
```

`--no-llm` 只适用于离线验证：类目不做无依据的语义猜测，属性只接受完全匹配，未匹配值留待人工。`--no-project` 跳过合规检测，不能当作已通过检测。图片处理与图床上传仍可能发生，运行前须遵守当前会话的外部操作权限。

## 契约与决策

Schema 真相源是 Console 注册表。运行时通过 GET 获取 canonical 契约，获取失败应明确报告，不退回本地副本。本地 `canonical.schema.json` 是初始化和离线测试使用的存档。原始输入使用 `raw-1688-offer`，店铺配置使用 `shop-profile`，不再登记 `doudian-addv2`。

- `canDraft` 表示具备填表条件；类目缺失、阻断错误、检测失败均不能视为可填表。
- `canPublish` 还要求必填字段齐全且发布校验通过。只看进程退出码无法判断是否已发布。
- `outcome` 是预处理结果；最终发布或草稿结果由发布 book 根据实际回执生成。
- 发布 book 的 `mode: auto` 根据 `publication` 选择发布或草稿。页面填写检查未通过时退回草稿；回执不完整或不一致时返回待核验。人工确认和重试前核验继续生效。

## 数据处理约束

- 不猜类目、属性值 ID、商家资质或证书号。LLM 通道失败和无匹配应留下明确原因，不能回退为字符串相似度猜测。
- 无 options 的必填资质字段交商家提供。带 options 的推断必须有商品信息证据；不能覆盖来源真值。
- 缺失、非正价格以及默认配置中的零库存 SKU 会被剔除；`preprocessConfig.sku.dropZeroStock`
  可关闭零库存剔除；同一商品保留各 SKU 的来源价差异。
- 图片在内存中下载、裁剪、检测并上传，canonical 的 `url` 为可用地址，`sourceUrl` 保留来源。检测不可用必须阻断，不能当作通过。
- 不修改原始采集文件，不擅自删除整个商品，不输出 Cookie 或 Token。

## 价格配置

价格由 `preprocessConfig.pricing` 覆盖店铺配置，金额单位为元；未传新配置时沿用
`shop-profile` 的策略。详见 `product-preprocess-config.example.json`。

图片配置使用 1-based 闭区间，先裁剪再 shuffle，最后按平台上限裁剪；`seed` 可使随机
顺序可复现。AI 敏感词、品牌清洗和 AI 短标题只处理对外文案，AI 失败会阻断商品；正则
替换规则按配置数组顺序执行。

| strategy | 必填配置 | 计算 |
|---|---|---|
| `fixed_amount` | `markup` | 来源价 + 固定加价 |
| `percentage` | `markupPercent` | 来源价 ×（1 + 百分比）|
| `percentage_plus_fixed` | `markupPercent`、`markupFixed` | 百分比加价后再加固定金额 |
| `min_max` | `minPriceYuan`、`maxPriceYuan` | 加价后限制在上下界内 |

金额保留两位小数。`minMarginYuan` 检查最低毛利，违例保留风险提示；上下界倒置是错误。

## 相关实现

- `scripts/build_doudian_product.py`：图片、类目、属性、价格和检测编排。
- `scripts/preprocess_wrapper.py`：Flow 入出参、异常与业务结果转换。
- `build_canonical.py`、`canonical_overlay.py`：商品结构及属性覆盖合并。
- `validate_doudian_rules.py`：发布硬约束；`unknown` 不等于通过。
- `projection/project.py`：检测发现、缺失属性、发布条件。
- `projection/edit.py`：人工修改工具，独立于自动上架流程。

数据库中的契约和 Flow 变更须由用户执行同步；此 skill 不授予数据库写权限。
