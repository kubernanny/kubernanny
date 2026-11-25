// Takes the store screenshots from the demo agents run.sh starts: each screen
// on a real device's viewport (targets.cjs), in English and German, dark, into
// raw/. frame/frame.cjs then puts every shot into a drawn device with a
// headline on the brand background, at the exact pixel size the App Store and
// Google Play take, into fastlane/screenshots/ where the screenshot lanes read them.
const path = require('node:path');
const { chromium, devices } = require('playwright');
const { LABELS, tab, closeSheet, pairAll, openCluster } = require('../screenshots/helpers.cjs');
const { TARGETS, LOCALES } = require('./targets.cjs');
const { frameTarget, clearTarget } = require('./frame/frame.cjs');

const RAW = process.env.OUT ?? path.join(__dirname, 'raw');
const errors = [];

const LANGUAGES = {
  'en-US': { browser: 'en-US', labels: { ...LABELS.en, overview: 'Overview' } },
  'de-DE': { browser: 'de-DE', labels: { ...LABELS.en, ...LABELS.de, overview: 'Lage', restarted: 'Mit Neustarts' } },
};

/** The screens, in store order. Their headlines are in frame/texts.cjs. */
const SCREENS = [
  { file: '01-overview', go: (p) => openCluster(p, 'homelab') },
  { file: '02-issues', go: (p) => scrollToTop(p, 'app-issue-list') },
  { file: '03-nodes', go: (p, L) => tab(p, L.nodes) },
  { file: '04-restarts', go: showRestarts },
  { file: '05-service', go: (p, L) => openService(p, L, 'CloudNativePG'), after: (p, L) => closeSheet(p, L) },
  { file: '06-ready-to-sync', go: showReadyToSync, after: (p, L) => closeReadyToSync(p, L) },
  { file: '07-clusters', go: showClusters },
  // Push exists only in the native app; pushPlugin and showPush play it.
  { file: '08-push', go: showPush },
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

/** A service's sheet, scrolled to its own list (CloudNativePG: the database clusters with primary and backups). */
async function openService(page, labels, name) {
  await tab(page, labels.services);
  await page.locator('app-services-tab button').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).first().click();
  await page.waitForSelector('app-module-sheet app-detail-section', { timeout: 10000 });
  await page.waitForTimeout(900);
  await page.locator('app-module-sheet ion-content').evaluate(async (el) => {
    const target = el.querySelector('app-detail-section');
    const scroller = await el.getScrollElement();
    await el.scrollToPoint(0, target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 24);
  });
  await page.waitForTimeout(600);
}

/** The workloads that restarted, the first OOMKill opened: why the last run ended, against its limit. */
async function showRestarts(page, labels) {
  await tab(page, labels.workloads);
  await page.locator('app-workloads-tab .filters button', { hasText: labels.restarted }).click();
  await page.waitForTimeout(500);
  const oom = page.locator('app-workloads-tab li', { has: page.locator('.restart.oom') }).first();
  await oom.locator('.row').click();
  await page.waitForTimeout(500);
  await oom.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    return el.closest('ion-content')?.scrollByPoint(0, -128, 0);
  });
  await page.waitForTimeout(600);
}

/** The "ready to sync" card on the overview opens the list of manual Argo CD apps with a change waiting. */
async function showReadyToSync(page, labels) {
  await tab(page, labels.overview);
  // Under the overview on a phone, in the side column on a tablet.
  await page.locator('app-pending-sync-card button:visible').last().click();
  await page.waitForSelector('app-pending-sync-sheet li', { timeout: 10000 });
  await page.waitForTimeout(900);
}

async function closeReadyToSync(page, labels) {
  await page.locator('app-pending-sync-sheet ion-button', { hasText: labels.close }).click();
  await page.waitForTimeout(700);
}

/** Cluster settings, "Push to this device" tapped: the sign picker with its preview. */
async function showPush(page) {
  await openCluster(page, 'homelab');
  // openCluster reloads the page; the native platform is played from here on, for the settings page only.
  await page.evaluate(() => {
    window.Capacitor.isNativePlatform = () => true;
  });
  await page.locator('.ion-page:not(.ion-page-hidden) ion-button:has(ion-icon[name="settings-outline"])').first().click();
  await page.waitForSelector('app-push-section ion-button', { timeout: 15000 });
  await page.locator('app-push-section ion-button').first().click();
  await page.waitForSelector('app-push-marker-picker', { timeout: 5000 });
  await page.waitForTimeout(400);
  await scrollToTop(page, 'app-push-section');
  // On a short screen (Play's 16:9 phone) the preview of a push matters more than the section's intro.
  await page.locator('app-push-marker-picker').evaluate((el) => {
    if (el.getBoundingClientRect().bottom > window.innerHeight) {
      el.scrollIntoView({ block: 'end' });
    }
  });
  await page.waitForTimeout(600);
}

/**
 * The push plugin as a build with Firebase has it, for the push screen. Only
 * its header is set at load, so the app stays on the web platform everywhere
 * else; showPush then lets PushNative see a native platform, after the page
 * has loaded and just before the settings ask for it.
 */
function pushPlugin(platform) {
  const answers = { isAvailable: { available: true, platform }, getMarker: { marker: null } };
  window.Capacitor = {
    PluginHeaders: [
      {
        name: 'KubernannyPush',
        methods: [
          ...['isAvailable', 'requestPermission', 'getToken', 'storeKey', 'removeKey', 'getMarker', 'setMarker', 'removeListener'].map((name) => ({ name, rtype: 'promise' })),
          { name: 'addListener', rtype: 'callback' },
        ],
      },
    ],
    nativePromise: async (plugin, method) => answers[method] ?? {},
    nativeCallback: () => 'store-screenshot',
  };
}

async function showClusters(page) {
  await page.goto(`${new URL(page.url()).origin}/#/clusters`);
  await page.reload();
  await page.waitForSelector('app-clusters app-nanny-eye', { timeout: 15000 });
  await page.waitForTimeout(2500);
}

/**
 * Room for the status bar and the home indicator the frame draws, the way a
 * phone reports it: Ionic reads the safe area from these variables.
 */
function safeArea([top, bottom]) {
  const style = document.createElement('style');
  style.textContent = `html:root { --ion-safe-area-top: ${top}px !important; --ion-safe-area-bottom: ${bottom}px !important; }`;
  document.addEventListener('DOMContentLoaded', () => document.head.append(style));
}

async function captureTarget(browser, target, locale) {
  const [width, height] = target.viewport;
  const ua = devices[target.ua];
  const { labels, browser: lang } = LANGUAGES[locale];
  const ctx = await browser.newContext({
    userAgent: ua.userAgent,
    isMobile: ua.isMobile,
    hasTouch: ua.hasTouch,
    viewport: { width, height },
    deviceScaleFactor: target.scale,
    colorScheme: 'dark',
    locale: lang,
  });
  await ctx.addInitScript(pushPlugin, target.platform);
  await ctx.addInitScript(safeArea, target.safe);
  const page = await ctx.newPage();
  const label = `${target.id}/${locale}`;
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  const files = [];
  try {
    await pairAll(page);
    for (const screen of SCREENS) {
      try {
        await screen.go(page, labels);
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(RAW, `${target.id}-${locale}-${screen.file}.png`) });
        files.push(screen.file);
        if (screen.after) {
          await screen.after(page, labels);
        }
      } catch (e) {
        errors.push(`${label} ${screen.file}: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    await ctx.close();
  }
  return files;
}

(async () => {
  require('node:fs').mkdirSync(RAW, { recursive: true });
  const browser = await chromium.launch();
  for (const locale of LOCALES) {
    for (const target of TARGETS) {
      clearTarget(target, locale);
      const files = await captureTarget(browser, target, locale).catch((e) => {
        errors.push(`${target.id}/${locale}: ${e.message.split('\n')[0]}`);
        return [];
      });
      errors.push(...(await frameTarget(browser, target, locale, files)));
      console.log(`${target.id} ${locale}: ${files.length} screenshots`);
    }
  }
  await browser.close();
  console.log(errors.length ? errors.join('\n') : 'no page errors');
  process.exitCode = errors.length ? 1 : 0;
})();
