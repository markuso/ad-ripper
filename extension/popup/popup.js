'use strict';

const $ = (id) => document.getElementById(id);

async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Ad Ripper');
  return res.result;
}

function showError(e) {
  $('error').textContent = e.message || String(e);
  $('error').hidden = false;
}

let tab;
let info;

function render() {
  $('global-enabled').checked = info.enabled;
  if (!info.host) {
    $('not-web').hidden = false;
    return;
  }
  $('site').hidden = false;
  $('host').textContent = info.host;
  $('site-enabled').checked = !info.allowlistedBy;
  $('site-enabled').disabled = !info.enabled;
  $('pick').disabled = !info.enabled || !!info.allowlistedBy;
  $('blocked').textContent = info.blocked;
  $('site-status').textContent = !info.enabled
    ? 'Ad Ripper is paused everywhere'
    : info.allowlistedBy
      ? `Allowed (allowlist: ${info.allowlistedBy})`
      : 'Blocking ads on this site';
}

async function refresh() {
  info = await call('getTabInfo', { tabId: tab.id, url: tab.url || '' });
  render();
}

$('global-enabled').addEventListener('change', async (e) => {
  try {
    await call('setEnabled', { enabled: e.target.checked });
    await refresh();
    chrome.tabs.reload(tab.id);
  } catch (err) {
    showError(err);
  }
});

$('site-enabled').addEventListener('change', async (e) => {
  try {
    if (e.target.checked) await call('removeAllowlist', { domain: info.allowlistedBy });
    else await call('addAllowlist', { domain: info.host });
    await refresh();
    chrome.tabs.reload(tab.id);
  } catch (err) {
    showError(err);
  }
});

$('pick').addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'startPicker' });
    window.close();
  } catch {
    showError(new Error('Reload the page first — Ad Ripper was installed after it loaded.'));
  }
});

$('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await refresh();
  } catch (e) {
    showError(e);
  }
})();
