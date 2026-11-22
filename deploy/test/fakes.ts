/**
 * Loopback stand-ins for everything outside the bundle: a SOCKS5 server in place of Tor (the
 * relay package's test approach), a JSON-RPC server in place of a Solana node (it serves real
 * encoded maker accounts), HTTP servers in place of Monero nodes and of a maker's onion service.
 * Nothing here touches the system Tor, the Tor network, a real RPC or a real node.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { PublicKey } from '@solana/web3.js';
import { ACCOUNTS, type Maker, PROGRAM_ID, SEED, base58Encode, encodeAccount } from '@xmrswap/protocol';

const closers: (() => Promise<void>)[] = [];
export function onClose(fn: () => Promise<void>): void {
  closers.push(fn);
}
/** Close everything the helpers opened. */
export async function closeAll(): Promise<void> {
  while (closers.length) await closers.pop()!();
}

// ------------------------------------------------------------------ SOCKS5 (stands in for Tor)

export interface FakeSocks {
  port: number;
  /** Destination host names the server was asked to connect to, in order. */
  connects: string[];
  /** Destination host name -> local port of the backend that plays it. */
  map: Map<string, number>;
  /** Stop the proxy now (the Tor client goes away). */
  close(): Promise<void>;
}

/** A minimal SOCKS5 server (no auth, CONNECT by host name). Unmapped destinations get "host unreachable". */
export async function startFakeSocks(): Promise<FakeSocks> {
  const state: FakeSocks = { port: 0, connects: [], map: new Map(), close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'request' | 'piped' = 'greeting';
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
        if (buf[0] !== 0x05) return void client.destroy();
        buf = buf.subarray(2 + buf[1]!);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        // Only domain-name requests are served: the relay must leave name resolution to Tor.
        if (buf[3] !== 0x03) return void client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        const end = 5 + buf[4]!;
        if (buf.length < end + 2) return;
        const host = buf.subarray(5, end).toString('latin1');
        const rest = buf.subarray(end + 2);
        state.connects.push(host);
        const target = state.map.get(host);
        if (buf[1] !== 0x01 || target === undefined) return void client.end(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        stage = 'piped';
        client.off('data', onData);
        const upstream = net.connect(target, '127.0.0.1', () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        sockets.add(upstream);
        upstream.on('close', () => {
          sockets.delete(upstream);
          client.destroy();
        });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
      }
    };
    client.on('data', onData);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.port = (server.address() as AddressInfo).port;
  let closed: Promise<void> | null = null;
  state.close = () =>
    (closed ??= new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }));
  onClose(state.close);
  return state;
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

// ------------------------------------------------------------------ HTTP backends

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
export interface Backend {
  port: number;
  url: string;
  seen: Seen[];
}
export type Handler = (req: Seen, res: http.ServerResponse) => void;

export async function startBackend(handler: Handler): Promise<Backend> {
  const backend: Backend = { port: 0, url: '', seen: [] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const seen: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      backend.seen.push(seen);
      handler(seen, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  backend.port = (server.address() as AddressInfo).port;
  backend.url = `http://127.0.0.1:${backend.port}`;
  onClose(
    () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  );
  return backend;
}

const json = (res: http.ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

// ------------------------------------------------------------------ Monero node

export interface FakeMonero extends Backend {
  height: number;
  topHash: string;
  synchronized: boolean;
  /** When true the node answers nothing useful (HTTP 500). */
  down: boolean;
}

/** A Monero daemon that answers `get_info` (JSON-RPC) and `/get_height`, as the relay and the page ask. */
export async function startFakeMonero(height = 3_300_000, topHash = 'ab'.repeat(32)): Promise<FakeMonero> {
  const node = (await startBackend((req, res) => {
    if (node.down) return json(res, 500, {});
    if (req.method === 'POST' && req.url === '/get_height') return json(res, 200, { height: node.height, hash: node.topHash, status: 'OK' });
    if (req.method === 'POST' && req.url === '/json_rpc') {
      const call = JSON.parse(req.body.toString('utf8')) as { id: unknown; method: string };
      if (call.method === 'get_info') return json(res, 200, { id: call.id, jsonrpc: '2.0', result: { height: node.height, top_block_hash: node.topHash, synchronized: node.synchronized, status: 'OK' } });
      return json(res, 200, { id: call.id, jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' } });
    }
    json(res, 404, {});
  })) as FakeMonero;
  Object.assign(node, { height, topHash, synchronized: true, down: false });
  return node;
}

// ------------------------------------------------------------------ Solana RPC

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A syntactically valid v3 onion host that exists nowhere. */
export function fakeOnion(): string {
  return `${[...randomBytes(56)].map((b) => B32[b % 32]).join('')}.onion`;
}

const key = (): string => base58Encode(randomBytes(32));
/** A maker account as the program stores it, listing `onion`. */
export function makerAccount(onion: string): Uint8Array {
  const maker: Maker = {
    owner: key(),
    operator: key(),
    payout: key(),
    encKey: randomBytes(32),
    encKeyVersion: 1,
    prevEncKey: new Uint8Array(32),
    prevEncKeyExpiresAt: 0n,
    approvalEpoch: 0,
    quoteEpoch: 0,
    paused: 0,
    inboxPolicy: 0,
    openPending: 0,
    registeredSlot: 1n,
    registeredAt: 1n,
    ethLink: new Uint8Array(20),
    ethLinkNext: new Uint8Array(20),
    ethLinkNextAt: 0n,
    counters: new Array<number>(40).fill(0),
    responseSecsSum: 0n,
    volume: [0n, 0n],
    withheldVolume: [0n, 0n],
    bump: 255,
    onion,
    contacts: [],
  };
  return encodeAccount('Maker', maker);
}

export interface FakeSolana extends Backend {
  /** Program ids that exist on this cluster. */
  programs: Set<string>;
  /** The registered makers: account address and the onion address the account lists. */
  makers: { pubkey: string; onion: string }[];
  /** HTTP status to answer every request with instead of serving it (e.g. 429). */
  refuseWith: number | null;
  /** JSON-RPC methods called, in order. */
  methods: string[];
}

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };

/**
 * A Solana JSON-RPC endpoint that knows the pinned program: the program account, its Config
 * account, the Clock sysvar and the maker accounts (real encodings, so the relay and the page
 * decode them with their own code). Like a real endpoint it allows cross-origin calls.
 */
export async function startFakeSolana(onions: string[] = []): Promise<FakeSolana> {
  const configPda = (program: string): string => PublicKey.findProgramAddressSync([Buffer.from(SEED.config)], new PublicKey(program))[0].toBase58();
  const account = (data: Uint8Array, owner: string, executable = false) => ({ data: [Buffer.from(data).toString('base64'), 'base64'], executable, lamports: 1_000_000, owner, rentEpoch: 0, space: data.length });
  const rpc = (await startBackend((req, res) => {
    const reply = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
    if (rpc.refuseWith !== null) return reply(rpc.refuseWith, { jsonrpc: '2.0', error: { code: rpc.refuseWith, message: 'Too many requests' } });
    let call: { id: unknown; method: string; params: any[] };
    try {
      call = JSON.parse(req.body.toString('utf8'));
    } catch {
      return reply(400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
    }
    rpc.methods.push(call.method);
    const ok = (result: unknown): void => reply(200, { jsonrpc: '2.0', id: call.id, result });
    if (call.method === 'getGenesisHash') return ok('FakeGenesis1111111111111111111111111111111111');
    if (call.method === 'getAccountInfo') {
      const address = String(call.params[0]);
      const value = (): unknown => {
        if (address === CLOCK_SYSVAR) {
          const clock = Buffer.alloc(40);
          clock.writeBigUInt64LE(1n, 0);
          clock.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 32);
          return account(clock, 'Sysvar1111111111111111111111111111111111111');
        }
        if (rpc.programs.has(address)) return account(new Uint8Array(36), 'BPFLoaderUpgradeab1e11111111111111111111111', true);
        for (const program of rpc.programs) {
          if (address === configPda(program))
            return account(encodeAccount('Config', { admin: key(), treasuryAuthority: key(), clusterTag: new Uint8Array(32), usdcMint: key(), splitMode: 0, bump: 255, treasuryBump: 255, reserved: new Uint8Array(117) }), program);
        }
        const maker = rpc.makers.find((m) => m.pubkey === address);
        if (maker) return account(makerAccount(maker.onion), PROGRAM_ID);
        return null;
      };
      return ok({ context: { slot: 1 }, value: value() });
    }
    if (call.method === 'getProgramAccounts') {
      const program = String(call.params[0]);
      const filters = (call.params[1]?.filters ?? []) as { memcmp?: { offset: number; bytes: string } }[];
      // Only maker accounts exist; a query for another account type (offers, swaps) finds nothing.
      const wantsMakers = filters.some((f) => f.memcmp?.offset === 0 && f.memcmp.bytes === base58Encode(ACCOUNTS.Maker.discriminator));
      if (!rpc.programs.has(program) || !wantsMakers) return ok([]);
      return ok(rpc.makers.map((m) => ({ pubkey: m.pubkey, account: account(makerAccount(m.onion), program) })));
    }
    reply(200, { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } });
  })) as FakeSolana;
  Object.assign(rpc, { programs: new Set([PROGRAM_ID]), makers: onions.map((onion) => ({ pubkey: key(), onion })), refuseWith: null, methods: [] });
  return rpc;
}

// ------------------------------------------------------------------ maker onion service

/** A maker endpoint (SPEC 6.3) answering `/xs/v1/info` (as the maker account `id()` names) and echoing `/xs/v1/msg`. */
export function startFakeMaker(id: () => string = () => 'M'): Promise<Backend> {
  return startBackend((req, res) => {
    if (req.method === 'GET' && req.url === '/xs/v1/info') return json(res, 200, { maker: id(), operator: 'O', enc_key_version: 1, chain_time: 1 });
    if (req.method === 'POST' && req.url === '/xs/v1/msg') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return void res.end(Buffer.concat([Buffer.from('reply:'), req.body]));
    }
    json(res, 404, { code: 'bad_request' });
  });
}

// ------------------------------------------------------------------ client

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json(): any;
}

/** A raw HTTP call, so tests control the Host header and other details `fetch` hides. */
export function call(port: number, path: string, opts: { method?: string; body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.from(opts.body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method ?? (body ? 'POST' : 'GET'), agent: false, headers: { ...(body ? { 'content-length': String(body.length) } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
