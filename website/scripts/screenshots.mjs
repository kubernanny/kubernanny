/**
 * Screenshots of the built site at phone and desktop width, dark and light:
 * `npm run screenshots` (after `npm run build`). Uses the Playwright install
 * that is on the machine (local dependency or the global one).
 *
 *   node scripts/screenshots.mjs [route ...]     default: / and /docs/protocol
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(join(globalRoot, 'playwright'));
  }
}

const { serve } = await import('./serve.ts');
const { chromium } = loadPlaywright();

const routes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['/', '/docs/protocol'];
const outDir = process.env.SCREENSHOT_DIR ?? new URL('../screenshots/', import.meta.url).pathname;
const viewports = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
];
const schemes = ['dark', 'light'];

mkdirSync(outDir, { recursive: true });
const port = 4400 + Math.floor(Math.random() * 400);
const server = await serve(port);
const browser = await chromium.launch();
const problems = [];

try {
  for (const route of routes) {
    for (const vp of viewports) {
      for (const scheme of schemes) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: vp.width < 500 ? 2 : 1,
          colorScheme: scheme,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => problems.push(`${route} ${vp.name} ${scheme}: ${e.message}`));
        page.on('console', (m) => {
          if (m.type() === 'error') {
            problems.push(`${route} ${vp.name} ${scheme}: console: ${m.text()}`);
          }
        });
        await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle' });
        // Load lazy images and let mermaid draw.
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 60));
          }
          window.scrollTo(0, 0);
          await document.fonts.ready;
        });
        await page.waitForLoadState('networkidle');
        await page
          .waitForFunction(() => document.querySelectorAll('pre.mermaid:not([data-processed="true"])').length === 0, null, { timeout: 15000 })
          .catch(() => problems.push(`${route} ${vp.name} ${scheme}: diagrams not drawn`));
        await page.waitForTimeout(400);
        const horizontal = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (horizontal > 0) {
          problems.push(`${route} ${vp.name} ${scheme}: page scrolls horizontally by ${horizontal}px`);
        }
        const slug = route === '/' ? 'home' : route.slice(1).replace(/\//g, '-');
        const file = join(outDir, `${slug}-${vp.name}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length > 0) {
  console.error('\nProblems:\n' + problems.join('\n'));
  process.exitCode = 1;
}
