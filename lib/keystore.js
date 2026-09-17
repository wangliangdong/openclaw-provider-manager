/**
 * Encrypted, write-only key store ("vault").
 *
 * WHY THIS EXISTS
 * `config.get` always redacts stored provider keys, so this manager cannot run
 * an authenticated `GET {baseUrl}/models` for an EXISTING provider — which
 * means it cannot refresh that provider's model list. The gateway has the key
 * but exposes no RPC that would perform discovery on our behalf
 * (`models.probe` is off the admin allowlist and only does a tiny inference
 * call; `models.catalogRefresh` only touches built-in catalog metadata, never a
 * custom `openai-completions` endpoint). See README §4.
 *
 * So, for providers whose owner opts in, we keep our own copy — ENCRYPTED.
 *
 * THREAT MODEL (be honest about what this does and does not buy)
 *   Protects against: casual reads of the data directory; a backup, snapshot,
 *     screenshot, or sync that captures the vault file alone; accidental
 *     `git add` of a data dir; log/trace leakage of stored material.
 *   Does NOT protect against: a compromised manager container (the key is held
 *     in memory to make the upstream call), anyone with Docker/host access, or
 *     a leaked `PM_VAULT_KEY`.
 * The master key deliberately lives OUTSIDE the mounted data directory
 * (`vault.key` beside `data/`, not inside it), so ciphertext alone is useless.
 * There is no scheme that both keeps the key always available and never
 * exposes it — that trade-off was accepted knowingly.
 *
 * The store is WRITE-ONLY over the API: no HTTP route ever returns a stored
 * secret. Values are read only internally, to call the upstream.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { validateProviderId } from './config-ops.js';

export const VAULT_VERSION = 1;
export const DEFAULT_FILE = 'vault.enc';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const MODE = 0o600;

export class KeyStoreError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'KeyStoreError';
    this.code = code;
  }
}

/** Parse a base64 master key, enforcing exactly 256 bits. */
export function parseMasterKey(base64) {
  const raw = String(base64 ?? '').trim();
  if (!raw) throw new KeyStoreError('缺少主密钥 PM_VAULT_KEY', { code: 'NO_KEY' });
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new KeyStoreError('PM_VAULT_KEY 不是合法 base64', { code: 'BAD_KEY' });
  }
  if (buf.length !== KEY_BYTES) {
    throw new KeyStoreError(
      `PM_VAULT_KEY 必须是 ${KEY_BYTES} 字节（base64 后 44 字符），当前 ${buf.length} 字节`,
      { code: 'BAD_KEY' },
    );
  }
  return buf;
}

/** Generate a fresh master key as base64 (used by deploy tooling). */
export function generateMasterKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Bind an entry to its provider id so a ciphertext cannot be swapped from one
 * provider to another without the tag failing.
 */
function aadFor(id) {
  return Buffer.from(`provider-manager:vault:v${VAULT_VERSION}:${id}`, 'utf8');
}

function encrypt(key, id, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(id));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

function decrypt(key, id, entry) {
  const iv = Buffer.from(entry.iv, 'base64');
  const tag = Buffer.from(entry.tag, 'base64');
  const ct = Buffer.from(entry.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aadFor(id));
  decipher.setAuthTag(tag);
  // Throws on tampering (wrong key, edited ct, swapped id).
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export class KeyStore {
  #key = null;
  #dir;
  #file;
  #enabled = false;
  #reason = null;
  #queue = Promise.resolve(); // serialize read-modify-write

  /**
   * @param {{dir: string, keyBase64?: string, fileName?: string}} opts
   *   `keyBase64` empty/invalid keeps the vault DISABLED rather than crashing
   *   the server — every other feature must keep working without it.
   */
  constructor({ dir, keyBase64, fileName = DEFAULT_FILE } = {}) {
    this.#dir = dir;
    this.#file = path.join(dir, fileName);
    try {
      this.#key = parseMasterKey(keyBase64);
      this.#enabled = true;
    } catch (err) {
      this.#reason = err.message;
    }
  }

  get enabled() { return this.#enabled; }
  get reason() { return this.#reason; }
  get file() { return this.#file; }

  /** Serialize mutations so two concurrent saves cannot lose an entry. */
  #serial(task) {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #assertEnabled() {
    if (!this.#enabled) throw new KeyStoreError(`密钥库不可用：${this.#reason}`, { code: 'DISABLED' });
  }

  async #readAll() {
    let text;
    try {
      text = await fs.readFile(this.#file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { version: VAULT_VERSION, entries: {} };
      throw new KeyStoreError(`读取密钥库失败：${err.message}`, { code: 'READ_FAILED' });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new KeyStoreError('密钥库文件已损坏（不是合法 JSON）', { code: 'CORRUPT' });
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new KeyStoreError('密钥库文件结构不合法', { code: 'CORRUPT' });
    }
    if (parsed.version !== VAULT_VERSION) {
      throw new KeyStoreError(`密钥库版本不支持：${parsed.version}`, { code: 'BAD_VERSION' });
    }
    return parsed;
  }

  async #writeAll(data) {
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    // Write-then-rename: a crash mid-write must not truncate the existing vault.
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: MODE });
    await fs.rename(tmp, this.#file);
  }

  /** Metadata only — never returns secrets. Safe to expose. */
  async list() {
    if (!this.#enabled) return [];
    const data = await this.#readAll();
    return Object.entries(data.entries).map(([id, e]) => ({
      id,
      createdAt: e.createdAt ?? null,
      updatedAt: e.updatedAt ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async has(id) {
    if (!this.#enabled) return false;
    const data = await this.#readAll();
    return Object.hasOwn(data.entries, validateProviderId(id));
  }

  /** Encrypt and store (or replace) the secret for one provider. */
  async set(id, secret) {
    this.#assertEnabled();
    const pid = validateProviderId(id);
    const value = String(secret ?? '');
    if (!value.trim()) throw new KeyStoreError('密钥不能为空', { code: 'EMPTY' });

    return this.#serial(async () => {
      const data = await this.#readAll();
      const now = new Date().toISOString();
      const prev = data.entries[pid];
      data.entries[pid] = {
        ...encrypt(this.#key, pid, value),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      await this.#writeAll(data);
      return { id: pid, createdAt: data.entries[pid].createdAt, updatedAt: now };
    });
  }

  /**
   * Decrypt one secret. INTERNAL ONLY — must never be wired to an HTTP route.
   * Returns null when absent; throws on tampering/corruption.
   */
  async get(id) {
    this.#assertEnabled();
    const pid = validateProviderId(id);
    const data = await this.#readAll();
    const entry = data.entries[pid];
    if (!entry) return null;
    try {
      return decrypt(this.#key, pid, entry);
    } catch {
      throw new KeyStoreError(
        `密钥库中「${pid}」的密文无法解密（主密钥已更换或数据被篡改），请重新保存该密钥`,
        { code: 'DECRYPT_FAILED' },
      );
    }
  }

  async delete(id) {
    this.#assertEnabled();
    const pid = validateProviderId(id);
    return this.#serial(async () => {
      const data = await this.#readAll();
      if (!Object.hasOwn(data.entries, pid)) return false;
      delete data.entries[pid];
      await this.#writeAll(data);
      return true;
    });
  }
}
