/**
 * Renders the brand images in public/ from branding/kubernanny-ok.svg with
 * Playwright: og.png (1200x630), apple-touch-icon.png (180) and
 * favicon-32.png, plus favicon.svg as a copy. The results are committed;
 * run `npm run brand` again when the icon or the pitch changes.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    try { return require(join(root, '..', 'e2e', 'node_modules', 'playwright')); } catch { return require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
  }
})();

const iconPath = join(root, '..', 'branding', 'kubernanny-ok.svg');
const icon = readFileSync(iconPath, 'utf8');
// Inlined: a page set with setContent() may not load file:// URLs.
const font = (pkg, file) =>
  'data:font/woff2;base64,' + readFileSync(join(root, 'node_modules', '@fontsource-variable', pkg, 'files', file)).toString('base64');
const pitch = "Your cluster's nanny: one light, and only what is broken, with the cause and the fix.";

const og = `<!doctype html><html><head><style>
@font-face { font-family: 'Bricolage'; src: url(${font('bricolage-grotesque', 'bricolage-grotesque-latin-wght-normal.woff2')}); font-weight: 200 800; }
@font-face { font-family: 'Figtree'; src: url(${font('figtree', 'figtree-latin-wght-normal.woff2')}); font-weight: 300 900; }
html, body { margin: 0; width: 1200px; height: 630px; }
body { position: relative; overflow: hidden; background: #0f1626; color: #e9edf7; font-family: Figtree; }
.glow { position: absolute; inset: 0; background: radial-gradient(700px 420px at 88% 20%, rgba(111,132,234,.32), transparent 65%), radial-gradient(520px 360px at 0% 100%, rgba(54,214,168,.16), transparent 70%); }
.dots { position: absolute; inset: 0; background-image: radial-gradient(rgba(141,151,181,.22) 1px, transparent 1px); background-size: 28px 28px; -webkit-mask-image: radial-gradient(ellipse at 75% 30%, black, transparent 70%); }
.wrap { position: absolute; inset: 0; display: flex; align-items: center; gap: 64px; padding: 0 80px; }
.icon { width: 300px; height: 300px; flex: none; filter: drop-shadow(0 30px 50px rgba(0,0,0,.55)); transform: rotate(-4deg); }
.icon svg { width: 100%; height: 100%; }
.name { font-family: Bricolage; font-weight: 800; font-size: 92px; letter-spacing: -0.035em; line-height: 1; }
.pitch { margin-top: 26px; font-size: 36px; line-height: 1.32; color: #c3cbe0; max-width: 680px; }
.pitch b { color: #e9edf7; }
.url { margin-top: 30px; display: inline-flex; align-items: center; gap: 12px; font-size: 26px; font-weight: 700; color: #8ea2ff; }
.url i { width: 12px; height: 12px; border-radius: 50%; background: #36d6a8; box-shadow: 0 0 14px #36d6a8; }
</style></head><body>
<div class="glow"></div><div class="dots"></div>
<div class="wrap">
  <div class="icon">${icon}</div>
  <div>
    <div class="name">Kubernanny</div>
    <div class="pitch">Your cluster's nanny: <b>one light</b>, and only what is broken, with the cause and the fix.</div>
    <div class="url"><i></i>kubernanny.app</div>
  </div>
</div>
</body></html>`;

const square = (size, background) => `<!doctype html><html><head><style>
html, body { margin: 0; width: ${size}px; height: ${size}px; background: ${background}; }
svg { display: block; width: ${size}px; height: ${size}px; }
</style></head><body>${icon}</body></html>`;

const browser = await chromium.launch();
try {
  const shoot = async (html, width, height, file, omitBackground = false) => {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(root, 'public', file), omitBackground });
    await page.close();
    console.log(`public/${file}`);
  };
  await shoot(og, 1200, 630, 'og.png');
  // iOS rounds the corners itself, so the touch icon is a full square on the icon's own ground.
  await shoot(square(180, '#16213b'), 180, 180, 'apple-touch-icon.png');
  await shoot(square(32, 'transparent'), 32, 32, 'favicon-32.png', true);
} finally {
  await browser.close();
}
copyFileSync(iconPath, join(root, 'public', 'favicon.svg'));
console.log(`og pitch: ${pitch}`);
