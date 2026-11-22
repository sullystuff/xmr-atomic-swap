import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Loopback address of the daemon's local API (SPEC 7.2 `[daemon].api_bind`). */
const DAEMON_URL = process.env.DAEMON_URL ?? 'http://127.0.0.1:7071';
const MOCK_PORT = Number(process.env.MOCK_DAEMON_PORT ?? 7171);

/** `vite --mode mock`: start the mock daemon on loopback in this process and proxy `/api` to it. */
function mockDaemon(): Plugin {
  return {
    name: 'xmrswap-mock-daemon',
    apply: 'serve',
    async configureServer(server) {
      const { startMockServer, MOCK_TOKEN } = await import('./server/mock-server.js');
      const mock = await startMockServer({ port: MOCK_PORT });
      server.httpServer?.once('close', () => void mock.close());
      server.config.logger.info(`\n  mock daemon on ${mock.url} (bearer token: ${MOCK_TOKEN})\n`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const mock = mode === 'mock';
  const target = mock ? `http://127.0.0.1:${MOCK_PORT}` : DAEMON_URL;
  return {
    plugins: [react(), tailwindcss(), ...(mock ? [mockDaemon()] : [])],
    define: mock ? { 'import.meta.env.VITE_DAEMON_TOKEN': JSON.stringify('mock-token') } : {},
    server: {
      host: '127.0.0.1',
      port: 5183,
      strictPort: true,
      proxy: { '/api': { target, ws: true, changeOrigin: false } },
    },
    preview: { host: '127.0.0.1', port: 5183, proxy: { '/api': { target, ws: true } } },
    build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  };
});
