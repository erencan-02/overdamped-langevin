import { registerSW } from 'virtual:pwa-register';
import type { App } from './app';

/**
 * The offline app: registers the service worker of the production build (see vite.config.ts),
 * which keeps every file of the app, so it works without a network after the first visit and can
 * be installed. A new version is not loaded by surprise (that would lose the current set-up): it
 * is offered with a Reload button. Online-only features (opening a GitHub Gist) still need a
 * network.
 */
export function setUpOffline(app: App): void {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  const reload = registerSW({
    onNeedRefresh() {
      app.controls.showToast('A new version of the app is available', { label: 'Reload', run: () => void reload(true) });
    },
    onOfflineReady() {
      app.controls.showToast('The app is now also available offline');
    },
    onRegisterError(err: unknown) {
      console.warn('The offline app could not be set up:', err);
    },
  });
}
