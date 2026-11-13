import fs from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/**
 * The course scenarios with measurable answers: each is opened from the address, simulated to
 * the time its question names, and what the app measures is checked against the answer in the
 * scenario file (within the question's tolerance). A wrong answer, a broken formula or a
 * changed default would fail here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Debug = any;

interface Question {
  text: string;
  answer?: number | string;
  tolerance?: number;
  relative?: boolean;
}

function answer(id: string, index: number): { value: number; tolerance: number } {
  const s = JSON.parse(fs.readFileSync(`public/scenarios/${id}.json`, 'utf8')) as { questions: Question[] };
  const q = s.questions[index];
  if (typeof q.answer !== 'number' || q.tolerance === undefined) throw new Error(`${id} question ${index} has no numeric answer`);
  return { value: q.answer, tolerance: q.relative ? q.tolerance * Math.abs(q.answer) : q.tolerance };
}

function near(measured: number, a: { value: number; tolerance: number }, label: string): void {
  expect(Math.abs(measured - a.value), `${label}: measured ${measured}, answer ${a.value} ± ${a.tolerance}`).toBeLessThanOrEqual(a.tolerance);
}

let loads = 0;

async function open(page: Page, id: string): Promise<void> {
  // A new query each time: the page loads afresh (the same address would not reload).
  await page.goto(`/?load=${++loads}#scenario=${id}`);
  await page.waitForFunction(() => (window as Debug).sde?.particles?.time === 0, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => (window as Debug).sde?.particles?.count > 0, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => !(window as Debug).sde.app.formulas.waiting(), undefined, { timeout: 30_000 });
}

/** Plays until simulated time t, pauses, and returns the Observable window's readouts. */
async function runTo(page: Page, t: number): Promise<{ mean: number; ci: number; exact: number }> {
  if (!(await page.evaluate(() => (window as Debug).sde.state.playing))) await page.keyboard.press(' ');
  await page.waitForFunction((t) => (window as Debug).sde.particles.time >= t, t, { timeout: 60_000 });
  await page.keyboard.press(' ');
  // One more frame so the window has sampled the final positions.
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const r = (window as Debug).sde.instruments.readouts();
    return { mean: r['observable.mean'], ci: r['observable.ci'], exact: r['observable.exact'] };
  });
}

async function setObservable(page: Page, tex: string): Promise<void> {
  await page.evaluate((tex) => (window as Debug).sde.session.apply({ analysis: { observable: tex } }), tex);
  await page.waitForTimeout(500); // compiled in the background
}

test.describe.configure({ timeout: 120_000 });

test("Itô's lemma: E e^{W_t} = e^{t/2}", async ({ page }) => {
  await open(page, 'ito-lemma');
  near((await runTo(page, 1)).mean, answer('ito-lemma', 1), 'σ = 1, t = 1');
  await open(page, 'ito-lemma');
  await page.evaluate(() => (window as Debug).sde.session.apply({ physics: { sigma: 0.5 } }));
  near((await runTo(page, 1)).mean, answer('ito-lemma', 3), 'σ = 0.5, t = 1');
});

test('geometric Brownian motion: the mean grows, most paths shrink', async ({ page }) => {
  await open(page, 'geometric-brownian-motion');
  near((await runTo(page, 1)).mean, answer('geometric-brownian-motion', 0), 'E X at t = 1');
  await setObservable(page, '\\mathbf{1}_{x < 1}');
  near((await runTo(page, 4)).mean, answer('geometric-brownian-motion', 3), 'P(X < 1) at t = 4');
});

test('backward Kolmogorov: v((2, 0), t) from one starting point', async ({ page }) => {
  await open(page, 'backward-kolmogorov');
  near((await runTo(page, 1)).mean, answer('backward-kolmogorov', 0), 'v at t = 1');
  near((await runTo(page, 6)).mean, answer('backward-kolmogorov', 1), 'v as t → ∞');
});

test('Monte Carlo error: the 95 % half-width with 400 particles', async ({ page }) => {
  await open(page, 'monte-carlo-error');
  const r = await runTo(page, 0.5);
  near(r.ci, answer('monte-carlo-error', 1), 'half-width');
  expect(Math.abs(r.mean - 1)).toBeLessThan(0.2);
  near(r.exact, { value: 1, tolerance: 0.01 }, 'exact ∫ f dπ');
});

test('rare events: the exact tail probability', async ({ page }) => {
  await open(page, 'rare-events');
  const r = await runTo(page, 0.2);
  near(r.exact, answer('rare-events', 0), 'exact p');
  expect(r.mean).toBeLessThan(0.02); // a handful of particles at most
});
