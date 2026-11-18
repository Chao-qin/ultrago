#!/bin/sh
# weclaw 的 noop agent：立即输出固定回执。runner 可能保持 stdin 打开，不能等待 EOF。
echo "✅ 已收到（AI 已关闭）"
