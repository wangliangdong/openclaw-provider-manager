/**
 * openclaw-provider-manager — small web tool to manage OpenClaw custom model
 * providers through the Gateway admin HTTP RPC (never by editing
 * openclaw.json, never by mounting docker.sock).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { GatewayClient, GatewayError } from './lib/gateway.js';
import { discoverModels, probeProvider, DiscoveryError, normalizeBaseUrl } from './lib/discovery.js';
import { KeyStore, KeyStoreError } from './lib/keystore.js';
import {
  REDACTED,
  buildProviderPatch,
  buildProviderDeletePatch,
  listProviders,
  normalizeModels,
  parseRawConfig,
  sanitizePatch,
  validateProviderId,
  isStaleHashError,
} from './lib/config-ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.PM_PORT || 8891);
const BIND = process.env.PM_BIND || '0.0.0.0';
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://openclaw-gateway:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const ADMIN_TOKEN = process.env.PM_ADMIN_TOKEN || '';
const VAULT_DIR = process.env.PM_VAULT_DIR || '/data';
const VAULT_KEY = process.env.PM_VAULT_KEY || '';
const COOKIE_NAME = 'pm_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (!GATEWAY_TOKEN) {
  console.error('[fatal] OPENCLAW_GATEWAY_TOKEN is required');
  process.exit(1);
}

const gateway = new GatewayClient({ baseUrl: GATEWAY_URL, token: GATEWAY_TOKEN });

/**
 * Optional encrypted key store (see lib/keystore.js).
 *
 * Without it, an EXISTING provider's model list can never be refreshed:
 * `config.get` redacts the stored key, and the gateway exposes no RPC that
 * would run discovery for us. It is optional on purpose — when the master key
 * is absent the vault stays disabled and every other feature still works.
 */
const keystore = new KeyStore({ dir: VAULT_DIR, keyBase64: VAULT_KEY });

/* ------------------------------------------------------------------ auth --- */

const signingKey = crypto
  .createHash('sha256')
  .update(`pm-session:${ADMIN_TOKEN || GATEWAY_TOKEN}`)
  .digest();

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', signingKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', signingKey).update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!ADMIN_TOKEN) return true; // auth disabled
  const hdr = String(req.headers.authorization || '');
  if (hdr.toLowerCase().startsWith('bearer ') && safeEqual(hdr.slice(7).trim(), ADMIN_TOKEN)) return true;
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}

/* --------------------------------------------------------------- helpers --- */

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function fail(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message, ...extra });
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
    return parsed;
  } catch (err) {
    throw new Error(`请求体解析失败: ${err.message}`);
  }
}

/** Read providers straight from the Gateway (single source of truth). */
async function fetchProviders() {
  const payload = await gateway.call('config.get', {});
  return {
    providers: listProviders(payload),
    configPath: payload?.path ?? null,
    hash: payload?.hash ?? null,
  };
}

/** Look up one stored provider entry (raw), and the current config hash. */
async function readProvider(id) {
  const payload = await gateway.call('config.get', {});
  const cfg = parseRawConfig(payload);
  const entry = cfg?.models?.providers?.[id] ?? null;
  return { entry, hash: payload?.hash ?? null, payload };
}

/**
 * Resolve the plaintext key used for an upstream call, in priority order:
 *
 *   1. `supplied` — typed into the UI for this one call (never persisted)
 *   2. config    — plaintext in config; not reachable today, since `config.get`
 *                  always returns the sentinel. Kept so a future gateway that
 *                  stops redacting starts working here with no change.
 *   3. vault     — our own encrypted store, when the owner opted in
 *
 * Returns `{apiKey, source}` where source is
 * `provided` | `stored` | `vault` | `redacted` | `missing`.
 *
 * `redacted` and `missing` both yield an empty key but mean opposite things:
 * the gateway holds a usable key vs. nothing is configured at all. Callers
 * must not report the former as a failure — see the `/api/test` handler.
 */
async function resolveApiKey(id, supplied) {
  if (supplied) return { apiKey: supplied, source: 'provided' };

  let sawSentinel = false;
  try {
    const { entry } = await readProvider(id);
    const stored = entry?.apiKey;
    if (typeof stored === 'string' && stored && stored !== REDACTED) {
      return { apiKey: stored, source: 'stored' };
    }
    sawSentinel = stored === REDACTED;
  } catch { /* fall through to the vault */ }

  if (keystore.enabled) {
    // Let a decrypt failure propagate: a tampered entry must be visible, not
    // silently downgraded to "no key configured".
    const fromVault = await keystore.get(id);
    if (fromVault) return { apiKey: fromVault, source: 'vault' };
  }

  return { apiKey: '', source: sawSentinel ? 'redacted' : 'missing' };
}

/**
 * Apply a provider patch, re-reading the config hash first and retrying once if
 * the gateway reports that the config moved underneath us.
 */
async function applyPatch({ raw, replacePaths }, { attempts = 3 } = {}) {
  const clean = sanitizePatch(raw);
  let lastErr = null;

  for (let i = 0; i < attempts; i += 1) {
    const payload = await gateway.call('config.get', {});
    const baseHash = payload?.hash;
    if (!baseHash) throw new GatewayError('config.get 未返回 hash，无法安全写入', { code: 'NO_HASH' });

    try {
      const result = await gateway.call(
        'config.patch',
        { raw: JSON.stringify(clean), baseHash, replacePaths },
        { timeoutMs: 30_000 },
      );
      return { result, replaced: replacePaths ?? [] };
    } catch (err) {
      lastErr = err;
      if (isStaleHashError(err) && i < attempts - 1) continue; // config moved; retry
      throw err;
    }
  }
  throw lastErr;
}

/* ----------------------------------------------------------------- routes --- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..')) return fail(res, 400, '非法路径');
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return fail(res, 400, '非法路径');
  fs.readFile(full, (err, data) => {
    if (err) return fail(res, 404, '未找到');
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

async function handleApi(req, res, urlPath) {
  const method = req.method || 'GET';

  if (urlPath === '/api/login' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!ADMIN_TOKEN) return sendJson(res, 200, { ok: true, authRequired: false });
    if (!safeEqual(body.token || '', ADMIN_TOKEN)) return fail(res, 401, '管理令牌不正确');
    const token = signSession({ exp: Date.now() + SESSION_TTL_MS });
    return sendJson(res, 200, { ok: true, authRequired: true }, {
      'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    });
  }

  if (urlPath === '/api/session' && method === 'GET') {
    return sendJson(res, 200, { ok: true, authRequired: Boolean(ADMIN_TOKEN), authed: isAuthed(req) });
  }

  if (!isAuthed(req)) return fail(res, 401, '未认证');

  if (urlPath === '/api/status' && method === 'GET') {
    const info = { gatewayUrl: gateway.baseUrl, endpoint: gateway.endpoint };
    try {
      const probe = await gateway.probe();
      info.gatewayOk = probe.ok;
      info.latencyMs = probe.latencyMs;
    } catch (err) {
      info.gatewayOk = false;
      info.gatewayError = err.message;
    }
    return sendJson(res, 200, { ok: true, ...info });
  }

  if (urlPath === '/api/providers' && method === 'GET') {
    const { providers, configPath, hash } = await fetchProviders();
    return sendJson(res, 200, { ok: true, providers, configPath, hash });
  }

  if (urlPath === '/api/discover' && method === 'POST') {
    const body = await readJsonBody(req);
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const api = String(body.api || 'openai-completions');

    // A typed key wins; otherwise fall back to config/vault so a SAVED provider
    // can refresh its model list without re-entering the key.
    const supplied = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const providerId = body.providerId ? validateProviderId(body.providerId) : null;
    const resolved = providerId
      ? await resolveApiKey(providerId, supplied)
      : { apiKey: supplied, source: supplied ? 'provided' : 'missing' };

    // Report WHICH key we used even when discovery fails. The two 401 cases
    // need opposite fixes and are indistinguishable from the message alone:
    //   source=vault   -> the stored key was rejected; re-enter and re-save it
    //   source=redacted-> there was no usable key at all; enable the vault
    // So the source travels with the error, not only with the success.
    try {
      const found = await discoverModels({ baseUrl, apiKey: resolved.apiKey, api });
      return sendJson(res, 200, { ok: true, ...found, keySource: resolved.source });
    } catch (err) {
      if (!(err instanceof DiscoveryError)) throw err;
      return fail(res, 400, err.message, {
        detail: err.detail,
        status: err.status ?? null,
        keySource: resolved.source,
      });
    }
  }

  /* ----------------------------------------------------------- vault --- */
  /**
   * Encrypted key store. WRITE-ONLY by design: no route ever returns a stored
   * secret. `GET` exposes metadata only (which providers are stored, when).
   */
  if (urlPath === '/api/vault' && method === 'GET') {
    return sendJson(res, 200, { ok: true, enabled: keystore.enabled, reason: keystore.reason, entries: await keystore.list() });
  }

  if (urlPath === '/api/vault' && (method === 'POST' || method === 'PUT')) {
    const body = await readJsonBody(req);
    const id = validateProviderId(body.id);
    if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
      return fail(res, 400, '密钥不能为空');
    }
    const meta = await keystore.set(id, body.apiKey.trim());
    return sendJson(res, 200, { ok: true, entry: meta });
  }

  const vaultMatch = urlPath.match(/^\/api\/vault\/([^/]+)$/);
  if (vaultMatch && method === 'DELETE') {
    const id = validateProviderId(decodeURIComponent(vaultMatch[1]));
    const removed = await keystore.delete(id);
    if (!removed) return fail(res, 404, `密钥库中没有「${id}」的密钥`);
    return sendJson(res, 200, { ok: true });
  }

  if (urlPath === '/api/providers' && (method === 'POST' || method === 'PUT')) {
    const body = await readJsonBody(req);

    // Read the stored entry first so per-model metadata survives the array
    // replacement that `replacePaths` performs (see mergeModelEntries).
    const { entry: existing } = await readProvider(validateProviderId(body.id));
    const existingModels = Array.isArray(existing?.models) ? existing.models : [];

    const patch = buildProviderPatch({
      id: body.id,
      baseUrl: body.baseUrl,
      api: body.api,
      apiKey: body.apiKey,
      models: body.models,
      existingModels,
    });
    const applied = await applyPatch(patch);
    const { providers } = await fetchProviders();
    return sendJson(res, 200, {
      ok: true,
      noop: applied.result?.noop === true,
      replacePaths: applied.replaced,
      // Which selected models kept stored metadata (shown in the UI).
      preserved: patch.preserved,
      providers,
    });
  }

  const delMatch = urlPath.match(/^\/api\/providers\/([^/]+)$/);
  if (delMatch && method === 'DELETE') {
    const id = validateProviderId(decodeURIComponent(delMatch[1]));

    // Reject unknown ids instead of reporting a hollow success: deleting a
    // missing provider otherwise returns ok:true/noop:true and looks like it
    // worked.
    const { entry } = await readProvider(id);
    if (!entry) return fail(res, 404, `未找到 Provider: ${id}`);

    const patch = buildProviderDeletePatch(id);
    const applied = await applyPatch(patch);
    const { providers } = await fetchProviders();
    return sendJson(res, 200, { ok: true, noop: applied.result?.noop === true, providers });
  }

  /**
   * Provider connection test.
   *
   * `models.probe` is NOT on the admin HTTP allowlist, and `models.list` only
   * echoes what is DECLARED in config (its `available` flag is not a liveness
   * check — a provider pointing at a dead host still reports every model
   * available). So this endpoint probes the upstream endpoint directly.
   *
   * An authenticated probe needs the plaintext key, which `config.get` never
   * returns (it yields the redaction sentinel; no option reveals it). So when
   * the caller supplies no key we report reachability only — a 401 then proves
   * the host answered, it does NOT prove the provider is misconfigured.
   *
   * `keyState` distinguishes the two reasons a key may be missing, because they
   * mean opposite things: `redacted` = a key IS stored but unusable here (fine,
   * the gateway still has it); `missing` = no key configured at all (a real
   * setup error). The UI must not present the former as a failure.
   */
  if (urlPath === '/api/test' && method === 'POST') {
    const body = await readJsonBody(req);
    const id = validateProviderId(body.id);

    const { providers } = await fetchProviders();
    const provider = providers.find((p) => p.id === id);
    if (!provider) return fail(res, 404, `未找到 Provider: ${id}`);

    const supplied = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const { apiKey, source: keyState } = await resolveApiKey(id, supplied);

    const probe = await probeProvider({ baseUrl: provider.baseUrl, apiKey, api: provider.api });

    // Gateway registry view (declaration only) — useful context, not liveness.
    let registered = 0;
    try {
      const listed = await gateway.call('models.list', {});
      registered = (listed?.models ?? []).filter((m) => m?.provider === id).length;
    } catch { /* best effort */ }

    // `source` keeps its old vocabulary for callers that predate keyState; the
    // vault is an authenticated source, so it maps to the same bucket as a
    // freshly typed key.
    const keySource = keyState === 'stored' ? 'stored' : keyState === 'redacted' || keyState === 'missing' ? 'hidden' : 'provided';

    return sendJson(res, 200, {
      ok: true,
      provider: id,
      endpoint: probe.endpoint,
      reachable: probe.reachable,
      authorized: probe.authorized,
      upstreamModels: probe.count,
      models: probe.models,
      status: probe.status,
      registered,
      keySource,
      keyState,
      // A 401 while the key is merely redacted is expected, not a fault.
      authenticated: probe.authorized,
      verificationSkipped: keyState === 'redacted' && !probe.authorized,
      error: keyState === 'redacted' && !probe.authorized ? null : probe.error,
    });
  }

  return fail(res, 404, '未知接口');
}

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url || '/', 'http://localhost').pathname;

  try {
    if (urlPath.startsWith('/api/')) {
      await handleApi(req, res, urlPath);
      return;
    }
    // Static assets are not sensitive; every /api/ route above stays gated.
    serveStatic(req, res, urlPath);
  } catch (err) {
    if (err instanceof DiscoveryError) return fail(res, 400, err.message, { detail: err.detail });
    if (err instanceof KeyStoreError) {
      // A corrupt/tampered vault or a missing master key is a server-side
      // condition, not a bad request — surface it as such.
      const status = err.code === 'DISABLED' ? 503 : err.code === 'EMPTY' || err.code === 'BAD_KEY' ? 400 : 500;
      return fail(res, status, `密钥库错误：${err.message}`, { code: err.code });
    }
    if (err instanceof GatewayError) {
      const missingScope = /missing scope/i.test(String(err.message || ''));
      const status = missingScope ? 403 : err.httpStatus && err.httpStatus < 500 ? err.httpStatus : 502;
      return fail(res, status, `Gateway 调用失败: ${err.message}`, { code: err.code, detail: err.details });
    }
    console.error('[error]', err);
    return fail(res, 400, err?.message || '内部错误');
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[openclaw-provider-manager] listening on http://${BIND}:${PORT}`);
  console.log(`[openclaw-provider-manager] gateway=${gateway.endpoint} auth=${ADMIN_TOKEN ? 'admin-token' : 'disabled'}`);
  console.log(
    keystore.enabled
      ? `[openclaw-provider-manager] vault=enabled dir=${VAULT_DIR}`
      : `[openclaw-provider-manager] vault=disabled（${keystore.reason}）`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
