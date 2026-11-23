// README screenshots in demo mode, the way Hivogram's are made: the real rail UI (desktop/ui) fed with
// made-up accounts (docs/demo/demo-state.js), a made-up chat where the app shows web.gemspace.com,
// and a replica of the Android account strip. One dark theme; desktop 1440×900 @2x, phone 390×844 @3x.
//   node docs/make-screens.js [d1,d2,d3,d4,d5,d6,d7,a1,a2,a3,a4,a5,a6]      (Playwright with Chromium)
//   python3 docs/make-grids.py                                   (Pillow) builds the captioned grids
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const url = (f) => 'file://' + path.join(root, f);
const O = path.join(root, 'docs/screens');
fs.mkdirSync(O, { recursive: true });
const D = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const P = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const only = (process.argv[2] || '').split(',').filter(Boolean);
const run = (k) => !only.length || only.includes(k);

async function shot(browser, key, file, opts, page, before) {
  if (!run(key)) return;
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark', locale: 'ru-RU' });
  await ctx.addInitScript({ path: path.join(root, 'docs/demo/demo-state.js') });
  const p = await ctx.newPage();
  await p.goto(url(page));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(700);
  if (before) await before(p);
  await p.waitForTimeout(700); // overlay and tile animations settle
  await p.screenshot({ path: path.join(O, file + '.png') });
  console.log('saved', file);
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();
  const rail = 'desktop/ui/index.html';
  await shot(b, 'd1', 'desktop-main', D, 'docs/demo/desktop.html');
  await shot(b, 'd2', 'desktop-add', D, rail, async (p) => {
    await p.click('#add'); await p.waitForTimeout(400);
    await p.fill('#f-name', 'Розница'); await p.click('.swatch[data-c="#ffa726"]');
    await p.fill('#f-proxy', 'socks5://185.10.20.30:1080'); await p.locator('#f-proxy').blur();
  });
  await shot(b, 'd3', 'desktop-menu', D, 'docs/demo/desktop.html?menu');
  await shot(b, 'd4', 'desktop-notify', D, 'docs/demo/desktop.html?toast');
  await shot(b, 'd5', 'desktop-settings', D, rail, (p) => p.click('#gear'));
  await shot(b, 'd6', 'desktop-feed', D, rail, (p) => p.click('#feed'));
  await shot(b, 'd7', 'desktop-welcome', D, rail + '?empty');
  await shot(b, 'a1', 'android-main', P, 'docs/demo/phone.html');
  await shot(b, 'a2', 'android-add', P, 'docs/demo/phone.html?dialog');
  await shot(b, 'a3', 'android-menu', P, 'docs/demo/phone.html?menu');
  await shot(b, 'a5', 'android-feed', P, 'docs/demo/phone.html?feed');
  await shot(b, 'a6', 'android-welcome', P, 'docs/demo/phone.html?empty');
  await shot(b, 'a4', 'android-notify', P, 'docs/demo/phone.html?shade');
  await b.close();
})();
