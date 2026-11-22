/**
 * The mock daemon behind real loopback HTTP and WebSocket, for `pnpm dev` and for one
 * transport test. It binds 127.0.0.1 only.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { WS_PING_SECS, type WsClientMessage } from '@xmrswap/protocol/daemon-api';
import { MOCK_TOKEN, MockDaemon, type MockOptions } from '../src/mock/daemon.js';

export { MOCK_TOKEN };

export interface MockServer {
  url: string;
  port: number;
  daemon: MockDaemon;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

export async function startMockServer(opts: { port?: number; daemon?: MockDaemon } & MockOptions = {}): Promise<MockServer> {
  const daemon = opts.daemon ?? new MockDaemon(opts);
  const server: Server = createServer((req, res) => {
    void (async () => {
      let body: unknown;
      try {
        const text = await readBody(req);
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad_request', detail: 'The body is not JSON.' }));
        return;
      }
      const out = daemon.handle({ method: req.method ?? 'GET', path: req.url ?? '/', body, authorization: req.headers.authorization ?? null });
      res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(out.body));
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('token');
    const bearer = req.headers.authorization;
    if (url.pathname !== '/api/ws' || (token !== daemon.token && bearer !== `Bearer ${daemon.token}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = daemon.connect((m) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
      });
      ws.on('message', (data) => {
        try {
          conn.receive(JSON.parse(String(data)) as WsClientMessage);
        } catch {
          ws.send(JSON.stringify({ op: 'error', error: 'not JSON' }));
        }
      });
      ws.on('close', () => conn.close());
    });
  });
  const ping = setInterval(() => daemon.ping(), WS_PING_SECS * 1000);
  ping.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    daemon,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(ping);
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
