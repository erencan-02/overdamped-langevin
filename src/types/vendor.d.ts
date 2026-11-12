// Types for the parts of untyped libraries that the app uses.

declare module 'gifenc' {
  export type Palette = number[][];
  export interface GifEncoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; dispose?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
}

declare module 'svgcanvas' {
  /** A Canvas 2D context that records what is drawn as SVG. */
  export class Context {
    constructor(options: { width: number; height: number });
    getSerializedSvg(fixNamedEntities?: boolean): string;
  }
}
