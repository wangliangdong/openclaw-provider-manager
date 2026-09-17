/* openclaw-provider-manager — frontend */

const $ = (id) => document.getElementById(id);

const state = {
  providers: [],
  editingId: null,     // null = add mode, string = edit mode
  remote: [],          // discovered model ids
  selected: new Set(), // model ids to save
  knownMeta: new Map(), // model id -> stored metadata field names
  authRequired: false,
  vaultEnabled: false, // encrypted key store usable on this server
  vaultReason: null,   // why it is unavailable, when it is
  vaultIds: new Set(), // provider ids that already have a stored secret
};

/* ------------------------------------------------------------ api helper --- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && data?.error === '未认证') {
    showLogin();
    throw new Error('未认证');
  }
  if (!res.ok || data?.ok === false) {
    const detail = data?.detail ? `\n${typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)}` : '';
    throw new Error((data?.error || `HTTP ${res.status}`) + detail);
  }
  return data;
}

/* ----------------------------------------------------------------- alerts --- */

let alertTimer = null;
function showAlert(message, kind = 'error') {
  const box = $('alert');
  box.textContent = message;
  box.className = `alert ${kind}`;
  clearTimeout(alertTimer);
  if (kind === 'ok') alertTimer = setTimeout(() => box.classList.add('hidden'), 4000);
}
function clearAlert() { $('alert').classList.add('hidden'); }

/* ------------------------------------------------------------------ login --- */

function showLogin() {
  $('loginModal').classList.remove('hidden');
  $('fLoginToken')?.focus();
}

async function doLogin() {
  const token = $('fLoginToken').value;
  try {
    await api('/api/login', { method: 'POST', body: { token } });
    $('loginModal').classList.add('hidden');
    $('fLoginToken').value = '';
    await refresh();
  } catch (err) {
    showAlert(err.message);
  }
}

/* ------------------------------------------------------------------ status --- */

function setGwStatus(kind, text, title) {
  // Update in place rather than replaceChildren(): the static markup declares
  // the dot and the label as separate elements, and destroying them would
  // break the HTML contract (and any selector relying on those ids).
  const box = $('gwStatus');
  const dot = box.querySelector('.dot');
  if (dot) dot.className = `dot dot-${kind}`;
  const label = $('gwStatusText');
  if (label) label.textContent = text;
  box.title = title || '';
}

async function refreshStatus() {
  // Must never throw: refresh() calls this before loading providers, so an
  // error escaping here would leave the list empty and the status stuck.
  try {
    const s = await api('/api/status');
    if (s.gatewayOk) {
      setGwStatus('ok', 'Gateway 已连接', `${s.endpoint} · ${s.latencyMs}ms`);
    } else {
      setGwStatus('bad', 'Gateway 异常', s.gatewayError || '');
    }
  } catch (err) {
    try {
      setGwStatus('bad', '无法连接', err.message || '');
    } catch { /* status widget is cosmetic; never block the page */ }
  }
}

/* ------------------------------------------------------------------ render --- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function modelTags(models) {
  const wrap = el('div', { class: 'tags' });
  const shown = models.slice(0, 6);
  for (const m of shown) {
    const tag = el('span', { class: 'tag', text: m.id });
    // Flag models that carry per-model metadata, since the editor preserves it.
    if (Array.isArray(m.extra) && m.extra.length) {
      tag.title = `保存时保留现有字段：${m.extra.join(', ')}`;
      tag.classList.add('has-meta');
    }
    wrap.append(tag);
  }
  if (models.length > shown.length) {
    wrap.append(el('span', { class: 'tag more', text: `+${models.length - shown.length}` }));
  }
  if (!models.length) wrap.append(el('span', { class: 'hint', text: '未声明模型' }));
  return wrap;
}

function providerCard(p) {
  const card = el('div', { class: 'card' });

  const head = el('div', { class: 'card-head' }, [
    el('h3', { text: p.id }),
    el('span', { class: 'api', text: p.api || 'openai-completions' }),
  ]);
  card.append(head);

  const keyBadge = p.apiKeyRedacted
    ? '✓ 已配置密钥（已脱敏）'
    : p.hasApiKey
      ? '✓ 已配置密钥'
      : '未配置密钥';
  const badgeRow = el('div', { class: 'tags' }, [
    el('span', { class: `badge ${p.hasApiKey ? 'ok' : 'warn'}`, text: keyBadge }),
    el('span', { class: 'badge', text: `${p.models.length} 个模型` }),
  ]);
  card.append(badgeRow);

  card.append(el('div', { class: 'card-row' }, [
    el('span', { class: 'k', text: 'Base URL' }),
    el('span', { class: 'v', text: p.baseUrl || '—' }),
  ]));
  if (p.apiKeyHint) {
    card.append(el('div', { class: 'card-row' }, [
      el('span', { class: 'k', text: 'API Key' }),
      el('span', { class: 'v', text: p.apiKeyHint }),
    ]));
  }

  card.append(modelTags(p.models));

  const actions = el('div', { class: 'card-actions' }, [
    el('button', { class: 'btn small', text: '编辑', onclick: () => openModal(p) }),
    el('button', { class: 'btn small', text: '刷新模型', onclick: (e) => refreshModels(p, e.target) }),
    el('button', { class: 'btn small', text: '测试连接', onclick: (e) => testConnection(p.id, e.target) }),
    el('button', { class: 'btn small danger', text: '删除', onclick: () => removeProvider(p) }),
  ]);
  card.append(actions);

  return card;
}

function renderProviders() {
  const list = $('providerList');
  list.replaceChildren(...state.providers.map(providerCard));
  $('empty').classList.toggle('hidden', state.providers.length > 0);
}

/* ------------------------------------------------------------- data load --- */

async function refresh() {
  // Status is cosmetic — a failure here must not stop the provider list.
  try { await refreshStatus(); } catch { /* ignore */ }
  // Vault availability drives the modal control; never fatal if missing.
  try {
    const v = await api('/api/vault');
    state.vaultEnabled = Boolean(v.enabled);
    state.vaultReason = v.reason || null;
    state.vaultIds = new Set((v.entries || []).map((e) => e.id));
  } catch { state.vaultEnabled = false; state.vaultIds = new Set(); }
  try {
    const r = await api('/api/providers');
    state.providers = r.providers || [];
    $('configPath').textContent = r.configPath ? `配置：${r.configPath}` : '';
    renderProviders();
  } catch (err) {
    showAlert(`读取 Provider 失败：${err.message}`);
  }
}

/* ------------------------------------------------------------------ modal --- */

function resetModal() {
  state.remote = [];
  state.selected = new Set();
  state.knownMeta = new Map();
  $('fId').value = '';
  $('fBaseUrl').value = '';
  $('fApiKey').value = '';
  $('fApi').value = 'openai-completions';
  $('fManualModel').value = '';
  $('fRememberKey').checked = false;
  $('keyHint').textContent = '';
  $('discoverHint').textContent = '';
  renderVault();
  renderModels();
}

/**
 * Paint the vault block for the provider currently being edited.
 *
 * The vault only makes "refresh models" possible for an EXISTING provider, so
 * in add mode we simply say what it is for. When the server has no master key
 * the control is disabled and the reason shown — never hidden, since a missing
 * feature the user expects is worse than an explained one.
 */
function renderVault() {
  const box = $('vaultBlock');
  const opt = $('fRememberKey');
  const forget = $('btnForgetKey');
  const hint = $('vaultHint');
  const id = state.editingId;
  const stored = Boolean(id && state.vaultIds.has(id));

  if (!state.vaultEnabled) {
    opt.disabled = true;
    opt.checked = false;
    forget.classList.add('hidden');
    $('vaultStatus').textContent = '未启用';
    hint.textContent = `服务器未配置主密钥（PM_VAULT_KEY）：${state.vaultReason || '不可用'}。`;
    box.classList.remove('hidden');
    return;
  }

  opt.disabled = !id; // a new provider has no id to key the vault entry on yet
  opt.checked = stored;
  forget.classList.toggle('hidden', !stored);
  $('vaultStatus').textContent = stored ? '✓ 已保存密钥' : '可用';

  if (!id) {
    hint.textContent = '保存后可为该 Provider 加密留存密钥，届时「刷新模型」无需重新输入。';
  } else if (stored) {
    hint.textContent = '已加密保存密钥。若在上方输入新密钥，保存时将覆盖密钥库中的值。';
  } else {
    hint.textContent = '启用后，本工具会用它请求上游以刷新模型列表；密钥经 AES-256-GCM 加密存盘，接口只写不读。';
  }
}

function openModal(provider = null) {
  clearAlert();
  resetModal();
  state.editingId = provider ? provider.id : null;
  $('modalTitle').textContent = provider ? `编辑 Provider：${provider.id}` : '添加 Provider';

  if (provider) {
    $('fId').value = provider.id;
    $('fId').disabled = true; // renaming would orphan the existing entry
    $('fBaseUrl').value = provider.baseUrl || '';
    $('fApi').value = provider.api || 'openai-completions';
    $('keyHint').textContent = provider.apiKeyRedacted || provider.hasApiKey
      ? '留空则保持现有密钥不变' : '该 Provider 目前没有密钥';
    state.selected = new Set(provider.models.map((m) => m.id));
    state.remote = provider.models.map((m) => m.id);
    // Remember which models already carry metadata, so the editor can say so.
    state.knownMeta = new Map(
      provider.models.map((m) => [m.id, Array.isArray(m.extra) ? m.extra : []]),
    );
  } else {
    $('fId').disabled = false;
  }

  renderVault();
  renderModels();
  $('modal').classList.remove('hidden');
  $('fId').focus();
}

function closeModal() {
  $('modal').classList.add('hidden');
  state.editingId = null;
}

function renderModels() {
  const box = $('modelsList');
  const all = [...new Set([...state.remote, ...state.selected])].sort();
  $('modelsCount').textContent = all.length
    ? `已发现 ${state.remote.length} 个 · 已选 ${state.selected.size} 个`
    : '';

  if (!all.length) {
    box.replaceChildren(el('p', { class: 'hint', text: '点击「获取模型」以发现上游可用模型。' }));
    return;
  }

  box.replaceChildren(...all.map((id) => {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = state.selected.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(id); else state.selected.delete(id);
      renderModels();
    });
    const label = el('label', {}, [cb, el('code', { text: id })]);
    // Flag likely non-chat models so they don't get selected by accident.
    if (/image|video|embed|tts|whisper|rerank/i.test(id)) {
      label.append(el('span', { class: 'warnmark', text: '非对话' }));
    }
    // Warn that this model has stored metadata that will be kept.
    const meta = state.knownMeta.get(id);
    if (meta && meta.length) {
      label.append(el('span', {
        class: 'metamark',
        text: '保留字段',
        title: `保存时保留：${meta.join(', ')}`,
      }));
    }
    return label;
  }));
}

async function discover() {
  const baseUrl = $('fBaseUrl').value.trim();
  if (!baseUrl) return showAlert('请先填写 Base URL');

  const btn = $('btnDiscover');
  btn.disabled = true;
  $('discoverHint').textContent = '正在请求上游…';
  try {
    const r = await api('/api/discover', {
      method: 'POST',
      body: {
        baseUrl,
        api: $('fApi').value,
        apiKey: $('fApiKey').value.trim(),
        providerId: state.editingId || undefined,
      },
    });
    state.remote = r.models;
    // Preserve an existing selection; otherwise default to text models only.
    if (!state.selected.size) {
      for (const id of r.models) {
        if (!/image|video|embed|tts|whisper|rerank/i.test(id)) state.selected.add(id);
      }
    }
    renderModels();
    const note = r.keySource === 'redacted'
      ? '（已存密钥被脱敏；启用密钥库并保存后可自动刷新）'
      : r.keySource === 'missing'
        ? '（未使用 API Key）'
        : r.keySource === 'vault'
          ? '（使用密钥库中的密钥）'
          : '';
    $('discoverHint').textContent = `找到 ${r.count} 个模型${note}`;
  } catch (err) {
    $('discoverHint').textContent = '';
    // A 401/403 for a SAVED provider is the expected outcome when the stored
    // key is redacted and no vault copy exists — say what to do about it
    // rather than only echoing the upstream error.
    const authish = /401|403/.test(err.message);
    const tip = authish && state.editingId && !state.vaultIds.has(state.editingId)
      ? '\n\n提示：OpenClaw 对已存密钥脱敏，本工具无法用它请求上游。勾选下方「加密保存此密钥」并保存，之后即可直接刷新模型。'
      : '';
    showAlert(`获取模型失败：${err.message}${tip}`);
  } finally {
    btn.disabled = false;
  }
}

async function save() {
  const id = $('fId').value.trim();
  const baseUrl = $('fBaseUrl').value.trim();
  if (!id) return showAlert('Provider ID 不能为空');
  if (!baseUrl) return showAlert('Base URL 不能为空');
  if (!state.selected.size) return showAlert('请至少选择一个模型');

  const body = {
    id,
    baseUrl,
    api: $('fApi').value,
    apiKey: $('fApiKey').value.trim(),
    models: [...state.selected].sort().map((mid) => ({ id: mid, name: mid })),
  };

  const btn = $('btnSave');
  btn.disabled = true;
  try {
    const r = await api('/api/providers', { method: 'POST', body });

    // Sync the optional encrypted vault. Done AFTER the config write so a vault
    // failure can never leave the provider unsaved, and reported separately so
    // a vault problem is not mistaken for a config problem.
    let vaultNote = '';
    if (state.vaultEnabled && state.editingId) {
      try {
        if ($('fRememberKey').checked && body.apiKey) {
          await api('/api/vault', { method: 'POST', body: { id, apiKey: body.apiKey } });
          vaultNote = '；密钥已加密存入密钥库';
        } else if (!body.apiKey && !$('fRememberKey').checked && state.vaultIds.has(id)) {
          // Explicitly unchecked: honour the removal.
          await api(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' });
          vaultNote = '；已从密钥库移除密钥';
        } else if (body.apiKey && !$('fRememberKey').checked && state.vaultIds.has(id)) {
          vaultNote = '；密钥库中的旧密钥未变动';
        }
      } catch (vaultErr) {
        vaultNote = `；但密钥库操作失败：${vaultErr.message}`;
      }
    }

    closeModal();
    if (r.noop) {
      showAlert(`Provider「${id}」提交成功，但配置内容与已有值相同，未发生变化${vaultNote}。`);
    } else {
      const kept = (r.preserved || []).filter((p) => p.fields?.length);
      const metaNote = kept.length
        ? `\n已保留 ${kept.length} 个模型的现有字段：` +
          kept.slice(0, 3).map((p) => `${p.id}(${p.fields.length})`).join('、') +
          (kept.length > 3 ? ' 等' : '')
        : '';
      showAlert(`已保存 Provider「${id}」，共 ${body.models.length} 个模型${vaultNote}。${metaNote}`, 'ok');
    }
    await refresh();
  } catch (err) {
    showAlert(`保存失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function removeProvider(p) {
  if (!confirm(`确定删除 Provider「${p.id}」吗？\n\n这只会移除 OpenClaw 里的该 provider 配置，不会影响上游服务。`)) return;
  try {
    await api(`/api/providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    showAlert(`已删除 Provider「${p.id}」。`, 'ok');
    await refresh();
  } catch (err) {
    showAlert(`删除失败：${err.message}`);
  }
}

async function testConnection(id, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  // Clear any previous result, so a stale alert can't be mistaken for this one.
  clearAlert();
  try {
    let r = await api('/api/test', { method: 'POST', body: { id } });

    // A stored key is redacted by config.get and cannot be read back, so an
    // authenticated probe is impossible without re-entering it. Ask once and
    // retry. (This is not a fault: the gateway still holds a working key.)
    if (r.verificationSkipped) {
      const key = prompt(
        `「${id}」已配置密钥，但 OpenClaw 对密钥脱敏（这是正常的安全行为），本工具无法用它请求上游。\n\n` +
        '输入 API Key 可完整验证鉴权（留空则只报告可达性）：',
        '',
      );
      if (key && key.trim()) {
        r = await api('/api/test', { method: 'POST', body: { id, apiKey: key.trim() } });
      }
    }

    const lines = [
      `上游端点：${r.endpoint || '—'}`,
      `可达：${r.reachable ? '是' : '否'}`,
    ];

    if (r.authenticated) {
      lines.push(`鉴权：通过　上游模型：${r.upstreamModels} 个`);
      lines.push(`Gateway 已注册：${r.registered} 个`);
      showAlert(`「${id}」连接测试\n${lines.join('\n')}`, 'ok');
    } else if (r.verificationSkipped) {
      // Redacted key: reachable but we could not authenticate. Neutral tone.
      lines.push('鉴权：未验证（已存储的密钥被 OpenClaw 脱敏，无法用于探测）');
      lines.push(`Gateway 已注册：${r.registered} 个`);
      if (!r.reachable) lines.push('提示：上游不可达，请检查 Base URL 与网络。');
      showAlert(`「${id}」连接测试（未做鉴权验证）\n${lines.join('\n')}`, 'warn');
    } else {
      lines.push(`鉴权：未通过　上游模型：${r.upstreamModels} 个`);
      lines.push(`Gateway 已注册：${r.registered} 个`);
      if (r.keyState === 'missing') {
        lines.push('原因：该 Provider 未配置 API Key，而上游要求鉴权。');
      } else if (r.error) {
        lines.push(`错误：${r.error}`);
      }
      showAlert(`「${id}」连接测试\n${lines.join('\n')}`, 'error');
    }
  } catch (err) {
    showAlert(`测试失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * Refresh an existing provider's model list.
 *
 * Opens the editor and immediately re-queries the upstream, so the user
 * reviews the fresh list and decides what to save. Config is never written
 * from here — saving stays an explicit click.
 *
 * This is only possible because /api/discover falls back to the vault when
 * `config.get` returns the redaction sentinel (see server.js resolveApiKey).
 */
async function refreshModels(p) {
  openModal(p);
  await discover();
}

/* ------------------------------------------------------------------- wire --- */

$('btnAdd').addEventListener('click', () => openModal());
$('btnReload').addEventListener('click', () => refresh());
$('btnCloseModal').addEventListener('click', closeModal);
$('btnCancel').addEventListener('click', closeModal);
$('btnSave').addEventListener('click', save);
$('btnDiscover').addEventListener('click', discover);
$('btnForgetKey').addEventListener('click', async () => {
  const id = state.editingId;
  if (!id) return;
  if (!confirm(`从密钥库移除「${id}」的密钥？\n\nOpenClaw 配置里的密钥不受影响，但本工具将无法再为它刷新模型。`)) return;
  try {
    await api(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.vaultIds.delete(id);
    $('fRememberKey').checked = false;
    renderVault();
    showAlert(`已从密钥库移除「${id}」的密钥。`, 'ok');
  } catch (err) {
    showAlert(`移除失败：${err.message}`);
  }
});
$('btnLogin')?.addEventListener('click', doLogin);
$('fLoginToken')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('fApiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') discover(); });

$('btnSelectAll').addEventListener('click', () => {
  for (const id of state.remote) state.selected.add(id);
  renderModels();
});
$('btnSelectNone').addEventListener('click', () => {
  state.selected.clear();
  renderModels();
});
$('btnSelectText').addEventListener('click', () => {
  state.selected.clear();
  for (const id of state.remote) {
    if (!/image|video|embed|tts|whisper|rerank/i.test(id)) state.selected.add(id);
  }
  renderModels();
});
$('btnManualAdd').addEventListener('click', () => {
  const v = $('fManualModel').value.trim();
  if (!v) return;
  state.selected.add(v);
  if (!state.remote.includes(v)) state.remote.push(v);
  $('fManualModel').value = '';
  renderModels();
});
$('fManualModel').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('btnManualAdd').click(); }
});
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal();
});

/* ------------------------------------------------------------------- init --- */

(async () => {
  try {
    const s = await api('/api/session');
    state.authRequired = Boolean(s.authRequired);
    if (s.authRequired && !s.authed) {
      showLogin();
      return;
    }
  } catch { /* fall through to normal load */ }
  await refresh();
})();
