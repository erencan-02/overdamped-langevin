/**
 * Typed descriptions of individual settings. A field knows how to turn an untrusted value (from a
 * recording, a URL, …) into a valid one, or reject it, so settings groups can be restored
 * generically and safely.
 */
export abstract class Field<V> {
  constructor(readonly key: string) {}

  /** A valid value for this field, or undefined if `raw` cannot be used. */
  abstract coerce(raw: unknown): V | undefined;
}

export class NumberField extends Field<number> {
  constructor(
    key: string,
    readonly min = -Infinity,
    readonly max = Infinity,
  ) {
    super(key);
  }

  coerce(raw: unknown): number | undefined {
    const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(v)) return undefined;
    return Math.min(this.max, Math.max(this.min, v));
  }
}

/** A whole number in [min, max]. */
export class IntegerField extends NumberField {
  override coerce(raw: unknown): number | undefined {
    const v = super.coerce(raw);
    return v === undefined ? undefined : Math.round(v);
  }
}

export class BooleanField extends Field<boolean> {
  coerce(raw: unknown): boolean | undefined {
    if (typeof raw === 'boolean') return raw;
    if (raw === 1 || raw === 0) return raw === 1;
    return undefined;
  }
}

export class EnumField<V extends string> extends Field<V> {
  constructor(
    key: string,
    readonly values: readonly V[],
  ) {
    super(key);
  }

  coerce(raw: unknown): V | undefined {
    return this.values.includes(raw as V) ? (raw as V) : undefined;
  }
}

/** A string of bounded length that passes a validity check (e.g. a formula that parses). */
export class StringField extends Field<string> {
  constructor(
    key: string,
    readonly maxLength: number,
    readonly valid: (v: string) => boolean = () => true,
  ) {
    super(key);
  }

  coerce(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || raw.length > this.maxLength || !this.valid(raw)) return undefined;
    return raw;
  }
}
