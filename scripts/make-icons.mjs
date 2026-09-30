// Renders extension/icons/*.png from the SVG below using Playwright's Chromium.
// Usage: npm run icons
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

// A torn "AD" tag: the left and right halves are pulled apart along a jagged rip.
const svg = (bg) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <clipPath id="l"><path d="M0 0 H70 L58 30 L72 52 L56 76 L70 100 L60 128 H0 Z"/></clipPath>
    <clipPath id="r"><path d="M128 0 H70 L58 30 L72 52 L56 76 L70 100 L60 128 H128 Z"/></clipPath>
    <g id="tag">
      <rect x="8" y="8" width="112" height="112" rx="26" fill="${bg}"/>
      <text x="64" y="84" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900"
            font-size="56" fill="#fff" letter-spacing="-2">AD</text>
    </g>
  </defs>
  <g clip-path="url(#l)" transform="translate(-5 3) rotate(-4 64 64)"><use href="#tag"/></g>
  <g clip-path="url(#r)" transform="translate(5 -3) rotate(4 64 64)"><use href="#tag"/></g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [suffix, color] of [['', '#d93025'], ['-off', '#8a8a8e']]) {
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">
         <img style="display:block;width:${size}px;height:${size}px"
              src="data:image/svg+xml;base64,${Buffer.from(svg(color)).toString('base64')}">
       </body></html>`
    );
    const png = await page.screenshot({ omitBackground: true });
    writeFileSync(join(outDir, `icon${size}${suffix}.png`), png);
  }
}
writeFileSync(join(outDir, 'icon.svg'), svg('#d93025').trim() + '\n');
await browser.close();
console.log('Icons written to', outDir);
