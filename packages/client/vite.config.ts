import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `vite build --mode hub` (root script `npm run hub:build`) produces the static
 * demo published inside the XMAN GAMES HUB at /play/tetrisvs/. It differs from
 * the normal build in three ways and nothing else:
 *  - relative asset URLs, because the page is served from a sub-path
 *  - its own output folder, so it never overwrites `dist/`
 *  - no copy of `public/`: nothing in `src/` or `index.html` references
 *    `public/art` today, so shipping it would only add 3.5 MB of dead weight.
 *    If the client starts using those files, drop this and add "art" to the
 *    `ship` list in hub.json.
 * The client reads the mode too (src/game/hub.ts) to switch off everything that
 * needs the game server.
 */
export default defineConfig(({ mode }) => {
  const hub = mode === 'hub';
  return {
    plugins: [react()],
    base: hub ? './' : '/',
    server: {
      // Vite's default `localhost` resolves to ::1 first on Windows, so the dev
      // server came up reachable only over IPv6 while every script, the README,
      // and the end-to-end harness point at 127.0.0.1. Pin the loopback.
      host: '127.0.0.1',
      port: 5173,
      // Fail loudly on a port clash instead of silently moving to 5174, where
      // nothing else knows to look for the app.
      strictPort: true,
    },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: {
      target: 'es2022',
      outDir: hub ? 'dist-hub' : 'dist',
      copyPublicDir: !hub,
    },
  };
});
