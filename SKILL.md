---
name: js-agent-deployer-skill
description: Coordinates deployment and channel routing for isolated OpenClaw agents. Use when the user asks an OpenClaw agent to create, deploy, inspect, bind, reassign, or provision another independent agent, especially with Feishu/Lark QR setup and channel routing.
---

# js-agent-deployer-skill

Use this skill when a deployed OpenClaw agent is asked to create another independent OpenClaw agent, inspect existing independent agents, or manage Feishu/Lark routing for an already-created agent.

The goal is orchestration, not reimplementation. Prefer OpenClaw's existing CLI, channel setup, Feishu/Lark plugin setup, config writers, and routing helpers. Do not hand-write platform API calls unless the existing setup surface cannot support the request.

## Operating Principles

- Before using this skill for any deployment or binding task, first analyze the current device's OpenClaw environment. Identify the active OpenClaw root, active config file, state dir, configured agents, configured channels/accounts, and existing `bindings[]`. Do not assume `process.cwd()`, `--openclaw-root`, or the skill workspace is the active Gateway config.
- Treat each new agent as an isolated scope: unique `agentId`, `workspace`, `agentDir`, auth profiles, sessions, and routing bindings.
- Never reuse an existing `agentDir` for a new agent.
- Do not print secrets. Redact tokens, app secrets, auth profile contents, and credential file paths when reporting back.
- Before executing deployment commands, confirm the requested agent identity, workspace path, channel account, model/auth expectations, routing target, and whether a gateway restart is acceptable.
- Prefer additive changes through `openclaw agents add` for agent creation. For Feishu/Lark QR provisioning, run `scripts/feishu-qr-provision.mjs` in cron-managed mode when webhook/message delivery details are available; do not try PTY or interactive `openclaw channels login` first.
- For Feishu/Lark scan-to-create, the intended UX is channel-delivered QR image from an isolated cron job: start QR registration from OpenClaw, send the generated QR image attachment through the operator channel, let the cron-owned run wait for scan approval, then finish config and routing.
- Do not use interactive terminal QR for remote/channel deployment. The script is the primary Feishu/Lark provisioning path for this skill.
- If direct config edits are unavoidable, inspect the current config first, preserve unrelated entries, and validate with `openclaw agents list --bindings`.
- For existing-agent inspection and Feishu route changes, prefer `scripts/openclaw-agent-admin.mjs`; it reads/writes through OpenClaw's config runtime and redacts app secrets.

## Required Inputs

Collect or infer these before deployment:

- `agentId`: stable lowercase id for the new agent.
- Display name and persona intent.
- Workspace path for the new agent.
- Model/auth plan: inherit defaults, configure a new provider auth profile, or copy portable static profiles.
- Channel plan: Feishu/Lark bot, another supported channel, or no channel yet.
- Routing plan: whole channel account, a specific DM, or a specific group.
- Operator contact: where to send the QR code, progress updates, and final proof.
- Cron delivery details for QR setup: `notifyChannel`, `notifyTarget`, optional `notifyThreadId`, and whether Gateway `/hooks/wake` is enabled for completion callbacks.

If anything is unclear, ask concise questions before changing configuration.

## Preferred Workflow

0. Analyze the local OpenClaw environment:
   - Resolve the OpenClaw CLI/package root that will be used for commands.
   - Run `openclaw config file` from that root and treat the returned path as the active config.
   - Note `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_HOME` when available; mismatched env vars can make scripts read a different config than the Gateway.
   - Run `openclaw agents list --bindings` and `openclaw channels list --json` before deciding whether to create, bind, or repair anything.
   - If using bundled scripts, pass `--openclaw-root <openclawRoot>` and make sure the script inventory agrees with `openclaw agents list --bindings`. If they disagree, stop and fix the config-runtime environment/path issue before writing config.

1. Inspect the current OpenClaw state:
   - `openclaw agents list --bindings`
   - `openclaw channels status --probe` when channel health matters

2. Create the isolated agent:
   - Use `openclaw agents add <agentId> --workspace <path>` in interactive mode when humans can answer prompts.
   - Use non-interactive flags only when all required values are known.
   - Allow the existing command to create the workspace, session store, agent config, and optional auth setup.

3. Set up the channel account:
   - For Feishu/Lark automatic bot creation, prefer an isolated cron job that runs `scripts/feishu-qr-provision.mjs --cron-mode` with `--notify-channel` and `--notify-target`.
   - Use a one-shot isolated cron job with a timeout longer than the Feishu/Lark QR lifetime, normally 720 seconds.
   - Include `--callback-url <gateway>/hooks/wake` plus one callback token source when Gateway hooks are enabled and the main session should be woken after completion.
   - The script writes a QR PNG/SVG image file and, in `--cron-mode`, sends the image directly through `openclaw message send`; legacy mode still exposes `qrImagePath`, `qrSvgPath`, and fallback `qrUrl` on stdout.
   - Use manual setup only when the user explicitly chooses manual App ID/App Secret entry. Do not fall back to manual setup merely because terminal interaction is unavailable.

4. Relay QR setup to the operator:
   - In the preferred cron flow, the script sends the QR image and progress updates itself. Do not start a second polling loop in the main Agent turn.
   - In legacy mode, when the script emits `{"event":"qr",...}`, send `qrImagePath` as an image attachment through the current conversation.
   - Do not send only the `qrUrl` link unless image upload/attachment fails.
   - Explain that the operator must scan with Feishu/Lark mobile app and approve the app creation.
   - Continue polling only within the command's supported flow.
   - If the QR expires, report that clearly and rerun setup only after user approval.
   - For cron flow recovery, inspect the cron run history once instead of continuously watching stdout.

5. Bind routing:
   - For a whole Feishu/Lark account, let `scripts/feishu-qr-provision.mjs` add the account-level binding.
   - If `--no-bind` was used, add routing later with `openclaw agents bind --agent <agentId> --bind feishu:<accountId>`.
   - For a single DM or group, use the existing routing config shape with `match.channel`, optional `match.accountId`, and `match.peer`.
   - Avoid stealing an existing binding from another agent unless the user explicitly requests reassignment.

6. Restart and verify:
   - Restart the gateway only when needed and approved.
   - Verify with `openclaw agents list --bindings`.
   - Probe channel status when credentials or listener state changed.
   - Send a final summary with the new `agentId`, workspace, agent dir, channel account, routing rule, and any required manual next step.

## Inspect Existing Agents

When the user asks what independent agents exist or how channels are currently bound, run:

```bash
node scripts/openclaw-agent-admin.mjs --list --openclaw-root <openclawRoot>
```

Report:

- configured agents (`agentId`, workspace, agent dir, default marker),
- configured Feishu accounts (`accountId`, enabled/domain/group policy, whether a secret exists),
- route bindings, especially `feishu` bindings and their owning `agentId`.

Do not print app secrets, token values, or credential file paths. If the OpenClaw CLI is easier in the current environment, `openclaw agents list --bindings` is also acceptable for read-only verification.

## Manage Existing Feishu Routing

Use `scripts/openclaw-agent-admin.mjs` for changing the route of an already-created Feishu/Lark account. The target `agentId` must already exist, and the Feishu account must already be configured.

Add or verify a Feishu account binding:

```bash
node scripts/openclaw-agent-admin.mjs --feishu-bind --agent <agentId> --account <accountId> --openclaw-root <openclawRoot>
```

Move an account binding from another agent only when the user explicitly approves reassignment:

```bash
node scripts/openclaw-agent-admin.mjs --feishu-bind --agent <agentId> --account <accountId> --reassign --restart --openclaw-root <openclawRoot>
```

Remove a Feishu account binding from an agent:

```bash
node scripts/openclaw-agent-admin.mjs --feishu-unbind --agent <agentId> --account <accountId> --restart --openclaw-root <openclawRoot>
```

Rules:

- Omit `--restart` only when the operator wants to apply config later; otherwise restart or report that runtime activation is pending.
- If the script reports a conflict, do not override it silently. Tell the user which agent owns the Feishu account and ask whether to reassign.
- If the Feishu account is not configured, use the QR provisioning flow or existing App ID/App Secret setup before binding.
- After any change, verify with `scripts/openclaw-agent-admin.mjs --list` or `openclaw agents list --bindings`.

## Feishu/Lark QR Notes

OpenClaw already owns the Feishu/Lark QR app-registration flow in the Feishu plugin. The deployment agent should use that setup path instead of copying external adapter logic.

For this skill, the desired Feishu/Lark flow is:

- create a one-shot isolated cron job that runs `scripts/feishu-qr-provision.mjs --cron-mode`,
- pass the operator channel/target so the script can send the generated QR image directly,
- let the cron-owned process wait until scan success, denial, expiry, or timeout,
- persist `appId`, `appSecret`, and `domain` through OpenClaw's channel config writer,
- add a Feishu account-level binding to the new `agentId`,
- call Gateway `/hooks/wake` when configured so the main session can resume with the result,
- restart or reload the gateway if required,
- verify and report completion in the same conversation.

The useful pattern from Feishu-style adapters is the operator loop:

- create or start platform-side setup,
- return QR/link to the requesting operator,
- wait for scan/approval,
- persist resulting app credentials through OpenClaw's channel config flow,
- bind the resulting channel account to the new `agentId`,
- confirm success in the same conversation.

## Feishu/Lark QR Provisioning Script

For Feishu/Lark, use the bundled provisioning script directly. Do not try `openclaw channels login` or any PTY-based flow first.

Preferred cron-managed run:

```bash
openclaw cron add \
  --name "Feishu QR setup for <agentId>" \
  --at "1s" \
  --session isolated \
  --timeout-seconds 720 \
  --message "Run: node scripts/feishu-qr-provision.mjs --agent <agentId> --account <accountId> --openclaw-root <openclawRoot> --cron-mode --notify-channel <channel> --notify-target <target> --callback-url <gatewayUrl>/hooks/wake --callback-token-env OPENCLAW_HOOK_TOKEN --restart"
```

Legacy direct run:

```bash
node scripts/feishu-qr-provision.mjs --agent <agentId> --account <accountId> --openclaw-root <openclawRoot> --legacy-mode
```

Defaults:

- `--account` defaults to `agentId`.
- `--domain` defaults to `feishu`; use `--domain lark` for Lark.
- `--group-policy` defaults to `allowlist`.
- The script writes the Feishu account config and adds an account-level binding unless `--no-bind` is provided.
- Use `--cron-mode` for cron-managed provisioning. Provide `--notify-channel` and `--notify-target` so the script can send QR/progress messages without the parent Agent watching stdout.
- Use `--callback-url` plus exactly one of `--callback-token-env`, `--callback-token-file`, or `--callback-token` to wake the main session when the isolated run finishes.
- Use `--legacy-mode` when running the original stdout JSON event stream for local debugging or environments without cron/webhooks.
- Use `--bind-only` when the Feishu/Lark app/account already exists in config but messages are not routed to the intended agent.
- Use `--app-id` plus one secret source when the Feishu/Lark app already exists on the platform but is not yet configured in OpenClaw.
- Use `--restart` when the operator approved applying the new route to the running gateway immediately. Without restart, the config file can contain `appSecret` while the running Gateway still reports the old missing-credentials state.
- Use `--dry-run` only to test QR generation and polling without changing OpenClaw config.

How to operate it from a channel-hosted agent in cron mode:

1. Create the isolated cron job with `--cron-mode`, operator delivery args, and an optional `/hooks/wake` callback.
2. Tell the user the QR will arrive as a channel attachment and must be approved in Feishu/Lark.
3. Let the cron-owned run wait for `scan_success` and `configured`; do not keep the main turn blocked on stdout.
4. When the callback wakes the main session, verify with `openclaw agents list --bindings` and `openclaw channels status --probe`.
5. If no callback is configured or the operator asks for status, inspect `openclaw cron runs --id <jobId>` once.

How to operate it in legacy mode:

1. Start the script with `--legacy-mode` and keep it running.
2. When stdout emits `{"event":"qr",...}`, send `qrImagePath` to the user as an image attachment in the current channel. Use `qrUrl` only as fallback text if image sending fails.
3. Tell the user to scan and approve in Feishu/Lark.
4. Wait for `scan_success`, then `configured`.
5. Restart/reload the gateway if `restartRequired` is true.
6. Verify with `openclaw agents list --bindings` and `openclaw channels status --probe`.

The script uses Feishu/Lark's device-code app registration endpoints directly, generates local QR image files, then writes config through OpenClaw's exported `openclaw/plugin-sdk/config-runtime` API. It does not print `appSecret`.

## Repair Missing Binding

If Feishu/Lark app creation succeeded but the account is not routed to the intended OpenClaw agent, do not rerun QR setup first. Add or verify the binding:

```bash
node scripts/feishu-qr-provision.mjs --agent <agentId> --account <accountId> --openclaw-root <openclawRoot> --bind-only --restart
```

For an already-configured Feishu account, the admin script is also valid:

```bash
node scripts/openclaw-agent-admin.mjs --feishu-bind --agent <agentId> --account <accountId> --restart --openclaw-root <openclawRoot>
```

Then verify:

```bash
openclaw agents list --bindings
openclaw channels status --probe
```

Expected binding shape:

```json
{
  "agentId": "<agentId>",
  "match": { "channel": "feishu", "accountId": "<accountId>" }
}
```

If `--bind-only` reports a conflict, do not overwrite silently. Tell the user which agent currently owns that Feishu account and ask whether to reassign or use another account id.

If `openclaw channels list --json` does not show the intended Feishu account id, `--bind-only` is not enough. The QR flow likely reached Feishu platform creation but did not reach OpenClaw config write. In that case:

- If the App ID and App Secret are available, configure that account and bind it directly:

  ```bash
  FEISHU_APP_SECRET_<ACCOUNT_ENV_SLUG>="<secret>" node scripts/feishu-qr-provision.mjs --agent <agentId> --account <accountId> --openclaw-root <openclawRoot> --app-id <cli_xxx> --app-secret-env FEISHU_APP_SECRET_<ACCOUNT_ENV_SLUG> --restart
  ```

  Derive `<ACCOUNT_ENV_SLUG>` from the target `--account` value by uppercasing it and replacing non-alphanumeric characters with `_` (for example `my-bot` -> `MY_BOT`). Never hardcode a slug from a previous deployment.

  Prefer `--app-secret-env` or `--app-secret-file` over `--app-secret` so the secret is not exposed in shell history.

- If the App Secret was not captured, rerun the full `scripts/feishu-qr-provision.mjs` flow for the intended `--account` and wait until the script emits `configured`.
- Do not claim deployment is complete after `scan_success`; only `configured` means OpenClaw has written the account and binding.

## Failure Handling

- If credentials are missing, ask the user to choose QR setup or manual App ID/App Secret entry.
- If QR setup fails because the Feishu/Lark app does not react, inspect the isolated cron run history once, retry once only after user confirmation, then offer manual setup.
- Do not attempt PTY or interactive `openclaw channels login` for Feishu/Lark QR setup in this skill.
- If `scripts/feishu-qr-provision.mjs` fails, report the concrete script failure. Only offer manual Feishu Open Platform setup if the user chooses that fallback.
- If `/hooks/wake` is unavailable or fails, use the operator notification and cron run history as the source of truth; do not start a new polling loop.
- If a binding conflict appears, report the current owning agent and ask whether to keep, reassign, or choose another channel account.
- If gateway restart is blocked, report that config is prepared but runtime activation is pending restart.
- If Feishu creation succeeded but routing still goes to the old agent, run the `--bind-only --restart` repair path and verify `agents list --bindings`.
- If Feishu creation succeeded but `channels list --json` does not show the intended account, first check whether the script emitted `credentialVerification.hasAppSecret=true` and whether `restartRequired=true`. Restart the Gateway when credentials are verified but runtime state is stale; rerun QR provisioning or ask for App ID/App Secret only when verification says credentials are missing.
- If validation fails, include the exact failing command category and the smallest next action.

## Final Report Template

Use this compact shape after a successful deployment:

```text
新 agent 已准备好：
- Agent: <agentId>
- Workspace: <workspace>
- Agent dir: <agentDir>
- Channel: feishu account <accountId>
- Routing: <binding summary>
- Runtime: <gateway restarted / restart pending>
- Verification: <agents list / channel probe result>
```
