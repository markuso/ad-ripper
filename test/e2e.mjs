// End-to-end test: loads the unpacked extension into Playwright's Chromium and
// drives it against a local fixture site. Every hostname resolves to 127.0.0.1,
// so "ad" requests that are NOT blocked show up in the local server's log.
//
// Usage: npm run test:e2e   (set HEADED=1 to watch, SHOTS=dir to save screenshots)
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'extension');
const fixture = readFileSync(join(root, 'test', 'fixtures', 'page.html'), 'utf8');
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null;
if (shots) mkdirSync(shots, { recursive: true });

// ---- fixture server ------------------------------------------------------------

const hits = [];
const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  hits.push(`${host}${req.url}`);
  if (req.url.endsWith('.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end('window.adTagLoaded = true;');
  }
  if (req.url.endsWith('.gif')) {
    res.writeHead(200, { 'content-type': 'image/gif' });
    return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  }
  if (req.url === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<p>ad frame</p>');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fixture.replaceAll('{{PORT}}', String(server.address().port)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const site = (path = '/') => `http://news.test:${PORT}${path}`;
const hitsFor = (host) => hits.filter((h) => h.startsWith(host));

// ---- browser -------------------------------------------------------------------

const userDataDir = mkdtempSync(join(tmpdir(), 'ad-ripper-e2e-'));

async function launch() {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--host-resolver-rules=MAP * 127.0.0.1',
    ],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options/options.html`);
  await options.waitForFunction(() => /rules enabled/.test(document.getElementById('summary').textContent));
  const call = async (type, payload = {}) => {
    const res = await options.evaluate((msg) => chrome.runtime.sendMessage(msg), { type, ...payload });
    if (!res.ok) throw new Error(`${type}: ${res.error}`);
    return res.result;
  };
  return { context, extensionId, options, call };
}

async function visit(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.body && document.body.dataset.lateDone === '1');
  await page.waitForTimeout(250); // let the MutationObserver flush
  return page;
}

const display = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).display : 'absent';
  }, sel);

let passed = 0;
async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  await fn();
  passed++;
  console.log('ok');
}

let browser = await launch();
let { context, call, options } = browser;

try {
  await step('built-in rules are seeded into SQLite', async () => {
    const state = await call('getState');
    assert.ok(state.stats.builtin >= 100, `expected ≥100 built-ins, got ${state.stats.builtin}`);
    assert.equal(state.enabled, true);
    const rows = await options.locator('#rules-body tr').count();
    assert.equal(rows, state.rules.length);
  });

  await step('network ad requests are blocked, normal requests are not', async () => {
    hits.length = 0;
    const page = await visit(context, site('/'));
    assert.deepEqual(hitsFor('securepubads.g.doubleclick.net'), [], 'doubleclick tag should be blocked');
    assert.deepEqual(hitsFor('tpc.googlesyndication.com'), [], 'syndication frame should be blocked');
    assert.equal(hitsFor('cdn.example.test').length, 1, 'control image should load');
    assert.equal(await page.evaluate(() => window.adTagLoaded), undefined);
    await page.close();
  });

  await step('banners are hidden and ad iframes removed, including late ones', async () => {
    const page = await visit(context, site('/'));
    assert.equal(await display(page, '#adsense'), 'none');
    assert.equal(await display(page, '#div-gpt-ad-1234'), 'none');
    assert.equal(await display(page, '#late-banner'), 'none');
    assert.equal(await display(page, '#syndication'), 'absent');
    assert.equal(await display(page, '#promo'), 'block', 'no custom rule yet');
    if (shots) await page.screenshot({ path: join(shots, 'fixture-blocked.png') });
    await page.close();
  });

  await step('custom remove / inject rules scoped by domain and URL', async () => {
    await call('addRule', { rule: { action: 'remove', target: '.promo', scope_type: 'domain', scope_value: 'news.test' } });
    await call('addRule', { rule: { action: 'hide', target: '#only-on-a', scope_type: 'url', scope_value: site('/a') } });
    await call('addRule', {
      rule: { action: 'inject_html', target: '#content', content: '<p id="injected">Injected!</p>', options: { position: 'afterbegin' }, scope_type: 'domain', scope_value: 'news.test' },
    });
    await call('addRule', { rule: { action: 'inject_css', content: 'h1 { color: rgb(1, 2, 3) !important; }', scope_type: 'all' } });
    await call('addRule', { rule: { action: 'hide', target: 'h1', scope_type: 'domain', scope_value: 'elsewhere.test' } });

    const a = await visit(context, site('/a/story'));
    assert.equal(await display(a, '#promo'), 'absent');
    assert.equal(await display(a, '#late-promo'), 'absent');
    assert.equal(await display(a, '#only-on-a'), 'none');
    assert.equal(await a.evaluate(() => document.querySelector('#content').firstElementChild.id), 'injected');
    assert.equal(await a.evaluate(() => document.querySelectorAll('#injected').length), 1, 'injected once');
    assert.equal(await a.evaluate(() => getComputedStyle(document.querySelector('h1')).color), 'rgb(1, 2, 3)');
    assert.equal(await display(a, 'h1'), 'block', 'rule for another domain does not apply');
    if (shots) await a.screenshot({ path: join(shots, 'fixture-custom.png') });

    const b = await visit(context, site('/b'));
    assert.equal(await display(b, '#only-on-a'), 'block', 'URL-scoped rule does not apply to /b');
    await b.close();

    // Rules apply live to open pages when changed.
    const state = await call('getState');
    const cssRule = state.rules.find((r) => r.action === 'inject_css' && !r.builtin);
    await call('setRuleEnabled', { id: cssRule.id, enabled: false });
    await a.waitForFunction(() => getComputedStyle(document.querySelector('h1')).color !== 'rgb(1, 2, 3)');
    await a.close();
  });

  await step('custom network rule scoped to a domain', async () => {
    await call('addRule', { rule: { action: 'block', target: 'cdn.example.test', scope_type: 'domain', scope_value: 'news.test' } });
    hits.length = 0;
    const page = await visit(context, site('/'));
    assert.deepEqual(hitsFor('cdn.example.test'), []);
    await page.close();
  });

  await step('invalid network filters are reported instead of breaking everything', async () => {
    const id = await call('addRule', { rule: { action: 'block', target: '||*bad' } });
    const state = await call('getState');
    const rule = state.rules.find((r) => r.id === id);
    assert.ok(rule.error, 'expected an error on the rule');
    hits.length = 0;
    const page = await visit(context, site('/'));
    assert.deepEqual(hitsFor('securepubads.g.doubleclick.net'), [], 'other rules still apply');
    await page.close();
    await call('deleteRule', { id });
  });

  await step('JavaScript injection via chrome.userScripts', async () => {
    const id = await call('addRule', {
      rule: { action: 'inject_js', content: 'document.documentElement.dataset.ripped = "yes";', scope_type: 'domain', scope_value: 'news.test', options: { runAt: 'document_end' } },
    });
    let state = await call('getState');
    if (!state.userScriptsAvailable) {
      // Fresh profiles start with the permission off: the rule must be flagged, not silently ignored.
      assert.match(state.rules.find((r) => r.id === id).error, /Allow User Scripts/);
      // Flip "Allow User Scripts" the way a user would, then re-apply from the Settings tab.
      const ext = await context.newPage();
      await ext.goto(`chrome://extensions/?id=${browser.extensionId}`);
      await ext.locator('#allow-user-scripts cr-toggle').click();
      await ext.close();
      await options.click('.tabs button[data-tab="settings"]');
      await options.click('#resync');
      await options.waitForFunction(() => document.getElementById('us-status').className === 'ok');
      await options.click('.tabs button[data-tab="rules"]');
      state = await call('getState');
    }
    assert.equal(state.userScriptsAvailable, true);
    assert.equal(state.rules.find((r) => r.id === id).error, null);
    const page = await visit(context, site('/'));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.ripped), 'yes');
    await page.close();
  });

  await step('allowlisting a site turns everything off there', async () => {
    await call('addAllowlist', { domain: 'news.test' });
    hits.length = 0;
    const page = await visit(context, site('/'));
    assert.equal(hitsFor('securepubads.g.doubleclick.net').length, 1);
    assert.notEqual(await display(page, '#adsense'), 'none');
    assert.equal(await display(page, '#promo'), 'block');
    await page.close();
    await call('removeAllowlist', { domain: 'news.test' });
  });

  await step('pausing globally turns everything off', async () => {
    await call('setEnabled', { enabled: false });
    hits.length = 0;
    const page = await visit(context, site('/'));
    assert.equal(hitsFor('securepubads.g.doubleclick.net').length, 1);
    assert.notEqual(await display(page, '#adsense'), 'none');
    await page.close();
    await call('setEnabled', { enabled: true });
  });

  await step('reset restores built-in rules and keeps custom ones', async () => {
    let state = await call('getState');
    const builtin = state.rules.find((r) => r.builtin && r.target === 'doubleclick.net');
    await call('updateRule', { id: builtin.id, rule: { target: 'changed.example', enabled: false } });
    const customBefore = state.stats.custom;
    await call('resetBuiltins');
    state = await call('getState');
    const restored = state.rules.find((r) => r.builtin && r.target === 'doubleclick.net');
    assert.ok(restored && restored.enabled);
    assert.ok(!state.rules.some((r) => r.target === 'changed.example'));
    assert.equal(state.stats.custom, customBefore);
  });

  await step('options UI: add a rule through the editor form', async () => {
    await options.reload();
    await options.waitForFunction(() => /rules enabled/.test(document.getElementById('summary').textContent));
    await options.click('#add-rule');
    await options.selectOption('#f-action', 'hide');
    await options.selectOption('#f-scope', 'domain');
    await options.fill('#f-scope-value', 'https://www.example.org/some/page');
    await options.fill('#f-target', '.from-the-ui');
    await options.fill('#f-name', 'Added from UI');
    if (shots) await options.screenshot({ path: join(shots, 'options-editor.png') });
    await options.click('#save-rule');
    await options.waitForFunction(() => !document.getElementById('editor').open);
    await options.fill('#search', 'from-the-ui');
    const rows = options.locator('#rules-body tr');
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /Added from UI[\s\S]*www\.example\.org/);

    // Validation errors are shown inline, not saved.
    await options.click('#add-rule');
    await options.fill('#f-target', 'div[');
    await options.fill('#f-scope-value', 'example.org');
    await options.click('#save-rule');
    assert.match(await options.textContent('#form-error'), /not a valid CSS selector/);
    await options.click('#cancel-edit');
    await options.fill('#search', '');
    if (shots) {
      await options.setViewportSize({ width: 1280, height: 900 });
      await options.screenshot({ path: join(shots, 'options-rules.png') });
      await options.click('.tabs button[data-tab="settings"]');
      await options.screenshot({ path: join(shots, 'options-settings.png'), fullPage: true });
      await options.click('.tabs button[data-tab="rules"]');
    }
  });

  await step('database exports as a real SQLite file', async () => {
    const b64 = await call('exportDb');
    const header = Buffer.from(b64, 'base64').subarray(0, 15).toString();
    assert.equal(header, 'SQLite format 3');
  });

  await step('popup reports blocked requests for a tab', async () => {
    const page = await visit(context, site('/'));
    const tab = await options.evaluate(async (url) => (await chrome.tabs.query({ url }))[0], site('/'));
    const info = await call('getTabInfo', { tabId: tab.id, url: tab.url });
    assert.equal(info.host, 'news.test');
    assert.equal(info.allowlistedBy, null);
    assert.ok(info.blocked >= 2, `expected ≥2 blocked requests, got ${info.blocked}`);
    await page.close();

    const popup = await context.newPage();
    await popup.setViewportSize({ width: 320, height: 300 });
    await popup.goto(`chrome-extension://${browser.extensionId}/popup/popup.html`);
    await popup.waitForSelector('#not-web:not([hidden])'); // opened as a tab, the "current tab" is the popup itself
    assert.equal(await popup.isChecked('#global-enabled'), true);
    await popup.close();
  });

  await step('rules persist in SQLite across a browser restart', async () => {
    const before = await call('getState');
    await context.close();
    browser = await launch();
    ({ context, call, options } = browser);
    const after = await call('getState');
    assert.equal(after.stats.custom, before.stats.custom);
    assert.ok(after.rules.some((r) => r.name === 'Added from UI'));
    const page = await visit(context, site('/'));
    assert.equal(await display(page, '#promo'), 'absent', 'custom rule still applied after restart');
    await page.close();
  });

  console.log(`\n${passed} end-to-end checks passed.`);
} catch (e) {
  console.log('FAILED');
  console.error(e);
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
