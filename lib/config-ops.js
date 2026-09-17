/**
 * Provider config operations on top of the Gateway admin HTTP RPC.
 *
 * All writes go through `config.patch`, so this manager never touches
 * openclaw.json directly and stays correct across future config-layout changes.
 *
 * VERIFIED `config.patch` SEMANTICS (OpenClaw 2026.9.4, 3a9d69d) — do not
 * "simplify" these away, each one was reproduced against the live gateway:
 *
 *   1. params are `{ raw: "<JSON5 string>", baseHash?, replacePaths? }`.
 *   2. `baseHash` is REQUIRED when the patch introduces new config paths
 *      (e.g. adding a provider); omitting it fails with
 *      "config base hash required for models.providers.<id>...".
 *   3. A stale `baseHash` fails with
 *      "config changed since last load; re-run config.get and retry".
 *      Callers must re-read the hash and retry (see server.js applyPatch).
 *   4. Arrays are MERGED BY INDEX, NOT REPLACED. Shrinking
 *      `models.providers.<id>.models` therefore SILENTLY NO-OPS: the call
 *      returns `ok:true` with `noop:true` and the old list stays. Removing a
 *      model (the whole point of the checkbox UI) only works when the exact
 *      array path is listed in `replacePaths`. We therefore always declare
 *      that path whenever we write a models array.
 *   5. Deleting a provider (`{...: null}`) is REJECTED while that provider has
 *      a models array unless the same `replacePaths` entry is present.
 *   6. Custom providers MUST declare a non-empty `models` array; an empty or
 *      missing list is rejected by config validation.
 *   7. `null` deletes a path; scalars and arrays replace when allowed.
 *
 * SECURITY: `config.get` redacts secrets as `__OPENCLAW_REDACTED__`.
 * Provider-level secrets ARE redacted (e.g. `headers.X-Tenant`), so writing
 * that sentinel back into a MERGED object is a safe no-op server-side.
 * Writing it INSIDE AN ARRAY ELEMENT is not: the gateway hard-rejects it
 * ("Reserved redaction sentinel ... is not valid config data"). Model-level
 * fields are not redacted in practice, but `sanitizePatch` still strips the
 * sentinel everywhere so a redacted read can never trigger that 400.
 */

export const REDACTED = '__OPENCLAW_REDACTED__';
export const PROVIDERS_PATH = 'models.providers';

/** Provider ids: stable, portable keys. */
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const DEFAULT_API = 'openai-completions';

export function validateProviderId(id) {
  const v = String(id ?? '').trim();
  if (!v) throw new Error('Provider ID 不能为空');
  if (!ID_PATTERN.test(v)) {
    throw new Error('Provider ID 只能包含小写字母、数字、- 和 _，且需以字母开头');
  }
  return v;
}

/** The array path that must be declared in `replacePaths` to truly replace models. */
export function modelsReplacePath(id) {
  return `${PROVIDERS_PATH}.${validateProviderId(id)}.models`;
}

/** Parse the raw config from `config.get`. */
export function parseRawConfig(payload) {
  if (!payload) return {};
  if (payload.parsed && typeof payload.parsed === 'object') return payload.parsed;
  try {
    return JSON.parse(payload.raw ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Normalize a models array from config into `{id, name}` pairs.
 *
 * Used for validating/normalizing the caller's SELECTION. Stored metadata is
 * deliberately not carried here — see `mergeModelEntries` for that.
 */
export function normalizeModels(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    let id = '';
    let name = '';
    if (typeof entry === 'string') {
      id = entry.trim();
      name = id;
    } else if (entry && typeof entry === 'object') {
      id = String(entry.id ?? '').trim();
      name = String(entry.name ?? '').trim() || id;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** Keys on a model entry that count as metadata (everything but id/name). */
export function modelMetaKeys(entry) {
  if (!entry || typeof entry !== 'object') return [];
  return Object.keys(entry).filter((k) => k !== 'id' && k !== 'name').sort();
}

/**
 * Merge the user's selected models against what is already stored.
 *
 * WHY THIS EXISTS (this was a real data-loss bug):
 * Writing `models.providers.<id>.models` requires `replacePaths`, and the
 * gateway then REPLACES that array wholesale. The UI only knows `{id, name}`,
 * but a stored model entry may carry up to 15 more fields — `contextWindow`,
 * `contextTokens`, `maxTokens`, `reasoning`, `input`, `cost`,
 * `thinkingLevelMap`, `params`, `agentRuntime`, `headers`, `compat`,
 * `mediaInput`, `metadataSource`, `api`, `baseUrl`. Sending only `{id, name}`
 * therefore SILENTLY DESTROYED that metadata on every edit (reproduced against
 * a live gateway: `contextWindow`/`maxTokens`/`reasoning`/`cost`/`headers` all
 * vanished).
 *
 * So for every selected id that already exists, we reuse the STORED entry
 * verbatim (all metadata intact) and only change the set membership. A stored
 * `name` is preserved too — the UI sends `name === id` for discovered models,
 * and honouring that would rename custom-named models on every save.
 *
 * Verified safe: model-level fields (including `headers.Authorization`) are
 * NOT redacted by `config.get`, so stored entries can be written back as-is.
 *
 * @param {Array<{id: string, name?: string}>} selected  caller's selection
 * @param {Array} existing                               raw stored models array
 * @returns {Array} models array ready to write
 */
export function mergeModelEntries(selected, existing) {
  const stored = new Map();
  for (const entry of Array.isArray(existing) ? existing : []) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id && !stored.has(id)) stored.set(id, { id, name: id });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const id = String(entry.id ?? '').trim();
      if (id && !stored.has(id)) stored.set(id, entry);
    }
  }

  return normalizeModels(selected).map(({ id, name }) => {
    const prev = stored.get(id);
    if (prev) return { ...prev, id };   // keep every stored metadata field
    return { id, name: name || id };    // genuinely new model
  });
}

/** Summarize which selected models bring metadata along, for the response. */
export function summarizePreserved(selected, existing) {
  const stored = new Map();
  for (const entry of Array.isArray(existing) ? existing : []) {
    if (entry && typeof entry === 'object') {
      const id = String(entry.id ?? '').trim();
      if (id) stored.set(id, entry);
    }
  }
  const preserved = [];
  for (const { id } of normalizeModels(selected)) {
    const prev = stored.get(id);
    const keys = prev ? modelMetaKeys(prev) : [];
    if (keys.length) preserved.push({ id, fields: keys });
  }
  return preserved;
}

/** List configured providers, with secrets masked. */
export function listProviders(payload) {
  const cfg = parseRawConfig(payload);
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== 'object') return [];
  return Object.entries(providers)
    .map(([id, cfgEntry]) => {
      const entry = cfgEntry && typeof cfgEntry === 'object' ? cfgEntry : {};
      const rawKey = typeof entry.apiKey === 'string' ? entry.apiKey : '';
      const redacted = rawKey === REDACTED;
      const hasApiKey = rawKey.length > 0;
      return {
        id,
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
        api: typeof entry.api === 'string' && entry.api ? entry.api : DEFAULT_API,
        hasApiKey,
        apiKeyRedacted: redacted,
        apiKeyHint: redacted ? '（已配置，已隐藏）' : maskKey(rawKey),
        // `extra` lets the UI show that metadata exists (and is preserved).
        models: normalizeModels(entry.models).map((m) => {
          const raw = Array.isArray(entry.models)
            ? entry.models.find((e) => e && typeof e === 'object' && String(e.id ?? '').trim() === m.id)
            : null;
          return { ...m, extra: modelMetaKeys(raw) };
        }),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`;
}

/**
 * Build the `config.patch` body for creating or updating a provider.
 *
 * Pass `existingModels` (the raw array from `config.get`) so stored per-model
 * metadata survives the array replacement. Omitting it treats every selected
 * model as new, which would drop metadata — only correct when creating.
 *
 * @returns {{raw: object, replacePaths: string[], preserved: Array<{id: string, fields: string[]}>}}
 */
export function buildProviderPatch({ id, baseUrl, api, apiKey, models, existingModels }) {
  const providerId = validateProviderId(id);

  const entry = {};

  const url = String(baseUrl ?? '').trim();
  if (!url) throw new Error('Base URL 不能为空');
  entry.baseUrl = url;

  entry.api = String(api ?? '').trim() || DEFAULT_API;

  const list = mergeModelEntries(models, existingModels);
  if (list.length === 0) {
    // Matches OpenClaw's own validation: custom providers must declare models.
    throw new Error('至少需要勾选一个模型（OpenClaw 要求自定义 Provider 必须声明 models）');
  }
  entry.models = list;

  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key && key !== REDACTED) entry.apiKey = key;

  return {
    raw: { models: { providers: { [providerId]: entry } } },
    // Required so removing a model actually shrinks the stored array.
    replacePaths: [modelsReplacePath(providerId)],
    preserved: summarizePreserved(models, existingModels),
  };
}

/**
 * Build the `config.patch` body that removes a provider entirely.
 *
 * `replacePaths` is required whenever the provider owns a models array,
 * otherwise the delete is rejected as an accidental array truncation.
 *
 * @returns {{raw: object, replacePaths: string[]}}
 */
export function buildProviderDeletePatch(id) {
  const providerId = validateProviderId(id);
  return {
    raw: { models: { providers: { [providerId]: null } } },
    replacePaths: [modelsReplacePath(providerId)],
  };
}

/** Recursively strip the redaction sentinel so it can never be written back. */
export function sanitizePatch(value) {
  if (value === REDACTED) return undefined;
  if (Array.isArray(value)) return value.map(sanitizePatch).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = sanitizePatch(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/** True when the gateway rejected the patch because our baseHash went stale. */
export function isStaleHashError(err) {
  const msg = String(err?.message || '');
  return /config changed since last load|base hash/i.test(msg) && /retry|re-run/i.test(msg);
}

/** True when the patch was accepted but changed nothing (array-merge no-op). */
export function isNoopResult(result) {
  return result?.noop === true;
}
