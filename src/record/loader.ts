import type { BusyOverlay } from '../ui/busyOverlay';
import type { DropHandler } from '../ui/dropzone';
import { readNpz } from './npzRead';
import { RecordingError, RecordingTimeline } from './timeline';

export function isRecordingFile(file: File): boolean {
  return /\.npz$/i.test(file.name);
}

/** Reads a recording file behind the busy overlay; errors become user-facing messages. */
export async function loadRecording(file: File, busy: BusyOverlay): Promise<RecordingTimeline> {
  return busy.run('Loading recording…', file.name, async () => {
    let arrays;
    try {
      arrays = await readNpz(new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      console.error(err);
      throw new RecordingError('This file could not be read as an .npz recording.');
    }
    return new RecordingTimeline(arrays);
  });
}

/**
 * Drop handler for recorded simulations. Any dragged file that is not an image shows the
 * "Add recorded simulation" zone; on drop only .npz files are accepted.
 */
export class RecordingDropHandler implements DropHandler {
  readonly id = 'recording';

  constructor(private readonly open: (file: File) => void) {}

  acceptsDrag(items: readonly DataTransferItem[]): boolean {
    return items.some((i) => !i.type.startsWith('image/'));
  }

  acceptsFile(file: File): boolean {
    return isRecordingFile(file);
  }

  drop(file: File): void {
    this.open(file);
  }
}
