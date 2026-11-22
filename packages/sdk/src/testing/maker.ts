import { MAKER_PATH_PATTERN, RELAY_ROUTES, type RelayForwardRequest } from '@xmrswap/protocol';
import type { HttpFetch, MakerEndpoint } from '../messages/transports.js';
import { type Bytes, fromBase64, toBase64 } from '../util.js';

type Handler = (method: 'GET' | 'POST' | 'PUT', path: string, body?: Bytes) => { status: number; body?: Bytes | string } | Promise<{ status: number; body?: Bytes | string }>;

const bytesOf = (b: Bytes | string | undefined): Bytes => (b === undefined ? new Uint8Array(0) : typeof b === 'string' ? new TextEncoder().encode(b) : b);

/** A `MakerEndpoint` backed by a handler function: a maker daemon's `/xs/v1` routes in memory. */
export function fakeMakerEndpoint(handler: Handler): MakerEndpoint & { requests: { method: string; path: string; body?: Bytes }[] } {
  const requests: { method: string; path: string; body?: Bytes }[] = [];
  return {
    requests,
    async request(method, path, body) {
      requests.push({ method, path, ...(body ? { body } : {}) });
      const r = await handler(method, path, body);
      return { status: r.status, body: bytesOf(r.body) };
    },
  };
}

/**
 * A `fetch` that plays a relay in front of in-memory makers: `POST /relay/v1/forward` is
 * forwarded to `makers[onion]`; an unlisted onion or a disallowed path is refused, as the real
 * relay does. `down = true` makes every request fail like an unreachable host.
 */
export function fakeRelayFetch(makers: Record<string, Handler>): HttpFetch & { down: boolean; forwarded: RelayForwardRequest[] } {
  const forwarded: RelayForwardRequest[] = [];
  const respond = (status: number, body: Bytes | string) => ({ status, arrayBuffer: async () => bytesOf(body).slice().buffer as ArrayBuffer });
  const f = (async (url: string, init: { method: string; body?: Bytes | string }) => {
    if (f.down) throw new Error('connect ECONNREFUSED');
    if (!url.endsWith(RELAY_ROUTES.forward) || init.method !== 'POST') return respond(404, '{}');
    const req = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) as RelayForwardRequest;
    forwarded.push(req);
    const maker = makers[req.onion];
    if (!maker) return respond(403, JSON.stringify({ code: 'not_allowed' }));
    if (!MAKER_PATH_PATTERN.test(req.path)) return respond(400, JSON.stringify({ code: 'bad_request' }));
    const r = await maker(req.method, req.path, req.body_b64 ? fromBase64(req.body_b64) : undefined);
    return respond(200, JSON.stringify({ status: r.status, body_b64: toBase64(bytesOf(r.body)) }));
  }) as HttpFetch & { down: boolean; forwarded: RelayForwardRequest[] };
  f.down = false;
  f.forwarded = forwarded;
  return f;
}
