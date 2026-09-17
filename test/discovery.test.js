/**
 * Unit tests for lib/discovery.js.
 *
 * Run: node --test test/discovery.test.js
 *
 * `normalizeBaseUrl` is tested directly; `discoverModels`/`probeProvider` are
 * tested against a throwaway local HTTP server so no real upstream is needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { DiscoveryError, discoverModels, normalizeBaseUrl, probeProvider } from '../lib/discovery.js';

/* ------------------------------------------------------------- baseUrl --- */

test('normalizeBaseUrl trims, strips trailing slashes, keeps the path', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('  https://api.example.com/v1/  '), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('http://192.0.2.10:7865/v1/'), 'http://192.0.2.10:7865/v1');
  assert.equal(normalizeBaseUrl('https://host'), 'https://host');
});

test('normalizeBaseUrl rejects empty, malformed, and non-http values', () => {
  assert.throws(() => normalizeBaseUrl(''), /不能为空/);
  assert.throws(() => normalizeBaseUrl('   '), /不能为空/);
  assert.throws(() => normalizeBaseUrl('not a url'), /不是合法 URL/);
  assert.throws(() => normalizeBaseUrl('ftp://host/v1'), /必须是 http\/https/);
});

/* ------------------------------------------------------- helper server --- */

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/* ---------------------------------------------------------- discovery --- */

test('discoverModels parses an OpenAI-style data array', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer sk-test');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }));
  }, async (baseUrl) => {
    const r = await discoverModels({ baseUrl, apiKey: 'sk-test' });
    assert.equal(r.count, 2);                       // deduped
    assert.deepEqual(r.models, ['a', 'b']);
    assert.equal(r.endpoint, `${baseUrl}/models`);
  });
});

test('discoverModels uses /api/tags for ollama', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/v1/api/tags');          // base path is preserved
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llama3' }] }));
  }, async (baseUrl) => {
    const r = await discoverModels({ baseUrl, api: 'ollama' });
    assert.deepEqual(r.models, ['llama3']);
  });
});

test('discoverModels reports an auth failure as a typed error', async () => {
  await withServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"no token"}');
  }, async (baseUrl) => {
    await assert.rejects(
      () => discoverModels({ baseUrl, apiKey: 'bad' }),
      (err) => {
        assert.ok(err instanceof DiscoveryError);
        assert.equal(err.status, 401);
        assert.match(err.message, /API Key 无效或缺失/);
        return true;
      },
    );
  });
});

test('discoverModels rejects a non-JSON body', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>nope</html>');
  }, async (baseUrl) => {
    await assert.rejects(() => discoverModels({ baseUrl }), /不是 JSON/);
  });
});

/* -------------------------------------------------------------- probe --- */

test('probeProvider reports reachable+authorized on a valid endpoint', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'x' }, { id: 'y' }] }));
  }, async (baseUrl) => {
    const p = await probeProvider({ baseUrl });
    assert.equal(p.reachable, true);
    assert.equal(p.authorized, true);
    assert.equal(p.count, 2);
    assert.equal(p.error, null);
  });
});

test('probeProvider treats an HTTP error as reachable but unauthorized', async () => {
  await withServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"bad key"}');
  }, async (baseUrl) => {
    const p = await probeProvider({ baseUrl });
    // The host answered, so it is reachable; the key was rejected.
    assert.equal(p.reachable, true);
    assert.equal(p.authorized, false);
    assert.equal(p.status, 401);
    assert.match(p.error, /401/);
  });
});

test('probeProvider treats a connection failure as unreachable', async () => {
  // Port 9 (discard) is closed on the loopback interface.
  const p = await probeProvider({ baseUrl: 'http://127.0.0.1:9/v1' });
  assert.equal(p.reachable, false);
  assert.equal(p.authorized, false);
  assert.equal(p.status, null);
  assert.match(p.error, /无法连接/);
});
