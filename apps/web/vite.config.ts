import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The E2E suite runs its own API instance on a different port so it never
// touches a stack that happens to be running on 8420.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8420';

const PROXY = {
  '/api': API_TARGET,
  '/events': { target: API_TARGET, ws: false },
  '/healthz': API_TARGET,
};

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // The API and the SSE stream are served by the Hono app (§3); in dev they
    // are proxied so the browser sees a single origin, exactly as it will
    // behind nginx in production. WebAuthn depends on that: the relying-party
    // id is derived from the origin, so a split origin would break the
    // ceremony in dev in a way it never would in production.
    proxy: PROXY,
  },
  // The browser suite serves the **built** bundle rather than the dev server,
  // so `preview` needs the same proxy — see A120 and `playwright.config.ts`.
  preview: {
    proxy: PROXY,
  },
});
