// Copies the sql.js browser build from node_modules into extension/vendor.
// The vendored files are committed, so this is only needed when upgrading sql.js.
// Usage: npm install && npm run vendor
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('sql.js/package.json'));
const vendor = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'vendor');

copyFileSync(join(pkgDir, 'dist', 'sql-wasm-browser.js'), join(vendor, 'sql-wasm.js'));
copyFileSync(join(pkgDir, 'dist', 'sql-wasm-browser.wasm'), join(vendor, 'sql-wasm.wasm'));
copyFileSync(join(pkgDir, 'LICENSE'), join(vendor, 'sql.js-LICENSE'));
console.log(`Vendored sql.js ${require('sql.js/package.json').version} into ${vendor}`);
