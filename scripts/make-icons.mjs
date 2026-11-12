// Renders the app icons (PNG) from public/favicon.svg with the installed Chrome (Playwright).
// Run after changing the favicon:  node scripts/make-icons.mjs
//
//  icon-192.png, icon-512.png   the favicon as it is (rounded square), for the installed app
//  icon-maskable-512.png        full-bleed square (no rounded corners): Android crops it itself
//  apple-touch-icon.png         180 px full-bleed square for iOS home screens
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const svg = fs.readFileSync('public/favicon.svg', 'utf8');
// Full bleed: square corners; the artwork stays inside the maskable safe zone (the dot is
// within 40 % of the size from the centre).
const square = svg.replaceAll('rx="14"', 'rx="0"');

const icons = [
  { file: 'icon-192.png', size: 192, svg },
  { file: 'icon-512.png', size: 512, svg },
  { file: 'icon-maskable-512.png', size: 512, svg: square },
  { file: 'apple-touch-icon.png', size: 180, svg: square },
];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const icon of icons) {
  await page.setViewportSize({ width: icon.size, height: icon.size });
  const sized = icon.svg.replace('<svg ', `<svg width="${icon.size}" height="${icon.size}" `);
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
  await page.screenshot({ path: `public/${icon.file}`, omitBackground: true, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
  console.log('wrote', icon.file);
}
await browser.close();
