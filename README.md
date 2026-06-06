# js-agent-deployer

OpenClaw Agent Skill：从已部署的 OpenClaw Agent 编排创建新的隔离 Agent，重点支持飞书/Lark 扫码建机器人与渠道路由绑定。

## 功能

- 指导 Agent 使用 `openclaw agents add` 创建独立 Agent（独立 `agentId`、workspace、agentDir、认证与路由）
- 飞书/Lark 非交互式扫码建应用：`scripts/feishu-qr-provision.mjs`
- 生成 QR 图片（PNG/SVG），通过当前对话渠道发给操作者扫码
- 轮询扫码结果后写入 OpenClaw 渠道配置与路由绑定
- 支持 `--bind-only`、`--dry-run`、已有 App ID/Secret 直接配置等模式

## 安装

将本仓库放到 OpenClaw workspace 的技能目录，例如：

```text
<workspace>/skills/js-agent-deployer/
```

确保 `SKILL.md` 与 `scripts/` 在同一目录下，OpenClaw 会自动发现该技能。

## 飞书/Lark 扫码配置

```bash
node scripts/feishu-qr-provision.mjs \
  --agent <agentId> \
  --account <accountId> \
  --openclaw-root <openclawRoot>
```

脚本通过 stdout 输出 JSON 事件行。当看到 `{"event":"qr",...}` 时，将 `qrImagePath` 作为图片附件发给操作者，并保持进程运行直至 `configured`。

常用选项：

| 选项 | 说明 |
|------|------|
| `--domain lark` | 使用 Lark 域名（默认 `feishu`） |
| `--bind-only` | 仅补路由绑定，不重跑 QR |
| `--no-bind` | 只写渠道配置，不加绑定 |
| `--restart` | 配置完成后重启 gateway |
| `--dry-run` | 测试 QR 与轮询，不写配置 |

## 前置条件

- 已安装并构建 [OpenClaw](https://github.com/openclaw/openclaw)（脚本依赖 `openclaw/plugin-sdk/config-runtime`）
- 目标 `agentId` 已通过 `openclaw agents add` 创建

## 文档

详细操作原则、故障处理与修复流程见 [SKILL.md](./SKILL.md)。

## License

MIT
