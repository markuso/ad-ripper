# Ad Ripper

A Chrome extension (Manifest V3) that removes ads from the pages you visit: ad-network requests, banners, sponsored-content widgets and auto-playing video ads. Every rule is stored in a local **SQLite** database, and you can view, edit, disable and add rules from the extension's own rules manager.

- **Blocks ads.** It blocks requests to around 70 ad, native-ad and video-ad networks, hides common banner and slot markup, removes ad iframes, and skips or pauses video ads.
- **Rules manager.** Search, filter, edit, duplicate, enable or disable any rule. Custom rules can be deleted.
- **Reset built-ins.** Puts every built-in rule back the way it shipped. Your custom rules and allowlist are kept.
- **Local SQLite database.** It uses [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly). The database file is kept in the extension's IndexedDB, and you can export or import it as a `.sqlite` file.
- **Custom rules for all sites, one domain, or a URL pattern.** Rules can block requests, hide or remove elements, or inject CSS, HTML or JavaScript.
- **Toolbar popup.** Pause Ad Ripper everywhere, allowlist the current site, see how many requests were blocked, or open the element picker to hide something with a click.

## Install it locally

You need Chrome 120 or newer (or Edge, Brave or another Chromium-based browser).

1. Get the code:
   ```bash
   git clone <this repo> ad-ripper
   ```
   You can also use the folder you already have. No build step is needed because the sql.js files are committed under `extension/vendor/`.
2. Open **`chrome://extensions`**.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and choose the **`ad-ripper/extension`** folder. Pick the `extension` subfolder, not the repository root.
5. Pin **Ad Ripper** from the puzzle-piece menu so its icon stays in the toolbar.
6. *(Optional, only needed for "Inject JavaScript" rules.)* On `chrome://extensions`, click **Details** under Ad Ripper and turn on **Allow User Scripts** (Chrome 138+). On Chrome 120–137, having Developer mode on is enough. Then open Ad Ripper → *Settings & data* → **Re-check & re-apply rules**.

Pages that were already open before you installed the extension need a reload.

**Updating:** after pulling new code, click the ↻ reload button on Ad Ripper's card in `chrome://extensions`. Your database is kept. New built-in rules are added, and your edits to existing ones are left alone.

**Uninstalling** deletes the extension's storage, and the database goes with it. Export it first if you want to keep your rules.

## Using it

### Toolbar popup

| Control | What it does |
|---|---|
| Top-right switch | Pause or resume Ad Ripper on every site |
| Site switch | Allowlist the current site (Ad Ripper does nothing there, including on its subdomains) |
| *requests blocked* | Number of network requests blocked in this tab |
| **Pick an element to hide…** | Hover over something on the page and click it. Adjust the selector if needed, choose *Hide* or *Remove* and where the rule applies, then save. |
| **Manage rules** | Opens the rules manager |

The number on the toolbar icon is how many requests were blocked on the current page.

### Rules manager

Open it from the popup, or right-click the toolbar icon and choose **Options**.

- **Rules tab.** Every rule, with custom rules listed first. Filter by action, built-in or custom, and status (including *Has problem*: rules Chrome rejected, which are shown with the reason). Use **Edit** to change a rule, **Duplicate** to copy it (built-ins too) as a new custom rule, and the switch to turn it on or off.
- **Allowlist tab.** Sites where Ad Ripper is turned off.
- **Settings & data tab.** Reset built-in rules, check the user-scripts permission, export or import the database, and a reference for the rule syntax.

### Rule types

| Action | Target field | Notes |
|---|---|---|
| **Block requests** | URL filter | Uses Chrome's `declarativeNetRequest`, so blocking happens before the request is sent. Optionally limit it to resource types (script, image, media, sub_frame…). |
| **Hide elements** | CSS selector | Injected as `display: none !important` at `document_start`, so the element doesn't flash on screen. |
| **Remove elements** | CSS selector | Hidden immediately, then deleted from the DOM. A `MutationObserver` also catches elements added later. |
| **Inject CSS** | CSS text | Added as a user-origin stylesheet, which takes priority over page styles and still works on pages with a strict CSP. |
| **Inject HTML** | CSS selector + position + HTML | Inserted once per matching element (`beforebegin`, `afterbegin`, `beforeend`, `afterend`). Removed again if you edit or disable the rule. |
| **Inject JavaScript** | JS code, run-at, world | Registered with `chrome.userScripts`. Runs in the page's own JavaScript context (`MAIN`) or an isolated one (`USER_SCRIPT`). |
| **Built-in snippet** | snippet name | `skip-video-ads` (mutes, fast-forwards and clicks "Skip" on in-player ads) or `pause-ad-videos` (pauses, mutes and hides autoplaying videos inside ad containers). |

### Scopes

| Scope | Example | Matches |
|---|---|---|
| All sites | – | every page |
| Domain | `example.com` | example.com and all of its subdomains. For **block** rules this means requests *made by* pages on that domain. |
| URL pattern | `https://example.com/news/*` | The full page URL. `*` is a wildcard. A pattern without `*` matches any URL that starts with it. Not available for block rules, because Chrome's network API can't see the page URL. |

### Network filter syntax

- `ads.example.com`: a bare domain blocks that domain and all of its subdomains.
- `||example.com/ads/*`: Chrome [`urlFilter`](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#property-RuleCondition-urlFilter) syntax. `||` anchors to a domain, `|` anchors to the start or end, `^` matches a separator, and `*` is a wildcard.
- `/banner\d+\.gif/`: text wrapped in slashes is treated as a regular expression.

## How it works

```
                 ┌──────────────── service worker (background.js) ─────────────────┐
 options page ──►│  sql.js (SQLite/WASM)  ◄──►  IndexedDB  (ad-ripper.sqlite bytes) │
 popup        ──►│        │                                                         │
 picker       ──►│        ├─► block rules + allowlist ─► declarativeNetRequest       │
                 │        ├─► inject_js rules         ─► chrome.userScripts          │
                 │        └─► everything else         ─► chrome.storage.local        │
                 └──────────────────────────────────────────────────┬──────────────┘
                                                                    │ snapshot
                                   content script (every frame, document_start)
                                   hide / remove / inject CSS & HTML / snippets
```

- The **SQLite database is the only place rules are stored.** The service worker loads it into sql.js on startup and saves the exported bytes back to IndexedDB after each change. It then rebuilds everything derived from the database: Chrome's network rules, the user-script registrations, and a snapshot of the page-side rules in `chrome.storage.local`.
- **Content scripts read that snapshot directly** at `document_start`, without waiting on the service worker, so cosmetic rules are in place before the page paints. They also watch the snapshot and apply rule changes to pages that are already open.
- **One bad filter doesn't break the rest.** If Chrome rejects a block rule or user script, Ad Ripper applies the other rules one at a time and records the error on the rejected rule, where the rules manager shows it.
- Built-in rules come from `extension/data/default-rules.json`. Each one has a stable key, so an extension update can add or retire built-ins without touching your changes to the others.

### Database schema

```sql
rules(id, builtin_key, builtin, name, action, scope_type, scope_value,
      target, content, options /* JSON */, enabled, error, created_at, updated_at)
allowlist(domain, created_at)
settings(key, value /* JSON */)      -- e.g. enabled, builtin_version
```

An exported file opens in any SQLite tool, for example `sqlite3 ad-ripper-2026-09-30.sqlite 'select name, action, target from rules where builtin = 0'`.

## Project layout

```
extension/            ← load this folder in chrome://extensions
  manifest.json
  background.js       service worker: database, rule sync, messaging
  lib/rules.js        rule model: validation, scope matching, DNR/userScripts conversion
  lib/db.js           SQLite RuleStore (schema, CRUD, built-in seeding/reset)
  lib/theme.css       shared styles
  content/content.js  cosmetic filtering, DOM injection, snippets, element picker
  popup/              toolbar popup
  options/            rules manager
  data/default-rules.json   built-in rules
  vendor/             sql.js WebAssembly build (MIT)
  icons/
scripts/              icon renderer, sql.js vendoring
test/                 unit tests (node:test) + end-to-end tests (Playwright)
```

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm install` installs sql.js and Playwright, which are only needed for tests and tooling.
- `npm test` runs the unit tests for the rule model and the SQLite store.
- `npm run test:e2e` loads the real extension into Playwright's Chromium and checks blocking, hiding, injection, allowlist, reset, the UI and persistence. Set `HEADED=1` to watch it run, or `SHOTS=dir` to save screenshots. If Chromium isn't installed yet, run `npx playwright install chromium` first.

Other scripts:

- `npm run vendor` copies a new sql.js build into `extension/vendor/` after you upgrade the package.
- `npm run icons` regenerates the PNG icons from the SVG in `scripts/make-icons.mjs`.

After editing extension code, reload the extension on `chrome://extensions`, then reload the tab you're testing on.

## Limitations

- YouTube and a few other sites serve ads from their own domains and change their markup often. The YouTube rules and the `skip-video-ads` snippet do their best, but may need updating.
- Blocking `imasdk.googleapis.com` stops most pre-roll video ads. It can also stop some sites' video players from loading at all; if that happens, disable the rule or allowlist the site.
- Chrome allows up to 30,000 dynamic network rules and 1,000 regex rules per extension.
