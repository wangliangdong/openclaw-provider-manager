/**
 * Unit tests for lib/keystore.js.
 *
 * Run: node --test test/keystore.test.js
 *
 * Focus is on the security-relevant paths: tamper detection, wrong-key
 * rejection, cross-provider ciphertext swapping, and atomic rewrite. Plain
 * round-tripping is the least interesting case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KeyStore,
  KeyStoreError,
  generateMasterKey,
  parseMasterKey,
} from '../lib/keystore.js';

// Every temp dir handed out here is removed when the process exits, so a run
// does not litter /tmp (an earlier version leaked one dir per test).
// NOTE: the sync remover comes from `node:fs` — `node:fs/promises` has no
// `rmSync`, and calling it there throws inside the catch and deletes nothing.
const tempDirs = [];
process.on('exit', () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-vault-'));
  tempDirs.push(dir);
  return dir;
}

/** A store backed by a fresh temp dir; `opts` can override key/dir. */
async function makeStore(opts = {}) {
  const dir = opts.dir ?? await tmpDir();
  const key = opts.key ?? generateMasterKey();
  return { store: new KeyStore({ dir, keyBase64: key }), dir, key };
}

/* ------------------------------------------------------------ master key --- */

test('parseMasterKey accepts exactly 32 bytes of base64', () => {
  const key = generateMasterKey();
  assert.equal(parseMasterKey(key).length, 32);
  assert.equal(key.length, 44); // 32 bytes -> 44 base64 chars with padding
});

test('parseMasterKey rejects empty, non-base64 and wrong-length keys', () => {
  assert.throws(() => parseMasterKey(''), /缺少主密钥/);
  assert.throws(() => parseMasterKey('   '), /缺少主密钥/);
  // 16 bytes is a valid AES-128 key but NOT what we asked for.
  assert.throws(() => parseMasterKey(Buffer.alloc(16).toString('base64')), /32 字节/);
  assert.throws(() => parseMasterKey(Buffer.alloc(31).toString('base64')), /32 字节/);
});

test('a bad master key disables the vault instead of throwing at construction', () => {
  // The server must keep running (list/test/delete) even if the key is wrong.
  const store = new KeyStore({ dir: '/tmp/unused', keyBase64: '' });
  assert.equal(store.enabled, false);
  assert.match(store.reason, /缺少主密钥/);
});

/* --------------------------------------------------------- round trip --- */

test('set/get round-trips a secret and list never exposes it', async () => {
  const { store, dir } = await makeStore();
  await store.set('localbox', 'sk-secret-value');

  assert.equal(await store.get('localbox'), 'sk-secret-value');
  assert.equal(await store.has('localbox'), true);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'localbox');
  assert.ok(listed[0].createdAt && listed[0].updatedAt);
  // Metadata must not carry the secret in any form.
  assert.equal(JSON.stringify(listed).includes('sk-secret-value'), false);

  // Neither must the file on disk.
  const raw = await fs.readFile(path.join(dir, 'vault.enc'), 'utf8');
  assert.equal(raw.includes('sk-secret-value'), false);
  assert.equal(raw.includes('sk-secret'), false);
});

test('get returns null for an unknown provider (not a throw)', async () => {
  const { store } = await makeStore();
  assert.equal(await store.get('nothing'), null);
  assert.equal(await store.has('nothing'), false);
});

test('set replaces an existing secret and keeps createdAt', async () => {
  const { store } = await makeStore();
  const first = await store.set('example', 'old');
  const second = await store.set('example', 'new');
  assert.equal(await store.get('example'), 'new');
  assert.equal(second.createdAt, first.createdAt);
});

test('multiple providers stay independent', async () => {
  const { store } = await makeStore();
  await store.set('example', 'a-key');
  await store.set('localbox', 'l-key');
  assert.equal(await store.get('example'), 'a-key');
  assert.equal(await store.get('localbox'), 'l-key');
  assert.deepEqual((await store.list()).map((e) => e.id), ['example', 'localbox']);
});

test('delete removes an entry and reports whether it existed', async () => {
  const { store } = await makeStore();
  await store.set('localbox', 'k');
  assert.equal(await store.delete('localbox'), true);
  assert.equal(await store.delete('localbox'), false);
  assert.equal(await store.get('localbox'), null);
});

/* ------------------------------------------------------- tamper checks --- */

test('a different master key cannot decrypt (and says so clearly)', async () => {
  const dir = await tmpDir();
  const { store } = await makeStore({ dir });
  await store.set('localbox', 'sk-value');

  const other = new KeyStore({ dir, keyBase64: generateMasterKey() });
  await assert.rejects(
    () => other.get('localbox'),
    (err) => {
      assert.ok(err instanceof KeyStoreError);
      assert.equal(err.code, 'DECRYPT_FAILED');
      assert.match(err.message, /重新保存/);
      return true;
    },
  );
});

test('editing the ciphertext is detected (GCM auth tag)', async () => {
  const { store, dir } = await makeStore();
  await store.set('localbox', 'sk-value');

  const file = path.join(dir, 'vault.enc');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  const ct = Buffer.from(data.entries.localbox.ct, 'base64');
  ct[0] ^= 0xff;
  data.entries.localbox.ct = ct.toString('base64');
  await fs.writeFile(file, JSON.stringify(data));

  await assert.rejects(() => store.get('localbox'), /无法解密/);
});

test('swapping ciphertext between providers is detected (AAD binds the id)', async () => {
  const { store, dir } = await makeStore();
  await store.set('example', 'example-key');
  await store.set('localbox', 'localbox-key');

  // Move localbox's ciphertext under the example id.
  const file = path.join(dir, 'vault.enc');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.entries.example = { ...data.entries.localbox };
  await fs.writeFile(file, JSON.stringify(data));

  await assert.rejects(() => store.get('example'), /无法解密/);
});

test('a corrupt vault file is reported, not silently treated as empty', async () => {
  const { store, dir } = await makeStore();
  await fs.writeFile(path.join(dir, 'vault.enc'), 'not json at all');
  await assert.rejects(() => store.list(), /损坏/);
});

test('an unsupported vault version is rejected', async () => {
  const { store, dir } = await makeStore();
  await fs.writeFile(path.join(dir, 'vault.enc'), JSON.stringify({ version: 99, entries: {} }));
  await assert.rejects(() => store.list(), /版本不支持/);
});

/* ------------------------------------------------------------- inputs --- */

test('set rejects empty secrets and invalid provider ids', async () => {
  const { store } = await makeStore();
  await assert.rejects(() => store.set('localbox', ''), /不能为空/);
  await assert.rejects(() => store.set('localbox', '   '), /不能为空/);
  await assert.rejects(() => store.set('../evil', 'k'), /Provider ID/);
  await assert.rejects(() => store.set('Bad-Id', 'k'), /Provider ID/);
});

test('a disabled vault fails closed on write and read', async () => {
  const store = new KeyStore({ dir: await tmpDir(), keyBase64: 'nope' });
  await assert.rejects(() => store.set('localbox', 'k'), /密钥库不可用/);
  await assert.rejects(() => store.get('localbox'), /密钥库不可用/);
  // Reads that only describe state stay safe and empty.
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.has('localbox'), false);
});

/* ------------------------------------------------------- concurrency --- */

test('concurrent writes do not lose entries', async () => {
  const { store } = await makeStore();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => store.set(`p${i}`, `k${i}`)),
  );
  const list = await store.list();
  assert.equal(list.length, 12);
  // Every secret must still decrypt to its own value.
  for (let i = 0; i < 12; i += 1) {
    assert.equal(await store.get(`p${i}`), `k${i}`);
  }
});

test('the vault file is created with owner-only permissions', async () => {
  const { store, dir } = await makeStore();
  await store.set('localbox', 'k');
  const st = await fs.stat(path.join(dir, 'vault.enc'));
  assert.equal(st.mode & 0o777, 0o600);
});
