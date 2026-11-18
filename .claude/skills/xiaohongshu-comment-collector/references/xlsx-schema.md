# XLSX 表结构

## 列定义

| 列 | 字段名 | 类型 | 说明 |
|----|--------|------|------|
| A | 序号 | int | 自增编号 |
| B | 帖子标题 | str | post title |
| C | 帖子链接 | str | post URL |
| D | 发帖时间 | str | post date |
| E | 作者 | str | post author |
| F | 作者主页 | str | author profile URL |
| G | 推广商品 | str | products mentioned |
| H | 评论者名称 | str | commenter name |
| I | 评论者主页 | str | commenter profile URL |
| J | 评论内容 | str | comment text |
| K | 评论时间 | str | comment date |
| L | 评论地点 | str | IP location |
| M | 评论点赞 | int | comment likes |
| N | 是否作者回复 | bool | is_author_reply |
| O | 是否置顶 | bool | is_pinned |
| P | 需求分类 | str | demand category (manual) |

## 写入代码模板

```python
import openpyxl

def append_comments(xlsx_path, post_data, comments):
    """
    post_data: dict - title, link, author, author_profile, date, products
    comments: list[dict] - commenter, profile, content, time, location, likes, is_author, is_pinned
    """
    wb = openpyxl.load_workbook(xlsx_path)
    ws = wb.active
    start_row = ws.max_row + 1

    for i, c in enumerate(comments):
        row = start_row + i
        ws.cell(row=row, column=1, value=start_row + i - 1)
        ws.cell(row=row, column=2, value=post_data['title'])
        ws.cell(row=row, column=3, value=post_data['link'])
        ws.cell(row=row, column=4, value=post_data['date'])
        ws.cell(row=row, column=5, value=post_data['author'])
        ws.cell(row=row, column=6, value=post_data.get('author_profile', ''))
        ws.cell(row=row, column=7, value=post_data.get('products', ''))
        ws.cell(row=row, column=8, value=c['commenter'])
        ws.cell(row=row, column=9, value=c.get('profile', ''))
        ws.cell(row=row, column=10, value=c['content'])
        ws.cell(row=row, column=11, value=c.get('time', ''))
        ws.cell(row=row, column=12, value=c.get('location', ''))
        ws.cell(row=row, column=13, value=c.get('likes', 0))
        ws.cell(row=row, column=14, value=c.get('is_author', False))
        ws.cell(row=row, column=15, value=c.get('is_pinned', False))
        ws.cell(row=row, column=16, value='')

    wb.save(xlsx_path)
    return len(comments)
```

## 滚动加载伪代码

```python
def scroll_to_load_all_comments():
    prev_count = 0
    max_scrolls = 50  # 安全上限
    for _ in range(max_scrolls):
        browser_copilot_scroll(deltaY=800)
        wait(1.5)
        current_count = count_visible_comments()
        if current_count == prev_count:
            break
        prev_count = current_count
    return prev_count
```

## 评论者主页提取 JS

```javascript
// eval 可用时使用
Array.from(document.querySelectorAll('a[href*="/user/profile/"]'))
  .map(a => ({ name: a.textContent.trim(), url: a.href }))
  .filter(x => x.name && x.url)
```
