import fs from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * Figure and video export: every plot as PNG and SVG (with title, axis titles and legend), a
 * picture of the scene, and video recordings (MP4 or WebM, and GIF), as downloaded files.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Debug = any;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message}`);
    console.log('PAGEERROR', e.message, e.stack);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function download(page: Page, action: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await action();
  const d = await pending;
  return { name: d.suggestedFilename(), bytes: fs.readFileSync((await d.path())!) };
}

/** Width and height of a PNG (from its IHDR chunk). */
function pngSize(b: Buffer): [number, number] {
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

async function menu(page: Page, action: string): Promise<void> {
  await page.locator('#menu-btn').click();
  await page.locator(`#menu [data-action="${action}"]`).click();
}

test('every plot exports as PNG and SVG with its labels', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#scenario=birth-death');
  await page.waitForFunction(() => (window as Debug).sde?.particles?.count > 0);
  // Open every window and let the curves grow.
  const heads = page.locator('#left-body .analysis-head[aria-expanded="false"]');
  for (let k = await heads.count(); k > 0; k--) await heads.first().click();
  await page.keyboard.press(' ');
  await page.waitForTimeout(1500);

  const plots = page.locator('.plot-wrap');
  const n = await plots.count();
  expect(n).toBe(6); // KL, observable, birth / death, ergodicity, first passage, Δt sweep
  for (let k = 0; k < n; k++) {
    const plot = plots.nth(k);
    const id = await plot.locator('canvas').evaluate((c) => c.closest('section')?.id ?? '');
    if (id === 'sweep') continue; // empty until the sweep is run (checked below)
    await plot.hover();
    const svg = await download(page, async () => {
      await plot.locator('.plot-export').click();
      await plot.locator('.plot-export-menu button', { hasText: 'SVG' }).click();
    });
    const text = svg.bytes.toString('utf8');
    expect(svg.name, id).toMatch(/\.svg$/);
    expect(text, id).toContain('<svg');
    expect(text, id).toContain('simulated time t'); // x axis title
    expect(text, id).toMatch(/<path|<line|<polyline/);
    const png = await download(page, async () => {
      await plot.locator('.plot-export').click();
      await plot.locator('.plot-export-menu button', { hasText: 'PNG' }).click();
    });
    expect(png.name, id).toMatch(/\.png$/);
    expect(pngSize(png.bytes), id).toEqual([2400, 1500]);
  }

  // The Δt sweep: empty before a run (refused with a hint), then exportable.
  const sweep = page.locator('#sweep .plot-wrap');
  await sweep.hover();
  await sweep.locator('.plot-export').click();
  await sweep.locator('.plot-export-menu button', { hasText: 'SVG' }).click();
  await expect(page.locator('#toast')).toContainText('Nothing to export yet');
  await page.locator('#sweep-paths').fill('40');
  await page.locator('#sweep button', { hasText: 'Run sweep' }).click();
  await expect(page.locator('#sweep-value')).toHaveText('done', { timeout: 60_000 });
  await sweep.hover();
  const svg = await download(page, async () => {
    await sweep.locator('.plot-export').click();
    await sweep.locator('.plot-export-menu button', { hasText: 'SVG' }).click();
  });
  const text = svg.bytes.toString('utf8');
  expect(text).toContain('step size Δt');
  expect(text).toContain('Euler–Maruyama');

  expect(errors).toEqual([]);
});

test('picture of the scene, video (MP4 or WebM) and GIF', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#scenario=ornstein-uhlenbeck');
  await page.waitForFunction(() => (window as Debug).sde?.particles?.count > 0);
  await page.keyboard.press(' ');

  const picture = await download(page, () => menu(page, 'save-picture'));
  expect(picture.name).toMatch(/^langevin-dynamics-\d{8}-\d{6}\.png$/);
  const [w, h] = pngSize(picture.bytes);
  const stage = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#gl')!;
    return [c.width, c.height];
  });
  expect([w, h]).toEqual(stage);

  // Video: the chip shows the time; Stop saves the file.
  await menu(page, 'record-mp4');
  await expect(page.locator('.video-chip')).toBeVisible();
  await expect(page.locator('.video-chip')).toContainText('Video 0:01', { timeout: 10_000 });
  const video = await download(page, () => page.locator('.video-chip button').click());
  await expect(page.locator('.video-chip')).toBeHidden();
  if (video.name.endsWith('.mp4')) {
    expect(video.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  } else {
    expect(video.name).toMatch(/\.webm$/);
    expect(video.bytes.readUInt32BE(0)).toBe(0x1a45dfa3); // EBML
  }
  expect(video.bytes.length).toBeGreaterThan(10_000);

  // GIF.
  await menu(page, 'record-gif');
  await expect(page.locator('.video-chip')).toContainText('GIF 0:01', { timeout: 10_000 });
  const gif = await download(page, () => page.locator('.video-chip button').click());
  expect(gif.name).toMatch(/\.gif$/);
  expect(gif.bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  // Several frames (image descriptors follow graphic control extensions).
  const frames = gif.bytes.toString('latin1').split('\x21\xf9\x04').length - 1;
  expect(frames).toBeGreaterThan(8);

  expect(errors).toEqual([]);
});
