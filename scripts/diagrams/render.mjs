// Renders the diagrams in docs/diagrams/*.svg to docs/*.png (the README and
// the docs embed the PNG; GitHub and the website show it in light and dark).
// `node scripts/diagrams/render.mjs`, with e2e/ installed (Playwright's Chromium).
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(join(root, 'e2e/package.json'))('@playwright/test');
const source = join(root, 'docs/diagrams');

const browser = await chromium.launch();
for (const file of readdirSync(source).filter((f) => f.endsWith('.svg'))) {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  await page.goto(pathToFileURL(join(source, file)).href);
  const box = await page.locator('svg').boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  const out = join(root, 'docs', file.replace(/\.svg$/, '.png'));
  await page.locator('svg').screenshot({ path: out });
  console.log(`docs/${file.replace(/\.svg$/, '.png')}`);
  await page.close();
}
await browser.close();
