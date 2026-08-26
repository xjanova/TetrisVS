import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
  build: { target: 'es2022' },
});
