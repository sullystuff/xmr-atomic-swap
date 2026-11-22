import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * A strict Content-Security-Policy for the built page (SPEC 8.3): scripts, styles and wasm from
 * the same origin only, no inline script, no third-party anything. `connect-src` stays open
 * because the RPC endpoints, Monero nodes and relay are whatever the user configured.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' data:",
  'connect-src http: https:',
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'xmrswap-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta name="referrer"', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <meta name="referrer"`),
  };
}

export default defineConfig({
  // Relative asset paths: the build is static files that work from any directory or origin.
  base: './',
  plugins: [react(), tailwindcss(), csp()],
  define: { global: 'globalThis' },
  server: { host: '127.0.0.1', port: 5184, strictPort: true },
  preview: { host: '127.0.0.1', port: 5184, strictPort: true },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', chunkSizeWarningLimit: 4000 },
});
