#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

function usage() {
  return `
Usage:
  node scripts/openclaw-agent-admin.mjs --list [--openclaw-root <path>]
  node scripts/openclaw-agent-admin.mjs --feishu-bind --agent <agentId> [--account <accountId>] [--reassign] [--restart] [--openclaw-root <path>]
  node scripts/openclaw-agent-admin.mjs --feishu-unbind --agent <agentId> [--account <accountId>] [--restart] [--openclaw-root <path>]

Options:
  --list                    Print configured agents, Feishu accounts, and route bindings.
  --feishu-bind             Add or verify a Feishu account route binding.
  --feishu-unbind           Remove a Feishu account route binding from an agent.
  --agent <agentId>         Target OpenClaw agent id.
  --account <accountId>     Feishu account id. Defaults to agent id. Use "default" for the default account.
  --reassign                Move an existing Feishu account binding from another agent to --agent.
  --openclaw-root <path>    OpenClaw package/repo root used to resolve SDK config API.
  --restart                 Run OpenClaw gateway restart after config is written.
  --help                    Show this help.

The script prints JSON lines and never prints app secrets.
`.trim();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--list") {
      out.action = setAction(out.action, "list");
      continue;
    }
    if (arg === "--feishu-bind") {
      out.action = setAction(out.action, "feishu-bind");
      continue;
    }
    if (arg === "--feishu-unbind") {
      out.action = setAction(out.action, "feishu-unbind");
      continue;
    }
    if (arg === "--reassign") {
      out.reassign = true;
      continue;
    }
    if (arg === "--restart") {
      out.restart = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    i += 1;
    switch (arg) {
      case "--agent":
        out.agentId = next.trim();
        break;
      case "--account":
        out.accountId = next.trim();
        break;
      case "--openclaw-root":
        out.openclawRoot = path.resolve(next);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (out.help) return out;
  if (!out.action) {
    throw new Error("Choose exactly one action: --list, --feishu-bind, or --feishu-unbind");
  }
  if (out.action !== "list") {
    if (!out.agentId) {
      throw new Error("--agent is required for Feishu binding changes");
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(out.agentId)) {
      throw new Error("--agent must be a stable lowercase OpenClaw agent id");
    }
    out.accountId ||= out.agentId;
  }
  return out;
}

function setAction(current, next) {
  if (current && current !== next) {
    throw new Error("Choose exactly one action");
  }
  return next;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function findOpenClawRoot(explicitRoot) {
  const candidates = [
    explicitRoot,
    process.env.OPENCLAW_ROOT,
    process.cwd(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const packagePath = path.join(candidate, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      if (parsed.name === "openclaw") {
        return path.resolve(candidate);
      }
    } catch {}
  }
  return null;
}

async function importOpenClawConfigRuntime(openclawRoot) {
  const requireFromRoot = createRequire(path.join(openclawRoot, "package.json"));
  let resolved;
  try {
    resolved = requireFromRoot.resolve("openclaw/plugin-sdk/config-runtime");
  } catch (err) {
    throw new Error(
      `Cannot resolve openclaw/plugin-sdk/config-runtime from ${openclawRoot}. ` +
        "Run from a built OpenClaw package/repo, or pass --openclaw-root. " +
        `Original error: ${err?.message || err}`,
    );
  }
  return await import(pathToFileURL(resolved).href);
}

async function readSnapshot(openclawRoot) {
  const runtime = await importOpenClawConfigRuntime(openclawRoot);
  const snapshot = await runtime.readConfigFileSnapshotForWrite();
  return {
    runtime,
    hash: snapshot.hash,
    config: structuredClone(snapshot.sourceConfig ?? snapshot.config ?? {}),
  };
}

function normalizeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function listAgents(cfg) {
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  if (list.length === 0) {
    const id = normalizeId(cfg.agents?.default ?? "main") || "main";
    return [{ id, isDefault: true }];
  }
  const defaultId = normalizeId(cfg.agents?.default ?? list[0]?.id);
  return list
    .map((entry) => ({
      id: normalizeId(entry?.id),
      name: entry?.name,
      workspace: entry?.workspace,
      agentDir: entry?.agentDir,
      isDefault: normalizeId(entry?.id) === defaultId,
    }))
    .filter((entry) => entry.id);
}

function assertAgentExists(cfg, agentId) {
  const normalized = normalizeId(agentId);
  const ids = listAgents(cfg).map((entry) => entry.id);
  if (!ids.includes(normalized)) {
    throw new Error(`Agent "${agentId}" not found. Known agents: ${ids.join(", ") || "(none)"}`);
  }
}

function isRouteBinding(binding) {
  return Boolean(binding?.agentId && binding?.match?.channel);
}

function listRouteBindings(cfg) {
  return Array.isArray(cfg.bindings) ? cfg.bindings.filter(isRouteBinding) : [];
}

function bindingKey(binding) {
  const match = binding.match || {};
  return JSON.stringify([
    match.channel || "",
    match.accountId || "default",
    match.peer?.kind || "",
    match.peer?.id || "",
    match.guildId || "",
    match.teamId || "",
  ]);
}

function feishuBinding(agentId, accountId) {
  return {
    type: "route",
    agentId: normalizeId(agentId),
    match: {
      channel: "feishu",
      ...(accountId && accountId !== "default" ? { accountId } : {}),
    },
  };
}

function listFeishuAccounts(cfg) {
  const feishu = cfg.channels?.feishu;
  if (!feishu || feishu.enabled === false) {
    return [];
  }
  const accounts = [];
  const namedAccounts = feishu.accounts || {};
  if (feishu.appId || feishu.appSecret || Object.keys(namedAccounts).length === 0) {
    accounts.push(summarizeFeishuAccount("default", feishu));
  }
  for (const [accountId, accountCfg] of Object.entries(namedAccounts)) {
    accounts.push(summarizeFeishuAccount(accountId, accountCfg));
  }
  return accounts;
}

function summarizeFeishuAccount(accountId, cfg) {
  return {
    accountId,
    enabled: cfg?.enabled !== false,
    appId: cfg?.appId || null,
    hasAppSecret: Boolean(cfg?.appSecret),
    domain: cfg?.domain || "feishu",
    connectionMode: cfg?.connectionMode || null,
    groupPolicy: cfg?.groupPolicy || null,
    dmPolicy: cfg?.dmPolicy || null,
    allowFromCount: Array.isArray(cfg?.allowFrom) ? cfg.allowFrom.length : 0,
  };
}

function assertFeishuAccountExists(cfg, accountId) {
  const accounts = new Set(listFeishuAccounts(cfg).map((entry) => entry.accountId));
  if (!accounts.has(accountId || "default")) {
    throw new Error(
      `Feishu account "${accountId || "default"}" is not configured. ` +
        `Known Feishu accounts: ${Array.from(accounts).join(", ") || "(none)"}`,
    );
  }
}

function describeBinding(binding) {
  const match = binding.match || {};
  const parts = [match.channel || "(unknown)"];
  if (match.accountId) parts.push(`accountId=${match.accountId}`);
  if (match.peer) parts.push(`peer=${match.peer.kind}:${match.peer.id}`);
  if (match.guildId) parts.push(`guild=${match.guildId}`);
  if (match.teamId) parts.push(`team=${match.teamId}`);
  return parts.join(" ");
}

function inventory(cfg) {
  const routeBindings = listRouteBindings(cfg).map((binding) => ({
    agentId: normalizeId(binding.agentId),
    match: binding.match,
    description: describeBinding(binding),
  }));
  const feishuBindings = routeBindings.filter((binding) => binding.match?.channel === "feishu");
  return {
    event: "inventory",
    agents: listAgents(cfg),
    feishuAccounts: listFeishuAccounts(cfg),
    routeBindings,
    feishuBindings,
  };
}

function patchFeishuBind(cfg, options) {
  assertAgentExists(cfg, options.agentId);
  assertFeishuAccountExists(cfg, options.accountId);
  const desired = feishuBinding(options.agentId, options.accountId);
  const desiredKey = bindingKey(desired);
  const existingBindings = Array.isArray(cfg.bindings) ? [...cfg.bindings] : [];
  const existingIndex = existingBindings.findIndex(
    (binding) => isRouteBinding(binding) && bindingKey(binding) === desiredKey,
  );

  if (existingIndex >= 0) {
    const existing = existingBindings[existingIndex];
    const existingAgentId = normalizeId(existing.agentId);
    if (existingAgentId === normalizeId(options.agentId)) {
      return { config: cfg, action: "skipped", binding: desired };
    }
    if (!options.reassign) {
      const err = new Error(
        `Feishu binding conflict: ${describeBinding(desired)} is already owned by agent "${existingAgentId}"`,
      );
      err.code = "BINDING_CONFLICT";
      err.existingAgentId = existingAgentId;
      throw err;
    }
    existingBindings[existingIndex] = { ...existing, agentId: normalizeId(options.agentId) };
    return {
      config: { ...cfg, bindings: existingBindings },
      action: "reassigned",
      previousAgentId: existingAgentId,
      binding: existingBindings[existingIndex],
    };
  }

  return {
    config: { ...cfg, bindings: [...existingBindings, desired] },
    action: "added",
    binding: desired,
  };
}

function patchFeishuUnbind(cfg, options) {
  assertAgentExists(cfg, options.agentId);
  const desired = feishuBinding(options.agentId, options.accountId);
  const desiredKey = bindingKey(desired);
  const existingBindings = Array.isArray(cfg.bindings) ? [...cfg.bindings] : [];
  const existingIndex = existingBindings.findIndex(
    (binding) => isRouteBinding(binding) && bindingKey(binding) === desiredKey,
  );
  if (existingIndex < 0) {
    return { config: cfg, action: "missing", binding: desired };
  }
  const existing = existingBindings[existingIndex];
  const existingAgentId = normalizeId(existing.agentId);
  if (existingAgentId !== normalizeId(options.agentId)) {
    const err = new Error(
      `Cannot unbind ${describeBinding(desired)} from "${options.agentId}" because it is owned by "${existingAgentId}"`,
    );
    err.code = "BINDING_CONFLICT";
    err.existingAgentId = existingAgentId;
    throw err;
  }
  const nextBindings = existingBindings.filter((_, index) => index !== existingIndex);
  return {
    config: { ...cfg, bindings: nextBindings.length > 0 ? nextBindings : undefined },
    action: "removed",
    binding: existing,
  };
}

function restartGateway(openclawRoot) {
  const cliPath = path.join(openclawRoot, "openclaw.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Cannot restart gateway: ${cliPath} not found`);
  }
  const result = spawnSync(process.execPath, [cliPath, "gateway", "restart"], {
    cwd: openclawRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Gateway restart failed with exit ${result.status}: ${
        (result.stderr || result.stdout || "").trim() || "no output"
      }`,
    );
  }
  return { stdout: result.stdout?.trim() || "" };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const openclawRoot = findOpenClawRoot(options.openclawRoot);
  if (!openclawRoot) {
    throw new Error(
      "Cannot find OpenClaw root. Run this from the OpenClaw repo/package or pass --openclaw-root <path>.",
    );
  }
  const snapshot = await readSnapshot(openclawRoot);

  if (options.action === "list") {
    emit({ ...inventory(snapshot.config), openclawRoot });
    return;
  }

  const result =
    options.action === "feishu-bind"
      ? patchFeishuBind(snapshot.config, options)
      : patchFeishuUnbind(snapshot.config, options);

  if (result.config !== snapshot.config) {
    await snapshot.runtime.replaceConfigFile({
      nextConfig: result.config,
      ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    });
  }

  let restartResult = null;
  if (options.restart) {
    restartResult = restartGateway(openclawRoot);
  }

  emit({
    event: options.action === "feishu-bind" ? "feishu_binding_configured" : "feishu_binding_removed",
    agentId: normalizeId(options.agentId),
    accountId: options.accountId,
    action: result.action,
    previousAgentId: result.previousAgentId,
    binding: result.binding,
    openclawRoot,
    restarted: Boolean(restartResult),
    restartRequired: !restartResult,
  });
}

main().catch((err) => {
  emit({
    event: "error",
    code: err?.code,
    message: String(err?.message || err),
    existingAgentId: err?.existingAgentId,
  });
  process.exitCode = 1;
});
