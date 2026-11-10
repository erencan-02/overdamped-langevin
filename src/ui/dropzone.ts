/**
 * Window-wide drag and drop, dispatched to pluggable handlers. While a file is dragged only its
 * MIME type is known, so each handler decides from the types whether it is the right one and
 * gets its own layout inside the overlay (the image handler shows two zones, the recording
 * handler one). On drop the actual file name is known and decides which handler receives it.
 *
 * Adding a new kind of droppable file means writing one DropHandler and one layout element
 * (`.drop-layout[data-handler="<id>"]` inside #drop-overlay).
 */
export interface DropHandler {
  /** Matches `data-handler` of the handler's layout inside the drop overlay. */
  readonly id: string;
  /** Whether a drag carrying these items (types only) should show this handler's layout. */
  acceptsDrag(items: readonly DataTransferItem[]): boolean;
  /** Whether this handler takes the dropped file. */
  acceptsFile(file: File): boolean;
  /** Updates the layout while the cursor moves (e.g. highlights the zone under it). */
  hover?(clientX: number, clientY: number, layout: HTMLElement): void;
  drop(file: File, clientX: number, clientY: number): void;
}

export class DropController {
  private depth = 0;
  private current: DropHandler | null = null;
  private readonly overlay = el('drop-overlay');

  constructor(
    private readonly handlers: readonly DropHandler[],
    private readonly isBusy: () => boolean,
    private readonly reject: (message: string) => void,
    /** Why a drop is refused while `isBusy` (shown to the user), or null to ignore it silently. */
    private readonly blockedReason: () => string | null = () => null,
  ) {
    window.addEventListener('dragenter', this.onEnter);
    window.addEventListener('dragover', this.onOver);
    window.addEventListener('dragleave', this.onLeave);
    window.addEventListener('drop', this.onDrop);
  }

  private hasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files');
  }

  private layout(id: string): HTMLElement | null {
    return this.overlay.querySelector<HTMLElement>(`.drop-layout[data-handler="${id}"]`);
  }

  private show(handler: DropHandler | null, e: DragEvent): void {
    this.current = handler;
    for (const h of this.handlers) {
      const l = this.layout(h.id);
      if (l) l.hidden = h !== handler;
    }
    this.overlay.hidden = handler === null;
    const l = handler && this.layout(handler.id);
    if (handler && l) handler.hover?.(e.clientX, e.clientY, l);
  }

  private onEnter = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.depth++;
    if (this.depth > 1 || this.isBusy()) return;
    const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file');
    this.show(this.handlers.find((h) => h.acceptsDrag(items)) ?? null, e);
  };

  private onOver = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    // Without preventDefault the browser would open the file in the tab.
    e.preventDefault();
    const accept = !this.isBusy() && this.current !== null;
    if (e.dataTransfer) e.dataTransfer.dropEffect = accept ? 'copy' : 'none';
    const l = this.current && this.layout(this.current.id);
    if (accept && l) this.current!.hover?.(e.clientX, e.clientY, l);
  };

  private onLeave = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.hide();
  };

  private onDrop = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.depth = 0;
    this.hide();
    if (this.isBusy()) {
      const why = this.blockedReason();
      if (why) this.reject(why);
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    for (const file of files) {
      const handler = this.handlers.find((h) => h.acceptsFile(file));
      if (handler) {
        handler.drop(file, e.clientX, e.clientY);
        return;
      }
    }
    this.reject('Drop an image (PNG, JPEG, WebP, GIF, SVG) or a recorded simulation (.npz).');
  };

  private hide(): void {
    this.overlay.hidden = true;
    this.current = null;
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e;
}
