// Renders the app icons, splash screens and Play listing graphics from
// branding/kubernanny-ok.svg into the native projects and fastlane/. Run after
// changing the logo, then commit the PNGs:
//   npm run native-assets
//
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install
// chromium`). It renders in a real browser instead of an image library so the
// SVG gradients look exactly as they do in the app and on the website.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '..');
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is missing: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

const GROUND = '#0f1626';
const logo = readFileSync(join(root, 'branding/kubernanny-ok.svg'), 'utf8');

// The logo's own background: a rounded square with the dark gradient. The
// stores and launchers apply their own mask, so every variant below starts
// from the nanny alone and decides about the ground itself.
const BACKGROUND_RECT = /<rect width="1024" height="1024" rx="230" fill="url\(#bg\)"\/>/;
if (!BACKGROUND_RECT.test(logo)) {
  throw new Error('branding/kubernanny-ok.svg changed: update BACKGROUND_RECT in this script');
}
const defs = logo.match(/<defs>[\s\S]*?<\/defs>/)[0];
const nanny = logo.replace(/^[\s\S]*?<\/defs>/, '').replace(BACKGROUND_RECT, '').replace('</svg>', '');

// The nanny's drawn area within the 1024 canvas (head circle at the top,
// heptagon with its 64 px stroke at the sides and bottom).
const NANNY = { x: 218, y: 170, width: 588, height: 694 };
const nannyCentre = { x: NANNY.x + NANNY.width / 2, y: NANNY.y + NANNY.height / 2 };

/** The nanny alone, scaled so its height is `share` of the square. */
function nannyOnly(share) {
  const side = NANNY.height / share;
  const x = nannyCentre.x - side / 2;
  const y = nannyCentre.y - side / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${side} ${side}">${defs}${nanny}</svg>`;
}

/** Full-bleed square: the gradient ground without rounded corners, the nanny as in the logo. */
const fullBleed = (corner = 0) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}<rect width="1024" height="1024" rx="${corner}" fill="url(#bg)"/>${nanny}</svg>`;

const roundIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs}<circle cx="512" cy="512" r="512" fill="url(#bg)"/><g transform="translate(512 512) scale(0.9) translate(-512 -512)">${nanny}</g></svg>`;

const font = readFileSync(
  join(app, 'node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2'),
).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage();

/** Renders an HTML body of exactly width x height px; transparent where nothing is drawn. */
async function render(file, width, height, body, transparent = false) {
  mkdirSync(dirname(file), { recursive: true });
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><html><head><style>
      @font-face { font-family: Bricolage; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 800; }
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${transparent ? 'transparent' : GROUND}; }
      svg { display: block; }
    </style></head><body>${body}</body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: transparent });
}

const svgAt = (svg, size) => svg.replace('<svg ', `<svg width="${size}" height="${size}" `);

// ---- iOS ------------------------------------------------------------------
// One 1024 px icon; Xcode derives every size from it (iOS 12+ targets). It must
// be opaque and square: iOS applies the rounded mask itself.
const iosIcons = join(app, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
rmSync(iosIcons, { recursive: true, force: true });
await render(join(iosIcons, 'AppIcon-1024.png'), 1024, 1024, svgAt(fullBleed(), 1024));
writeFileSync(
  join(iosIcons, 'Contents.json'),
  JSON.stringify(
    { images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info: { author: 'xcode', version: 1 } },
    null,
    2,
  ) + '\n',
);

// Launch screen: the storyboard shows this image "aspect fill" on a dark view,
// so a phone sees the middle third of the square and the nanny stays centred.
const iosSplash = join(app, 'ios/App/App/Assets.xcassets/Splash.imageset');
rmSync(iosSplash, { recursive: true, force: true });
await render(
  join(iosSplash, 'splash.png'),
  2732,
  2732,
  `<div style="display:grid;place-items:center;width:2732px;height:2732px">${svgAt(nannyOnly(1), 560)}</div>`,
);
writeFileSync(
  join(iosSplash, 'Contents.json'),
  JSON.stringify({ images: [{ filename: 'splash.png', idiom: 'universal' }], info: { author: 'xcode', version: 1 } }, null, 2) + '\n',
);

// ---- Android --------------------------------------------------------------
const res = join(app, 'android/app/src/main/res');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = join(res, `mipmap-${density}`);
  // Adaptive icon foreground: 108 dp, of which launchers show at most the
  // middle 72 dp and guarantee only a 66 dp circle. The nanny reaches at most
  // 372 units from its centre (head top, heptagon feet); at 52 % of the height
  // that is 30 dp, inside the circle with a margin.
  const fg = Math.round(108 * scale);
  await render(join(dir, 'ic_launcher_foreground.png'), fg, fg, svgAt(nannyOnly(0.52), fg), true);
  // Legacy icons for Android 7.x (minSdk 24), which has no adaptive icons.
  const legacy = Math.round(48 * scale);
  await render(join(dir, 'ic_launcher.png'), legacy, legacy, svgAt(fullBleed(230), legacy), true);
  await render(join(dir, 'ic_launcher_round.png'), legacy, legacy, svgAt(roundIcon, legacy), true);
  // The splash logo for Android 7 to 11 (12+ shows the launcher icon instead).
  const logoSize = Math.round(160 * scale);
  await render(join(res, `drawable-${density}`, 'splash_logo.png'), logoSize, logoSize, svgAt(nannyOnly(1), logoSize), true);
}

// Capacitor's template ships one stretched splash bitmap per orientation and
// density; a layer list (drawable/splash.xml) replaces them and never distorts.
for (const orientation of ['port', 'land']) {
  for (const density of Object.keys(DENSITIES)) {
    rmSync(join(res, `drawable-${orientation}-${density}`), { recursive: true, force: true });
  }
}
rmSync(join(res, 'drawable/splash.png'), { force: true });

// ---- Google Play listing --------------------------------------------------
// Uploaded by `fastlane android screenshots` together with the screenshots.
const TAGLINES = { 'de-DE': 'Ist mein Cluster okay?', 'en-US': 'Is my cluster okay?' };
for (const [locale, tagline] of Object.entries(TAGLINES)) {
  const images = join(root, 'fastlane/screenshots/android', locale, 'images');
  await render(join(images, 'icon.png'), 512, 512, svgAt(fullBleed(), 512));
  await render(
    join(images, 'featureGraphic.png'),
    1024,
    500,
    `<div style="display:flex;align-items:center;gap:44px;width:1024px;height:500px;box-sizing:border-box;padding:0 72px;
      background:linear-gradient(180deg,#1d2b4d,${GROUND});font-family:Bricolage,sans-serif;color:#eef1ff">
      ${svgAt(nannyOnly(0.92), 330)}
      <div><div style="font-size:84px;font-weight:700;letter-spacing:-1px">Kubernanny</div>
      <div style="font-size:40px;font-weight:500;color:#b3c0ff;margin-top:8px">${tagline}</div></div></div>`,
  );
}

await browser.close();
console.log('Icons, splash screens and Play graphics written.');
