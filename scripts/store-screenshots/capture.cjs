// Renders the store screenshots from the demo agents run.sh starts: each
// screen at the exact pixel size the App Store and Google Play take, in
// English and German, with a caption band above the app in the app's style.
// Writes into fastlane/screenshots/ where the screenshot lanes read them.
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const { LABELS, scroll, tab, closeSheet, pairAll, openCluster } = require('../screenshots/helpers.cjs');

const ROOT = path.resolve(__dirname, '../..');
const FASTLANE = path.join(ROOT, 'fastlane/screenshots');
const RAW = process.env.OUT ?? path.join(__dirname, 'raw');
const CAPTIONS = process.env.CAPTIONS !== '0';
const errors = [];

/**
 * Store sizes (docs/RELEASING.md, Screenshots). App Store: 6.9" iPhone and
 * 13" iPad, told apart by pixel size, so both go into the same folder. Play:
 * 9:16 phone, 10:16 ten-inch tablet (Play wants each side between 320 and
 * 3840 px and the long side at most twice the short one).
 */
const TARGETS = [
  { id: 'iphone69', size: [1320, 2868], scale: 3, ua: devices['iPhone 15'], dir: (l) => `ios/${l}` },
  { id: 'ipad13', size: [2064, 2752], scale: 2, ua: devices['iPad Pro 11'], dir: (l) => `ios/${l}` },
  { id: 'phone', size: [1080, 1920], scale: 3, ua: devices['Pixel 7'], dir: (l) => `android/${l}/images/phoneScreenshots` },
  { id: 'tablet', size: [1600, 2560], scale: 2, ua: devices['Galaxy Tab S4'], dir: (l) => `android/${l}/images/tenInchScreenshots` },
].filter((t) => !process.env.ONLY || process.env.ONLY.split(',').includes(t.id));

const LOCALES = {
  'en-US': { browser: 'en-US', labels: LABELS.en },
  'de-DE': { browser: 'de-DE', labels: { ...LABELS.en, ...LABELS.de } },
};

/** The screens, in store order, with their captions. Claims only what the app really does. */
const SCREENS = [
  { file: '01-overview', en: 'Your cluster at a glance', de: 'Dein Cluster auf einen Blick', go: (p) => openCluster(p, 'homelab') },
  { file: '02-issues', en: 'Only what is broken, with cause and fix', de: 'Nur was kaputt ist, mit Ursache und Abhilfe', go: (p) => scrollToTop(p, 'app-issue-list') },
  { file: '03-last-7-days', en: 'The last 7 days', de: 'Die letzten 7 Tage', go: (p) => scrollToTop(p, 'app-history-section') },
  { file: '04-services', en: 'Recognizes your tools by their images', de: 'Erkennt deine Tools an ihren Images', go: (p, L) => tab(p, L.services) },
  { file: '05-component', en: 'Each component in detail', de: 'Jede Komponente im Detail', go: openSheet, after: (p, L) => closeSheet(p, L) },
  { file: '06-backups', en: 'Are your backups current?', de: 'Sind deine Backups aktuell?', go: (p, L) => tab(p, L.backups) },
  { file: '07-clusters', en: 'All your clusters, one traffic light each', de: 'Alle deine Cluster, je eine Ampel', go: showClusters },
  { file: '08-all-good', en: 'End-to-end encrypted. Open source.', de: 'Ende-zu-Ende verschlüsselt. Open Source.', go: (p) => openCluster(p, 'staging') },
];

/** Puts a section's heading at the top of the screen (scrollIntoViewIfNeeded would leave it at the bottom edge). */
async function scrollToTop(page, selector) {
  await page.locator(selector).first().evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    // Room for the sticky tab bar above it.
    return el.closest('ion-content')?.scrollByPoint(0, -96, 0);
  });
  await page.waitForTimeout(600);
}

/** The Argo CD sheet from the services tab: a component with its own checks and issues. */
async function openSheet(page, labels) {
  await tab(page, labels.services);
  await scroll(page, 0);
  await page.locator('app-services-tab button', { hasText: 'Argo CD' }).first().click();
  await page.waitForTimeout(1200);
}

async function showClusters(page) {
  await page.goto(`${new URL(page.url()).origin}/#/clusters`);
  await page.reload();
  await page.waitForSelector('app-clusters app-heartbeat', { timeout: 15000 });
  await page.waitForTimeout(2500);
}

/** Band height in CSS pixels: room for two lines of the title at the device's width. */
const bandHeight = (cssW, cssH) => Math.round(Math.min(cssH * 0.2, Math.max(150, cssW * 0.42)));

async function captureTarget(browser, target, locale) {
  const [w, h] = target.size;
  const cssW = w / target.scale;
  const cssH = h / target.scale;
  const band = CAPTIONS ? bandHeight(cssW, cssH) : 0;
  const { labels, browser: lang } = LOCALES[locale];
  const ctx = await browser.newContext({
    userAgent: target.ua.userAgent,
    isMobile: target.ua.isMobile,
    hasTouch: target.ua.hasTouch,
    viewport: { width: cssW, height: cssH - band },
    deviceScaleFactor: target.scale,
    colorScheme: 'dark',
    locale: lang,
  });
  const page = await ctx.newPage();
  const label = `${target.id}/${locale}`;
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await pairAll(page);
  const shots = [];
  for (const screen of SCREENS) {
    try {
      await screen.go(page, labels);
      await page.waitForTimeout(500);
      const raw = path.join(RAW, `${target.id}-${locale}-${screen.file}.png`);
      await page.screenshot({ path: raw });
      shots.push({ raw, screen });
      if (screen.after) {
        await screen.after(page, labels);
      }
    } catch (e) {
      errors.push(`${label} ${screen.file}: ${e.message.split('\n')[0]}`);
    }
  }
  await ctx.close();
  return shots.map((s) => ({ ...s, band, cssW, cssH }));
}

const fontData = (pkg, file) => fs.readFileSync(path.join(ROOT, 'app/node_modules/@fontsource-variable', pkg, 'files', file)).toString('base64');
const FONTS = `
  @font-face { font-family: 'Bricolage'; font-weight: 200 800; src: url(data:font/woff2;base64,${fontData('bricolage-grotesque', 'bricolage-grotesque-latin-wght-normal.woff2')}) format('woff2'); }
  @font-face { font-family: 'Figtree'; font-weight: 300 900; src: url(data:font/woff2;base64,${fontData('figtree', 'figtree-latin-wght-normal.woff2')}) format('woff2'); }`;
const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Caption band above the app screenshot, rendered by Chromium so the app's own fonts apply. */
async function compose(browser, target, locale, shot, out) {
  const title = shot.screen[locale.slice(0, 2)];
  const ctx = await browser.newContext({ viewport: { width: shot.cssW, height: shot.cssH }, deviceScaleFactor: target.scale });
  const page = await ctx.newPage();
  const img = fs.readFileSync(shot.raw).toString('base64');
  await page.setContent(`<!doctype html><html><head><style>${FONTS}
    html, body { margin: 0; width: ${shot.cssW}px; height: ${shot.cssH}px; overflow: hidden; background: #0f1626; }
    header { height: ${shot.band}px; box-sizing: border-box; padding: 0 ${Math.round(shot.cssW * 0.07)}px; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: ${Math.round(shot.band * 0.06)}px;
      background: radial-gradient(120% 140% at 50% 0%, #1f2a46 0%, #0f1626 70%); }
    .eyes { display: flex; gap: 8px; }
    .eyes i { width: 10px; height: 10px; border-radius: 50%; display: block; }
    h1 { margin: 0; font-family: 'Bricolage', sans-serif; font-weight: 750; letter-spacing: -0.02em; line-height: 1.08; color: #e9edf7;
      font-size: ${Math.round(Math.min(shot.cssW * 0.075, shot.band * 0.27))}px; text-wrap: balance; }
    img { display: block; width: ${shot.cssW}px; height: ${shot.cssH - shot.band}px; }
  </style></head><body>
    ${shot.band ? `<header><div class="eyes"><i style="background:#36d6a8"></i><i style="background:#f5b83d"></i><i style="background:#ff5d73"></i></div><h1>${escape(title)}</h1></header>` : ''}
    <img src="data:image/png;base64,${img}">
  </body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: out });
  await ctx.close();
}

(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  const browser = await chromium.launch();
  for (const locale of Object.keys(LOCALES)) {
    for (const target of TARGETS) {
      const dir = path.join(FASTLANE, target.dir(locale));
      fs.mkdirSync(dir, { recursive: true });
      // Only this target's earlier files: Play's icon and feature graphic sit next to them.
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${target.id}-`) && f.endsWith('.png')) {
          fs.rmSync(path.join(dir, f));
        }
      }
      const shots = await captureTarget(browser, target, locale).catch((e) => {
        errors.push(`${target.id}/${locale}: ${e.message.split('\n')[0]}`);
        return [];
      });
      for (const shot of shots) {
        await compose(browser, target, locale, shot, path.join(dir, `${target.id}-${shot.screen.file}.png`));
      }
      console.log(`${target.id} ${locale}: ${shots.length} screenshots`);
    }
  }
  await browser.close();
  console.log(errors.length ? errors.join('\n') : 'no page errors');
  process.exitCode = errors.length ? 1 : 0;
})();
