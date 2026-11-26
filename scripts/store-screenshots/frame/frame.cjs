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

// Whole device screenshots (home screen with the widgets), taken on a
// simulator or emulator, not in the browser: committed, since they cannot be
// rendered here (docs/RELEASING.md, Screenshots). Same name as a raw shot.
const DEVICE = path.join(__dirname, '../device');
const deviceFile = (target, locale, file) => path.join(DEVICE, `${target.id}-${locale}-${file}.jpg`);
const rawFile = (target, locale, file) => {
  const device = deviceFile(target, locale, file);
  return fs.existsSync(device) ? device : path.join(RAW, `${target.id}-${locale}-${file}.png`);
};
const isDeviceShot = (file) => file.startsWith(DEVICE + path.sep);
const imageUrl = (file) => dataUrl(file, isDeviceShot(file) ? 'image/jpeg' : 'image/png');

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
          screenshot: imageUrl(rawFile(target, locale, file)),
          deviceShot: isDeviceShot(rawFile(target, locale, file)),
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

/**
 * The App Store's product page header (21:9) and search result asset (3:2),
 * and Google Play's feature graphic, from the same shots as the screenshots.
 * App Store Connect takes the first two only by hand (docs/RELEASING.md).
 * `target` names the size whose shots and device are shown.
 */
const BANNERS = [
  { id: 'apple-header', size: [3840, 1646], kind: 'header', target: 'iphone69', shots: ['01-overview', '08-widgets'], dir: (l) => `banners/${l}`, layout: { phoneX: [.545, .77] } },
  // Not 02-issues: the overview above already shows the same list.
  { id: 'apple-search', size: [3840, 2560], kind: 'search', target: 'iphone69', shots: ['01-overview', '03-nodes', '08-widgets'], dir: (l) => `banners/${l}` },
  {
    id: 'featureGraphic', size: [1024, 500], kind: 'header', target: 'phone', shots: ['01-overview', '08-widgets'], dir: (l) => `android/${l}/images`,
    layout: { claimSize: 8.6, nameSize: 6.4, textWidth: .48, textLeft: .06, phoneW: .215, phoneX: [.535, .765], phoneY: [11, 18] },
  },
];

/** Renders the banners of one language; returns the problems found. */
async function frameBanners(browser, locale) {
  const { ALL } = require('../targets.cjs');
  const texts = TEXTS[locale.slice(0, 2)].banner;
  const problems = [];
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(TEMPLATE);
  await page.addStyleTag({ content: FONTS });
  for (const banner of BANNERS) {
    const target = ALL.find((t) => t.id === banner.target);
    const missing = banner.shots.filter((f) => !fs.existsSync(rawFile(target, locale, f)));
    if (missing.length) {
      problems.push(`${banner.id}/${locale}: no shot ${missing.join(', ')}`);
      continue;
    }
    const [W, H] = banner.size;
    await page.setViewportSize({ width: W, height: H });
    const found = await page.evaluate((d) => window.renderBanner(d), {
      width: W, height: H, kind: banner.kind, frame: target.frame, android: target.platform === 'android',
      claim: texts.claim, line: texts.line, icon: ICON, layout: banner.layout,
      screenAspect: target.viewport[0] / target.viewport[1],
      statusShare: target.safe[0] / target.viewport[1],
      bottomShare: target.safe[1] / target.viewport[1],
      shots: banner.shots.map((f) => ({ screenshot: imageUrl(rawFile(target, locale, f)), deviceShot: isDeviceShot(rawFile(target, locale, f)) })),
    });
    problems.push(...found.map((p) => `${banner.id}/${locale}: ${p}`));
    const dir = path.join(FASTLANE, banner.dir(locale));
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${banner.id}.png`), clip: { x: 0, y: 0, width: W, height: H } });
  }
  await ctx.close();
  return problems;
}

module.exports = { frameTarget, clearTarget, frameBanners };

if (require.main === module) {
  (async () => {
    const { chromium } = require('playwright');
    const files = Object.keys(TEXTS.en).filter((f) => !f.includes('@') && f !== 'banner');
    const browser = await chromium.launch();
    const problems = [];
    for (const locale of LOCALES) {
      for (const target of TARGETS) {
        clearTarget(target, locale);
        problems.push(...(await frameTarget(browser, target, locale, files)));
        console.log(`${target.id} ${locale}`);
      }
      if (!process.env.ONLY) {
        problems.push(...(await frameBanners(browser, locale)));
        console.log(`banners ${locale}`);
      }
    }
    await browser.close();
    console.log(problems.length ? problems.join('\n') : 'all framed');
    process.exitCode = problems.length ? 1 : 0;
  })();
}
