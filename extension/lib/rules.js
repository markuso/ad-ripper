/*
 * Ad Ripper — shared rule model.
 *
 * Loaded by the service worker (importScripts), the content script (manifest),
 * the options/popup pages (<script>) and the Node test suite (require).
 * Everything here is pure: no chrome.* APIs and no DOM access except the
 * optional selector check.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdRipperRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ACTIONS = {
    block: { label: 'Block requests', kind: 'network', help: 'Blocks network requests (scripts, images, frames, video…) whose URL matches the filter.' },
    hide: { label: 'Hide elements', kind: 'content', help: 'Hides elements matching a CSS selector with an injected stylesheet.' },
    remove: { label: 'Remove elements', kind: 'content', help: 'Removes elements matching a CSS selector from the DOM, including ones added later.' },
    inject_css: { label: 'Inject CSS', kind: 'content', help: 'Adds your CSS to the page.' },
    inject_html: { label: 'Inject HTML', kind: 'content', help: 'Inserts your HTML relative to every element matching a CSS selector.' },
    inject_js: { label: 'Inject JavaScript', kind: 'userscript', help: 'Runs your JavaScript in the page. Requires "Allow User Scripts" to be enabled for the extension.' },
    snippet: { label: 'Built-in snippet', kind: 'content', help: 'Runs one of Ad Ripper\'s packaged behaviours (e.g. skipping video ads).' },
  };

  const SCOPES = {
    all: 'All sites',
    domain: 'Domain',
    url: 'URL pattern',
  };

  const SNIPPETS = {
    'skip-video-ads': 'Mutes, fast-forwards and auto-clicks "Skip" on in-player video ads (YouTube and Google IMA players).',
    'pause-ad-videos': 'Pauses, mutes and hides auto-playing videos that sit inside ad containers.',
  };

  const RESOURCE_TYPES = [
    'script', 'image', 'sub_frame', 'xmlhttprequest', 'media', 'stylesheet',
    'font', 'object', 'ping', 'websocket', 'webtransport', 'other', 'main_frame',
  ];

  const HTML_POSITIONS = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'];
  const RUN_AT = ['document_start', 'document_end', 'document_idle'];
  const WORLDS = ['MAIN', 'USER_SCRIPT'];

  // DNR ids for allowlist rules live far above any SQLite rowid we'll ever hand out.
  const ALLOWLIST_ID_BASE = 1000000000;

  class RuleError extends Error {}

  function str(v) {
    return v == null ? '' : String(v).trim();
  }

  /** "https://www.Example.com/foo" → "www.example.com"; "*.ads.net" → "ads.net". */
  function normalizeDomain(input) {
    let s = str(input).toLowerCase().replace(/^\*\.|^\.+/, '');
    if (!s) throw new RuleError('Domain is required.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
    let host;
    try {
      host = new URL(s).hostname;
    } catch {
      throw new RuleError(`"${str(input)}" is not a valid domain.`);
    }
    host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || /[\s/]/.test(host)) throw new RuleError(`"${str(input)}" is not a valid domain.`);
    return host;
  }

  function hostMatchesDomain(hostname, domain) {
    if (!hostname || !domain) return false;
    hostname = hostname.toLowerCase();
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  /**
   * URL patterns use "*" as a wildcard and are matched against the full URL.
   * A pattern without any "*" is a prefix match.
   */
  function urlPatternToRegExp(pattern) {
    const p = str(pattern);
    const body = p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp('^' + body + (p.includes('*') ? '$' : ''), 'i');
  }

  function scopeMatches(rule, url, hostname) {
    switch (rule.scope_type) {
      case 'all':
        return true;
      case 'domain':
        return hostMatchesDomain(hostname, rule.scope_value);
      case 'url':
        try {
          return urlPatternToRegExp(rule.scope_value).test(url);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  function isAllowlisted(hostname, allowlist) {
    return (allowlist || []).some((d) => hostMatchesDomain(hostname, d));
  }

  /** Validates a CSS selector when a DOM is available (options page, content script). */
  function isValidSelector(selector) {
    if (typeof document === 'undefined' || !document.createDocumentFragment) return true;
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch {
      return false;
    }
  }

  function defaultName(rule) {
    const label = ACTIONS[rule.action] ? ACTIONS[rule.action].label : rule.action;
    const what = rule.target || (rule.content || '').slice(0, 40);
    return what ? `${label}: ${what}` : label;
  }

  /**
   * Validates and normalizes user input into the stored rule shape.
   * Throws RuleError with a human-readable message on invalid input.
   */
  function normalizeRule(input) {
    input = input || {};
    const action = str(input.action);
    if (!ACTIONS[action]) throw new RuleError(`Unknown action "${action}".`);

    const scope_type = str(input.scope_type) || 'all';
    if (!SCOPES[scope_type]) throw new RuleError(`Unknown scope "${scope_type}".`);

    let scope_value = '';
    if (scope_type === 'domain') scope_value = normalizeDomain(input.scope_value);
    if (scope_type === 'url') {
      scope_value = str(input.scope_value);
      if (!scope_value) throw new RuleError('URL pattern is required.');
    }

    let target = str(input.target);
    let content = input.content == null ? '' : String(input.content);
    const rawOptions = input.options && typeof input.options === 'object' ? input.options : {};
    const options = {};

    switch (action) {
      case 'block': {
        if (!target) throw new RuleError('A URL filter is required.');
        if (scope_type === 'url') {
          throw new RuleError('Network block rules can apply to all sites or to a domain, not to a URL pattern.');
        }
        const types = Array.isArray(rawOptions.resourceTypes) ? rawOptions.resourceTypes : [];
        const bad = types.filter((t) => !RESOURCE_TYPES.includes(t));
        if (bad.length) throw new RuleError(`Unknown resource type(s): ${bad.join(', ')}.`);
        if (types.length) options.resourceTypes = [...new Set(types)];
        content = '';
        break;
      }
      case 'hide':
      case 'remove':
        if (!target) throw new RuleError('A CSS selector is required.');
        if (!isValidSelector(target)) throw new RuleError(`"${target}" is not a valid CSS selector.`);
        content = '';
        break;
      case 'inject_css':
        if (!content.trim()) throw new RuleError('CSS to inject is required.');
        target = '';
        break;
      case 'inject_html': {
        if (!content.trim()) throw new RuleError('HTML to inject is required.');
        target = target || 'body';
        if (!isValidSelector(target)) throw new RuleError(`"${target}" is not a valid CSS selector.`);
        const position = str(rawOptions.position) || 'beforeend';
        if (!HTML_POSITIONS.includes(position)) throw new RuleError(`Unknown position "${position}".`);
        options.position = position;
        break;
      }
      case 'inject_js': {
        if (!content.trim()) throw new RuleError('JavaScript to inject is required.');
        target = '';
        const runAt = str(rawOptions.runAt) || 'document_idle';
        if (!RUN_AT.includes(runAt)) throw new RuleError(`Unknown run-at value "${runAt}".`);
        const world = str(rawOptions.world) || 'MAIN';
        if (!WORLDS.includes(world)) throw new RuleError(`Unknown world "${world}".`);
        options.runAt = runAt;
        options.world = world;
        break;
      }
      case 'snippet':
        if (!SNIPPETS[target]) throw new RuleError(`Unknown snippet "${target}".`);
        content = '';
        break;
    }

    const rule = {
      action,
      scope_type,
      scope_value,
      target,
      content,
      options,
      enabled: input.enabled === undefined ? true : !!input.enabled,
    };
    rule.name = str(input.name) || defaultName(rule);
    return rule;
  }

  const PLAIN_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

  /** Stored "block" rule → chrome.declarativeNetRequest rule. */
  function toDnrRule(rule) {
    if (rule.action !== 'block') throw new RuleError('Only block rules map to network rules.');
    if (rule.scope_type === 'url') {
      throw new RuleError('Network block rules can apply to all sites or to a domain, not to a URL pattern.');
    }
    const condition = {};
    const t = rule.target;
    if (t.length > 2 && t.startsWith('/') && t.endsWith('/')) condition.regexFilter = t.slice(1, -1);
    else if (PLAIN_DOMAIN.test(t)) condition.urlFilter = `||${t.toLowerCase()}^`;
    else condition.urlFilter = t;

    const types = rule.options && rule.options.resourceTypes;
    if (types && types.length) condition.resourceTypes = types;
    if (rule.scope_type === 'domain') condition.initiatorDomains = [rule.scope_value];

    return { id: rule.id, priority: 1, action: { type: 'block' }, condition };
  }

  /** Allowlisted site → rule that lets every request made by that site through. */
  function allowlistDnrRule(domain, index) {
    return {
      id: ALLOWLIST_ID_BASE + index,
      priority: 1000,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] },
    };
  }

  const IP_OR_SINGLE_LABEL = /^(\d+\.\d+\.\d+\.\d+|[^.]+|.*:.*)$/;

  /** Stored "inject_js" rule → chrome.userScripts registration. */
  function toUserScript(rule) {
    const script = {
      id: `rule-${rule.id}`,
      js: [{ code: rule.content }],
      runAt: (rule.options && rule.options.runAt) || 'document_idle',
      world: (rule.options && rule.options.world) || 'MAIN',
      allFrames: false,
    };
    if (rule.scope_type === 'domain') {
      const d = rule.scope_value;
      script.matches = [IP_OR_SINGLE_LABEL.test(d) ? `*://${d}/*` : `*://*.${d}/*`];
    } else if (rule.scope_type === 'url') {
      script.matches = ['<all_urls>'];
      script.includeGlobs = [rule.scope_value.includes('*') ? rule.scope_value : rule.scope_value + '*'];
    } else {
      script.matches = ['<all_urls>'];
    }
    return script;
  }

  /**
   * Picks the content-side rules that apply to a page.
   * Returns null when blocking is off for this page.
   */
  function rulesForPage(snapshot, url, hostname, topHostname) {
    if (!snapshot || !snapshot.enabled) return null;
    if (isAllowlisted(topHostname || hostname, snapshot.allowlist)) return null;
    const out = { hide: [], remove: [], css: [], html: [], snippets: [] };
    for (const rule of snapshot.rules || []) {
      if (!scopeMatches(rule, url, hostname)) continue;
      switch (rule.action) {
        case 'hide': out.hide.push(rule.target); break;
        case 'remove': out.remove.push(rule.target); break;
        case 'inject_css': out.css.push(rule.content); break;
        case 'inject_html': out.html.push(rule); break;
        case 'snippet': out.snippets.push(rule.target); break;
      }
    }
    out.snippets = [...new Set(out.snippets)];
    return out;
  }

  return {
    ACTIONS,
    SCOPES,
    SNIPPETS,
    RESOURCE_TYPES,
    HTML_POSITIONS,
    RUN_AT,
    WORLDS,
    ALLOWLIST_ID_BASE,
    RuleError,
    normalizeDomain,
    hostMatchesDomain,
    urlPatternToRegExp,
    scopeMatches,
    isAllowlisted,
    isValidSelector,
    normalizeRule,
    toDnrRule,
    allowlistDnrRule,
    toUserScript,
    rulesForPage,
  };
});
