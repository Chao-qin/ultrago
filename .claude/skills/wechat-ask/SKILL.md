---
name: wechat-ask
description: Use when遇到需要用户交互的场景时通过微信询问用户，如登录验证、填写表单、确认操作、选择选项等。中文触发:微信询问、微信提问、问用户、需要确认、登录、验证码、填写表单、选择、用户输入。English triggers: ask user via wechat, wechat question, need user input, login verification, fill form, confirm action, user interaction.
---

# 微信询问用户

当遇到需要用户交互的场景时，通过微信发送消息询问用户。

## 使用场景

- **登录验证**：需要用户名/密码/验证码
- **填写表单**：需要用户提供具体信息
- **确认操作**：不可逆操作前需要确认
- **选择选项**：多个选项需要用户选择
- **遇到障碍**：页面行为异常，需要用户协助判断

## 工作流程

1. **识别问题**：判断当前遇到的问题类型
2. **构建问题**：用清晰简洁的中文描述问题和选项
3. **发送微信**：使用 `wec_send_text` 工具发送
4. **等待回复**：查看 weclaw 日志获取用户回复
5. **继续执行**：根据用户回复继续操作

## 收件人

- 默认收件人由 WeClaw 的本地 `config/user.json` 提供。
- 调用 `wec_send_text` 询问用户时，优先省略 `to`，让 MCP 使用默认收件人。
- 需要发送给其他用户时，才显式传入对方的 `ilink ID`。

## 发送消息模板

```
【浏览器助手】
问题类型：[登录/表单/确认/选择]
当前页面：[页面标题或URL]
遇到问题：[具体描述]
需要你提供：[具体要求]
```

## 查看回复

查看 weclaw 日志获取用户最新回复：
```bash
tail -20 "$(git rev-parse --show-toplevel)/packages/weclaw/config/weclaw.log" | grep "received from"
```

## 注意事项

- 消息要简洁明了，避免过长
- 提供明确的选项或填写格式
- 标注紧急程度（如需要立即回复）
- 发送后主动查看日志获取回复，不要被动等待
