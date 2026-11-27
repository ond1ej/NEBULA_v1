/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { collectLicenseFiles } from './scripts/third-party-licenses.mjs';

// Dev-only proxy to the local NEBULA host API.
// The host API checks Host and Origin on every request (DNS-rebinding / CSRF guard):
//  * changeOrigin rewrites Host to the target, so run the host on that port (the default is 3100);
//  * the browser Origin stays http://127.0.0.1:5173, so start the host with
//    NEBULA_DEV_ORIGIN=http://127.0.0.1:5173 or mutations and the live WebSocket are rejected (bad_origin).
// NEBULA_API_TARGET overrides the target (e.g. a second host instance on another local port).
const API_TARGET = process.env.NEBULA_API_TARGET ?? 'http://127.0.0.1:3100';

// Two pages share one asset graph: the Dashboard (index.html) and the Telegram Mini App (mini.html).
// Both reference hashed bundles under /assets/, which the host (and the Mini App gateway) serve.
const PAGES = {
  main: fileURLToPath(new URL('./index.html', import.meta.url)),
  mini: fileURLToPath(new URL('./mini.html', import.meta.url)),
};

/** Dev server: /mini and /mini/* render mini.html, exactly like the host and the Mini App gateway do. */
function miniAppDevRoute(): Plugin {
  return {
    name: 'nebula-mini-app-route',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? '';
        const path = url.split('?')[0];
        if (path === '/mini' || path.startsWith('/mini/')) req.url = '/mini.html';
        next();
      });
    },
  };
}

/**
 * noVNC is MPL-2.0 and esbuild strips its header comments, so its license notices (plus pako, DES and the React
 * licenses) are emitted into the build as dist/licenses/*.txt and linked from Settings -> Third-party licenses.
 */
function thirdPartyLicenses(): Plugin {
  const root = fileURLToPath(new URL('.', import.meta.url));
  return {
    name: 'nebula-third-party-licenses',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const text = path.startsWith('/licenses/') ? collectLicenseFiles(root)[path.slice(1)] : undefined;
        if (text === undefined) return next();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(text);
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(collectLicenseFiles(root))) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), miniAppDevRoute(), thirdPartyLicenses()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Must come before '/api' so the WebSocket upgrade is proxied.
      '/api/v1/live/ws': { target: API_TARGET, ws: true, changeOrigin: true },
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // noVNC 1.7 uses top-level await (WebCodecs H.264 probe).
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: PAGES,
      output: {
        // React changes far less often than NEBULA's own code: its own chunk stays cached across updates.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
  },
  esbuild: {
    target: 'esnext',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    css: false,
  },
});
