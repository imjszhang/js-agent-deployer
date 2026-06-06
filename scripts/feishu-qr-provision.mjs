#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10_000;
const SCAN_TO_CREATE_TP = "ob_cli_app";

function usage() {
  return `
Usage:
  node scripts/feishu-qr-provision.mjs --agent <agentId> [options]

Options:
  --account <accountId>        Feishu account id. Defaults to agent id.
  --domain <feishu|lark>       Initial domain. Defaults to feishu.
  --group-policy <policy>      allowlist, open, or disabled. Defaults to allowlist.
  --qr-output-dir <path>       Directory for generated QR PNG/SVG files.
  --qr-only <text>             Only generate QR image files for text; no network/config write.
  --app-id <cli_xxx>           Configure an already-created Feishu/Lark app.
  --app-secret-env <name>      Read existing app secret from an environment variable.
  --app-secret-file <path>     Read existing app secret from a local file.
  --app-secret <secret>        Read existing app secret from argv. Avoid when possible.
  --owner-open-id <open_id>    Optional owner open_id for DM allowlist.
  --openclaw-root <path>       OpenClaw package/repo root used to resolve SDK config API.
  --restart                    Run OpenClaw gateway restart after config is written.
  --bind-only                  Only add/verify Feishu account routing binding; no QR flow.
  --no-bind                    Write channel account only; do not add routing binding.
  --dry-run                    Print QR and poll result, but do not write OpenClaw config.
  --cron-mode                  Run as a cron-managed job: human logs + direct notifications.
  --legacy-mode                Force the original stdout JSON event stream.
  --notify-channel <name>      Channel for --cron-mode operator updates.
  --notify-target <target>     Channel target for --cron-mode operator updates.
  --notify-thread-id <id>      Optional thread/topic id for operator updates.
  --callback-url <url>         Gateway /hooks/wake URL to call on completion/failure.
  --callback-token-env <name>  Read callback bearer token from an environment variable.
  --callback-token-file <path> Read callback bearer token from a local file.
  --callback-token <token>     Read callback bearer token from argv. Avoid when possible.
  --callback-mode <mode>       Wake mode: now or next-heartbeat. Defaults to now.
  --help                       Show this help.

By default the script prints legacy JSON event lines. In --cron-mode, it writes
human-readable logs, sends QR/progress updates through openclaw message, and can
call Gateway /hooks/wake so the main session resumes after the isolated job ends.
`.trim();
}

function parseArgs(argv) {
  const out = {
    domain: "feishu",
    groupPolicy: "allowlist",
    bind: true,
    dryRun: false,
    callbackMode: "now",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--no-bind") {
      out.bind = false;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--restart") {
      out.restart = true;
      continue;
    }
    if (arg === "--bind-only") {
      out.bindOnly = true;
      continue;
    }
    if (arg === "--cron-mode") {
      out.cronMode = true;
      continue;
    }
    if (arg === "--legacy-mode") {
      out.legacyMode = true;
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
      case "--domain":
        out.domain = next.trim();
        break;
      case "--group-policy":
        out.groupPolicy = next.trim();
        break;
      case "--qr-output-dir":
        out.qrOutputDir = path.resolve(next);
        break;
      case "--qr-only":
        out.qrOnly = next;
        break;
      case "--app-id":
        out.appId = next.trim();
        break;
      case "--app-secret-env":
        out.appSecretEnv = next.trim();
        break;
      case "--app-secret-file":
        out.appSecretFile = path.resolve(next);
        break;
      case "--app-secret":
        out.appSecret = next;
        break;
      case "--owner-open-id":
        out.ownerOpenId = next.trim();
        break;
      case "--openclaw-root":
        out.openclawRoot = path.resolve(next);
        break;
      case "--notify-channel":
        out.notifyChannel = next.trim();
        break;
      case "--notify-target":
        out.notifyTarget = next.trim();
        break;
      case "--notify-thread-id":
        out.notifyThreadId = next.trim();
        break;
      case "--callback-url":
        out.callbackUrl = next.trim();
        break;
      case "--callback-token-env":
        out.callbackTokenEnv = next.trim();
        break;
      case "--callback-token-file":
        out.callbackTokenFile = path.resolve(next);
        break;
      case "--callback-token":
        out.callbackToken = next;
        break;
      case "--callback-mode":
        out.callbackMode = next.trim();
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (out.help) return out;
  if (!out.agentId) {
    throw new Error("--agent is required");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(out.agentId)) {
    throw new Error("--agent must be a stable lowercase OpenClaw agent id");
  }
  out.accountId ||= out.agentId;
  if (out.domain !== "feishu" && out.domain !== "lark") {
    throw new Error('--domain must be "feishu" or "lark"');
  }
  if (!["allowlist", "open", "disabled"].includes(out.groupPolicy)) {
    throw new Error('--group-policy must be "allowlist", "open", or "disabled"');
  }
  if (out.cronMode && out.legacyMode) {
    throw new Error("--cron-mode and --legacy-mode cannot be used together");
  }
  if (out.callbackMode !== "now" && out.callbackMode !== "next-heartbeat") {
    throw new Error('--callback-mode must be "now" or "next-heartbeat"');
  }
  if (out.callbackUrl) {
    const tokenSources = [
      out.callbackToken ? "argv" : null,
      out.callbackTokenEnv ? "env" : null,
      out.callbackTokenFile ? "file" : null,
    ].filter(Boolean);
    if (tokenSources.length !== 1) {
      throw new Error(
        "Callback setup requires exactly one token source: --callback-token-env, --callback-token-file, or --callback-token.",
      );
    }
    const parsed = new URL(out.callbackUrl);
    if (parsed.searchParams.has("token") || parsed.searchParams.has("hookToken")) {
      throw new Error("Callback tokens must be sent via Authorization header, not query string");
    }
  }
  out.qrOutputDir ||= path.join(os.tmpdir(), "js-agent-deployer-skill-qrs");
  return out;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function reportEvent(options, event) {
  if (!options.cronMode || options.legacyMode) {
    emit(event);
    return;
  }
  process.stdout.write(`${new Date().toISOString()} ${event.event}: ${summarizeEvent(event)}\n`);
}

function summarizeEvent(event) {
  const safe = { ...event };
  delete safe.qrUrl;
  delete safe.instruction;
  const pairs = Object.entries(safe)
    .filter(([key]) => key !== "event")
    .map(([key, value]) => `${key}=${formatSummaryValue(value)}`);
  return pairs.join(" ") || "ok";
}

function formatSummaryValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function resolveExistingAppRegistration(options) {
  if (!options.appId) {
    return null;
  }
  const secretSources = [
    options.appSecret ? "argv" : null,
    options.appSecretEnv ? "env" : null,
    options.appSecretFile ? "file" : null,
  ].filter(Boolean);
  if (secretSources.length !== 1) {
    throw new Error(
      "Existing app setup requires exactly one secret source: --app-secret-env, --app-secret-file, or --app-secret.",
    );
  }
  let appSecret = options.appSecret;
  if (options.appSecretEnv) {
    appSecret = process.env[options.appSecretEnv];
    if (!appSecret) {
      throw new Error(`Environment variable ${options.appSecretEnv} is empty or missing`);
    }
  }
  if (options.appSecretFile) {
    appSecret = fs.readFileSync(options.appSecretFile, "utf8").trim();
    if (!appSecret) {
      throw new Error(`Secret file ${options.appSecretFile} is empty`);
    }
  }
  return {
    appId: options.appId,
    appSecret,
    domain: options.domain,
    openId: options.ownerOpenId || undefined,
  };
}

function accountsBaseUrl(domain) {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

async function postRegistration(baseUrl, body) {
  const response = await fetch(`${baseUrl}${REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return await response.json();
}

async function initAppRegistration(domain) {
  const res = await postRegistration(accountsBaseUrl(domain), { action: "init" });
  if (!res.supported_auth_methods?.includes("client_secret")) {
    throw new Error("Current Feishu/Lark environment does not support client_secret auth method");
  }
}

async function beginAppRegistration(domain) {
  const res = await postRegistration(accountsBaseUrl(domain), {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  if (!res.device_code || !res.verification_uri_complete) {
    throw new Error(`Feishu registration begin failed: ${res.error || res.error_description || "missing device_code"}`);
  }
  const qrUrl = new URL(res.verification_uri_complete);
  qrUrl.searchParams.set("from", "oc_onboard");
  qrUrl.searchParams.set("tp", SCAN_TO_CREATE_TP);
  return {
    deviceCode: res.device_code,
    qrUrl: qrUrl.toString(),
    userCode: res.user_code,
    interval: res.interval || 5,
    expireIn: res.expire_in || 600,
  };
}

function generateQrArtifacts(text, { outputDir, basename }) {
  const qr = encodeQrVersion5L(text);
  fs.mkdirSync(outputDir, { recursive: true });
  const safeBase = basename.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const pngPath = path.join(outputDir, `${safeBase}.png`);
  const svgPath = path.join(outputDir, `${safeBase}.svg`);
  fs.writeFileSync(pngPath, renderQrPng(qr, { scale: 8, quiet: 4 }));
  fs.writeFileSync(svgPath, renderQrSvg(qr, { quiet: 4 }));
  return { pngPath, svgPath };
}

function encodeQrVersion5L(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 106) {
    throw new Error(
      `QR payload is too long for the bundled generator (${bytes.length} bytes > 106). Send qrUrl fallback or use a shorter URL.`,
    );
  }

  const version = 5;
  const size = 17 + version * 4;
  const dataCodewords = 108;
  const eccCodewords = 26;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = Boolean(dark);
    reserved[y][x] = true;
  };

  drawFinder(modules, reserved, 0, 0);
  drawFinder(modules, reserved, size - 7, 0);
  drawFinder(modules, reserved, 0, size - 7);
  drawAlignment(modules, reserved, 30, 30);

  for (let i = 8; i < size - 8; i += 1) {
    setFunction(i, 6, i % 2 === 0);
    setFunction(6, i, i % 2 === 0);
  }

  // Reserve format areas and dark module.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = size - 8; i < size; i += 1) reserved[8][i] = true;
  for (let i = size - 7; i < size; i += 1) reserved[i][8] = true;
  setFunction(8, 4 * version + 9, true);

  const data = buildQrDataCodewords(bytes, dataCodewords);
  const ecc = reedSolomonCompute(data, eccCodewords);
  const codewords = [...data, ...ecc];
  const bits = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push(((codeword >>> i) & 1) !== 0);
  }

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (reserved[y][x]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex] : false;
        bitIndex += 1;
        modules[y][x] = bit !== ((x + y) % 2 === 0);
      }
    }
    upward = !upward;
  }

  drawFormatBits(modules, reserved, 1, 0);
  return { size, modules };
}

function drawFinder(modules, reserved, left, top) {
  const size = modules.length;
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const xx = left + x;
      const yy = top + y;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      const dark =
        x >= 0 &&
        x <= 6 &&
        y >= 0 &&
        y <= 6 &&
        (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
      modules[yy][xx] = dark;
      reserved[yy][xx] = true;
    }
  }
}

function drawAlignment(modules, reserved, cx, cy) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const dark = Math.max(Math.abs(x), Math.abs(y)) !== 1;
      modules[cy + y][cx + x] = dark;
      reserved[cy + y][cx + x] = true;
    }
  }
}

function buildQrDataCodewords(bytes, dataCodewords) {
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const b of bytes) appendBits(bits, b, 8);
  const capacityBits = dataCodewords * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(false);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | (bits[i + j] ? 1 : 0);
    codewords.push(value);
  }
  for (let pad = 0xec; codewords.length < dataCodewords; pad = pad === 0xec ? 0x11 : 0xec) {
    codewords.push(pad);
  }
  return codewords;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push(((value >>> i) & 1) !== 0);
}

function reedSolomonCompute(data, degree) {
  const divisor = reedSolomonGenerator(degree);
  const result = Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= gfMultiply(divisor[i + 1], factor);
    }
  }
  return result;
}

function reedSolomonGenerator(degree) {
  let result = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array(result.length + 1).fill(0);
    for (let j = 0; j < result.length; j += 1) {
      next[j] ^= result[j];
      next[j + 1] ^= gfMultiply(result[j], gfPow(2, i));
    }
    result = next;
  }
  return result;
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function gfPow(x, power) {
  let result = 1;
  for (let i = 0; i < power; i += 1) result = gfMultiply(result, x);
  return result;
}

function drawFormatBits(modules, reserved, eccLevelFormatBits, mask) {
  const size = modules.length;
  const data = (eccLevelFormatBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((rem >>> i) & 1) !== 0) rem ^= 0x537 << (i - 10);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function renderQrSvg(qr, { quiet = 4 } = {}) {
  const outSize = qr.size + quiet * 2;
  const commands = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.modules[y][x]) commands.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outSize} ${outSize}" shape-rendering="crispEdges">`,
    `<rect width="${outSize}" height="${outSize}" fill="#fff"/>`,
    `<path d="${commands.join("")}" fill="#000"/>`,
    "</svg>",
    "",
  ].join("\n");
}

function renderQrPng(qr, { scale = 8, quiet = 4 } = {}) {
  const modules = qr.size + quiet * 2;
  const width = modules * scale;
  const raw = Buffer.alloc((width + 1) * width);
  for (let y = 0; y < width; y += 1) {
    const rowStart = y * (width + 1);
    raw[rowStart] = 0;
    const moduleY = Math.floor(y / scale) - quiet;
    for (let x = 0; x < width; x += 1) {
      const moduleX = Math.floor(x / scale) - quiet;
      const dark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < qr.size &&
        moduleY < qr.size &&
        qr.modules[moduleY][moduleX];
      raw[rowStart + 1 + x] = dark ? 0 : 255;
    }
  }
  return Buffer.concat([
    pngSignature(),
    pngChunk("IHDR", pngIhdr(width, width)),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngSignature() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function pngIhdr(width, height) {
  const buf = Buffer.alloc(13);
  buf.writeUInt32BE(width, 0);
  buf.writeUInt32BE(height, 4);
  buf[8] = 8;
  buf[9] = 0;
  buf[10] = 0;
  buf[11] = 0;
  buf[12] = 0;
  return buf;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pollAppRegistration({ deviceCode, interval, expireIn, initialDomain, report }) {
  let currentInterval = interval;
  let domain = initialDomain;
  let domainSwitched = false;
  const deadline = Date.now() + expireIn * 1000;
  while (Date.now() < deadline) {
    let pollRes;
    try {
      pollRes = await postRegistration(accountsBaseUrl(domain), {
        action: "poll",
        device_code: deviceCode,
        tp: SCAN_TO_CREATE_TP,
      });
    } catch (err) {
      report({ event: "poll_retry", reason: String(err?.message || err) });
      await sleep(currentInterval * 1000);
      continue;
    }

    const tenantBrand = pollRes.user_info?.tenant_brand;
    if (!domainSwitched && tenantBrand === "lark") {
      domain = "lark";
      domainSwitched = true;
      continue;
    }

    if (pollRes.client_id && pollRes.client_secret) {
      return {
        status: "success",
        result: {
          appId: pollRes.client_id,
          appSecret: pollRes.client_secret,
          domain,
          openId: pollRes.user_info?.open_id,
        },
      };
    }

    if (pollRes.error === "authorization_pending") {
      report({ event: "poll_pending" });
    } else if (pollRes.error === "slow_down") {
      currentInterval += 5;
      report({ event: "poll_slow_down", interval: currentInterval });
    } else if (pollRes.error === "access_denied") {
      return { status: "access_denied" };
    } else if (pollRes.error === "expired_token") {
      return { status: "expired" };
    } else if (pollRes.error) {
      return {
        status: "error",
        message: `${pollRes.error}: ${pollRes.error_description || "unknown"}`,
      };
    }

    await sleep(currentInterval * 1000);
  }
  return { status: "timeout" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function readOpenClawConfigSnapshot(runtime) {
  const result = await runtime.readConfigFileSnapshotForWrite();
  const snapshot = result?.snapshot ?? result;
  const writeOptions = result?.writeOptions;
  const baseConfig = snapshot?.sourceConfig ?? snapshot?.runtimeConfig ?? snapshot?.config ?? {};
  return {
    snapshot,
    writeOptions,
    baseConfig: structuredClone(baseConfig),
  };
}

async function replaceOpenClawConfig(runtime, readResult, nextConfig) {
  await runtime.replaceConfigFile({
    nextConfig,
    snapshot: readResult.snapshot,
    writeOptions: readResult.writeOptions,
    ...(readResult.snapshot?.hash !== undefined ? { baseHash: readResult.snapshot.hash } : {}),
  });
}

function patchFeishuConfig(cfg, accountId, registration, groupPolicy) {
  const next = structuredClone(cfg);
  next.channels ||= {};
  const feishu = (next.channels.feishu = {
    ...(next.channels.feishu || {}),
    enabled: true,
  });

  const patch = {
    enabled: true,
    appId: registration.appId,
    appSecret: registration.appSecret,
    connectionMode: "websocket",
    domain: registration.domain,
    groupPolicy,
  };
  if (groupPolicy === "open") {
    patch.requireMention = true;
  }
  if (registration.openId) {
    patch.dmPolicy = "allowlist";
    patch.allowFrom = [registration.openId];
  }

  if (!accountId || accountId === "default") {
    Object.assign(feishu, patch);
  } else {
    feishu.accounts ||= {};
    const existingAccount =
      feishu.accounts[accountId] && typeof feishu.accounts[accountId] === "object"
        ? feishu.accounts[accountId]
        : {};
    feishu.accounts[accountId] = {
      ...existingAccount,
      ...patch,
    };
  }
  return next;
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

function addFeishuBinding(cfg, agentId, accountId) {
  const next = structuredClone(cfg);
  assertAgentExists(next, agentId);
  const binding = {
    agentId,
    match: {
      channel: "feishu",
      ...(accountId && accountId !== "default" ? { accountId } : {}),
    },
  };
  const desiredKey = bindingKey(binding);
  const existing = Array.isArray(next.bindings) ? next.bindings : [];
  for (const candidate of existing) {
    if (bindingKey(candidate) !== desiredKey) continue;
    if (candidate.agentId === agentId) {
      return { config: next, action: "skipped" };
    }
    throw new Error(
      `Feishu account binding conflict: ${JSON.stringify(binding.match)} is already owned by agent "${candidate.agentId}"`,
    );
  }
  next.bindings = [...existing, binding];
  return { config: next, action: "added" };
}

function normalizeId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function listConfiguredAgentIds(cfg) {
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  if (list.length === 0) {
    return [normalizeId(cfg.agents?.default ?? "main") || "main"];
  }
  return list.map((entry) => normalizeId(entry?.id)).filter(Boolean);
}

function assertAgentExists(cfg, agentId) {
  const normalized = normalizeId(agentId);
  const ids = listConfiguredAgentIds(cfg);
  if (!ids.includes(normalized)) {
    throw new Error(
      `Cannot bind Feishu account to agent "${agentId}" because it is not present in agents.list. ` +
        `Known agents: ${ids.join(", ") || "(none)"}`,
    );
  }
}

function bindingSummary(agentId, accountId) {
  return {
    agentId,
    match: {
      channel: "feishu",
      ...(accountId && accountId !== "default" ? { accountId } : {}),
    },
  };
}

async function writeOpenClawConfig(options, registration) {
  const openclawRoot = findOpenClawRoot(options.openclawRoot);
  if (!openclawRoot) {
    throw new Error(
      "Cannot find OpenClaw root. Run this from the OpenClaw repo/package or pass --openclaw-root <path>.",
    );
  }
  const runtime = await importOpenClawConfigRuntime(openclawRoot);
  const readResult = await readOpenClawConfigSnapshot(runtime);
  let next = patchFeishuConfig(
    readResult.baseConfig,
    options.accountId,
    registration,
    options.groupPolicy,
  );
  let bindingAction = "not_requested";
  if (options.bind) {
    const result = addFeishuBinding(next, options.agentId, options.accountId);
    next = result.config;
    bindingAction = result.action;
  }
  await replaceOpenClawConfig(runtime, readResult, next);
  return { openclawRoot, bindingAction };
}

async function writeBindingOnly(options) {
  const openclawRoot = findOpenClawRoot(options.openclawRoot);
  if (!openclawRoot) {
    throw new Error(
      "Cannot find OpenClaw root. Run this from the OpenClaw repo/package or pass --openclaw-root <path>.",
    );
  }
  const runtime = await importOpenClawConfigRuntime(openclawRoot);
  const readResult = await readOpenClawConfigSnapshot(runtime);
  const result = addFeishuBinding(readResult.baseConfig, options.agentId, options.accountId);
  await replaceOpenClawConfig(runtime, readResult, result.config);
  return { openclawRoot, bindingAction: result.action };
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
  return {
    stdout: result.stdout?.trim() || "",
  };
}

function resolveCallbackToken(options) {
  let token = options.callbackToken;
  if (options.callbackTokenEnv) {
    token = process.env[options.callbackTokenEnv];
    if (!token) {
      throw new Error(`Environment variable ${options.callbackTokenEnv} is empty or missing`);
    }
  }
  if (options.callbackTokenFile) {
    token = fs.readFileSync(options.callbackTokenFile, "utf8").trim();
    if (!token) {
      throw new Error(`Callback token file ${options.callbackTokenFile} is empty`);
    }
  }
  return token;
}

function openClawCliPath(options) {
  const openclawRoot = findOpenClawRoot(options.openclawRoot);
  if (!openclawRoot) {
    throw new Error(
      "Cannot find OpenClaw root. Run this from the OpenClaw repo/package or pass --openclaw-root <path>.",
    );
  }
  const cliPath = path.join(openclawRoot, "openclaw.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Cannot find OpenClaw CLI at ${cliPath}`);
  }
  return { openclawRoot, cliPath };
}

function notifyOperator(options, { message, media }) {
  if (!options.cronMode || !options.notifyChannel || !options.notifyTarget) {
    return { skipped: true };
  }
  const { openclawRoot, cliPath } = openClawCliPath(options);
  const args = [
    cliPath,
    "message",
    "send",
    "--channel",
    options.notifyChannel,
    "--target",
    options.notifyTarget,
  ];
  if (message) args.push("--message", message);
  if (media) args.push("--media", media);
  if (options.notifyThreadId) args.push("--thread-id", options.notifyThreadId);
  const result = spawnSync(process.execPath, args, {
    cwd: openclawRoot,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Operator notification failed with exit ${result.status}: ${
        (result.stderr || result.stdout || "").trim() || "no output"
      }`,
    );
  }
  return { skipped: false };
}

function notifyOperatorSafely(options, payload, report) {
  try {
    const result = notifyOperator(options, payload);
    if (!result.skipped) {
      report({ event: "notification_sent" });
    }
    return result;
  } catch (err) {
    report({ event: "notification_failed", message: String(err?.message || err) });
    return { skipped: false, failed: true };
  }
}

function callbackText(payload) {
  const safePayload = {
    status: payload.status,
    event: payload.event,
    agentId: payload.agentId,
    accountId: payload.accountId,
    domain: payload.domain,
    binding: payload.binding,
    restarted: payload.restarted,
    restartRequired: payload.restartRequired,
    message: payload.message,
  };
  return `OpenClaw deployer QR provisioning result: ${JSON.stringify(safePayload)}`;
}

async function wakeGateway(options, payload) {
  if (!options.callbackUrl) {
    return { skipped: true };
  }
  const token = resolveCallbackToken(options);
  const response = await fetch(options.callbackUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: callbackText(payload),
      mode: options.callbackMode,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gateway wake callback failed with HTTP ${response.status}: ${body || response.statusText}`);
  }
  return { skipped: false };
}

async function finishWithCallback(options, payload, report) {
  try {
    const result = await wakeGateway(options, payload);
    if (!result.skipped) {
      report({ event: "callback_sent", callbackUrl: options.callbackUrl });
    }
  } catch (err) {
    report({ event: "callback_failed", message: String(err?.message || err) });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = (event) => reportEvent(options, event);
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.qrOnly) {
    const qrArtifacts = generateQrArtifacts(options.qrOnly, {
      outputDir: options.qrOutputDir,
      basename: `${options.agentId}-${options.accountId}-qr-only-${Date.now()}`,
    });
    report({
      event: "qr_only",
      qrUrl: options.qrOnly,
      qrImagePath: qrArtifacts.pngPath,
      qrSvgPath: qrArtifacts.svgPath,
      qrImageMime: "image/png",
    });
    notifyOperatorSafely(options, {
      message: `Feishu/Lark QR image generated for agent ${options.agentId}. Scan this image in the mobile app.`,
      media: qrArtifacts.pngPath,
    }, report);
    return;
  }

  if (options.bindOnly) {
    const writeResult = await writeBindingOnly(options);
    let restartResult = null;
    if (options.restart) {
      restartResult = restartGateway(writeResult.openclawRoot);
    }
    const event = {
      event: "binding_configured",
      agentId: options.agentId,
      accountId: options.accountId,
      openclawRoot: writeResult.openclawRoot,
      binding: writeResult.bindingAction,
      bindingRule: bindingSummary(options.agentId, options.accountId),
      restarted: Boolean(restartResult),
      restartRequired: !restartResult,
    };
    report(event);
    notifyOperatorSafely(options, {
      message: `Feishu/Lark binding configured for agent ${options.agentId} and account ${options.accountId}.`,
    }, report);
    await finishWithCallback(options, { ...event, status: "success" }, report);
    return;
  }

  const existingRegistration = resolveExistingAppRegistration(options);
  if (existingRegistration) {
    if (options.dryRun) {
      report({
        event: "existing_app_dry_run",
        agentId: options.agentId,
        accountId: options.accountId,
        appId: existingRegistration.appId,
        domain: existingRegistration.domain,
        bind: options.bind,
      });
      return;
    }
    const writeResult = await writeOpenClawConfig(options, existingRegistration);
    let restartResult = null;
    if (options.restart) {
      restartResult = restartGateway(writeResult.openclawRoot);
    }
    const event = {
      event: "configured_existing_app",
      agentId: options.agentId,
      accountId: options.accountId,
      appId: existingRegistration.appId,
      domain: existingRegistration.domain,
      openclawRoot: writeResult.openclawRoot,
      binding: writeResult.bindingAction,
      bindingRule: bindingSummary(options.agentId, options.accountId),
      restarted: Boolean(restartResult),
      restartRequired: !restartResult,
    };
    report(event);
    notifyOperatorSafely(options, {
      message: `Existing Feishu/Lark app configured for agent ${options.agentId} and account ${options.accountId}.`,
    }, report);
    await finishWithCallback(options, { ...event, status: "success" }, report);
    return;
  }

  report({
    event: "start",
    agentId: options.agentId,
    accountId: options.accountId,
    domain: options.domain,
    bind: options.bind,
    dryRun: options.dryRun,
  });

  await initAppRegistration(options.domain);
  const begin = await beginAppRegistration(options.domain);
  const qrArtifacts = generateQrArtifacts(begin.qrUrl, {
    outputDir: options.qrOutputDir,
    basename: `${options.agentId}-${options.accountId}-${Date.now()}`,
  });
  report({
    event: "qr",
    qrUrl: begin.qrUrl,
    qrImagePath: qrArtifacts.pngPath,
    qrSvgPath: qrArtifacts.svgPath,
    qrImageMime: "image/png",
    userCode: begin.userCode,
    expiresInSeconds: begin.expireIn,
    instruction: "Send qrImagePath as an image attachment through the current chat channel. Use qrUrl only as a fallback. Keep this process running while the operator scans and approves.",
  });
  notifyOperatorSafely(options, {
    message:
      `Scan this Feishu/Lark QR code to create the app for OpenClaw agent ${options.agentId}. ` +
      `It expires in ${begin.expireIn} seconds. If the image fails to render, open this fallback URL: ${begin.qrUrl}`,
    media: qrArtifacts.pngPath,
  }, report);

  const outcome = await pollAppRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    initialDomain: options.domain,
    report,
  });

  if (outcome.status !== "success") {
    const event = { event: "failed", status: outcome.status, message: outcome.message };
    report(event);
    notifyOperatorSafely(options, {
      message: `Feishu/Lark QR provisioning for agent ${options.agentId} failed: ${outcome.status}${
        outcome.message ? ` (${outcome.message})` : ""
      }.`,
    }, report);
    await finishWithCallback(options, { ...event, agentId: options.agentId, accountId: options.accountId }, report);
    process.exitCode = 1;
    return;
  }

  report({
    event: "scan_success",
    appId: outcome.result.appId,
    domain: outcome.result.domain,
    openId: outcome.result.openId || null,
  });
  notifyOperatorSafely(options, {
    message: `Feishu/Lark scan approved for agent ${options.agentId}. Writing OpenClaw channel config now.`,
  }, report);

  if (options.dryRun) {
    const event = { event: "dry_run_complete", agentId: options.agentId, accountId: options.accountId, status: "success" };
    report(event);
    await finishWithCallback(options, event, report);
    return;
  }

  const writeResult = await writeOpenClawConfig(options, outcome.result);
  let restartResult = null;
  if (options.restart) {
    restartResult = restartGateway(writeResult.openclawRoot);
  }
  const event = {
    event: "configured",
    agentId: options.agentId,
    accountId: options.accountId,
    domain: outcome.result.domain,
    openclawRoot: writeResult.openclawRoot,
    binding: writeResult.bindingAction,
    bindingRule: bindingSummary(options.agentId, options.accountId),
    restarted: Boolean(restartResult),
    restartRequired: !restartResult,
  };
  report(event);
  notifyOperatorSafely(options, {
    message:
      `Feishu/Lark provisioning finished for agent ${options.agentId}. ` +
      `Account ${options.accountId} is configured; binding ${writeResult.bindingAction}; ` +
      (restartResult ? "gateway restarted." : "gateway restart is still required."),
  }, report);
  await finishWithCallback(options, { ...event, status: "success" }, report);
}

main().catch(async (err) => {
  if (process.argv.includes("--cron-mode") && !process.argv.includes("--legacy-mode")) {
    const message = String(err?.message || err);
    process.stderr.write(`error: ${message}\n`);
    try {
      const options = parseArgs(process.argv.slice(2));
      const report = (event) => reportEvent(options, event);
      await finishWithCallback(
        options,
        {
          event: "error",
          status: "error",
          agentId: options.agentId,
          accountId: options.accountId,
          message,
        },
        report,
      );
    } catch (callbackErr) {
      process.stderr.write(`callback_error: ${String(callbackErr?.message || callbackErr)}\n`);
    }
  } else {
    emit({ event: "error", message: String(err?.message || err) });
  }
  process.exitCode = 1;
});
