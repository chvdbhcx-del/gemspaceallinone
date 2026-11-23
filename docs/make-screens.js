// Renders the README screenshots in demo mode: the real rail UI (desktop/ui) with made-up accounts
// (docs/demo/demo-state.js) next to a made-up chat page, plus a replica of the Android account strip.
// Usage: node docs/make-screens.js   (needs Playwright with Chromium)
// Grids (ImageMagick), from docs/screens:
//   convert desktop-add.png -crop 1520x1800+680+0 +repage a.png; convert desktop-settings.png -crop 1520x1800+680+0 +repage b.png
//   convert a.png b.png -bordercolor "#3a4654" -border 2 +append -resize 2000x grid-desktop.png
//   convert android-main.png android-add.png -bordercolor "#888" -border 1 -background none -splice 24x0 +append -chop 24x0 grid-phone.png
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const demo = (f) => 'file://' + path.join(root, 'docs/demo', f);
const out = (f) => path.join(root, 'docs/screens', f);
const initScript = { path: path.join(root, 'docs/demo/demo-state.js') };

async function shot(browser, { url, file, width, height, scheme = 'dark', mobile = false, before }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(400);
  if (before) await before(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out(file) });
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  // main window: rail + chat of the open account
  await shot(browser, { url: demo('desktop.html'), file: 'desktop-main.png', width: 1440, height: 900 });
  // overlays of the real rail UI, full window
  const rail = 'file://' + path.join(root, 'desktop/ui/index.html');
  await shot(browser, { url: rail, file: 'desktop-add.png', width: 1440, height: 900, before: async (p) => {
    await p.click('#add'); await p.fill('#f-name', 'Розница'); await p.click('.swatch[data-c="#ffa726"]');
    await p.fill('#f-proxy', 'socks5://185.10.20.30:1080');
  } });
  await shot(browser, { url: rail, file: 'desktop-settings.png', width: 1440, height: 900, before: (p) => p.click('#gear') });
  // phone
  await shot(browser, { url: demo('phone.html'), file: 'android-main.png', width: 390, height: 844, scheme: 'light', mobile: true });
  await shot(browser, { url: demo('phone.html?dialog'), file: 'android-add.png', width: 390, height: 844, scheme: 'light', mobile: true });
  await browser.close();
})();
