import { MAKER_PATH_PATTERN, MAKER_ROUTE_METHODS } from '@xmrswap/protocol';

/** A v3 onion host exactly as the registry stores it: 56 base32 characters and `.onion` (SPEC 4.3 `set_onion`). */
const ONION_V3 = /^[a-z2-7]{56}\.onion$/;

/**
 * True only for a bare v3 onion host name. Everything else is refused before the registry is
 * even consulted: clearnet names, IP literals, ports, userinfo, upper case, trailing dots,
 * anything with a path or whitespace.
 */
export function isOnionHost(value: unknown): value is string {
  return typeof value === 'string' && ONION_V3.test(value);
}

export type MakerRoute = keyof typeof MAKER_ROUTE_METHODS;

/** The maker route a path names, or `null` if the relay does not forward it. */
export function makerRouteOf(path: unknown): MakerRoute | null {
  if (typeof path !== 'string') return null;
  const m = MAKER_PATH_PATTERN.exec(path);
  if (!m) return null;
  const head = m[1]!.split('/')[0]!;
  return head in MAKER_ROUTE_METHODS ? (head as MakerRoute) : null;
}

export function methodAllowed(route: MakerRoute, method: unknown): method is 'GET' | 'POST' | 'PUT' {
  return typeof method === 'string' && (MAKER_ROUTE_METHODS[route] as readonly string[]).includes(method);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict standard base64 (padded, no whitespace); `null` if malformed. */
export function decodeBase64(value: string): Buffer | null {
  if (!BASE64.test(value)) return null;
  return Buffer.from(value, 'base64');
}
