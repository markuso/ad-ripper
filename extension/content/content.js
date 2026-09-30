/*
 * Ad Ripper — content script (runs at document_start in every frame).
 *
 * Reads the rule snapshot the service worker keeps in chrome.storage.local,
 * picks the rules whose scope matches this frame and applies them:
 *   hide        → stylesheet (display:none !important)
 *   remove      → hidden immediately, then removed by a MutationObserver
 *   inject_css  → stylesheet
 *   inject_html → inserted next to every matching element
 *   snippet     → packaged behaviours (video ad skipping, etc.)
 * It also hosts the element picker opened from the toolbar popup.
 */
(() => {
  'use strict';
  if (globalThis.__adRipperContentLoaded) return;
  globalThis.__adRipperContentLoaded = true;

  const R = globalThis.AdRipperRules;
  const INJECTED_ATTR = 'data-ad-ripper-injected';

  const state = {
    css: '',
    styleEl: null,
    removeSelector: '',
    htmlRules: [],
    injected: new Map(), // rule id → { key, nodes: Node[], done: WeakSet<Element> }
    snippets: new Map(), // name → stop()
    observer: null,
    flushTimer: 0,
    lastFlush: 0,
  };

  // ---- helpers ------------------------------------------------------------

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension was reloaded; this script is orphaned
    }
  }

  function topHostname() {
    const origins = location.ancestorOrigins;
    if (origins && origins.length) {
      try {
        return new URL(origins[origins.length - 1]).hostname;
      } catch {
        /* fall through */
      }
    }
    return location.hostname;
  }

  function validSelectors(list) {
    return list.filter((s) => {
      try {
        return CSS.supports(`selector(${s})`);
      } catch {
        return false;
      }
    });
  }

  // ---- stylesheet (hide / remove / inject_css) -------------------------------

  function setCss(css) {
    if (css === state.css) return;
    const previous = state.css;
    state.css = css;

    // A <style> element applies instantly at document_start…
    if (!state.styleEl) {
      state.styleEl = document.createElement('style');
      state.styleEl.setAttribute(INJECTED_ATTR, 'style');
    }
    state.styleEl.textContent = css;
    if (css && !state.styleEl.isConnected) (document.head || document.documentElement).append(state.styleEl);
    if (!css) state.styleEl.remove();

    // …and a user-origin sheet from the service worker survives strict page CSPs
    // and outranks page styles.
    if (previous) send({ type: 'removeCSS', css: previous });
    if (css) send({ type: 'insertCSS', css });
  }

  // ---- DOM work (remove / inject_html / snippets) ------------------------------

  function htmlKey(rule) {
    return JSON.stringify([rule.target, rule.content, rule.options && rule.options.position]);
  }

  function insertHtml(el, rule) {
    const template = document.createElement('template');
    template.innerHTML = rule.content;
    const nodes = [...template.content.childNodes];
    for (const n of nodes) if (n.nodeType === Node.ELEMENT_NODE) n.setAttribute(INJECTED_ATTR, String(rule.id));
    switch ((rule.options && rule.options.position) || 'beforeend') {
      case 'beforebegin': el.before(...nodes); break;
      case 'afterbegin': el.prepend(...nodes); break;
      case 'afterend': el.after(...nodes); break;
      default: el.append(...nodes);
    }
    return nodes;
  }

  function flush() {
    state.flushTimer = 0;
    state.lastFlush = performance.now();

    if (state.styleEl && state.css && !state.styleEl.isConnected) {
      (document.head || document.documentElement).append(state.styleEl);
    }

    if (state.removeSelector) {
      for (const el of document.querySelectorAll(state.removeSelector)) {
        if (!el.closest(`[${INJECTED_ATTR}]`)) el.remove();
      }
    }

    for (const rule of state.htmlRules) {
      const entry = state.injected.get(rule.id);
      let targets;
      try {
        targets = document.querySelectorAll(rule.target);
      } catch {
        continue;
      }
      for (const el of targets) {
        if (entry.done.has(el) || el.closest(`[${INJECTED_ATTR}]`)) continue;
        if (el === document.documentElement && /^(beforebegin|afterend)$/.test(rule.options?.position)) continue;
        entry.done.add(el);
        entry.nodes.push(...insertHtml(el, rule));
      }
    }
  }

  function scheduleFlush() {
    if (state.flushTimer) return;
    const wait = Math.max(0, 50 - (performance.now() - state.lastFlush));
    state.flushTimer = setTimeout(flush, wait);
  }

  function setObserver(needed) {
    if (needed && !state.observer) {
      state.observer = new MutationObserver(scheduleFlush);
      state.observer.observe(document.documentElement || document, { childList: true, subtree: true });
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', flush, { once: true });
    } else if (!needed && state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  function setHtmlRules(rules) {
    const wanted = new Map(rules.map((r) => [r.id, r]));
    // Drop injections whose rule was removed or edited.
    for (const [id, entry] of state.injected) {
      const rule = wanted.get(id);
      if (!rule || htmlKey(rule) !== entry.key) {
        entry.nodes.forEach((n) => n.remove());
        state.injected.delete(id);
      }
    }
    for (const rule of rules) {
      if (!state.injected.has(rule.id)) state.injected.set(rule.id, { key: htmlKey(rule), nodes: [], done: new WeakSet() });
    }
    state.htmlRules = rules;
  }

  // ---- snippets -------------------------------------------------------------------

  const AD_CONTAINER = /(^|[\s_-])(ad|ads|adv|advert|advertisement|advertising|sponsor|sponsored|outstream|preroll|video-?ad)([\s_-]|$)/i;

  function inAdContainer(el) {
    for (let n = el, depth = 0; n && n !== document.body && depth < 10; n = n.parentElement, depth++) {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (AD_CONTAINER.test(n.id) || AD_CONTAINER.test(cls)) return n;
    }
    return null;
  }

  const SNIPPET_IMPL = {
    'skip-video-ads'() {
      let mutedByUs = null;
      const tick = () => {
        const player = document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
        const video = player && player.querySelector('video');
        if (video) {
          if (!video.muted) {
            video.muted = true;
            mutedByUs = video;
          }
          video.playbackRate = 16;
          if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
        } else if (mutedByUs) {
          mutedByUs.muted = false;
          mutedByUs.playbackRate = 1;
          mutedByUs = null;
        }
        const skip = document.querySelectorAll(
          '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, .videoAdUiSkipButton'
        );
        skip.forEach((b) => b.click());
      };
      const timer = setInterval(tick, 300);
      tick();
      return () => clearInterval(timer);
    },

    'pause-ad-videos'() {
      const neutralise = (video) => {
        const container = inAdContainer(video);
        if (!container) return;
        video.pause();
        video.muted = true;
        video.autoplay = false;
        container.style.setProperty('display', 'none', 'important');
      };
      const onPlay = (e) => {
        if (e.target instanceof HTMLVideoElement) neutralise(e.target);
      };
      // "play" does not bubble, but it can be caught on the way down.
      document.addEventListener('play', onPlay, true);
      const scan = () => document.querySelectorAll('video[autoplay]').forEach(neutralise);
      const timer = setInterval(scan, 1500);
      scan();
      return () => {
        document.removeEventListener('play', onPlay, true);
        clearInterval(timer);
      };
    },
  };

  function setSnippets(names) {
    for (const [name, stop] of state.snippets) {
      if (!names.includes(name)) {
        stop();
        state.snippets.delete(name);
      }
    }
    for (const name of names) {
      if (!state.snippets.has(name) && SNIPPET_IMPL[name]) state.snippets.set(name, SNIPPET_IMPL[name]());
    }
  }

  // ---- applying the snapshot ----------------------------------------------------

  function apply(snapshot) {
    const page = R.rulesForPage(snapshot, location.href, location.hostname, topHostname()) || {
      hide: [], remove: [], css: [], html: [], snippets: [],
    };

    const hidden = validSelectors([...page.hide, ...page.remove]);
    let css = '';
    for (let i = 0; i < hidden.length; i += 200) {
      css += hidden.slice(i, i + 200).join(',\n') + ' { display: none !important; }\n';
    }
    css += page.css.join('\n');
    setCss(css);

    state.removeSelector = validSelectors(page.remove).join(', ');
    setHtmlRules(page.html);
    setSnippets(page.snippets);

    setObserver(!!(state.removeSelector || state.htmlRules.length));
    flush();
  }

  chrome.storage.local.get('snapshot').then(({ snapshot }) => apply(snapshot)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.snapshot) apply(changes.snapshot.newValue);
  });

  // ---- element picker (top frame only) ---------------------------------------------

  if (window !== window.top) return;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'startPicker') {
      startPicker();
      sendResponse({ ok: true });
    }
  });

  function cssPath(el) {
    const unique = (sel) => {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch {
        return false;
      }
    };
    if (el.id && !/\d{3,}/.test(el.id) && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);

    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      let part = n.localName;
      if (n.id && !/\d{3,}/.test(n.id)) {
        parts.unshift(`${part}#${CSS.escape(n.id)}`);
        if (unique(parts.join(' > '))) break;
        continue;
      }
      const classes = [...n.classList].filter((c) => !/\d{3,}|^(active|hover|focus|open|show|visible)$/.test(c)).slice(0, 3);
      if (classes.length) part += classes.map((c) => '.' + CSS.escape(c)).join('');
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === n.localName);
        if (same.length > 1 && !classes.length) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(' > ')) || parts.length >= 5) break;
    }
    return parts.join(' > ');
  }

  let picker = null;

  function startPicker() {
    if (picker) return;
    const host = document.createElement('ad-ripper-picker');
    host.setAttribute(INJECTED_ATTR, 'picker');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box { position: fixed; pointer-events: none; background: rgba(217,48,37,.18); outline: 2px solid #d93025; border-radius: 2px; transition: all .05s; }
        .match { position: fixed; pointer-events: none; outline: 2px dashed #d93025; }
        .panel { position: fixed; right: 16px; bottom: 16px; width: min(420px, calc(100vw - 32px)); pointer-events: auto;
                 font: 13px/1.4 system-ui, sans-serif; color: #1f1f1f; background: #fff; border-radius: 12px;
                 box-shadow: 0 8px 30px rgba(0,0,0,.3); padding: 14px; box-sizing: border-box; }
        .panel h2 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; }
        .panel p { margin: 0 0 10px; color: #555; }
        label { display: block; font-weight: 600; margin: 8px 0 4px; }
        textarea, select { width: 100%; box-sizing: border-box; font: 12px ui-monospace, monospace; padding: 6px; border: 1px solid #bbb; border-radius: 6px; }
        textarea { height: 56px; resize: vertical; }
        .row { display: flex; gap: 8px; }
        .row > div { flex: 1; }
        .buttons { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
        button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #bbb; background: #f4f4f4; cursor: pointer; }
        button.primary { background: #d93025; border-color: #d93025; color: #fff; }
        .count { font-weight: normal; color: #555; }
        .hint { color: #555; }
        [hidden] { display: none !important; }
      </style>
      <div class="box" hidden></div>
      <div class="matches"></div>
      <div class="panel">
        <h2>Ad Ripper picker <span class="count"></span></h2>
        <p class="hint">Hover an element and click it. Press Esc to cancel.</p>
        <div class="form" hidden>
          <label>CSS selector</label>
          <textarea class="selector" spellcheck="false"></textarea>
          <div class="row">
            <div><label>Action</label>
              <select class="action"><option value="hide">Hide</option><option value="remove">Remove from DOM</option></select></div>
            <div><label>Apply on</label>
              <select class="scope">
                <option value="domain">This site</option>
                <option value="url">This page only</option>
                <option value="all">All sites</option>
              </select></div>
          </div>
          <div class="buttons">
            <button class="parent" title="Select the parent element">Parent ↑</button>
            <button class="repick">Pick again</button>
            <button class="cancel">Cancel</button>
            <button class="primary save">Save rule</button>
          </div>
        </div>
        <div class="buttons idle"><button class="cancel">Cancel</button></div>
      </div>`;
    document.documentElement.append(host);

    const $ = (s) => root.querySelector(s);
    const box = $('.box');
    let hovered = null;
    let selected = null;

    const place = (el, node) => {
      const r = el.getBoundingClientRect();
      Object.assign(node.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };

    const showMatches = () => {
      const container = $('.matches');
      container.textContent = '';
      let els = [];
      try {
        els = [...document.querySelectorAll($('.selector').value)].filter((e) => e !== host);
      } catch {
        $('.count').textContent = 'invalid selector';
        return;
      }
      $('.count').textContent = `${els.length} match${els.length === 1 ? '' : 'es'}`;
      for (const el of els.slice(0, 50)) {
        const m = document.createElement('div');
        m.className = 'match';
        place(el, m);
        container.append(m);
      }
    };

    const select = (el) => {
      selected = el;
      box.hidden = true;
      $('.hint').textContent = 'Adjust the selector if needed, then save.';
      $('.form').hidden = false;
      $('.idle').hidden = true;
      $('.selector').value = cssPath(el);
      showMatches();
    };

    const onMove = (e) => {
      if (selected) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === host || el === hovered || el === document.documentElement || el === document.body) return;
      hovered = el;
      box.hidden = false;
      place(el, box);
    };

    // The shadow root is closed, so document-level listeners never see nodes inside it:
    // events from the panel arrive retargeted to the host element.
    const fromPanel = (e) => e.target === host;

    const onClick = (e) => {
      if (fromPanel(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!selected && hovered) select(hovered);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') stop();
    };

    const swallow = (e) => {
      if (!fromPanel(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    function stop() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      picker = null;
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('keydown', onKey, true);

    root.querySelectorAll('.cancel').forEach((b) => b.addEventListener('click', stop));
    $('.selector').addEventListener('input', showMatches);
    $('.parent').addEventListener('click', () => {
      if (selected && selected.parentElement && selected.parentElement !== document.body) select(selected.parentElement);
    });
    $('.repick').addEventListener('click', () => {
      selected = null;
      $('.form').hidden = true;
      $('.idle').hidden = false;
      $('.matches').textContent = '';
      $('.count').textContent = '';
      $('.hint').textContent = 'Hover an element and click it. Press Esc to cancel.';
    });
    $('.save').addEventListener('click', async () => {
      const scope = $('.scope').value;
      const target = $('.selector').value.trim();
      const res = await send({
        type: 'pickerAddRule',
        rule: {
          name: `Picked on ${location.hostname}`,
          action: $('.action').value,
          target,
          scope_type: scope,
          scope_value: scope === 'domain' ? location.hostname : scope === 'url' ? location.origin + location.pathname : '',
        },
      });
      if (res && res.ok) stop();
      else $('.count').textContent = (res && res.error) || 'Could not save rule';
    });

    picker = { stop };
  }
})();
