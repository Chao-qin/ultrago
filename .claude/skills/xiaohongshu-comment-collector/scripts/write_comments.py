#!/usr/bin/env python3
"""
小红书评论写入 xlsx 工具
用法: python write_comments.py <xlsx_path> <post_json> <comments_json>
"""
import sys
import json
import openpyxl

def write_comments(xlsx_path: str, post_data: dict, comments: list[dict]) -> int:
    """将帖子评论写入 xlsx，返回写入行数"""
    wb = openpyxl.load_workbook(xlsx_path)
    ws = wb.active
    start_row = ws.max_row + 1

    for i, c in enumerate(comments):
        row = start_row + i
        ws.cell(row=row, column=1, value=start_row + i - 1)  # 序号
        ws.cell(row=row, column=2, value=post_data.get('title', ''))
        ws.cell(row=row, column=3, value=post_data.get('link', ''))
        ws.cell(row=row, column=4, value=post_data.get('date', ''))
        ws.cell(row=row, column=5, value=post_data.get('author', ''))
        ws.cell(row=row, column=6, value=post_data.get('author_profile', ''))
        ws.cell(row=row, column=7, value=post_data.get('products', ''))
        ws.cell(row=row, column=8, value=c.get('commenter', ''))
        ws.cell(row=row, column=9, value=c.get('profile', ''))
        ws.cell(row=row, column=10, value=c.get('content', ''))
        ws.cell(row=row, column=11, value=c.get('time', ''))
        ws.cell(row=row, column=12, value=c.get('location', ''))
        ws.cell(row=row, column=13, value=c.get('likes', 0))
        ws.cell(row=row, column=14, value=c.get('is_author', False))
        ws.cell(row=row, column=15, value=c.get('is_pinned', False))
        ws.cell(row=row, column=16, value='')

    wb.save(xlsx_path)
    return len(comments)

if __name__ == '__main__':
    if len(sys.argv) != 4:
        print("Usage: python write_comments.py <xlsx_path> <post_json> <comments_json>")
        sys.exit(1)

    xlsx_path = sys.argv[1]
    post_data = json.loads(sys.argv[2])
    comments = json.loads(sys.argv[3])

    count = write_comments(xlsx_path, post_data, comments)
    print(f"Written {count} comments to {xlsx_path}")
