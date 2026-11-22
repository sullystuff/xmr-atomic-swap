import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AssetId, ExecContext, EthSend, HttpClient, HttpRequest, HttpResponse, PriceSource, SolSend, XmrSend } from '../src/index.js';

/** Reference prices used across the tests (USD per whole unit). */
export const PRICES: Record<AssetId, number> = { xmr: 400, sol: 200, eth: 4000, usdc_sol: 1, usdc_eth: 1 };
export const prices = (over: Partial<Record<AssetId, number>> = {}): PriceSource => ({ usd: async (a) => ({ ...PRICES, ...over })[a] });

// Addresses used as "the maker's own". The XMR one is a syntactically plausible 95-character string, not a real wallet.
export const XMR_ADDR = '4' + 'A'.repeat(94);
export const XMR_ADDR_2 = '8' + 'B'.repeat(94);
export const SOL_ADDR = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
export const ETH_ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';
export const ALLOW = { xmr: [XMR_ADDR], sol: [SOL_ADDR], eth: [ETH_ADDR] };

export interface Route { method: 'GET' | 'POST'; path: string; status?: number; body: unknown; /** Only matches when the request body or URL contains this text. */ when?: string }

/** A fixture HTTP client: answers from a route table and records every request. It can not reach the network. */
export class FixtureHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(public routes: Route[]) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const url = new URL(req.url);
    const hit = this.routes.find((r) => r.method === req.method && url.pathname.endsWith(r.path) && (!r.when || req.url.includes(r.when) || (req.body ?? '').includes(r.when)));
    if (!hit) return { status: 404, body: JSON.stringify({ message: `no fixture for ${req.method} ${url.pathname}` }) };
    return { status: hit.status ?? 200, body: typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body) };
  }
  last(path: string): HttpRequest {
    const r = [...this.requests].reverse().find((x) => new URL(x.url).pathname.endsWith(path));
    if (!r) throw new Error(`no request to ${path}`);
    return r;
  }
  count(path: string): number { return this.requests.filter((x) => new URL(x.url).pathname.endsWith(path)).length; }
}

export interface FakeCtx extends ExecContext {
  journalled: { step: string; data: unknown }[];
  sol: SolSend[]; eth: EthSend[]; xmr: XmrSend[];
  /** Order of everything that happened: `journal:<step>` and `send:<chain>`. */
  order: string[];
  clock: { t: number };
  failNextSend?: string;
}

export function fakeCtx(start = 1_800_000_000, onSol?: (send: SolSend, sig: string) => void): FakeCtx {
  let n = 0;
  const ctx: FakeCtx = {
    journalled: [], sol: [], eth: [], xmr: [], order: [], clock: { t: start },
    async journal(step, data) { ctx.journalled.push({ step, data }); ctx.order.push(`journal:${step}`); },
    async sendSol(send) {
      if (ctx.failNextSend) { const m = ctx.failNextSend; delete ctx.failNextSend; throw new Error(m); }
      ctx.sol.push(send); ctx.order.push('send:sol');
      const sig = `solsig${++n}`;
      onSol?.(send, sig);
      return sig;
    },
    async sendEth(send) {
      if (ctx.failNextSend) { const m = ctx.failNextSend; delete ctx.failNextSend; throw new Error(m); }
      ctx.eth.push(send); ctx.order.push('send:eth'); return `0xethtx${++n}`;
    },
    async sendXmr(send) {
      if (ctx.failNextSend) { const m = ctx.failNextSend; delete ctx.failNextSend; throw new Error(m); }
      ctx.xmr.push(send); ctx.order.push('send:xmr'); return `xmrtx${++n}`;
    },
    now: () => ctx.clock.t,
  };
  return ctx;
}

export function fixture(name: string): any {
  const text = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
  // The fixtures name the maker's addresses by placeholder.
  return JSON.parse(text.replaceAll('__XMR__', XMR_ADDR).replaceAll('__SOL__', SOL_ADDR).replaceAll('__ETH__', ETH_ADDR));
}

/** Everything a test could have leaked a secret into. */
export function everythingSeen(ctx: FakeCtx, errors: unknown[] = []): string {
  return JSON.stringify(ctx.journalled) + errors.map((e) => String((e as Error)?.message ?? e) + String((e as Error)?.stack ?? '')).join('\n');
}
