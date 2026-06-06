---
name: js-agent-deployer-skill
description: Coordinates deployment and channel routing for isolated OpenClaw agents. Use when the user asks an OpenClaw agent to create, deploy, inspect, bind, reassign, or provision another independent agent, especially with Feishu/Lark QR setup and channel routing.
---

# js-agent-deployer-skill

Use this skill when a deployed OpenClaw agent is asked to create another independent OpenClaw agent, inspect existing independent agents, or manage Feishu/Lark routing for an already-created agent.

The goal is orchestration, not reimplementation. Prefer OpenClaw's existing CLI, channel setup, Feishu/Lark plugin setup, config writers, and routing helpers. Do not hand-write platform API calls unless the existing setup surface cannot support the request.

## Operating Principles

- Treat each new agent as an isolated scope: unique `agentId`, `workspace`, `agentDir`, auth profiles, sessions, and routing bindings.
- Never reuse an existing `agentDir` for a new agent.
- Do not print secrets. Redact tokens, app secrets, auth profile contents, and credential file paths when reporting back.
- Before executing deployment commands, confirm the requested agent identity, workspace path, channel account, model/auth expectations, routing target, and whether a gateway restart is acceptable.
- Prefer additive changes through `openclaw agents add` for agent creation. For Feishu/Lark QR provisioning, run `scripts/feishu-qr-provision.mjs` directly; do not try PTY or interactive `openclaw channels login` first.
- For Feishu/Lark scan-to-create, the intended UX is channel-delivered QR image: start QR registration from OpenClaw, send the generated QR image attachment back through the current conversation, poll for scan approval, then finish config and routing.
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

If anything is unclear, ask concise questions before changing configuration.

## Preferred Workflow

1. Inspect the current OpenClaw state:
   - `openclaw agents list --bindings`
   - `openclaw channels status --probe` when channel health matters

2. Create the isolated agent:
   - Use `openclaw agents add <agentId> --workspace <path>` in interactive mode when humans can answer prompts.
   - Use non-interactive flags only when all required values are known.
   - Allow the existing command to create the workspace, session store, agent config, and optional auth setup.

3. Set up the channel account:
   - For Feishu/Lark, run `node scripts/feishu-qr-provision.mjs --agent <agentId> --account <accountId> --openclaw-root <openclawRoot>` directly.
   - This script is the default QR setup path when the goal is automatic bot creation.
   - It writes a QR PNG/SVG image file and exposes paths as data (`qrImagePath`, `qrSvgPath`, plus fallback `qrUrl`) so the current chat channel can send an actual QR image.
   - Use manual setup only when the user explicitly chooses manual App ID/App Secret entry. Do not fall back to manual setup merely because terminal interaction is unavailable.

4. Relay QR setup to the operator:
   - When the script emits `{"event":"qr",...}`, send `qrImagePath` as an image attachment through the current conversation.
   - Do not send only the `qrUrl` link unless image upload/attachment fails.
   - Explain that the operator must scan with Feishu/Lark mobile app and approve the app creation.
   - Continue polling only within the command's supported flow.
   - If the QR expires, report that clearly and rerun setup only after user approval.
   - Watch stdout for a JSON line with `"event":"qr"` and immediately send its `qrImagePath` to the operator through the current chat channel.

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

- run `scripts/feishu-qr-provision.mjs` from the already deployed agent,
- capture the generated `qrImagePath` as data,
- send that QR image file to the requesting operator through the current channel,
- poll until scan success, denial, expiry, or timeout,
- persist `appId`, `appSecret`, and `domain` through OpenClaw's channel config writer,
- add a Feishu account-level binding to the new `agentId`,
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

```bash
node scripts/feishu-qr-provision.mjs --agent <agentId> --account <accountId> --openclaw-root <openclawRoot>
```

Defaults:

- `--account` defaults to `agentId`.
- `--domain` defaults to `feishu`; use `--domain lark` for Lark.
- `--group-policy` defaults to `allowlist`.
- The script writes the Feishu account config and adds an account-level binding unless `--no-bind` is provided.
- Use `--bind-only` when the Feishu/Lark app/account already exists in config but messages are not routed to the intended agent.
- Use `--app-id` plus one secret source when the Feishu/Lark app already exists on the platform but is not yet configured in OpenClaw.
- Use `--restart` when the operator approved applying the new route to the running gateway immediately.
- Use `--dry-run` only to test QR generation and polling without changing OpenClaw config.

How to operate it from a channel-hosted agent:

1. Start the script and keep it running.
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
- If QR setup fails because the Feishu/Lark app does not react, retry once only after user confirmation, then offer manual setup.
- Do not attempt PTY or interactive `openclaw channels login` for Feishu/Lark QR setup in this skill.
- If `scripts/feishu-qr-provision.mjs` fails, report the concrete script failure. Only offer manual Feishu Open Platform setup if the user chooses that fallback.
- If a binding conflict appears, report the current owning agent and ask whether to keep, reassign, or choose another channel account.
- If gateway restart is blocked, report that config is prepared but runtime activation is pending restart.
- If Feishu creation succeeded but routing still goes to the old agent, run the `--bind-only --restart` repair path and verify `agents list --bindings`.
- If Feishu creation succeeded but `channels list --json` does not show the intended account, rerun the full QR provisioning flow or ask for App ID/App Secret. Binding alone cannot make an unconfigured account work.
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
