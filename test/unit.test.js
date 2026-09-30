'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const R = require('../extension/lib/rules.js');
const { RuleStore, builtinKey } = require('../extension/lib/db.js');
const defaults = require('../extension/data/default-rules.json');

const sqlReady = initSqlJs();
async function freshStore(bytes = null) {
  const store = new RuleStore(await sqlReady, bytes);
  store.syncBuiltins(defaults);
  return store;
}

// ---- rules.js ---------------------------------------------------------------

test('normalizeDomain strips schemes, paths and wildcards', () => {
  assert.equal(R.normalizeDomain('https://WWW.Example.com/path?q=1'), 'www.example.com');
  assert.equal(R.normalizeDomain('*.ads.example.net'), 'ads.example.net');
  assert.equal(R.normalizeDomain('localhost:8080'), 'localhost');
  assert.throws(() => R.normalizeDomain(''), R.RuleError);
  assert.throws(() => R.normalizeDomain('exa mple.com'), R.RuleError);
});

test('domain scope matches the domain and its subdomains only', () => {
  const rule = { scope_type: 'domain', scope_value: 'example.com' };
  assert.ok(R.scopeMatches(rule, '', 'example.com'));
  assert.ok(R.scopeMatches(rule, '', 'news.example.com'));
  assert.ok(!R.scopeMatches(rule, '', 'badexample.com'));
  assert.ok(!R.scopeMatches(rule, '', 'example.com.evil.net'));
});

test('url scope: wildcards are anchored, plain patterns are prefixes', () => {
  const wild = { scope_type: 'url', scope_value: 'https://example.com/news/*' };
  assert.ok(R.scopeMatches(wild, 'https://example.com/news/a?b=1', 'example.com'));
  assert.ok(!R.scopeMatches(wild, 'https://example.com/sport/a', 'example.com'));
  const prefix = { scope_type: 'url', scope_value: 'https://example.com/a.b' };
  assert.ok(R.scopeMatches(prefix, 'https://example.com/a.b/c', 'example.com'));
  assert.ok(!R.scopeMatches(prefix, 'https://example.com/aXb', 'example.com'), 'dots are literal');
});

test('normalizeRule validates per action', () => {
  assert.throws(() => R.normalizeRule({ action: 'nope' }), /Unknown action/);
  assert.throws(() => R.normalizeRule({ action: 'hide' }), /selector is required/);
  assert.throws(() => R.normalizeRule({ action: 'block', target: 'x.com', scope_type: 'url', scope_value: 'https://a/' }), /not to a URL/);
  assert.throws(() => R.normalizeRule({ action: 'block', target: 'x.com', options: { resourceTypes: ['bogus'] } }), /resource type/);
  assert.throws(() => R.normalizeRule({ action: 'snippet', target: 'nope' }), /Unknown snippet/);
  assert.throws(() => R.normalizeRule({ action: 'inject_js', content: '  ' }), /JavaScript/);

  const html = R.normalizeRule({ action: 'inject_html', content: '<b>x</b>', scope_type: 'domain', scope_value: 'https://Foo.com/x' });
  assert.equal(html.target, 'body');
  assert.equal(html.options.position, 'beforeend');
  assert.equal(html.scope_value, 'foo.com');
  assert.match(html.name, /^Inject HTML/);

  const js = R.normalizeRule({ action: 'inject_js', content: 'alert(1)' });
  assert.deepEqual(js.options, { runAt: 'document_idle', world: 'MAIN' });
});

test('toDnrRule converts filters', () => {
  const base = { id: 7, action: 'block', scope_type: 'all', options: {} };
  assert.deepEqual(R.toDnrRule({ ...base, target: 'Ads.Example.com' }).condition, { urlFilter: '||ads.example.com^' });
  assert.deepEqual(R.toDnrRule({ ...base, target: '||x.com/ads/*' }).condition, { urlFilter: '||x.com/ads/*' });
  assert.deepEqual(R.toDnrRule({ ...base, target: '/ban+er/' }).condition, { regexFilter: 'ban+er' });
  const scoped = R.toDnrRule({ ...base, target: 'x.com', scope_type: 'domain', scope_value: 'news.com', options: { resourceTypes: ['script'] } });
  assert.deepEqual(scoped.condition, { urlFilter: '||x.com^', resourceTypes: ['script'], initiatorDomains: ['news.com'] });
  assert.equal(scoped.id, 7);
});

test('toUserScript builds match patterns from scope', () => {
  const base = { id: 3, action: 'inject_js', content: 'x()', options: { runAt: 'document_end', world: 'MAIN' } };
  assert.deepEqual(R.toUserScript({ ...base, scope_type: 'domain', scope_value: 'example.com' }).matches, ['*://*.example.com/*']);
  assert.deepEqual(R.toUserScript({ ...base, scope_type: 'domain', scope_value: 'localhost' }).matches, ['*://localhost/*']);
  const url = R.toUserScript({ ...base, scope_type: 'url', scope_value: 'https://a.com/x' });
  assert.deepEqual(url.includeGlobs, ['https://a.com/x*']);
  assert.equal(url.id, 'rule-3');
  assert.equal(url.runAt, 'document_end');
});

test('rulesForPage honours enabled flag, allowlist and scopes', () => {
  const snapshot = {
    enabled: true,
    allowlist: ['safe.com'],
    rules: [
      { action: 'hide', scope_type: 'all', target: '.ad' },
      { action: 'remove', scope_type: 'domain', scope_value: 'news.com', target: '#promo' },
      { action: 'inject_css', scope_type: 'url', scope_value: 'https://news.com/a/*', content: 'p{}' },
      { action: 'snippet', scope_type: 'all', target: 'pause-ad-videos' },
      { action: 'snippet', scope_type: 'all', target: 'pause-ad-videos' },
    ],
  };
  const page = R.rulesForPage(snapshot, 'https://www.news.com/a/1', 'www.news.com');
  assert.deepEqual(page.hide, ['.ad']);
  assert.deepEqual(page.remove, ['#promo']);
  assert.deepEqual(page.css, []);
  assert.deepEqual(page.snippets, ['pause-ad-videos']);
  assert.deepEqual(R.rulesForPage(snapshot, 'https://news.com/a/1', 'news.com').css, ['p{}']);
  assert.equal(R.rulesForPage(snapshot, 'https://x.safe.com/', 'x.safe.com'), null);
  assert.equal(R.rulesForPage(snapshot, 'https://ad.net/', 'ad.net', 'safe.com'), null, 'frames inherit top-level allowlist');
  assert.equal(R.rulesForPage({ ...snapshot, enabled: false }, 'https://a.com/', 'a.com'), null);
});

// ---- default-rules.json -------------------------------------------------------

test('every built-in rule is valid and uniquely keyed', () => {
  const keys = new Set();
  for (const def of defaults.rules) {
    const rule = R.normalizeRule(def);
    if (rule.action === 'block') R.toDnrRule({ ...rule, id: 1 });
    const key = builtinKey(def);
    assert.ok(!keys.has(key), `duplicate built-in ${key}`);
    keys.add(key);
  }
});

// ---- db.js --------------------------------------------------------------------------

test('fresh store seeds built-ins and default settings', async () => {
  const store = await freshStore();
  const stats = store.stats();
  assert.equal(stats.builtin, defaults.rules.length);
  assert.equal(stats.custom, 0);
  assert.equal(store.getSetting('enabled', true), true);
  assert.equal(store.getSetting('builtin_version'), String(defaults.version));
  assert.equal(store.syncBuiltins(defaults), false, 'second sync is a no-op');
});

test('custom rule CRUD', async () => {
  const store = await freshStore();
  const rule = store.addRule({ action: 'hide', target: '.promo', scope_type: 'domain', scope_value: 'example.com' });
  assert.equal(rule.builtin, false);
  assert.equal(rule.scope_value, 'example.com');

  const updated = store.updateRule(rule.id, { target: '.promo, .banner', name: 'Promo boxes' });
  assert.equal(updated.target, '.promo, .banner');
  assert.equal(updated.name, 'Promo boxes');
  assert.equal(updated.scope_value, 'example.com', 'unchanged fields are kept');

  assert.equal(store.setRuleEnabled(rule.id, false).enabled, false);
  assert.throws(() => store.updateRule(rule.id, { target: '' }), /selector is required/);

  store.deleteRule(rule.id);
  assert.equal(store.getRule(rule.id), null);
  assert.throws(() => store.deleteRule(rule.id), /does not exist/);
});

test('built-in rules can be edited and disabled but not deleted; reset restores them', async () => {
  const store = await freshStore();
  const custom = store.addRule({ action: 'block', target: 'tracker.example' });
  const builtin = store.listRules().find((r) => r.builtin && r.action === 'block');

  assert.throws(() => store.deleteRule(builtin.id), /cannot be deleted/);
  store.updateRule(builtin.id, { target: 'changed.example', enabled: false });
  const hide = store.listRules().find((r) => r.builtin && r.action === 'hide');
  store.setRuleEnabled(hide.id, false);

  store.resetBuiltins(defaults);
  const after = store.listRules();
  const builtins = after.filter((r) => r.builtin);
  assert.equal(builtins.length, defaults.rules.length);
  assert.ok(builtins.every((r) => r.enabled !== false || defaults.rules.find((d) => builtinKey(d) === r.builtin_key).enabled === false));
  assert.ok(!builtins.some((r) => r.target === 'changed.example'));
  assert.ok(after.some((r) => r.id === custom.id), 'custom rules survive a reset');
});

test('upgrading defaults adds new and retires removed built-ins, keeping user edits', async () => {
  const store = await freshStore();
  const first = store.listRules().find((r) => r.builtin);
  store.setRuleEnabled(first.id, false);

  const retired = defaults.rules[1];
  const next = {
    version: defaults.version + 1,
    rules: [...defaults.rules.filter((r) => r !== retired), { name: 'New network', action: 'block', target: 'new-ads.example' }],
  };
  assert.equal(store.syncBuiltins(next), true);
  const rules = store.listRules();
  assert.ok(rules.some((r) => r.target === 'new-ads.example' && r.builtin));
  assert.ok(!rules.some((r) => r.builtin_key === builtinKey(retired)));
  assert.equal(store.getRule(first.id).enabled, false, 'user choice kept across upgrade');
});

test('allowlist and settings', async () => {
  const store = await freshStore();
  assert.equal(store.addAllowlist('https://www.Example.com/page'), 'www.example.com');
  store.addAllowlist('www.example.com'); // duplicate is ignored
  store.addAllowlist('other.org');
  assert.deepEqual(store.listAllowlist(), ['other.org', 'www.example.com']);
  store.removeAllowlist('other.org');
  assert.deepEqual(store.listAllowlist(), ['www.example.com']);

  store.setSetting('enabled', false);
  assert.equal(store.getSetting('enabled', true), false);
});

test('setErrors records and clears rule errors', async () => {
  const store = await freshStore();
  const rule = store.addRule({ action: 'block', target: '||bad' });
  assert.equal(store.setErrors(new Map([[rule.id, 'Invalid filter']])), true);
  assert.equal(store.getRule(rule.id).error, 'Invalid filter');
  assert.equal(store.setErrors(new Map([[rule.id, 'Invalid filter']])), false, 'unchanged');
  store.setErrors(new Map([[rule.id, null]]));
  assert.equal(store.getRule(rule.id).error, null);
});

test('export/import round-trips through a real SQLite file', async () => {
  const store = await freshStore();
  store.addRule({ action: 'inject_css', content: 'body{color:red}', scope_type: 'url', scope_value: 'https://a.com/*' });
  store.addAllowlist('keep.me');
  const bytes = store.export();
  assert.equal(Buffer.from(bytes.subarray(0, 15)).toString(), 'SQLite format 3');

  const copy = await freshStore(bytes);
  assert.deepEqual(copy.listRules(), store.listRules());
  assert.deepEqual(copy.listAllowlist(), ['keep.me']);
});

test('opening a newer schema is refused', async () => {
  const SQL = await sqlReady;
  const db = new SQL.Database();
  db.exec('PRAGMA user_version = 99');
  assert.throws(() => new RuleStore(SQL, db.export()), /newer/);
});
