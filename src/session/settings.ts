import { RANGES } from '../config';
import type { ParticleSystem } from '../sim/particles';
import type { RandomStreams } from '../sim/random';
import { SCHEMES, type SchemeId } from '../sim/schemes';
import type { AppState, PotentialMode } from '../state';
import { StateComponent } from './component';
import { BooleanField, EnumField, type Field, IntegerField, NumberField, StringField } from './fields';

type Settings<K extends keyof AppState> = Partial<Pick<AppState, K>>;

/**
 * A group of scalar settings stored in AppState, described by typed fields. Capture and apply
 * are generic; subclasses only declare their fields and, if needed, side effects in afterApply.
 */
export abstract class SettingsGroup<K extends keyof AppState> extends StateComponent<Settings<K>> {
  protected abstract readonly fields: readonly Field<AppState[K]>[];

  constructor(
    protected readonly state: AppState,
    /** Called after any applied change (e.g. to refresh the UI). */
    protected readonly onChange: () => void,
  ) {
    super();
  }

  capture(): Settings<K> {
    const out: Settings<K> = {};
    for (const f of this.fields) {
      const key = f.key as K;
      (out as Record<K, AppState[K]>)[key] = this.state[key];
    }
    return out;
  }

  apply(value: Settings<K>): void {
    if (!value || typeof value !== 'object') return;
    const changed: K[] = [];
    for (const f of this.fields) {
      const key = f.key as K;
      if (!(key in value)) continue;
      const v = f.coerce((value as Record<string, unknown>)[key]);
      if (v === undefined || v === this.state[key]) continue;
      this.state[key] = v;
      changed.push(key);
    }
    if (changed.length) {
      this.afterApply(changed);
      this.onChange();
    }
  }

  /** Side effects of changed settings (default: none). */
  protected afterApply(_changed: K[]): void {}
}

type PhysicsKey =
  | 'sigma'
  | 'speed'
  | 'scheme'
  | 'seed'
  | 'potentialMode'
  | 'potentialTex'
  | 'birthDeath'
  | 'birthRate'
  | 'deathRate'
  | 'extraDrift'
  | 'driftU1'
  | 'driftU2'
  | 'noiseFormula'
  | 'noiseS1'
  | 'noiseS2';

/** Parameters of the dynamics. Applied first: the seed resets the random streams. */
export class PhysicsSettings extends SettingsGroup<PhysicsKey> {
  readonly key = 'physics';
  override readonly order = 10;
  protected readonly fields = [
    new NumberField('sigma', ...RANGES.sigma),
    new NumberField('speed', ...RANGES.speed),
    new EnumField<SchemeId>('scheme', Object.keys(SCHEMES) as SchemeId[]),
    new IntegerField('seed', 0, 2 ** 32 - 1),
    new EnumField<PotentialMode>('potentialMode', ['painted', 'formula']),
    // Checked by the potential window when applied (the LaTeX parser loads on demand).
    new StringField('potentialTex', 500),
    new BooleanField('birthDeath'),
    new NumberField('birthRate', ...RANGES.birthRate),
    new NumberField('deathRate', ...RANGES.deathRate),
    // Drift & noise: checked by their window when applied (like the potential formula).
    new BooleanField('extraDrift'),
    new StringField('driftU1', 500),
    new StringField('driftU2', 500),
    new BooleanField('noiseFormula'),
    new StringField('noiseS1', 500),
    new StringField('noiseS2', 500),
  ] as Field<AppState[PhysicsKey]>[];

  constructor(
    state: AppState,
    onChange: () => void,
    private readonly particles: ParticleSystem,
    private readonly random: RandomStreams,
  ) {
    super(state, onChange);
  }

  protected override afterApply(changed: PhysicsKey[]): void {
    if (changed.includes('scheme')) this.particles.scheme = SCHEMES[this.state.scheme];
    if (changed.includes('seed')) this.random.reseed(this.state.seed);
  }
}

type AnalysisKey = 'kernelVariance' | 'showDensity' | 'observable' | 'ergodicF' | 'passageTarget';

/** Settings of the equilibrium analysis and the observables window. */
export class AnalysisSettings extends SettingsGroup<AnalysisKey> {
  readonly key = 'analysis';
  override readonly order = 20;
  /** Viewing/analysis only: changing it does not count as altering the simulation. */
  override readonly tracksChanges = false;
  protected readonly fields = [
    new NumberField('kernelVariance', ...RANGES.kernelVariance),
    new BooleanField('showDensity'),
    // Checked by the observables window when applied (the LaTeX parser loads on demand).
    new StringField('observable', 500),
    new StringField('ergodicF', 500),
    new StringField('passageTarget', 500),
  ] as Field<AppState[AnalysisKey]>[];
}

type DisplayKey = 'grid' | 'trails' | 'contours' | 'forceField' | 'mode';

/** What is drawn and which tool is active. */
export class DisplaySettings extends SettingsGroup<DisplayKey> {
  readonly key = 'display';
  override readonly order = 20;
  /** Viewing/analysis only: changing it does not count as altering the simulation. */
  override readonly tracksChanges = false;
  protected readonly fields = [
    new BooleanField('grid'),
    new BooleanField('trails'),
    new BooleanField('contours'),
    new BooleanField('forceField'),
    new EnumField('mode', ['brush', 'particles'] as const),
  ] as Field<AppState[DisplayKey]>[];
}

type ToolKey = 'brushRadius' | 'brushStrength' | 'particleSpacing';

/** Brush and particle-tool parameters. */
export class ToolSettings extends SettingsGroup<ToolKey> {
  readonly key = 'tools';
  override readonly order = 20;
  /** Viewing/analysis only: changing it does not count as altering the simulation. */
  override readonly tracksChanges = false;
  protected readonly fields = [
    new NumberField('brushRadius', ...RANGES.brushRadius),
    new NumberField('brushStrength', ...RANGES.brushStrength),
    new NumberField('particleSpacing', ...RANGES.particleSpacing),
  ] as Field<AppState[ToolKey]>[];
}
