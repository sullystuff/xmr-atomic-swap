import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
// `VITE_DAEMON_URL` points the console at a daemon on another loopback port; by default it uses
// the origin that served this page. `VITE_DAEMON_TOKEN` is set only by `pnpm dev` for the mock.
const baseUrl = (import.meta.env.VITE_DAEMON_URL as string | undefined) ?? '';
const devToken = import.meta.env.VITE_DAEMON_TOKEN as string | undefined;
createRoot(root).render(
  <StrictMode>
    <Root baseUrl={baseUrl} {...(devToken ? { initialToken: devToken } : {})} />
  </StrictMode>,
);
