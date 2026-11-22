/**
 * The only way adapters reach a venue's HTTP API. Tests inject a fixture client; the daemon
 * injects `fetchHttpClient()` (optionally through its own proxy). Nothing in this package opens
 * a socket on its own.
 */
export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  /** Sent byte for byte (FixedFloat signs it). */
  body?: string;
}
export interface HttpResponse { status: number; body: string }
export interface HttpClient { request(req: HttpRequest): Promise<HttpResponse> }

export function fetchHttpClient(timeoutMs = 20_000): HttpClient {
  return {
    async request(req) {
      const init: RequestInit = { method: req.method, signal: AbortSignal.timeout(timeoutMs) };
      if (req.headers) init.headers = req.headers;
      if (req.body !== undefined) init.body = req.body;
      const res = await fetch(req.url, init);
      return { status: res.status, body: await res.text() };
    },
  };
}

/** An HTTP failure. Carries the method, path and status only: never headers, never a query string, never a body we sent. */
export class HttpError extends Error {
  readonly status: number;
  constructor(method: string, url: string, status: number, detail?: string) {
    super(`${method} ${redactUrl(url)} -> ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Sends a request and parses a JSON body; a non-2xx status or a non-JSON body is an `HttpError` with a short, secret-free detail. */
export async function requestJson(http: HttpClient, req: HttpRequest): Promise<unknown> {
  const res = await http.request(req);
  let parsed: unknown;
  try { parsed = res.body === '' ? null : JSON.parse(res.body); } catch { parsed = undefined; }
  if (res.status < 200 || res.status >= 300) throw new HttpError(req.method, req.url, res.status, venueMessage(parsed));
  if (parsed === undefined) throw new HttpError(req.method, req.url, res.status, 'response is not JSON');
  return parsed;
}

function venueMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const k of ['message', 'error', 'msg', 'err']) {
      const v = o[k];
      if (typeof v === 'string') return v.slice(0, 200);
      if (v && typeof v === 'object' && typeof (v as Record<string, unknown>)['message'] === 'string') return String((v as Record<string, unknown>)['message']).slice(0, 200);
    }
  }
  return undefined;
}

/** Reads credentials by environment-variable name. The value is returned to the adapter and goes nowhere else. */
export type EnvReader = (name: string) => string | undefined;
export const processEnv: EnvReader = (name) => process.env[name];

// ---- tolerant field readers for venue JSON

export function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what}: expected an object`);
  return v as Record<string, unknown>;
}
export function str(v: unknown, what: string): string {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new Error(`${what}: expected a string`);
}
export function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
/** A decimal amount as the venue wrote it (string or JSON number). */
export function dec(v: unknown, what: string): string | number {
  if (typeof v === 'string' && /^\d*\.?\d+$|^\d+\.$/.test(v.trim())) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  throw new Error(`${what}: expected a decimal amount`);
}
export function optDec(v: unknown): string | number | undefined {
  try { return v === null || v === undefined || v === '' ? undefined : dec(v, ''); } catch { return undefined; }
}
