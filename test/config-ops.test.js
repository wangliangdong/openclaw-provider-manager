/**
 * Unit tests for lib/config-ops.js.
 *
 * Run: node --test test/config-ops.test.js
 *
 * These lock in the config.patch semantics that were verified against a live
 * OpenClaw 2026.9.4 gateway (see the header comment in lib/config-ops.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REDACTED,
  buildProviderDeletePatch,
  buildProviderPatch,
  isNoopResult,
  isStaleHashError,
  listProviders,
  maskKey,
  mergeModelEntries,
  modelMetaKeys,
  modelsReplacePath,
  normalizeModels,
  parseRawConfig,
  sanitizePatch,
  summarizePreserved,
  validateProviderId,
} from '../lib/config-ops.js';

/* -------------------------------------------------------------- validation --- */

test('validateProviderId accepts stable keys and rejects the rest', () => {
  assert.equal(validateProviderId('example'), 'example');
  assert.equal(validateProviderId(' my-provider_2 '), 'my-provider_2');

  assert.throws(() => validateProviderId(''), /不能为空/);
  assert.throws(() => validateProviderId('Example'), /小写字母/);   // uppercase
  assert.throws(() => validateProviderId('2example'), /小写字母/);  // leading digit
  assert.throws(() => validateProviderId('a/b'), /小写字母/);     // path separator
  assert.throws(() => validateProviderId('a'.repeat(65)), /小写字母/);
});

/* ------------------------------------------------------------ patch build --- */

test('buildProviderPatch always declares replacePaths for the models array', () => {
  const { raw, replacePaths } = buildProviderPatch({
    id: 'example',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    apiKey: 'sk-real',
    models: [{ id: 'example-model-a', name: 'example-model-a' }],
  });

  // Without this, shrinking the model list silently no-ops server-side.
  assert.deepEqual(replacePaths, ['models.providers.example.models']);
  assert.deepEqual(raw, {
    models: {
      providers: {
        example: {
          baseUrl: 'https://api.example.com/v1',
          api: 'openai-completions',
          apiKey: 'sk-real',
          models: [{ id: 'example-model-a', name: 'example-model-a' }],
        },
      },
    },
  });
});

test('buildProviderPatch omits apiKey when blank, so the stored key survives', () => {
  const { raw } = buildProviderPatch({
    id: 'example',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'm', name: 'm' }],
  });
  assert.equal('apiKey' in raw.models.providers.example, false);
});

test('buildProviderPatch never writes the redaction sentinel', () => {
  const { raw } = buildProviderPatch({
    id: 'example',
    baseUrl: 'https://api.example.com/v1',
    apiKey: REDACTED,
    models: [{ id: 'm', name: 'm' }],
  });
  assert.equal('apiKey' in raw.models.providers.example, false);
});

test('buildProviderPatch defaults the api type and rejects an empty model list', () => {
  const { raw } = buildProviderPatch({
    id: 'x',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm', name: 'm' }],
  });
  assert.equal(raw.models.providers.x.api, 'openai-completions');

  // OpenClaw rejects custom providers that declare no models.
  assert.throws(
    () => buildProviderPatch({ id: 'x', baseUrl: 'http://127.0.0.1:9/v1', models: [] }),
    /至少需要勾选一个模型/,
  );
});

test('buildProviderPatch requires a baseUrl', () => {
  assert.throws(
    () => buildProviderPatch({ id: 'x', baseUrl: '   ', models: [{ id: 'm', name: 'm' }] }),
    /Base URL 不能为空/,
  );
});

/* ------------------------------------------------------------- deletion --- */

test('buildProviderDeletePatch nulls the provider and declares replacePaths', () => {
  const { raw, replacePaths } = buildProviderDeletePatch('example');
  assert.deepEqual(raw, { models: { providers: { example: null } } });
  // Required, otherwise the gateway rejects the delete as an array truncation.
  assert.deepEqual(replacePaths, ['models.providers.example.models']);
});

test('modelsReplacePath points at the exact array path the gateway names', () => {
  assert.equal(modelsReplacePath('example'), 'models.providers.example.models');
  assert.throws(() => modelsReplacePath('BAD'), /小写字母/);
});

/* ------------------------------------------- metadata preservation (bug fix) --- */

const STORED = [
  {
    id: 'm1',
    name: 'My Fancy Model',
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    cost: { input: 1.5, output: 6 },
    headers: { Authorization: 'Bearer secret' },
  },
  { id: 'm2', name: 'm2', contextWindow: 32000 },
];

test('mergeModelEntries keeps stored metadata for a kept model', () => {
  // The UI only knows {id, name}; that must NOT wipe contextWindow/cost/etc.
  const merged = mergeModelEntries([{ id: 'm1', name: 'm1' }], STORED);
  assert.deepEqual(merged, [{ ...STORED[0], id: 'm1' }]);
  assert.equal(merged[0].contextWindow, 200000);
  assert.equal(merged[0].maxTokens, 8192);
  assert.equal(merged[0].reasoning, true);
  assert.deepEqual(merged[0].cost, { input: 1.5, output: 6 });
  assert.deepEqual(merged[0].headers, { Authorization: 'Bearer secret' });
});

test('mergeModelEntries preserves a stored display name over the id', () => {
  // The UI sends name === id for discovered models; honouring it would rename
  // a custom-named model on every save.
  const merged = mergeModelEntries([{ id: 'm1', name: 'm1' }], STORED);
  assert.equal(merged[0].name, 'My Fancy Model');
});

test('mergeModelEntries drops unselected models and adds genuinely new ones', () => {
  const merged = mergeModelEntries(
    [{ id: 'm2', name: 'm2' }, { id: 'brand-new', name: 'brand-new' }],
    STORED,
  );
  assert.deepEqual(merged.map((m) => m.id), ['m2', 'brand-new']);
  assert.equal(merged[0].contextWindow, 32000);            // kept
  assert.deepEqual(merged[1], { id: 'brand-new', name: 'brand-new' }); // new
});

test('mergeModelEntries tolerates missing/legacy stored entries', () => {
  assert.deepEqual(mergeModelEntries([{ id: 'x', name: 'x' }], undefined), [
    { id: 'x', name: 'x' },
  ]);
  // A legacy string entry becomes a minimal object.
  assert.deepEqual(mergeModelEntries([{ id: 'legacy', name: 'legacy' }], ['legacy']), [
    { id: 'legacy', name: 'legacy' },
  ]);
});

test('buildProviderPatch preserves metadata through the patch, not just the helper', () => {
  const { raw, preserved } = buildProviderPatch({
    id: 'example',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'm1', name: 'm1' }],   // selection only
    existingModels: STORED,               // what config.get returned
  });
  const written = raw.models.providers.example.models;
  assert.equal(written[0].contextWindow, 200000);
  assert.deepEqual(written[0].cost, { input: 1.5, output: 6 });

  assert.deepEqual(preserved, [
    { id: 'm1', fields: ['contextWindow', 'cost', 'headers', 'maxTokens', 'reasoning'] },
  ]);
});

test('buildProviderPatch without existingModels treats all as new (create case)', () => {
  const { raw } = buildProviderPatch({
    id: 'fresh',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm', name: 'm' }],
  });
  assert.deepEqual(raw.models.providers.fresh.models, [{ id: 'm', name: 'm' }]);
});

test('modelMetaKeys lists metadata only', () => {
  assert.deepEqual(modelMetaKeys({ id: 'a', name: 'b' }), []);
  assert.deepEqual(modelMetaKeys({ id: 'a', name: 'b', maxTokens: 1, cost: {} }), ['cost', 'maxTokens']);
  assert.deepEqual(modelMetaKeys(null), []);
});

test('summarizePreserved reports only models that carry metadata', () => {
  assert.deepEqual(summarizePreserved([{ id: 'm1' }, { id: 'nope' }], STORED), [
    { id: 'm1', fields: ['contextWindow', 'cost', 'headers', 'maxTokens', 'reasoning'] },
  ]);
  assert.deepEqual(summarizePreserved([{ id: 'm1' }], []), []);
});

test('listProviders surfaces per-model metadata presence for the UI', () => {
  const payload = {
    raw: JSON.stringify({ models: { providers: { example: { baseUrl: 'https://x/v1', models: STORED } } } }),
  };
  const [example] = listProviders(payload);
  assert.deepEqual(example.models.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(example.models[0].extra, ['contextWindow', 'cost', 'headers', 'maxTokens', 'reasoning']);
  assert.deepEqual(example.models[1].extra, ['contextWindow']);
});

/* ---------------------------------------------------------------- redaction --- */

test('sanitizePatch strips the sentinel recursively but keeps other values', () => {
  const cleaned = sanitizePatch({
    models: {
      providers: {
        example: { apiKey: REDACTED, baseUrl: 'https://x/v1', models: [{ id: REDACTED, name: 'n' }] },
      },
    },
  });
  assert.deepEqual(cleaned, {
    models: { providers: { example: { baseUrl: 'https://x/v1', models: [{ name: 'n' }] } } },
  });
});

/* ------------------------------------------------------------------ reads --- */

test('listProviders masks keys and flags redacted ones', () => {
  const payload = {
    raw: JSON.stringify({
      models: {
        providers: {
          example: {
            baseUrl: 'https://api.example.com/v1',
            api: 'openai-completions',
            apiKey: REDACTED,
            models: [{ id: 'example-model-a', name: 'example-model-a' }],
          },
          localbox: { baseUrl: 'http://192.0.2.10:7865/v1', apiKey: 'sk-abcdefghijklmnop' },
        },
      },
    }),
  };

  const [example, localbox] = listProviders(payload);
  assert.equal(example.id, 'example');
  assert.equal(example.hasApiKey, true);
  assert.equal(example.apiKeyRedacted, true);
  assert.equal(example.apiKeyHint, '（已配置，已隐藏）');
  assert.equal(example.models.length, 1);

  assert.equal(localbox.id, 'localbox');
  assert.equal(localbox.apiKeyRedacted, false);
  assert.match(localbox.apiKeyHint, /^sk-a\*+mnop$/);
  assert.equal(localbox.api, 'openai-completions'); // defaulted
  assert.deepEqual(localbox.models, []);
});

test('maskKey shortens long keys and fully hides short ones', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short'), '*****');
  // 19 chars -> first 4 + 11 masked (capped at 12) + last 4.
  assert.equal(maskKey('sk-abcdefghijklmnop'), 'sk-a***********mnop');
  // At/under 8 chars the whole key is hidden.
  assert.equal(maskKey('12345678'), '********');
  // Long keys cap the masked run at 12 characters.
  assert.equal(maskKey('sk-' + 'x'.repeat(40) + 'tail'), 'sk-x' + '*'.repeat(12) + 'tail');
});

test('parseRawConfig prefers parsed and tolerates malformed raw', () => {
  assert.deepEqual(parseRawConfig({ parsed: { a: 1 }, raw: '{bad' }), { a: 1 });
  assert.deepEqual(parseRawConfig({ raw: '{"a":2}' }), { a: 2 });
  assert.deepEqual(parseRawConfig({ raw: '{bad' }), {});
  assert.deepEqual(parseRawConfig(null), {});
});

test('normalizeModels dedupes, trims, and drops empty ids', () => {
  assert.deepEqual(
    normalizeModels(['a', { id: 'b' }, { id: 'a', name: 'A' }, { id: '  ' }, { id: 'c', name: ' C ' }]),
    [
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
      { id: 'c', name: 'C' },
    ],
  );
  assert.deepEqual(normalizeModels(undefined), []);
});

/* ------------------------------------------------------------ error typing --- */

test('isStaleHashError recognises the gateway concurrency error', () => {
  assert.equal(isStaleHashError(new Error('config changed since last load; re-run config.get and retry')), true);
  assert.equal(isStaleHashError(new Error('config base hash required for models.providers.x; re-run config.get and retry with baseHash')), true);
  assert.equal(isStaleHashError(new Error('missing scope: operator.read')), false);
  assert.equal(isStaleHashError(null), false);
});

test('isNoopResult detects the array-merge no-op', () => {
  assert.equal(isNoopResult({ noop: true }), true);
  assert.equal(isNoopResult({ noop: false }), false);
  assert.equal(isNoopResult(undefined), false);
});
