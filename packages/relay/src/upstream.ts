/**
 * One HTTP request to an upstream, optionally through a SOCKS5 proxy with remote DNS.
 *
 * Never follows redirects, forwards no client headers, enforces one deadline over connect,
 * request and response, and stops reading once the response exceeds its cap.
 */
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import socks from 'socks';

const { SocksClient } = socks;

export type UpstreamErrorCode = 'upstream_timeout' | 'upstream_unreachable' | 'upstream_too_large' | 'upstream_redirect';

export class UpstreamError extends Error {
  constructor(readonly code: UpstreamErrorCode) {
    super(code);
  }
}

export interface UpstreamRequest {
  /** `http:` or `https:`; `https:` is not supported through SOCKS (onion services are plain HTTP). */
  url: URL;
  method: string;
  contentType?: string;
  body?: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
  /** When set, the TCP connection is opened by this SOCKS5 proxy, which also resolves the host name. */
  socks?: { host: string; port: number };
}

export interface UpstreamResponse {
  status: number;
  contentType: string | undefined;
  body: Buffer;
}

export function upstreamFetch(req: UpstreamRequest): Promise<UpstreamResponse> {
  return new Promise<UpstreamResponse>((resolve, reject) => {
    let done = false;
    let socket: Socket | undefined;
    let clientReq: http.ClientRequest | undefined;

    const finish = (err: UpstreamError | null, res?: UpstreamResponse): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        clientReq?.destroy();
        socket?.destroy();
        reject(err);
      } else {
        resolve(res!);
      }
    };
    const timer = setTimeout(() => finish(new UpstreamError('upstream_timeout')), req.timeoutMs);

    const port = req.url.port ? Number(req.url.port) : req.url.protocol === 'https:' ? 443 : 80;
    // Set explicitly: without an agent Node would append the port even when it is the default.
    const defaultPort = req.url.protocol === 'https:' ? 443 : 80;
    const headers: Record<string, string | number> = { host: port === defaultPort ? req.url.hostname : `${req.url.hostname}:${port}` };
    if (req.body) {
      headers['content-type'] = req.contentType ?? 'application/octet-stream';
      headers['content-length'] = req.body.length;
    }

    const send = (viaSocket?: Socket): void => {
      const options: http.RequestOptions = {
        host: req.url.hostname.replace(/^\[|\]$/g, ''),
        port,
        method: req.method,
        path: req.url.pathname + req.url.search,
        headers,
      };
      // With `createConnection` and NO agent, Node uses exactly this socket. (With `agent: false`
      // it would ignore it, resolve the host name itself and connect directly.)
      if (viaSocket) options.createConnection = () => viaSocket;
      else options.agent = false;
      const r = (req.url.protocol === 'https:' ? https : http).request(options, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          finish(new UpstreamError('upstream_redirect'));
          res.destroy();
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > req.maxResponseBytes) {
          finish(new UpstreamError('upstream_too_large'));
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxResponseBytes) {
            finish(new UpstreamError('upstream_too_large'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const ct = res.headers['content-type'];
          finish(null, { status, contentType: ct, body: Buffer.concat(chunks) });
          clientReq?.destroy();
          socket?.destroy();
        });
        res.on('error', () => finish(new UpstreamError('upstream_unreachable')));
        res.on('aborted', () => finish(new UpstreamError('upstream_unreachable')));
      });
      clientReq = r;
      r.on('error', () => finish(new UpstreamError('upstream_unreachable')));
      r.end(req.body);
    };

    if (!req.socks) {
      send();
      return;
    }
    if (req.url.protocol !== 'http:') {
      finish(new UpstreamError('upstream_unreachable'));
      return;
    }
    SocksClient.createConnection({
      proxy: { host: req.socks.host, port: req.socks.port, type: 5 },
      command: 'connect',
      // A host name here is sent to the proxy as a name (address type 3): the relay never resolves it.
      destination: { host: req.url.hostname, port },
      timeout: req.timeoutMs,
    }).then(
      (info) => {
        socket = info.socket;
        if (done) {
          socket.destroy();
          return;
        }
        socket.on('error', () => finish(new UpstreamError('upstream_unreachable')));
        send(socket);
      },
      () => finish(new UpstreamError('upstream_unreachable')),
    );
  });
}

/**
 * Is the SOCKS5 proxy answering? Opens a TCP connection and performs only the method
 * negotiation (no CONNECT), so no circuit is built and nothing leaves the machine.
 */
export function probeSocks(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const sock = new net.Socket();
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
    sock.on('data', (d: Buffer) => finish(d.length >= 2 && d[0] === 0x05 && d[1] === 0x00));
    sock.connect(port, host, () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
  });
}
