// The taker's side in a real browser: a static server for the BUILT web UI (apps/web/dist) with
// a `config.json` pointing at the harness, Chromium from the Playwright cache, and injected test
// wallets whose keys stay in Node (a Wallet Standard wallet for Solana, an EIP-1193 provider for
// Ethereum). Every signature request is counted.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { SolanaSigner } from '@xmrswap/sdk';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright-core';
import type { PrivateKeyAccount } from 'viem/accounts';
import { connectWallet, findChromium, injectWallet, saveRecoveryFile, watchErrors, type TestWallet } from '../../../apps/web/browser/driver.js';
import type { EthWorld } from './chains.js';
import { repoRoot, stateRoot } from './util.js';

export { connectWallet, saveRecoveryFile, watchErrors, type TestWallet };

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json' };

export interface UiServer {
  url: string;
  /** What `config.json` returns; edits apply to the next page load. */
  config: Record<string, unknown>;
  close(): Promise<void>;
}

/** Serve the built taker UI and its `config.json` on the given loopback port. */
export async function serveWeb(port: number, config: Record<string, unknown>): Promise<UiServer> {
  const dist = path.join(repoRoot, 'apps/web/dist');
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('apps/web/dist is missing; run `pnpm --filter @xmrswap/web build`');
  const ui: UiServer = { url: `http://127.0.0.1:${port}`, config, close: async () => undefined };
  const server = http.createServer(async (req, res) => {
    const p = path.normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
    if (p === 'config.json') {
      res.writeHead(200, { 'content-type': MIME['.json']!, 'cache-control': 'no-store' });
      return void res.end(JSON.stringify(ui.config));
    }
    const file = path.join(dist, p);
    if (!file.startsWith(dist)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  ui.close = () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
  return ui;
}

let browser: Browser | null = null;
export async function launchBrowser(): Promise<Browser> {
  browser ??= await chromium.launch({ executablePath: await findChromium(), headless: !process.env['HEADED'] });
  return browser;
}
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

export interface EthTestWallet {
  /** Transactions the wallet was asked to send. */
  signed: number;
  rejectNext: boolean;
  /** The user approved this site (`eth_requestAccounts`). */
  connected: boolean;
}

/** `window.ethereum` in every page of the context: an EIP-1193 provider that signs with `key` in Node and submits to anvil. */
export async function injectEthWallet(context: BrowserContext, key: PrivateKeyAccount, eth: EthWorld): Promise<EthTestWallet> {
  const state: EthTestWallet = { signed: 0, rejectNext: false, connected: false };
  await context.exposeFunction('__testEthRequest', async (method: string, paramsJson: string): Promise<string> => {
    const params = JSON.parse(paramsJson) as unknown[];
    switch (method) {
      case 'eth_requestAccounts':
        state.connected = true;
        return JSON.stringify([key.address.toLowerCase()]);
      case 'eth_accounts':
        // A wallet reveals its accounts only to a site the user connected it to.
        return JSON.stringify(state.connected ? [key.address.toLowerCase()] : []);
      case 'eth_chainId':
        return JSON.stringify('0x7a69');
      case 'eth_sendTransaction': {
        if (state.rejectNext) {
          state.rejectNext = false;
          throw new Error('User rejected the request.');
        }
        const tx = params[0] as { from: string; to: `0x${string}`; data: `0x${string}`; value?: string };
        if (tx.from.toLowerCase() !== key.address.toLowerCase()) throw new Error('test wallet: unknown account');
        state.signed++;
        const value = BigInt(tx.value ?? '0x0');
        const nonce = Number(await eth.rpc<string>('eth_getTransactionCount', [key.address, 'pending']));
        const gas = BigInt(await eth.rpc<string>('eth_estimateGas', [{ from: key.address, to: tx.to, data: tx.data, value: `0x${value.toString(16)}` }]));
        const base = BigInt((await eth.rpc<{ baseFeePerGas: string }>('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
        const raw = await key.signTransaction({ chainId: 31337, to: tx.to, data: tx.data, value, nonce, gas: (gas * 13n) / 10n, maxFeePerGas: base * 2n + 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, type: 'eip1559' });
        return JSON.stringify(await eth.rpc<string>('eth_sendRawTransaction', [raw]));
      }
      default:
        throw new Error(`test wallet: ${method} is not supported`);
    }
  });
  await context.addInitScript(() => {
    const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
    (window as unknown as { ethereum: unknown }).ethereum = {
      isTestWallet: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => JSON.parse(await (window as unknown as { __testEthRequest(m: string, p: string): Promise<string> }).__testEthRequest(method, JSON.stringify(params ?? []))),
      on: (event: string, h: (...a: unknown[]) => void) => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(h),
      removeListener: (event: string, h: (...a: unknown[]) => void) => void listeners.get(event)?.delete(h),
    };
  });
  return state;
}

export interface TakerTab {
  context: BrowserContext;
  page: Page;
  errors: string[];
  sol: TestWallet;
  eth: EthTestWallet | null;
  /** Every dialog the browser raised (the leave-page prompt is `beforeunload`); each one is accepted. */
  dialogs: string[];
  close(): Promise<void>;
}

/** A fresh browser profile with the test wallets installed. Nothing is connected until the page asks. */
export async function openTab(o: { solKey: SolanaSigner; ethKey?: PrivateKeyAccount; eth?: EthWorld | null }): Promise<TakerTab> {
  const b = await launchBrowser();
  const context = await b.newContext({ acceptDownloads: true });
  const sol = await injectWallet(context, o.solKey);
  const eth = o.ethKey && o.eth ? await injectEthWallet(context, o.ethKey, o.eth) : null;
  const page = await context.newPage();
  const errors = watchErrors(page);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.type());
    void d.accept().catch(() => undefined);
  });
  return { context, page, errors, sol, eth, dialogs, close: () => context.close() };
}

/** The swap reference in the page's address (`#/swap/<ref>`). */
export const refInUrl = (page: Page): string => decodeURIComponent(new URL(page.url()).hash.split('/').pop()!);
export const text = (page: Page, t: string | RegExp) => page.getByText(t).first();
/** The visible text of the page's main region (for failure messages and exploration). */
export const mainText = (page: Page): Promise<string> => page.locator('body').innerText();

export async function tmpProfileDir(): Promise<{ dir: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(path.join(stateRoot, 'profile-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
