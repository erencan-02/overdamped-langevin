import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

// `base: './'` makes the build work from any sub-path, e.g. https://<user>.github.io/<repo>/
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // Libraries first used later (export, the GIF worker) are prepared when the dev server starts,
  // so it does not reload the page when they are first needed.
  optimizeDeps: {
    include: ['gifenc', 'mediabunny', 'svgcanvas'],
  },
  plugins: [
    // Offline app: a service worker (Workbox) keeps every file of the build, so the app, its
    // lazily loaded parts (formula engine, 3D view, KaTeX) and the course scenarios work without
    // a network after the first visit; the manifest makes it installable. Only the production
    // build has the service worker (not the dev server).
    VitePWA({
      registerType: 'prompt', // a new version is offered with a Reload button (src/app/offline.ts)
      injectRegister: false, // registered by src/app/offline.ts
      manifest: {
        name: 'Langevin Dynamics',
        short_name: 'Langevin',
        description:
          'Paint a potential landscape and watch particles follow the stochastic differential equation dX = −∇Ψ(X) dt + σ dW in real time.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // (The manifest and its icons are added by the plugin itself.)
        globPatterns: ['**/*.{js,css,html,svg,png,json,woff,woff2,ttf}'],
        globIgnores: ['icon-*.png', 'favicon.svg'],
        // The formula engine is one large chunk; it must be kept too.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        // Any address of the app (?embed, #s=…) opens the cached page when offline.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Google Fonts: the style sheet (may change) and the font files (never change).
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-css', cacheableResponse: { statuses: [0, 200] } },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 3600 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
