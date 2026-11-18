---
name: xiaohongshu-comment-collector
description: Use when collecting social media post comments (Xiaohongshu, Douyin, etc.) to xlsx. 中文触发:小红书评论采集、抖音评论采集、评论采集、帖子评论抓取、评论数据导出。English triggers: collect comments, scrape post comments, comment data extraction, xiaohongshu comments, douyin comments.
---

# 社交媒体帖子评论采集

## 核心逻辑

评论区是懒加载的，每次滚动只加载一小批新评论。因此采集必须遵循一个循环：**滚动 → 提取 → 写入 → 检查是否有新评论 → 继续或停止**。整个过程不能分阶段，必须在一个循环里完成。

```
已采集 = []
prev_count = 0

循环:
  1. 滚动评论区 deltaY=500
  2. 等待 1.5s 加载
  3. 提取当前页面所有可见评论
  4. 对每条评论去重（用 作者+内容 判断），新评论立即追加写入 xlsx
  5. 如果 已采集数量 == prev_count，说明没有新评论了，退出循环
  6. prev_count = 已采集数量
```

## 支持平台

| 平台 | 帖子 URL 特征 | 评论区特征 |
|------|---------------|------------|
| 小红书 | `xiaohongshu.com/explore/` | modal 弹窗，scroll locked |
| 抖音 | `douyin.com/video/` | 页面内嵌或新页面 |
| 快手 | `kuaishou.com/short-video/` | 页面内嵌 |

## 单个帖子采集步骤

### 1. 打开帖子

```
click → 点击帖子
→ 小红书：页面 scroll locked = modal 已打开
→ 抖音：等待视频页加载
```

### 2. 获取帖子元数据

从 `analyze_page` 提取：标题、链接、作者、时间、点赞数、商品/品牌

### 3. 采集评论（核心循环）

```
已采集 = []
prev_count = 0

循环:
  scroll(deltaY=500)  # 滚动评论区
  wait(1.5)
  当前评论 = extract_visible_comments()  # 用 eval 或 snapshot 提取
  for c in 当前评论:
    if c 不在 已采集 中:
      已采集.append(c)
      append_to_xlsx(c)  # 立即写入
  if len(已采集) == prev_count:
    break
  prev_count = len(已采集)
```

注意"展开 X 条回复"按钮，点击后等待加载再采集。

### 4. 提取评论数据字段

每条评论需要：评论者名称、主页 URL、评论内容、评论时间、评论地点（IP 属地）、评论点赞数、是否作者回复、是否置顶

**评论者主页提取**：优先用 eval JS 提取 `a[href*="/user/profile/"]` 或 `a[href*="/user/"]`（需 `BCP_EVAL=on`）；eval 不可用时从 snapshot link 元素获取。

### 5. 写入 xlsx

每条评论一行，列结构见 `references/xlsx-schema.md`。用 Python 原子操作 read+append+save，避免并发写入丢数据。

### 6. 关闭并继续下一个帖子

```
小红书：press_key Escape → 关闭 modal
抖音：press_key Escape 或 click 返回按钮
wait 1s → 点击下一个帖子
```

## Gotchas

- 小红书 modal 弹窗：Escape 关闭后 DOM ref 全部失效，必须重新 snapshot
- "展开回复"按钮不在 accessibility tree 中，需用 JS 或 snapshot 文本匹配
- **eval 使用前提**：eval 工具默认关闭，需设置环境变量 `BCP_EVAL=on` 才可用。无法用 JS 时改用 snapshot 提取
- 抖音评论区可能在视频右侧，需定位正确的滚动容器

## 禁止事项

1. 禁止只采首屏评论 — 必须滚动直到没有新评论
2. 禁止多条评论塞一个格子 — 每条评论独立一行
3. 禁止跳过评论者主页链接
4. 禁止采集过程中修改 xlsx 表头结构
