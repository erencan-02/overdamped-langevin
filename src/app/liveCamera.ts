import { LiveCamera } from '../image/liveCamera';
import type { App } from './app';

/** The front camera as a live Ψ: dark areas become valleys (the camera button, V). */
export function createLiveCamera(app: App): LiveCamera {
  const controls = () => app.controls;
  const camera: LiveCamera = new LiveCamera(
    document.getElementById('cam-video') as HTMLVideoElement,
    app.core.field,
    app.core.camera,
    {
      onStateChange: (s) => {
        controls().setCameraState(s);
        // The camera rewrites Ψ every frame: steps recorded before it no longer apply.
        if (s === 'live') app.core.history.clear();
        if (s === 'starting') controls().showToast('Waiting for camera permission…');
        if (s === 'live') {
          controls().showToast('Camera live: dark areas are valleys', {
            label: 'Invert',
            run: () => {
              camera.invert = !camera.invert;
              controls().showToast(camera.invert ? 'Inverted: light areas are valleys' : 'Dark areas are valleys');
            },
          });
        }
      },
      onError: (message) => controls().showToast(message),
    },
  );
  return camera;
}
