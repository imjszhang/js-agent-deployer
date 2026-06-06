# js-agent-deployer-skill

OpenClaw Agent Skill：从已部署的 OpenClaw Agent 编排创建和管理隔离 Agent，重点支持飞书/Lark 扫码建机器人、现有 Agent 查看与飞书通道路由绑定。

## 功能

- 指导 Agent 使用 `openclaw agents add` 创建独立 Agent（独立 `agentId`、workspace、agentDir、认证与路由）
- 飞书/Lark 非交互式扫码建应用：`scripts/feishu-qr-provision.mjs`
- 生成 QR 图片（PNG/SVG），通过当前对话渠道发给操作者扫码
- 在 cron 托管模式下主动投递 QR/进度，并在扫码完成后写入 OpenClaw 渠道配置与路由绑定
- 支持 `--bind-only`、`--dry-run`、已有 App ID/Secret 直接配置等模式
- 查看当前 OpenClaw 独立 Agent、Feishu accounts 与通道绑定
- 修改已创建 Agent 的飞书通道绑定，支持显式 `--reassign` 改绑

## 安装

将本仓库放到 OpenClaw workspace 的技能目录，例如：

```text
<workspace>/skills/js-agent-deployer-skill/
```

确保 `SKILL.md` 与 `scripts/` 在同一目录下，OpenClaw 会自动发现该技能。

## 飞书/Lark 扫码配置

推荐用 OpenClaw cron 托管完整 QR 等待流程，避免父 Agent 长时间盯 stdout：

```bash
openclaw cron add \
  --name "Feishu QR setup for <agentId>" \
  --at "1s" \
  --session isolated \
  --timeout-seconds 720 \
  --message "Run: node scripts/feishu-qr-provision.mjs --agent <agentId> --account <accountId> --openclaw-root <openclawRoot> --cron-mode --notify-channel <channel> --notify-target <target> --callback-url <gatewayUrl>/hooks/wake --callback-token-env OPENCLAW_HOOK_TOKEN --restart"
```

`--cron-mode` 下脚本会：

- 使用 `openclaw message send` 把 QR 图片和关键状态直接发到 `--notify-channel` / `--notify-target`
- 成功或失败后调用 `--callback-url` 指向的 Gateway `/hooks/wake`，唤醒主 session 做最终验证
- 写入后重新读取活跃配置并回报 `credentialVerification.hasAppSecret`，确认 secret 已落盘；如果省略 `--restart`，运行中的 Gateway 可能仍显示旧的缺失状态
- 输出人类可读日志，cron run history 可作为断线补偿来源

Gateway 回调需要先启用 hooks，并配置独立 token。传 token 时优先使用 `--callback-token-env` 或 `--callback-token-file`，避免把 token 写进命令历史。

兼容/调试模式仍可直接运行脚本：

```bash
node scripts/feishu-qr-provision.mjs \
  --agent <agentId> \
  --account <accountId> \
  --openclaw-root <openclawRoot> \
  --legacy-mode
```

legacy 模式通过 stdout 输出 JSON 事件行。当看到 `{"event":"qr",...}` 时，将 `qrImagePath` 作为图片附件发给操作者，并保持进程运行直至 `configured`。

常用选项：

| 选项 | 说明 |
| ------ | ------ |
| `--domain lark` | 使用 Lark 域名（默认 `feishu`） |
| `--bind-only` | 仅补路由绑定，不重跑 QR |
| `--no-bind` | 只写渠道配置，不加绑定 |
| `--restart` | 配置完成后重启 gateway |
| `--dry-run` | 测试 QR 与轮询，不写配置 |
| `--cron-mode` | cron 托管模式：直接投递 QR/状态，可回调 `/hooks/wake` |
| `--legacy-mode` | 原始 stdout JSON 事件流模式 |
| `--notify-channel` / `--notify-target` | cron 模式下投递 QR 和状态的渠道与目标 |
| `--callback-url` | 完成或失败后调用的 Gateway `/hooks/wake` URL |

## 查看和管理现有 Agent

查看当前 agents、飞书账号和路由绑定：

```bash
node scripts/openclaw-agent-admin.mjs \
  --list \
  --openclaw-root <openclawRoot>
```

把已配置的飞书账号绑定到已创建的 agent：

```bash
node scripts/openclaw-agent-admin.mjs \
  --feishu-bind \
  --agent <agentId> \
  --account <accountId> \
  --restart \
  --openclaw-root <openclawRoot>
```

如果该飞书账号已经被其他 agent 占用，脚本会报冲突。确认要改绑后再显式使用：

```bash
node scripts/openclaw-agent-admin.mjs \
  --feishu-bind \
  --agent <agentId> \
  --account <accountId> \
  --reassign \
  --restart \
  --openclaw-root <openclawRoot>
```

移除某个 agent 的飞书绑定：

```bash
node scripts/openclaw-agent-admin.mjs \
  --feishu-unbind \
  --agent <agentId> \
  --account <accountId> \
  --restart \
  --openclaw-root <openclawRoot>
```

`openclaw-agent-admin.mjs` 通过 OpenClaw config runtime 读写配置，并且不会输出 app secret。

## 前置条件

- 已安装并构建 [OpenClaw](https://github.com/openclaw/openclaw)（脚本依赖 `openclaw/plugin-sdk/config-runtime`）
- 目标 `agentId` 已通过 `openclaw agents add` 创建
- 使用 cron 模式时，OpenClaw Gateway 需要可用，且操作者投递目标可由 `openclaw message send` 访问
- 使用 `/hooks/wake` 回调时，Gateway 需要启用 `hooks.enabled=true` 并配置专用 hook token

## 文档

详细操作原则、故障处理与修复流程见 [SKILL.md](./SKILL.md)。

## License

MIT
