// The REAL relay (`packages/relay/src/main.ts`) as its own process, in front of a SOCKS5 server
// that stands in for Tor: it maps each test onion name to the loopback port of a maker daemon's
// endpoint. The system Tor and the Tor network are never used.
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { RELAY_ROUTES } from '@xmrswap/protocol';
import { type Proc, startProc, tsNode } from './procs.js';
import { freePort, repoRoot, stateRoot, waitFor } from './util.js';

export interface FakeTor {
  port: number;
  /** Every CONNECT the proxy received: destination host and port. */
  connects: { host: string; port: number }[];
  /** Onion host -> loopback port that plays it. */
  map: Map<string, number>;
  close(): Promise<void>;
}

/** A minimal SOCKS5 server (no auth, CONNECT by domain name only). Unmapped destinations get "host unreachable". */
export async function startFakeTor(): Promise<FakeTor> {
  const state: FakeTor = { port: 0, connects: [], map: new Map(), close: async () => undefined };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
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
        // Only a domain name is acceptable: an onion host must be resolved by the proxy, never by the relay.
        if (buf[3] !== 0x03) return void client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        const end = 5 + buf[4]!;
        if (buf.length < end + 2) return;
        const host = buf.subarray(5, end).toString('latin1');
        const port = buf.readUInt16BE(end);
        const rest = buf.subarray(end + 2);
        state.connects.push({ host, port });
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
        upstream.on('close', () => (sockets.delete(upstream), client.destroy()));
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
      }
    };
    client.on('data', onData);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return state;
}

/** A syntactically valid v3 onion host for maker `n`. It exists nowhere but in the fake proxy's map. */
export const testOnion = (n: number): string => `${`xmrswaptestmaker${'abcdefghijklmnop'[n % 16]}`.padEnd(56, 'q')}.onion`;

export interface RelayProc {
  url: string;
  port: number;
  proc: Proc | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ tor_ok: boolean; makers: number; registry_age_secs: number }>;
}

export async function makeRelay(o: { solanaRpc: string; programId: string; torPort: number; moneroNodes: string[]; allowedOrigins: string[] }): Promise<RelayProc> {
  const port = await freePort();
  let runs = 0;
  const r: RelayProc = {
    url: `http://127.0.0.1:${port}`, port, proc: null,
    async start() {
      r.proc = startProc(`relay-run${++runs}`, ...tsNode(path.join(repoRoot, 'packages/relay/src/main.ts')), {
        cwd: stateRoot,
        env: {
          PATH: process.env['PATH'], HOME: '/nonexistent', RELAY_BIND: `127.0.0.1:${port}`, RELAY_TOR_SOCKS: `127.0.0.1:${o.torPort}`, SOLANA_RPC_URL: o.solanaRpc, RELAY_PROGRAM_ID: o.programId,
          RELAY_MONERO_NODES: o.moneroNodes.join(','), RELAY_ALLOWED_ORIGINS: o.allowedOrigins.join(','), RELAY_RATE_REQUESTS_PER_MINUTE: '100000', RELAY_RATE_BYTES_PER_MINUTE: '4000000000',
        },
      });
      await waitFor('the relay', async () => (await fetch(`${r.url}${RELAY_ROUTES.status}`)).ok, { timeoutMs: 60_000, context: () => r.proc?.output() });
    },
    async stop() {
      await r.proc?.stop(3_000);
      r.proc = null;
    },
    status: async () => (await (await fetch(`${r.url}${RELAY_ROUTES.status}`)).json()) as { tor_ok: boolean; makers: number; registry_age_secs: number },
  };
  return r;
}
