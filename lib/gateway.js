/**
 * OpenClaw Gateway admin HTTP RPC client.
 *
 * Transport (verified live against OpenClaw 2026.9.4, 3a9d69d):
 *
 *   POST {baseUrl}/api/v1/admin/rpc
 *   Authorization: Bearer <gateway token>
 *   Content-Type: application/json
 *   body: { id?, method, params }
 *   ->    { id, ok: true,  payload }
 *         { id, ok: false, error: { code, message } }
 *
 * Only methods on the bundled plugin allowlist are accepted (config.*,
 * models.list, models.authStatus, agents.*, cron.*, ...). Anything else comes
 * back as INVALID_REQUEST "admin HTTP RPC method is not supported: <method>".
 *
 * WHY HTTP AND NOT WEBSOCKET — do not "fix" this back to WebSocket:
 * A shared-secret (token) WebSocket connection is only granted operator scopes
 * when it arrives over loopback. From another container on the docker network
 * the token authenticates but the granted scope set is EMPTY, so every
 * `config.get` / `config.patch` / `models.list` fails with
 * "missing scope: operator.read". The admin HTTP endpoint resolves the bearer
 * token through the HTTP shared-secret path, which grants the CLI default
 * operator scopes regardless of source network. Hence all privileged calls here
 * go over HTTP.
 */

export const RPC_PATH = '/api/v1/admin/rpc';
export const DEFAULT_TIMEOUT_MS = 30_000;

export class GatewayError extends Error {
  constructor(message, { code, httpStatus, details } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** Convert a ws(s):// or http(s):// gateway URL into the HTTP(s) origin. */
export function normalizeGatewayUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new GatewayError('Gateway URL 为空', { code: 'BAD_URL' });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError(`Gateway URL 不合法: ${raw}`, { code: 'BAD_URL' });
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GatewayError(`Gateway URL 协议不支持: ${url.protocol}`, { code: 'BAD_URL' });
  }
  return url.origin;
}

export class GatewayClient {
  #baseUrl;
  #token;
  #timeoutMs;

  constructor({ baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!token) throw new GatewayError('缺少 Gateway token', { code: 'NO_TOKEN' });
    this.#baseUrl = normalizeGatewayUrl(baseUrl);
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get endpoint() {
    return `${this.#baseUrl}${RPC_PATH}`;
  }

  /** Low-level call. Returns the raw envelope; never throws on `ok:false`. */
  async raw(method, params = {}, { timeoutMs = this.#timeoutMs } = {}) {
    const body = JSON.stringify({ method, params: params ?? {} });
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#token}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = err?.cause?.code || err?.name || 'fetch failed';
      throw new GatewayError(`无法连接 Gateway（${cause}）`, {
        code: 'GATEWAY_UNREACHABLE',
        details: String(err?.message || err),
      });
    }

    const text = await res.text();
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      throw new GatewayError(`Gateway 返回非 JSON（HTTP ${res.status}）`, {
        code: 'BAD_RESPONSE',
        httpStatus: res.status,
        details: text.slice(0, 300),
      });
    }
    return { httpStatus: res.status, ...env };
  }

  /** Call a Gateway method, throwing `GatewayError` for `ok:false`. */
  async call(method, params = {}, { timeoutMs } = {}) {
    const env = await this.raw(method, params, { timeoutMs });
    if (env.ok) return env.payload;
    const error = env.error || {};
    throw new GatewayError(error.message || `Gateway 调用失败: ${method}`, {
      code: error.code || `HTTP_${env.httpStatus}`,
      httpStatus: env.httpStatus,
      details: error,
    });
  }

  /** Reachability check that does not require any operator scope semantics. */
  async probe() {
    const started = Date.now();
    const payload = await this.call('health', {}, { timeoutMs: 10_000 });
    return { ok: payload?.ok === true, latencyMs: Date.now() - started, payload };
  }
}
