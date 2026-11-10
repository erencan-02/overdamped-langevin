/** Delay after the last keystroke before the input is parsed (no red flashes while typing). */
const PARSE_DELAY_MS = 350;

export interface FormulaInputHooks {
  /**
   * Tries to use `tex` (parse, compile, apply). Returns null if it is now in use, or the message
   * explaining why not. Only called once `setReady()` was called (the parser has loaded).
   */
  tryUse(tex: string): string | null;
  /** The user entered a new formula that is now in use (e.g. to store it in the state). */
  committed(tex: string): void;
}

/**
 * A validated text input as used by the observable, potential and birth/death windows, found
 * inside `root`: an `<input>`, an error line (`.obs-error`), and optionally a rendered preview
 * (`.obs-preview`) and example buttons (`.obs-examples button[data-tex]`).
 *
 * The input is checked shortly after typing stops, on Enter and when it loses focus. An invalid
 * formula gets a red outline and a message under the input, while the last valid formula stays
 * in use (its preview is dimmed). Escape goes back to the formula in use. The preview is typeset
 * with KaTeX, loaded on demand.
 */
export class FormulaInput {
  readonly input: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly preview: HTMLElement | null;
  private timer = 0;
  /** The formula in use ('' before the first one). */
  applied = '';
  private ready = false;
  private katex: typeof import('./helpMath') | null = null;
  private katexLoading = false;

  constructor(
    root: HTMLElement,
    /** LaTeX written in front of the formula in the preview, e.g. "f(x,y) = ". */
    private readonly previewPrefix: string,
    private readonly hooks: FormulaInputHooks,
  ) {
    this.input = must(root.querySelector<HTMLInputElement>('input[type="text"]'));
    this.error = must(root.querySelector<HTMLElement>('.obs-error'));
    this.preview = root.querySelector<HTMLElement>('.obs-preview');
    this.input.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.commit(), PARSE_DELAY_MS);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit();
      } else if (e.key === 'Escape') {
        // Give up the edit: back to the formula in use (and nothing else reacts to Escape).
        e.stopPropagation();
        if (this.applied) this.input.value = this.applied;
        this.commit();
        this.input.blur();
      }
    });
    this.input.addEventListener('blur', () => this.commit());
    for (const b of root.querySelectorAll<HTMLButtonElement>('.obs-examples button[data-tex]')) {
      b.addEventListener('click', () => {
        this.input.value = b.dataset.tex ?? '';
        this.commit();
      });
    }
  }

  /**
   * The parser has loaded: start using the formula in the input, or `initial` (then without
   * reporting it as entered by the user).
   */
  setReady(initial?: string): void {
    this.ready = true;
    if (initial === undefined) {
      this.commit();
      return;
    }
    this.input.value = initial;
    this.use(initial);
  }

  /** Loads KaTeX for the preview (once). */
  loadPreview(): void {
    if (this.katex || this.katexLoading) return;
    this.katexLoading = true;
    import('./helpMath')
      .then((m) => {
        this.katex = m;
        this.renderPreview();
      })
      .catch((err) => console.error(err)); // the preview is optional
  }

  /** Takes over a formula set from outside (e.g. a restored recording). */
  setValue(tex: string): void {
    if (tex === this.applied) return;
    if (document.activeElement !== this.input) this.input.value = tex;
    if (this.ready) this.use(tex);
  }

  /** Parses the input: shows the error, or starts using the new formula. */
  commit(): void {
    window.clearTimeout(this.timer);
    if (!this.ready) return;
    const tex = this.input.value.trim();
    if (tex === this.applied) {
      this.showError(null);
      return;
    }
    if (this.use(tex)) this.hooks.committed(tex);
  }

  /** Starts using `tex` if it is valid; otherwise shows why not. */
  private use(tex: string): boolean {
    const message = this.hooks.tryUse(tex);
    if (message !== null) {
      this.showError(message);
      return false;
    }
    this.showError(null);
    this.applied = tex;
    this.renderPreview();
    return true;
  }

  showError(message: string | null): void {
    this.input.setAttribute('aria-invalid', String(message !== null));
    this.error.hidden = message === null;
    this.error.textContent = message ?? '';
    // The preview keeps showing the formula in use, dimmed while the input differs from it.
    this.preview?.classList.toggle('stale', message !== null);
  }

  private renderPreview(): void {
    if (!this.katex || !this.applied || !this.preview) return;
    this.katex.renderTex(this.preview, `${this.previewPrefix}${this.applied}`);
  }
}

function must<T>(el: T | null): T {
  if (!el) throw new Error('Formula input markup is incomplete.');
  return el;
}
