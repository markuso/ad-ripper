/*
 * Ad Ripper — service worker.
 *
 * Owns the SQLite database (the single source of truth) and projects it onto
 * the browser:
 *   - "block" rules + allowlist → chrome.declarativeNetRequest dynamic rules
 *   - "inject_js" rules         → chrome.userScripts registrations
 *   - content-side rules        → a read-only snapshot in chrome.storage.local
 *                                 that content scripts read at document_start
 */
importScripts('vendor/sql-wasm.js', 'lib/rules.js', 'lib/db.js');

const R = self.AdRipperRules;
const { RuleStore } = self.AdRipperDb;

const DB_FILE = 'ad-ripper.sqlite';
const EXTENSION_ORIGIN = chrome.runtime.getURL('');

// ---- IndexedDB file storage for the SQLite image ---------------------------

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ad-ripper', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbFile(mode, name, bytes) {
  const idb = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction('files', mode);
      const store = tx.objectStore('files');
      const req = mode === 'readonly' ? store.get(name) : store.put(bytes, name);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    idb.close();
  }
}

// ---- store lifecycle --------------------------------------------------------

let sqlPromise;
let storePromise;
let persistChain = Promise.resolve();

function loadSql() {
  sqlPromise ??= initSqlJs({ locateFile: () => chrome.runtime.getURL('vendor/sql-wasm.wasm') });
  return sqlPromise;
}

async function loadDefaults() {
  const res = await fetch(chrome.runtime.getURL('data/default-rules.json'));
  return res.json();
}

async function openStore() {
  const [SQL, bytes, defaults] = await Promise.all([loadSql(), idbFile('readonly', DB_FILE), loadDefaults()]);
  let store;
  try {
    store = new RuleStore(SQL, bytes || null);
  } catch (e) {
    console.error('Ad Ripper: stored database is unreadable, starting fresh.', e);
    store = new RuleStore(SQL, null);
  }
  if (store.syncBuiltins(defaults) || !bytes) await persist(store);
  return store;
}

function getStore() {
  storePromise ??= openStore().catch((e) => {
    storePromise = null;
    throw e;
  });
  return storePromise;
}

function persist(store) {
  persistChain = persistChain.catch(() => {}).then(() => idbFile('readwrite', DB_FILE, store.export()));
  return persistChain;
}

// ---- projecting rules onto the browser -------------------------------------

let applyChain = Promise.resolve();

/** Serialises apply runs so concurrent edits never interleave DNR updates. */
function applyAll() {
  applyChain = applyChain.catch(() => {}).then(doApplyAll);
  return applyChain;
}

async function doApplyAll() {
  const store = await getStore();
  const enabled = store.getSetting('enabled', true);
  const rules = store.listRules();
  const allowlist = store.listAllowlist();
  const errors = new Map();

  await applyNetworkRules(enabled, rules, allowlist, errors);
  await applyUserScripts(enabled, rules, errors);

  if (store.setErrors(errors)) await persist(store);

  const contentActions = new Set(['hide', 'remove', 'inject_css', 'inject_html', 'snippet']);
  await chrome.storage.local.set({
    snapshot: {
      enabled,
      allowlist,
      rules: rules
        .filter((r) => r.enabled && contentActions.has(r.action))
        .map(({ id, action, scope_type, scope_value, target, content, options }) => ({
          id, action, scope_type, scope_value, target, content, options,
        })),
      updatedAt: Date.now(),
    },
  });

  await updateActionState(enabled);
}

async function applyNetworkRules(enabled, rules, allowlist, errors) {
  const wanted = [];
  for (const rule of rules) {
    if (rule.action !== 'block') continue;
    errors.set(rule.id, null);
    if (!enabled || !rule.enabled) continue;
    try {
      wanted.push(R.toDnrRule(rule));
    } catch (e) {
      errors.set(rule.id, e.message);
    }
  }
  allowlist.forEach((domain, i) => wanted.push(R.allowlistDnrRule(domain, i)));

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: wanted });
  } catch (batchError) {
    // One bad filter rejects the whole batch; add rules one at a time to find it.
    console.warn('Ad Ripper: batch DNR update failed, retrying rule by rule.', batchError);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    for (const dnr of wanted) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [dnr] });
      } catch (e) {
        if (dnr.id < R.ALLOWLIST_ID_BASE) errors.set(dnr.id, e.message);
        else console.error('Ad Ripper: allowlist rule rejected', dnr, e);
      }
    }
  }
}

function userScriptsAvailable() {
  try {
    // Throws (or is undefined) until "Allow User Scripts" / Developer mode is on.
    chrome.userScripts.getScripts().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function applyUserScripts(enabled, rules, errors) {
  const jsRules = rules.filter((r) => r.action === 'inject_js');
  jsRules.forEach((r) => errors.set(r.id, null));

  if (!userScriptsAvailable()) {
    for (const r of jsRules) {
      if (r.enabled) errors.set(r.id, 'Not running: enable "Allow User Scripts" for Ad Ripper (see Settings tab).');
    }
    return;
  }

  await chrome.userScripts.unregister();
  if (!enabled) return;

  const wanted = jsRules.filter((r) => r.enabled).map((r) => [r, R.toUserScript(r)]);
  try {
    await chrome.userScripts.register(wanted.map(([, s]) => s));
  } catch (batchError) {
    console.warn('Ad Ripper: batch user script registration failed, retrying one by one.', batchError);
    await chrome.userScripts.unregister();
    for (const [rule, script] of wanted) {
      try {
        await chrome.userScripts.register([script]);
      } catch (e) {
        errors.set(rule.id, e.message);
      }
    }
  }
}

async function updateActionState(enabled) {
  const variant = enabled ? '' : '-off';
  await chrome.action.setIcon({
    path: {
      16: `icons/icon16${variant}.png`,
      32: `icons/icon32${variant}.png`,
      48: `icons/icon48${variant}.png`,
      128: `icons/icon128${variant}.png`,
    },
  });
  await chrome.action.setTitle({ title: enabled ? 'Ad Ripper' : 'Ad Ripper (paused)' });
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: enabled });
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

// ---- messaging ----------------------------------------------------------------

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getState(store) {
  const bytes = store.export();
  return {
    enabled: store.getSetting('enabled', true),
    rules: store.listRules(),
    allowlist: store.listAllowlist(),
    stats: { ...store.stats(), dbBytes: bytes.length },
    userScriptsAvailable: userScriptsAvailable(),
    builtinVersion: store.getSetting('builtin_version', null),
  };
}

/** Runs a mutation, then persists and re-applies everything. */
async function mutate(fn) {
  const store = await getStore();
  const result = fn(store);
  await persist(store);
  await applyAll();
  return result;
}

const pageHandlers = {
  getState: async () => getState(await getStore()),
  sync: async () => {
    await applyAll();
    return getState(await getStore());
  },
  addRule: ({ rule }) => mutate((s) => s.addRule(rule).id),
  updateRule: ({ id, rule }) => mutate((s) => s.updateRule(id, rule).id),
  setRuleEnabled: ({ id, enabled }) => mutate((s) => s.setRuleEnabled(id, enabled).id),
  deleteRule: ({ id }) => mutate((s) => s.deleteRule(id)),
  resetBuiltins: async () => {
    const defaults = await loadDefaults();
    return mutate((s) => s.resetBuiltins(defaults));
  },
  setEnabled: ({ enabled }) => mutate((s) => s.setSetting('enabled', !!enabled)),
  addAllowlist: ({ domain }) => mutate((s) => s.addAllowlist(domain)),
  removeAllowlist: ({ domain }) => mutate((s) => s.removeAllowlist(domain)),
  exportDb: async () => toBase64((await getStore()).export()),
  importDb: async ({ base64 }) => {
    const [SQL, defaults, current] = await Promise.all([loadSql(), loadDefaults(), getStore()]);
    let imported;
    try {
      imported = new RuleStore(SQL, fromBase64(base64));
      imported.listRules();
    } catch (e) {
      throw new Error(`That file is not an Ad Ripper database: ${e.message}`);
    }
    imported.syncBuiltins(defaults);
    storePromise = Promise.resolve(imported);
    current.close();
    await persist(imported);
    await applyAll();
    return imported.stats();
  },
  getTabInfo: async ({ tabId, url }) => {
    const store = await getStore();
    let host = '';
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
    } catch {
      /* not a web page */
    }
    let blocked = 0;
    try {
      const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
      blocked = rulesMatchedInfo.filter((m) => m.rule.ruleId < R.ALLOWLIST_ID_BASE).length;
    } catch {
      /* not available for this tab */
    }
    const allowlist = store.listAllowlist();
    return {
      host,
      enabled: store.getSetting('enabled', true),
      allowlistedBy: allowlist.find((d) => R.hostMatchesDomain(host, d)) || null,
      blocked,
    };
  },
};

// Content scripts run inside web pages, so they only get a narrow API.
const contentHandlers = {
  insertCSS: ({ css }, sender) =>
    chrome.scripting.insertCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId] }, css, origin: 'USER' }),
  removeCSS: ({ css }, sender) =>
    chrome.scripting.removeCSS({ target: { tabId: sender.tab.id, frameIds: [sender.frameId] }, css, origin: 'USER' }),
  pickerAddRule: ({ rule }) => {
    if (!rule || !['hide', 'remove'].includes(rule.action)) throw new Error('The picker can only add hide/remove rules.');
    return mutate((s) => s.addRule(rule).id);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromExtensionPage = sender.id === chrome.runtime.id && (sender.url || '').startsWith(EXTENSION_ORIGIN);
  const handler = (fromExtensionPage && pageHandlers[msg?.type]) || (sender.tab && contentHandlers[msg?.type]);
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error?.message || String(error) })
    );
  return true;
});

chrome.runtime.onInstalled.addListener(() => applyAll().catch((e) => console.error('Ad Ripper: apply failed', e)));
chrome.runtime.onStartup.addListener(() => applyAll().catch((e) => console.error('Ad Ripper: apply failed', e)));
