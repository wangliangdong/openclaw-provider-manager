/**
 * Provider model discovery.
 *
 * IMPORTANT (verified against OpenClaw 2026.9.4, do not re-litigate):
 * OpenClaw's Gateway does NOT enumerate `/v1/models` for custom
 * `openai-completions` providers. `models.list` only returns models declared in
 * `models.providers.<id>.models[]`. The hosted "catalog refresh"
 * (`models.catalogRefresh`) only updates metadata for *built-in* providers from
 * a remote OpenClaw catalog; it has no provider-endpoint discovery step.
 *
 * So this manager must perform discovery itself: call `GET {baseUrl}/models`
 * with the user's key, then let the user pick which models to write into config.
 */

const TIMEOUT_MS = 20_000;

export class DiscoveryError extends Error {
  constructor(message, { status, detail, endpoint } = {}) {
    super(message);
    this.name = 'DiscoveryError';
    this.status = status;
    this.detail = detail;
    this.endpoint = endpoint;
  }
}

/**
 * Normalize a provider base URL.
 *
 * Trims surrounding whitespace (a trailing space in `baseUrl` is a real bug we
 * have hit before) and strips trailing slashes.
 */
export function normalizeBaseUrl(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new DiscoveryError('baseUrl 不能为空');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DiscoveryError(`baseUrl 不是合法 URL: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DiscoveryError(`baseUrl 必须是 http/https: ${trimmed}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function pickId(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    for (const key of ['id', 'name', 'model']) {
      const v = entry[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

function normalizeList(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : null;
  if (!raw) return null;
  const seen = new Set();
  const ids = [];
  for (const entry of raw) {
    const id = pickId(entry);
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

/**
 * Discover model ids from a provider endpoint.
 *
 * @returns {Promise<{models: string[], endpoint: string, count: number}>}
 */
export async function discoverModels({ baseUrl, apiKey, api = 'openai-completions', extraHeaders = {} }) {
  const base = normalizeBaseUrl(baseUrl);
  const isOllama = String(api).toLowerCase() === 'ollama';
  const endpoint = isOllama ? `${base}/api/tags` : `${base}/models`;

  const headers = { accept: 'application/json', ...extraHeaders };
  if (apiKey && String(apiKey).trim()) {
    headers.authorization = `Bearer ${String(apiKey).trim()}`;
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.name || 'fetch failed';
    throw new DiscoveryError(`无法连接 ${endpoint}（${cause}）`, {
      detail: String(err?.message || err),
      endpoint,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? 'API Key 无效或缺失'
      : res.status === 404
        ? '端点不存在，请检查 Base URL 是否需要以 /v1 结尾'
        : '上游返回错误';
    // No "获取模型失败：" prefix here: the UI adds that context label once.
    // Baking it in too produced "获取模型失败：获取模型失败：HTTP 401…", and made
    // this message inconsistent with the other DiscoveryErrors, which describe
    // only the cause.
    throw new DiscoveryError(`HTTP ${res.status}（${hint}）`, {
      status: res.status,
      detail: text.slice(0, 500),
      endpoint,
    });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new DiscoveryError('上游返回的不是 JSON（可能不是 OpenAI 兼容端点）', {
      status: res.status,
      detail: text.slice(0, 300),
      endpoint,
    });
  }

  const models = normalizeList(payload);
  if (models === null) {
    throw new DiscoveryError('响应中没有 data/models 数组', { status: res.status, detail: text.slice(0, 300), endpoint });
  }

  return { models, endpoint, count: models.length };
}

/**
 * Probe a provider endpoint for liveness and authorization.
 *
 * WHY THIS EXISTS: the gateway's `models.list` reports `available: true` for
 * every model merely DECLARED in `models.providers.<id>.models[]`; it performs
 * no network call to the upstream. A provider pointed at a dead host still
 * reports all models "available". So a real connection test must hit the
 * upstream itself, which is what this does.
 *
 * @returns {Promise<{reachable: boolean, authorized: boolean, count: number,
 *   models: string[], status: number|null, endpoint: string, error: string|null}>}
 */
export async function probeProvider({ baseUrl, apiKey, api = 'openai-completions' }) {
  try {
    const found = await discoverModels({ baseUrl, apiKey, api });
    return {
      reachable: true,
      authorized: true,
      count: found.count,
      models: found.models,
      status: 200,
      endpoint: found.endpoint,
      error: null,
    };
  } catch (err) {
    if (!(err instanceof DiscoveryError)) throw err;
    // A network-level failure carries no HTTP status; an upstream rejection does.
    const reachable = typeof err.status === 'number';
    return {
      reachable,
      authorized: false,
      count: 0,
      models: [],
      status: err.status ?? null,
      endpoint: err.endpoint ?? null,
      error: err.message,
    };
  }
}
