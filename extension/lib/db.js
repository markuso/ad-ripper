/*
 * Ad Ripper — SQLite rule store (sql.js / WebAssembly).
 *
 * The store is an in-memory SQLite database. Callers persist it by writing
 * `export()` somewhere durable (the service worker uses IndexedDB) and pass
 * those bytes back to the constructor on the next start.
 */
(function (root, factory) {
  const rules = typeof module === 'object' && module.exports ? require('./rules.js') : root.AdRipperRules;
  const api = factory(rules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdRipperDb = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

  const SCHEMA_VERSION = 1;

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      builtin_key  TEXT UNIQUE,
      builtin      INTEGER NOT NULL DEFAULT 0,
      name         TEXT NOT NULL DEFAULT '',
      action       TEXT NOT NULL,
      scope_type   TEXT NOT NULL DEFAULT 'all',
      scope_value  TEXT NOT NULL DEFAULT '',
      target       TEXT NOT NULL DEFAULT '',
      content      TEXT NOT NULL DEFAULT '',
      options      TEXT NOT NULL DEFAULT '{}',
      enabled      INTEGER NOT NULL DEFAULT 1,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS rules_action ON rules(action);
    CREATE TABLE IF NOT EXISTS allowlist (
      domain     TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;

  function rowToRule(row) {
    let options = {};
    try {
      options = JSON.parse(row.options || '{}');
    } catch {
      /* keep {} */
    }
    return {
      id: row.id,
      builtin: !!row.builtin,
      builtin_key: row.builtin_key || null,
      name: row.name,
      action: row.action,
      scope_type: row.scope_type,
      scope_value: row.scope_value,
      target: row.target,
      content: row.content,
      options,
      enabled: !!row.enabled,
      error: row.error || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Stable identity for a built-in rule in default-rules.json. */
  function builtinKey(def) {
    return def.key || [def.action, def.scope_type || 'all', def.scope_value || '', def.target || ''].join('|');
  }

  class RuleStore {
    /**
     * @param SQL   the initialised sql.js module
     * @param bytes Uint8Array of a previously exported database, or null
     */
    constructor(SQL, bytes) {
      this.db = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
      this.migrate();
    }

    migrate() {
      const version = this.get('PRAGMA user_version').user_version;
      if (version > SCHEMA_VERSION) {
        throw new Error(`Database schema v${version} is newer than this extension supports (v${SCHEMA_VERSION}).`);
      }
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }

    // ---- low-level helpers ----------------------------------------------

    all(sql, params) {
      const stmt = this.db.prepare(sql);
      try {
        if (params) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    }

    get(sql, params) {
      return this.all(sql, params)[0] || null;
    }

    run(sql, params) {
      this.db.run(sql, params);
      return this.db.getRowsModified();
    }

    transaction(fn) {
      this.db.exec('BEGIN');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }

    // ---- rules ------------------------------------------------------------

    listRules() {
      return this.all('SELECT * FROM rules ORDER BY builtin ASC, id ASC').map(rowToRule);
    }

    getRule(id) {
      const row = this.get('SELECT * FROM rules WHERE id = ?', [id]);
      return row ? rowToRule(row) : null;
    }

    requireRule(id) {
      const rule = this.getRule(id);
      if (!rule) throw new R.RuleError(`Rule ${id} does not exist.`);
      return rule;
    }

    insertRule(rule, key) {
      this.run(
        `INSERT INTO rules (builtin_key, builtin, name, action, scope_type, scope_value, target, content, options, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key || null,
          key ? 1 : 0,
          rule.name,
          rule.action,
          rule.scope_type,
          rule.scope_value,
          rule.target,
          rule.content,
          JSON.stringify(rule.options || {}),
          rule.enabled ? 1 : 0,
        ]
      );
      return this.get('SELECT last_insert_rowid() AS id').id;
    }

    addRule(input) {
      const id = this.insertRule(R.normalizeRule(input), null);
      return this.getRule(id);
    }

    updateRule(id, input) {
      const current = this.requireRule(id);
      const rule = R.normalizeRule({ ...current, ...input });
      this.run(
        `UPDATE rules SET name = ?, action = ?, scope_type = ?, scope_value = ?, target = ?, content = ?,
                          options = ?, enabled = ?, error = NULL, updated_at = datetime('now')
         WHERE id = ?`,
        [
          rule.name,
          rule.action,
          rule.scope_type,
          rule.scope_value,
          rule.target,
          rule.content,
          JSON.stringify(rule.options),
          rule.enabled ? 1 : 0,
          id,
        ]
      );
      return this.getRule(id);
    }

    setRuleEnabled(id, enabled) {
      this.requireRule(id);
      this.run(`UPDATE rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`, [enabled ? 1 : 0, id]);
      return this.getRule(id);
    }

    deleteRule(id) {
      const rule = this.requireRule(id);
      if (rule.builtin) throw new R.RuleError('Built-in rules cannot be deleted. Disable them instead.');
      this.run('DELETE FROM rules WHERE id = ?', [id]);
    }

    /**
     * Records the outcome of applying rules to the browser.
     * @param errors Map of rule id → message (or null to clear)
     * @returns true if anything changed
     */
    setErrors(errors) {
      let changed = 0;
      this.transaction(() => {
        for (const [id, message] of errors) {
          changed += this.run('UPDATE rules SET error = ? WHERE id = ? AND error IS NOT ?', [message, id, message]);
        }
      });
      return changed > 0;
    }

    // ---- built-in rules ---------------------------------------------------

    /**
     * Brings built-in rules in line with default-rules.json.
     *  - first run / reset: (re)creates every built-in rule exactly as shipped
     *  - new defaults version: adds new rules and drops retired ones, keeping
     *    the user's edits and enabled/disabled choices on the rest
     * @returns true if the database changed
     */
    syncBuiltins(defaults, { reset = false } = {}) {
      const version = String(defaults.version);
      if (!reset && this.getSetting('builtin_version', null) === version) return false;

      const wanted = new Map();
      for (const def of defaults.rules) wanted.set(builtinKey(def), def);

      this.transaction(() => {
        if (reset) this.run('DELETE FROM rules WHERE builtin = 1');
        const existing = new Set(this.all('SELECT builtin_key FROM rules WHERE builtin = 1').map((r) => r.builtin_key));
        for (const key of existing) {
          if (!wanted.has(key)) this.run('DELETE FROM rules WHERE builtin_key = ?', [key]);
        }
        for (const [key, def] of wanted) {
          if (!existing.has(key)) this.insertRule(R.normalizeRule(def), key);
        }
        this.setSetting('builtin_version', version);
      });
      return true;
    }

    resetBuiltins(defaults) {
      return this.syncBuiltins(defaults, { reset: true });
    }

    // ---- allowlist ----------------------------------------------------------

    listAllowlist() {
      return this.all('SELECT domain FROM allowlist ORDER BY domain').map((r) => r.domain);
    }

    addAllowlist(domain) {
      const d = R.normalizeDomain(domain);
      this.run('INSERT OR IGNORE INTO allowlist (domain) VALUES (?)', [d]);
      return d;
    }

    removeAllowlist(domain) {
      this.run('DELETE FROM allowlist WHERE domain = ?', [R.normalizeDomain(domain)]);
    }

    // ---- settings -----------------------------------------------------------

    getSetting(key, fallback) {
      const row = this.get('SELECT value FROM settings WHERE key = ?', [key]);
      if (!row) return fallback;
      try {
        return JSON.parse(row.value);
      } catch {
        return fallback;
      }
    }

    setSetting(key, value) {
      this.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)]
      );
    }

    // ---- misc ---------------------------------------------------------------

    stats() {
      const rows = this.all(
        `SELECT builtin, enabled, COUNT(*) AS n FROM rules GROUP BY builtin, enabled`
      );
      const s = { total: 0, builtin: 0, custom: 0, enabled: 0 };
      for (const r of rows) {
        s.total += r.n;
        s[r.builtin ? 'builtin' : 'custom'] += r.n;
        if (r.enabled) s.enabled += r.n;
      }
      s.allowlist = this.get('SELECT COUNT(*) AS n FROM allowlist').n;
      return s;
    }

    export() {
      return this.db.export();
    }

    close() {
      this.db.close();
    }
  }

  return { RuleStore, SCHEMA_VERSION, builtinKey };
});
