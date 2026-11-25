// Puts the raw app shots of capture.cjs into the store screenshots: headline
// and subline (texts.cjs) on the brand background, the app inside a drawn
// device (template.html), at the exact store size, into fastlane/screenshots/.
//
// capture.cjs calls it after taking the shots. On its own it re-renders from
// the shots already in raw/, e.g. after changing a headline:
//   node scripts/store-screenshots/frame/frame.cjs   (ONLY=iphone69 works here too)
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TARGETS, LOCALES } = require('../targets.cjs');
const TEXTS = require('./texts.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const FASTLANE = path.join(ROOT, 'fastlane/screenshots');
const RAW = process.env.OUT ?? path.join(__dirname, '../raw');
const TEMPLATE = pathToFileURL(path.join(__dirname, 'template.html')).href;
const HERO = '01-overview';

const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
const font = (pkg, file) => dataUrl(path.join(ROOT, 'app/node_modules/@fontsource-variable', pkg, 'files', file), 'font/woff2');
const FONTS = `
  @font-face { font-family: 'Bricolage'; font-weight: 200 800; src: url(${font('bricolage-grotesque', 'bricolage-grotesque-latin-wght-normal.woff2')}) format('woff2'); }
  @font-face { font-family: 'Figtree'; font-weight: 300 900; src: url(${font('figtree', 'figtree-latin-wght-normal.woff2')}) format('woff2'); }`;
const ICON = dataUrl(path.join(ROOT, 'branding/kubernanny-icon-1024.png'), 'image/png');

const rawFile = (target, locale, file) => path.join(RAW, `${target.id}-${locale}-${file}.png`);

/**
 * Renders every shot of one target and language. `files` are the screen
 * files in store order; returns the problems found (missing shot, overflow).
 */
async function frameTarget(browser, target, locale, files) {
  const [W, H] = target.size;
  const [vw, vh] = target.viewport;
  const texts = TEXTS[locale.slice(0, 2)];
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(TEMPLATE);
  await page.addStyleTag({ content: FONTS });

  const shots = files
    .filter((file) => {
      const ok = fs.existsSync(rawFile(target, locale, file));
      if (!ok) {
        problems.push(`${target.id}/${locale} ${file}: no raw shot`);
      }
      return ok;
    })
    .map((file) => {
      // A tablet may word a shot differently (`<file>@tablet`).
      const [headline, subline] = (target.frame === 'tablet' && texts[`${file}@tablet`]) || texts[file] || [file, ''];
      return {
        file,
        data: {
          width: W, height: H, frame: target.frame, android: target.platform === 'android',
          headline, subline, hero: file === HERO, icon: ICON,
          screenshot: dataUrl(rawFile(target, locale, file), 'image/png'),
          screenAspect: vw / vh,
          statusShare: target.safe[0] / vh,
          bottomShare: target.safe[1] / vh,
        },
      };
    });

  // One device position and size for all shots of a target and language,
  // right under the tallest copy (the hero's, with the logo), so the device
  // does not jump while swiping.
  let deviceTop = 0;
  for (const shot of shots) {
    deviceTop = Math.max(deviceTop, await page.evaluate((d) => window.renderShot({ ...d, measureOnly: true }), shot.data));
  }

  const dir = path.join(FASTLANE, target.dir(locale));
  fs.mkdirSync(dir, { recursive: true });
  for (const shot of shots) {
    const found = await page.evaluate((d) => window.renderShot(d), { ...shot.data, deviceTop });
    problems.push(...found.map((p) => `${target.id}/${locale} ${shot.file}: ${p}`));
    await page.screenshot({ path: path.join(dir, `${target.id}-${shot.file}.png`), clip: { x: 0, y: 0, width: W, height: H } });
  }
  await ctx.close();
  return problems;
}

/** Removes a target's earlier files only: Play's icon and feature graphic sit next to them. */
function clearTarget(target, locale) {
  const dir = path.join(FASTLANE, target.dir(locale));
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${target.id}-`) && f.endsWith('.png')) {
      fs.rmSync(path.join(dir, f));
    }
  }
}

module.exports = { frameTarget, clearTarget };

if (require.main === module) {
  (async () => {
    const { chromium } = require('playwright');
    const files = Object.keys(TEXTS.en).filter((f) => !f.includes('@'));
    const browser = await chromium.launch();
    const problems = [];
    for (const locale of LOCALES) {
      for (const target of TARGETS) {
        clearTarget(target, locale);
        problems.push(...(await frameTarget(browser, target, locale, files)));
        console.log(`${target.id} ${locale}`);
      }
    }
    await browser.close();
    console.log(problems.length ? problems.join('\n') : 'all framed');
    process.exitCode = problems.length ? 1 : 0;
  })();
}
