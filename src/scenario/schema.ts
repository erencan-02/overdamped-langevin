import * as v from 'valibot';
import { MAX_PARTICLES } from '../sim/particles'; // the largest count a scenario can ask for

/**
 * Scenarios: a whole set-up of the app (process, potential, particles, view, open windows) plus
 * an optional worksheet, as plain JSON. They are shared as links (compressed into the URL hash),
 * files or GitHub Gists, and the course scenarios live in public/scenarios/.
 *
 * Everything that comes in is untrusted. This module checks the structure and bounds of a
 * scenario with a schema (valibot) and migrates older versions; the settings inside are then
 * applied through the session's typed fields, which coerce or drop each value, and formulas only
 * ever go through the LaTeX parser (never evaluated as JavaScript). Text is shown as text, with
 * $…$ typeset by KaTeX.
 */

export const SCENARIO_FORMAT = 'langevin-dynamics-scenario';
/** The current version. Older versions are migrated (see MIGRATIONS); newer ones are refused. */
export const SCENARIO_VERSION = 1;


const num = v.pipe(v.number(), v.finite());
const coord = v.pipe(num, v.minValue(-1e4), v.maxValue(1e4));
const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_PARTICLES));
const positive = v.pipe(num, v.minValue(0), v.maxValue(1e4));
const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

/** A settings group: key → number, boolean or short string (checked again by the session). */
const settingsGroup = v.pipe(v.record(v.pipe(v.string(), v.maxLength(40)), v.union([num, v.boolean(), text(500)])), v.check((r) => Object.keys(r).length <= 40, 'Too many settings.'));

const ParticleSpec = v.variant('kind', [
  /** n particles at one point. */
  v.object({ kind: v.literal('point'), x: coord, y: coord, n: count }),
  /** n particles from a Gaussian with standard deviations sx, sy (sy = sx if omitted). */
  v.object({ kind: v.literal('gaussian'), x: coord, y: coord, sx: positive, sy: v.optional(positive), n: count }),
  /** n particles uniformly in a rectangle. */
  v.object({ kind: v.literal('uniform'), x0: coord, y0: coord, x1: coord, y1: coord, n: count }),
  /** Explicit positions. */
  v.object({
    kind: v.literal('points'),
    xs: v.pipe(v.array(coord), v.maxLength(MAX_PARTICLES)),
    ys: v.pipe(v.array(coord), v.maxLength(MAX_PARTICLES)),
  }),
]);

const Rect = v.pipe(
  v.object({ x0: coord, y0: coord, x1: coord, y1: coord }),
  v.check((r) => r.x1 > r.x0 && r.y1 > r.y0, 'A box needs x1 > x0 and y1 > y0.'),
);

const Lattice = v.object({
  x0: coord,
  y0: coord,
  cell: v.pipe(num, v.minValue(0.001), v.maxValue(10)),
  nx: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(4096)),
  ny: v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(4096)),
  /** Little-endian float32 values, base64 (rows from the bottom up). */
  values: v.pipe(v.string(), v.maxLength(24_000_000), v.regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Ψ values must be base64.')),
});

const Question = v.object({
  /** The question; $…$ is typeset. */
  text: text(2000),
  /** How it is answered (default: text). */
  kind: v.optional(v.picklist(['text', 'number', 'choice'])),
  choices: v.optional(v.pipe(v.array(text(200)), v.maxLength(10))),
  /** The expected answer: a number (with `tolerance`) or a choice. */
  answer: v.optional(v.union([num, text(200)])),
  /**
   * Or check a number against a value the app measures now (an instrument readout such as
   * "firstPassage.meanTau"), within `tolerance`.
   */
  readout: v.optional(v.pipe(v.string(), v.maxLength(80), v.regex(/^[A-Za-z]+\.[A-Za-z0-9.-]+$/, 'Unknown readout.'))),
  tolerance: v.optional(positive),
  /** `tolerance` is relative (a fraction of the expected value). */
  relative: v.optional(v.boolean()),
});

export const ScenarioSchema = v.object({
  format: v.literal(SCENARIO_FORMAT),
  version: v.literal(SCENARIO_VERSION),
  title: v.pipe(v.string(), v.minLength(1, 'A scenario needs a title.'), v.maxLength(120)),
  description: v.optional(text(6000)),
  settings: v.optional(
    v.object({
      physics: v.optional(settingsGroup),
      analysis: v.optional(settingsGroup),
      display: v.optional(settingsGroup),
      tools: v.optional(settingsGroup),
    }),
  ),
  /** The painted potential: a preset, a lattice, or nothing (a formula is set in the settings). */
  potential: v.optional(
    v.union([v.object({ preset: v.picklist(['double-well', 'ring', 'landscape']) }), v.object({ lattice: Lattice })]),
  ),
  particles: v.optional(
    v.pipe(
      v.array(ParticleSpec),
      v.maxLength(64),
      v.check(
        (specs) => specs.reduce((n, s) => n + (s.kind === 'points' ? s.xs.length : s.n), 0) <= MAX_PARTICLES,
        `At most ${MAX_PARTICLES} particles.`,
      ),
      v.check((specs) => specs.every((s) => s.kind !== 'points' || s.xs.length === s.ys.length), 'xs and ys differ in length.'),
    ),
  ),
  /** Analysis box and view (centre and pixels per unit). */
  box: v.optional(Rect),
  view: v.optional(v.object({ x: coord, y: coord, scale: v.pipe(num, v.minValue(1), v.maxValue(5000)) })),
  /** Windows to open (instrument ids, "process", "settings"); all others are closed. */
  panels: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(40))), v.maxLength(20))),
  /** Start playing at once. */
  play: v.optional(v.boolean()),
  questions: v.optional(v.pipe(v.array(Question), v.maxLength(40))),
});

export type Scenario = v.InferOutput<typeof ScenarioSchema>;
export type ScenarioQuestion = NonNullable<Scenario['questions']>[number];
export type ParticleSpecification = NonNullable<Scenario['particles']>[number];

export type ScenarioResult = { ok: true; scenario: Scenario } | { ok: false; message: string };

/**
 * Migrations from version k to k + 1 (index k). Version 0 is a bare settings snapshot as stored
 * in recordings (metadata.settings): physics, analysis, display, tools, analysisBox, view.
 */
const MIGRATIONS: ((old: Record<string, unknown>) => Record<string, unknown>)[] = [
  (old) => ({
    format: SCENARIO_FORMAT,
    version: 1,
    title: 'Imported settings',
    settings: pick(old, ['physics', 'analysis', 'display', 'tools']),
    ...(old.analysisBox ? { box: old.analysisBox } : {}),
    ...(old.view ? { view: old.view } : {}),
  }),
];

/** Validates (and migrates) an untrusted value; on failure, a message for the user. */
export function parseScenario(raw: unknown): ScenarioResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'This is not a scenario.' };
  let obj = raw as Record<string, unknown>;
  let version: number;
  if (obj.format === SCENARIO_FORMAT) {
    version = typeof obj.version === 'number' && Number.isInteger(obj.version) ? obj.version : -1;
  } else if (obj.format === undefined && ('physics' in obj || 'analysis' in obj)) {
    version = 0; // a settings snapshot (e.g. from a recording)
  } else {
    return { ok: false, message: 'This is not a scenario of this app.' };
  }
  if (version < 0) return { ok: false, message: 'The scenario has no valid version.' };
  if (version > SCENARIO_VERSION) {
    return { ok: false, message: `This scenario needs a newer version of the app (format ${version}). Reload the page.` };
  }
  for (let k = version; k < SCENARIO_VERSION; k++) obj = MIGRATIONS[k](obj);
  const r = v.safeParse(ScenarioSchema, obj);
  if (!r.success) {
    const issue = r.issues[0];
    const path = v.getDotPath(issue);
    return { ok: false, message: `The scenario is not valid${path ? ` (${path})` : ''}: ${issue.message}` };
  }
  return { ok: true, scenario: r.output };
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] && typeof o[k] === 'object') out[k] = o[k];
  return out;
}
