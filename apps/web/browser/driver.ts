// Chromium for the browser tests, and the injected test wallet. The wallet is a Wallet Standard
// wallet registered by an init script (the same discovery path a real extension uses); its key
// stays in Node and every signature request is counted, so a test can prove that only the lock
// asked the wallet for anything.
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SolanaSigner } from '@xmrswap/sdk';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright-core';
import { base58 } from './stack.js';

/** `CHROMIUM=<path>`, else the newest build in the Playwright cache. Tests never rely on a download. */
export async function findChromium(): Promise<string> {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  for (const d of (await readdir(cache).catch(() => [] as string[])).filter((x) => x.startsWith('chromium')).sort().reverse())
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell'])
      if (existsSync(path.join(cache, d, rel))) return path.join(cache, d, rel);
  throw new Error('no Chromium found; set CHROMIUM=/path/to/chrome');
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: await findChromium(), headless: true });
}

export interface TestWallet {
  /** How many transactions the wallet was asked to sign. */
  signed: number;
  /** Refuse the next request, like a user clicking "Reject". */
  rejectNext: boolean;
}

/** Register a Wallet Standard wallet in every page of the context, signing with `key` in Node. */
export async function injectWallet(context: BrowserContext, key: SolanaSigner): Promise<TestWallet> {
  const state: TestWallet = { signed: 0, rejectNext: false };
  await context.exposeFunction('__testWalletSign', async (messageB64: string): Promise<string> => {
    if (state.rejectNext) {
      state.rejectNext = false;
      throw new Error('User rejected the request.');
    }
    state.signed++;
    const sig = await key.sign(Uint8Array.from(Buffer.from(messageB64, 'base64')));
    return Buffer.from(sig).toString('base64');
  });
  await context.addInitScript(
    ({ address, publicKey }) => {
      const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
      const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const account = { address, publicKey: new Uint8Array(publicKey), chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'], features: ['solana:signTransaction'] };
      let connected: (typeof account)[] = [];
      const listeners = new Set<(p: { accounts: (typeof account)[] }) => void>();
      const wallet = {
        version: '1.0.0',
        name: 'Test Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
        chains: account.chains,
        get accounts() {
          return connected;
        },
        features: {
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              connected = [account];
              for (const l of listeners) l({ accounts: connected });
              return { accounts: connected };
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => {
              connected = [];
              for (const l of listeners) l({ accounts: connected });
            },
          },
          'standard:events': {
            version: '1.0.0',
            on: (_event: string, l: (p: { accounts: (typeof account)[] }) => void) => {
              listeners.add(l);
              return () => listeners.delete(l);
            },
          },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
              const out = [];
              for (const i of inputs) {
                // A legacy transaction on the wire: compact-u16 signature count, the signatures, the message.
                const tx = new Uint8Array(i.transaction);
                const n = tx[0]!;
                if (n >= 0x80) throw new Error('test wallet: too many signatures');
                const message = tx.slice(1 + 64 * n);
                const sig = unb64(await (window as unknown as { __testWalletSign(m: string): Promise<string> }).__testWalletSign(b64(message)));
                // The wallet is the fee payer: its signature is the first.
                tx.set(sig, 1);
                out.push({ signedTransaction: tx });
              }
              return out;
            },
          },
        },
      };
      const register = (api: { register(w: unknown): void }) => api.register(wallet);
      try {
        window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }) as Event);
      } catch {
        // no listener yet
      }
      window.addEventListener('wallet-standard:app-ready', (e) => register((e as CustomEvent<{ register(w: unknown): void }>).detail));
    },
    { address: key.publicKey, publicKey: [...decode58(key.publicKey)] },
  );
  return state;
}

function decode58(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (base58(out) !== s) throw new Error('bad base58 key');
  return out;
}

/** Console errors and page crashes fail a test: collect them. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

export async function connectWallet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect Solana' }).click();
  await page.getByRole('button', { name: /^Solana / }).waitFor();
}

/** Create the recovery file through the UI: download it, then confirm it is saved. Returns the file's text. */
export async function saveRecoveryFile(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create a recovery file' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recovery file' }).click()]);
  const file = await download.path();
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(file, 'utf8');
  await page.getByRole('checkbox', { name: /I saved the recovery file/ }).click();
  await page.locator('[data-testid="backup"][data-state="saved"]').waitFor();
  return text;
}
