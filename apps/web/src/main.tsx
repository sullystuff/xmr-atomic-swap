import './polyfills.js';
import './styles.css';
import { init } from '@xmrswap/sdk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App.js';
import { App } from './lib/app.js';
import { browserGuardEnv } from './lib/guard.js';
import { fetchDeploymentConfig } from './lib/settings.js';
import { openKV } from './lib/storage.js';

async function boot(): Promise<void> {
  const root = createRoot(document.getElementById('root')!);
  try {
    // The wasm core is served from this origin; nothing else is fetched.
    const [deployment] = await Promise.all([fetchDeploymentConfig(), init()]);
    const app = new App({ kv: openKV(), deployment, guardEnv: browserGuardEnv() });
    await app.start();
    root.render(
      <StrictMode>
        <Root app={app} />
      </StrictMode>,
    );
  } catch (e) {
    root.render(
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1>The page could not start</h1>
        <p className="muted mt-3">The cryptography core (a WebAssembly file served by this site) did not load: {e instanceof Error ? e.message : String(e)}. No swap can run without it. Reload the page; if a swap is open and this keeps happening, open the site in another browser and load your recovery file.</p>
      </main>,
    );
  }
}
void boot();
