import { PALETTE } from '../config';
import type { Session, Snapshot } from '../session/session';
import type { PotentialSnapshot } from '../session/components';
import { applyPreset } from '../sim/presets';
import type { PotentialField } from '../sim/field';
import type { Rng } from '../sim/rng';
import { base64ToFloats, floatsToBase64 } from './codec';
import { type ParticleSpecification, SCENARIO_FORMAT, SCENARIO_VERSION, type Scenario, type ScenarioQuestion } from './schema';

/** Settings groups a scenario carries (applied through the session's typed fields). */
const GROUPS = ['physics', 'analysis', 'display', 'tools'] as const;

type Box = { x0: number; y0: number; x1: number; y1: number };

/** What applying and capturing a scenario needs from the app. */
export interface ScenarioHost {
  session: Session;
  /** The settings groups of a fresh app (what a scenario does not mention is reset to these). */
  defaults: Snapshot;
  field: PotentialField;
  /** Random streams: presets, particle positions, particle colours. */
  rng: { presets: Rng; positions: Rng; colors: Rng };
  /** Restarts every random stream from the seed now in the state. */
  reseed(): void;
  /** Stops what a scenario replaces (playback, recording, camera, a stroke) and clears undo. */
  prepare(): void;
  /** Shows a world rectangle (no view in the scenario), and the current view's bounds. */
  showRect(box: Box): void;
  viewBounds(): Box;
  /** Opens exactly the listed windows (ids of instruments, "process", "settings"). */
  openPanels(ids: readonly string[]): void;
  /** The windows that are open now. */
  openPanelIds(): string[];
  resetInstruments(): void;
  setPlaying(playing: boolean): void;
}

/** Positions for the particle specifications (seeded: the same scenario gives the same particles). */
export function sampleParticles(specs: readonly ParticleSpecification[], rng: Rng): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (const s of specs) {
    switch (s.kind) {
      case 'point':
        for (let i = 0; i < s.n; i++) x.push(s.x), y.push(s.y);
        break;
      case 'gaussian': {
        const sy = s.sy ?? s.sx;
        for (let i = 0; i < s.n; i++) x.push(s.x + s.sx * rng.normal()), y.push(s.y + sy * rng.normal());
        break;
      }
      case 'uniform':
        for (let i = 0; i < s.n; i++) {
          x.push(s.x0 + (s.x1 - s.x0) * rng.float());
          y.push(s.y0 + (s.y1 - s.y0) * rng.float());
        }
        break;
      case 'points':
        for (let i = 0; i < s.xs.length; i++) x.push(s.xs[i]), y.push(s.ys[i]);
        break;
    }
  }
  return { x, y };
}

/** Sets the app up as the scenario says. */
export function applyScenario(s: Scenario, host: ScenarioHost): void {
  host.prepare();
  // Settings: the scenario's values over a fresh app's (so nothing from before leaks in).
  const settings: Snapshot = {};
  for (const g of GROUPS) {
    settings[g] = { ...(host.defaults[g] as object), ...(s.settings?.[g] ?? {}) };
  }
  host.session.apply(settings);
  host.reseed(); // also when the seed did not change: the run starts from the seed

  // The painted lattice (a formula, if any, is in the physics settings).
  host.field.clear();
  if (s.potential && 'preset' in s.potential) {
    applyPreset(host.field, s.potential.preset, 0, 0, host.rng.presets);
  } else if (s.potential && 'lattice' in s.potential) {
    const l = s.potential.lattice;
    const values = base64ToFloats(l.values);
    if (values.length < l.nx * l.ny) throw new Error('The painted potential of the scenario is incomplete.');
    const snap: PotentialSnapshot = { x0: l.x0, y0: l.y0, cell: l.cell, nx: l.nx, ny: l.ny, values };
    host.session.apply({ potential: snap });
  }

  // Particles at time 0.
  const { x, y } = sampleParticles(s.particles ?? [], host.rng.positions);
  const n = x.length;
  host.session.apply({
    particles: {
      ids: Array.from({ length: n }, (_, i) => i),
      x,
      y,
      colors: Array.from({ length: n }, () => Math.floor(host.rng.colors.float() * PALETTE.length)),
      time: 0,
      clockRemainder: 0,
    },
  });

  // View and analysis box.
  if (s.view) host.session.apply({ view: s.view });
  else if (s.box) host.showRect(s.box);
  host.session.apply({ analysisBox: s.box ?? host.viewBounds() });

  if (s.panels) host.openPanels(s.panels);
  host.resetInstruments();
  host.setPlaying(s.play ?? false);
}

export interface CaptureOptions {
  title: string;
  description?: string;
  questions?: ScenarioQuestion[];
  includeParticles: boolean;
  /** Include the painted lattice (can make the scenario large). */
  includePotential: boolean;
  play: boolean;
}

/** The current set-up as a scenario (settings that equal a fresh app's are left out). */
export function captureScenario(host: ScenarioHost, o: CaptureOptions): Scenario {
  const now = host.session.capture([...GROUPS, 'particles', 'analysisBox', 'view']);
  const settings: Record<string, Record<string, number | boolean | string>> = {};
  for (const g of GROUPS) {
    const cur = (now[g] ?? {}) as Record<string, number | boolean | string>;
    const def = (host.defaults[g] ?? {}) as Record<string, unknown>;
    const diff: Record<string, number | boolean | string> = {};
    for (const [k, val] of Object.entries(cur)) if (def[k] !== val) diff[k] = val;
    if (Object.keys(diff).length) settings[g] = diff;
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const scenario: Scenario = {
    format: SCENARIO_FORMAT,
    version: SCENARIO_VERSION,
    title: o.title.trim() || 'Untitled scenario',
    ...(o.description?.trim() ? { description: o.description.trim() } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  };
  const physics = now.physics as { potentialMode?: string } | undefined;
  if (o.includePotential && physics?.potentialMode !== 'formula') {
    const lattice = host.session.capture(['potential']).potential as PotentialSnapshot | null;
    if (lattice) {
      scenario.potential = {
        lattice: { x0: lattice.x0, y0: lattice.y0, cell: lattice.cell, nx: lattice.nx, ny: lattice.ny, values: floatsToBase64(lattice.values) },
      };
    }
  }
  const p = now.particles as { x: ArrayLike<number>; y: ArrayLike<number> } | undefined;
  if (o.includeParticles && p && p.x.length > 0) {
    scenario.particles = [{ kind: 'points', xs: Array.from(p.x, r3), ys: Array.from(p.y, r3) }];
  }
  const box = now.analysisBox as Box | null;
  if (box) scenario.box = { x0: r3(box.x0), y0: r3(box.y0), x1: r3(box.x1), y1: r3(box.y1) };
  const view = now.view as { x: number; y: number; scale: number };
  scenario.view = { x: r3(view.x), y: r3(view.y), scale: r3(view.scale) };
  scenario.panels = host.openPanelIds();
  if (o.play) scenario.play = true;
  if (o.questions?.length) scenario.questions = o.questions;
  return scenario;
}

/**
 * Questions written one per line: plain text, or text followed by "= value ± tolerance"
 * ("± 10%" for a relative tolerance), where the value is a number or "@instrument.readout" (a
 * value the app measures, e.g. "@firstPassage.meanTau"). Lines starting with # are skipped.
 */
export function parseQuestionLines(text: string): ScenarioQuestion[] {
  const out: ScenarioQuestion[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(.*?)\s*=\s*(@[A-Za-z]+\.[A-Za-z0-9.-]+|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(?:(?:±|\+-|\+\/-)\s*((?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(%)?)?$/i.exec(line);
    if (!m || !m[1]) {
      out.push({ text: line.slice(0, 2000) });
      continue;
    }
    const q: ScenarioQuestion = { text: m[1].slice(0, 2000), kind: 'number' };
    if (m[2].startsWith('@')) q.readout = m[2].slice(1);
    else q.answer = Number(m[2]);
    if (m[3] !== undefined) {
      const tol = Number(m[3]);
      q.tolerance = m[4] ? tol / 100 : tol;
      if (m[4]) q.relative = true;
    }
    out.push(q);
  }
  return out.slice(0, 40);
}

/** The inverse of parseQuestionLines (for editing a loaded scenario's questions). */
export function questionLines(questions: readonly ScenarioQuestion[]): string {
  return questions
    .map((q) => {
      const target = q.readout ? `@${q.readout}` : typeof q.answer === 'number' ? String(q.answer) : null;
      if (target === null) return q.text;
      const tol = q.tolerance === undefined ? '' : q.relative ? ` ± ${+(q.tolerance * 100).toPrecision(6)}%` : ` ± ${q.tolerance}`;
      return `${q.text} = ${target}${tol}`;
    })
    .join('\n');
}

/** Checks an answer: true/false, or null if the question has nothing to check against. */
export function checkAnswer(q: ScenarioQuestion, answer: string, readouts: Record<string, number>): boolean | null {
  const a = answer.trim();
  if (!a) return null;
  if (q.kind === 'choice' || typeof q.answer === 'string') {
    return typeof q.answer === 'string' ? a === q.answer : null;
  }
  const expected = q.readout ? readouts[q.readout] : typeof q.answer === 'number' ? q.answer : undefined;
  if (expected === undefined) return null;
  if (!Number.isFinite(expected)) return null; // the app has not measured it (yet)
  const value = Number(a.replace(',', '.'));
  if (!Number.isFinite(value)) return false;
  const tol = q.tolerance === undefined ? 0.05 * Math.abs(expected) || 1e-9 : q.relative ? q.tolerance * Math.abs(expected) : q.tolerance;
  return Math.abs(value - expected) <= tol;
}
