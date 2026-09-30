'use strict';

const R = globalThis.AdRipperRules;
const $ = (id) => document.getElementById(id);

let state = null;
let editing = null; // rule being edited, or null when adding

// ---- plumbing ----------------------------------------------------------------

async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Ad Ripper');
  return res.result;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function confirmDialog(text, okLabel = 'OK') {
  const dlg = $('confirm');
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

async function reload(fresh) {
  state = fresh || (await call('getState'));
  render();
}

async function run(fn, success) {
  try {
    await fn();
    await reload();
    if (success) toast(success);
  } catch (e) {
    toast(e.message || String(e));
  }
}

// ---- rendering -------------------------------------------------------------------

function describeScope(rule) {
  if (rule.scope_type === 'all') return 'All sites';
  if (rule.scope_type === 'url') return `URL: ${rule.scope_value}`;
  return rule.scope_value;
}

function describeTarget(rule) {
  switch (rule.action) {
    case 'inject_css':
    case 'inject_js':
      return rule.content.replace(/\s+/g, ' ').slice(0, 120);
    case 'inject_html':
      return `${rule.options.position || 'beforeend'} ${rule.target}: ${rule.content.replace(/\s+/g, ' ').slice(0, 90)}`;
    case 'snippet':
      return `${rule.target} — ${R.SNIPPETS[rule.target] || ''}`;
    case 'block': {
      const types = rule.options.resourceTypes;
      return rule.target + (types && types.length ? `  [${types.join(', ')}]` : '');
    }
    default:
      return rule.target;
  }
}

function filteredRules() {
  const q = $('search').value.trim().toLowerCase();
  const action = $('filter-action').value;
  const source = $('filter-source').value;
  const status = $('filter-status').value;
  return state.rules.filter((r) => {
    if (action && r.action !== action) return false;
    if (source === 'builtin' && !r.builtin) return false;
    if (source === 'custom' && r.builtin) return false;
    if (status === 'enabled' && !r.enabled) return false;
    if (status === 'disabled' && r.enabled) return false;
    if (status === 'error' && !r.error) return false;
    if (q) {
      const hay = [r.name, r.target, r.content, r.scope_value, R.ACTIONS[r.action]?.label].join('\n').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderRules() {
  const rules = filteredRules();
  const body = $('rules-body');
  body.replaceChildren(
    ...rules.map((r) =>
      el(
        'tr',
        { class: r.enabled ? '' : 'disabled', 'data-id': r.id },
        el(
          'td',
          {},
          el(
            'label',
            { class: 'switch', title: r.enabled ? 'Disable rule' : 'Enable rule' },
            el('input', {
              type: 'checkbox',
              checked: r.enabled,
              'aria-label': `Enable ${r.name}`,
              onchange: (e) => run(() => call('setRuleEnabled', { id: r.id, enabled: e.target.checked })),
            }),
            el('span')
          )
        ),
        el(
          'td',
          {},
          el('div', { class: 'rule-name' }, r.name, r.builtin ? el('span', { class: 'badge builtin' }, 'Built-in') : null),
          el('div', { class: 'rule-target mono' }, describeTarget(r)),
          r.error ? el('div', { class: 'rule-error' }, '⚠ ' + r.error) : null
        ),
        el('td', {}, el('span', { class: `badge a-${r.action}` }, R.ACTIONS[r.action]?.label || r.action)),
        el('td', { class: 'scope' }, describeScope(r)),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'tools' },
            el('button', { class: 'btn small', onclick: () => openEditor(r) }, 'Edit'),
            el('button', { class: 'btn small', title: 'Copy as a new custom rule', onclick: () => openEditor(r, { duplicate: true }) }, 'Duplicate')
          )
        )
      )
    )
  );
  $('rules-empty').hidden = rules.length > 0;
}

function renderAllowlist() {
  $('allow-list').replaceChildren(
    ...state.allowlist.map((d) =>
      el(
        'li',
        {},
        el('span', { class: 'mono' }, d),
        el(
          'button',
          { class: 'btn small danger', onclick: () => run(() => call('removeAllowlist', { domain: d }), `${d} removed`) },
          'Remove'
        )
      )
    )
  );
  $('allow-empty').hidden = state.allowlist.length > 0;
}

function renderSettings() {
  $('builtin-count').textContent = state.stats.builtin;
  $('db-size').textContent = `${(state.stats.dbBytes / 1024).toFixed(1)} KB`;
  const jsRules = state.rules.filter((r) => r.action === 'inject_js').length;
  const us = $('us-status');
  if (state.userScriptsAvailable) {
    us.className = 'ok';
    us.textContent = '✓ User scripts are allowed — JavaScript injection rules are active.';
  } else {
    us.className = 'warn';
    us.textContent = `JavaScript injection rules are currently inactive${jsRules ? ` (${jsRules} rule${jsRules > 1 ? 's' : ''} waiting)` : ''}.`;
  }
  $('us-help').hidden = state.userScriptsAvailable;
}

function render() {
  const s = state.stats;
  $('summary').textContent = `${s.enabled} of ${s.total} rules enabled · ${s.custom} custom · ${s.allowlist} allowlisted site${s.allowlist === 1 ? '' : 's'}`;
  $('global-enabled').checked = state.enabled;
  $('global-label').textContent = state.enabled ? 'Enabled' : 'Paused';
  const banner = $('banner');
  banner.hidden = state.enabled;
  banner.textContent = 'Ad Ripper is paused — no rules are being applied anywhere.';
  renderRules();
  renderAllowlist();
  renderSettings();
}

// ---- rule editor ---------------------------------------------------------------------

const TARGET_UI = {
  block: { label: 'URL filter', placeholder: 'ads.example.com  or  ||example.com/ads/*  or  /regex/', help: 'See "Network filter syntax" in Settings & data.' },
  hide: { label: 'CSS selector', placeholder: '.sponsored-banner, #top-ad', help: 'Matching elements are hidden with display: none.' },
  remove: { label: 'CSS selector', placeholder: '.sponsored-banner, #top-ad', help: 'Matching elements are deleted, including ones added later.' },
  inject_html: { label: 'Insert relative to (CSS selector)', placeholder: 'body', help: 'Your HTML is inserted once for each matching element. Defaults to body.' },
  snippet: { label: 'Snippet', placeholder: '', help: '' },
};

const CONTENT_UI = {
  inject_css: { label: 'CSS', placeholder: 'body { font-size: 18px !important; }' },
  inject_html: { label: 'HTML', placeholder: '<div class="note">Hello from Ad Ripper</div>' },
  inject_js: { label: 'JavaScript', placeholder: "document.title = '[ripped] ' + document.title;" },
};

function syncEditorFields() {
  const action = $('f-action').value;
  const scope = $('f-scope').value;

  document.querySelectorAll('#rule-form [data-for]').forEach((node) => {
    node.hidden = !node.dataset.for.split(' ').includes(action);
  });
  $('action-help').textContent = R.ACTIONS[action].help;

  // Network rules can't be scoped to a page URL.
  const urlOption = $('f-scope').querySelector('option[value="url"]');
  urlOption.disabled = action === 'block';
  if (action === 'block' && scope === 'url') $('f-scope').value = 'domain';

  const scopeNow = $('f-scope').value;
  $('scope-value-field').hidden = scopeNow === 'all';
  $('scope-value-label').textContent = scopeNow === 'domain' ? 'Domain' : 'URL pattern';
  $('f-scope-value').placeholder = scopeNow === 'domain' ? 'example.com' : 'https://example.com/articles/*';

  const t = TARGET_UI[action];
  if (t) {
    const isSnippet = action === 'snippet';
    $('target-label').textContent = t.label;
    $('f-target').hidden = isSnippet;
    $('f-snippet').hidden = !isSnippet;
    $('f-target').placeholder = t.placeholder;
    $('target-help').textContent = isSnippet ? R.SNIPPETS[$('f-snippet').value] : t.help;
  }
  const c = CONTENT_UI[action];
  if (c) {
    $('content-label').textContent = c.label;
    $('f-content').placeholder = c.placeholder;
  }
}

function openEditor(rule, { duplicate = false } = {}) {
  editing = rule && !duplicate ? rule : null;
  const r = rule || { action: 'hide', scope_type: 'domain', scope_value: '', target: '', content: '', options: {}, enabled: true, name: '' };

  $('editor-title').textContent = editing ? 'Edit rule' : duplicate ? 'Duplicate rule' : 'Add rule';
  $('editor-builtin').hidden = !(editing && editing.builtin);
  $('delete-rule').hidden = !editing || editing.builtin;
  $('f-action').value = r.action;
  $('f-name').value = duplicate ? `${r.name} (copy)` : r.name;
  $('f-scope').value = r.scope_type;
  $('f-scope-value').value = r.scope_value;
  $('f-target').value = r.action === 'snippet' ? '' : r.target;
  $('f-snippet').value = r.action === 'snippet' ? r.target : Object.keys(R.SNIPPETS)[0];
  $('f-content').value = r.content;
  $('f-position').value = r.options.position || 'beforeend';
  $('f-runat').value = r.options.runAt || 'document_idle';
  $('f-world').value = r.options.world || 'MAIN';
  const types = new Set(r.options.resourceTypes || []);
  $('f-types').querySelectorAll('input').forEach((i) => (i.checked = types.has(i.value)));
  $('f-enabled').checked = duplicate ? true : r.enabled;
  $('form-error').hidden = true;
  $('rule-error').hidden = !(editing && editing.error);
  $('rule-error').textContent = editing && editing.error ? '⚠ ' + editing.error : '';

  syncEditorFields();
  $('editor').showModal();
  (r.action === 'snippet' ? $('f-snippet') : $('f-target')).focus();
}

function readEditor() {
  const action = $('f-action').value;
  const options = {};
  if (action === 'block') options.resourceTypes = [...$('f-types').querySelectorAll('input:checked')].map((i) => i.value);
  if (action === 'inject_html') options.position = $('f-position').value;
  if (action === 'inject_js') {
    options.runAt = $('f-runat').value;
    options.world = $('f-world').value;
  }
  return {
    action,
    name: $('f-name').value.trim(), // blank → generated from the action and target
    scope_type: $('f-scope').value,
    scope_value: $('f-scope-value').value,
    target: action === 'snippet' ? $('f-snippet').value : $('f-target').value,
    content: $('f-content').value,
    options,
    enabled: $('f-enabled').checked,
  };
}

async function saveEditor(e) {
  e.preventDefault();
  const input = readEditor();
  try {
    R.normalizeRule(input); // same validation the service worker runs, with DOM selector checks
    const id = editing
      ? await call('updateRule', { id: editing.id, rule: input })
      : await call('addRule', { rule: input });
    await reload();
    const saved = state.rules.find((r) => r.id === id);
    $('editor').close();
    toast(saved && saved.error ? `Saved, but: ${saved.error}` : 'Rule saved');
  } catch (err) {
    $('form-error').textContent = err.message;
    $('form-error').hidden = false;
  }
}

// ---- wiring --------------------------------------------------------------------------

function setupStaticUi() {
  for (const [value, meta] of Object.entries(R.ACTIONS)) {
    $('filter-action').append(el('option', { value }, meta.label));
    $('f-action').append(el('option', { value }, meta.label));
  }
  for (const [value, label] of Object.entries(R.SCOPES)) $('f-scope').append(el('option', { value }, label));
  for (const [value] of Object.entries(R.SNIPPETS)) $('f-snippet').append(el('option', { value }, value));
  for (const type of R.RESOURCE_TYPES) {
    $('f-types').append(el('label', {}, el('input', { type: 'checkbox', value: type }), type));
  }
  $('reference').append(
    ...Object.values(R.ACTIONS).flatMap((a) => [el('dt', {}, a.label), el('dd', {}, a.help)]),
    ...Object.entries(R.SNIPPETS).flatMap(([name, help]) => [el('dt', {}, el('span', { class: 'mono' }, name)), el('dd', {}, help)])
  );

  document.querySelectorAll('.tabs button').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${btn.dataset.tab}`));
      history.replaceState(null, '', `#${btn.dataset.tab}`);
    })
  );
  const initial = document.querySelector(`.tabs button[data-tab="${location.hash.slice(1)}"]`);
  if (initial) initial.click();

  ['search', 'filter-action', 'filter-source', 'filter-status'].forEach((id) => $(id).addEventListener('input', renderRules));

  $('global-enabled').addEventListener('change', (e) =>
    run(() => call('setEnabled', { enabled: e.target.checked }), e.target.checked ? 'Ad Ripper enabled' : 'Ad Ripper paused')
  );

  $('add-rule').addEventListener('click', () => openEditor(null));
  $('f-action').addEventListener('change', syncEditorFields);
  $('f-scope').addEventListener('change', syncEditorFields);
  $('f-snippet').addEventListener('change', syncEditorFields);
  $('rule-form').addEventListener('submit', saveEditor);
  $('cancel-edit').addEventListener('click', () => $('editor').close());
  $('delete-rule').addEventListener('click', async () => {
    const rule = editing;
    if (!(await confirmDialog(`Delete "${rule.name}"?`, 'Delete'))) return;
    $('editor').close();
    run(() => call('deleteRule', { id: rule.id }), 'Rule deleted');
  });

  $('allow-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const domain = $('allow-domain').value;
    run(async () => {
      const d = await call('addAllowlist', { domain });
      $('allow-domain').value = '';
      toast(`${d} allowlisted`);
    });
  });

  $('reset-builtins').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Restore all built-in rules to their original state? Edits and enabled/disabled changes to built-in rules will be lost. Custom rules are kept.',
      'Reset'
    );
    if (ok) run(() => call('resetBuiltins'), 'Built-in rules restored');
  });

  $('resync').addEventListener('click', async () => {
    try {
      await reload(await call('sync'));
      toast('Rules re-applied');
    } catch (e) {
      toast(e.message);
    }
  });

  $('export-db').addEventListener('click', async () => {
    try {
      const b64 = await call('exportDb');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' }));
      const a = el('a', { href: url, download: `ad-ripper-${new Date().toISOString().slice(0, 10)}.sqlite` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast(e.message);
    }
  });

  $('import-db').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const ok = await confirmDialog(`Replace ALL current rules, allowlist and settings with "${file.name}"?`, 'Import');
    if (!ok) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    run(() => call('importDb', { base64: btoa(binary) }), 'Database imported');
  });

  // Keep in sync with changes made elsewhere (popup, element picker).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.snapshot && !$('editor').open) reload().catch(() => {});
  });
}

setupStaticUi();
reload(null)
  .then(() => call('sync').then((fresh) => reload(fresh)))
  .catch((e) => {
    $('summary').textContent = 'Could not load rules: ' + e.message;
  });
