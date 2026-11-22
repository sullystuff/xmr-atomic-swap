import { MONERO_PROXY_JSON_RPC_METHODS, MONERO_PROXY_PATHS } from '@xmrswap/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type Backend, call, closeAll, fakeRegistry, startBackend, startFakeSocks, startTestRelay, type TestRelay } from './helpers.js';

afterEach(closeAll);

async function monero(env: Record<string, string> = {}): Promise<{ relay: TestRelay; nodes: Backend[] }> {
  const mk = (name: string) =>
    startBackend((req, res) => {
      res.writeHead(200, { 'content-type': req.url.endsWith('.bin') ? 'application/octet-stream' : 'application/json', 'set-cookie': 'node=1', 'x-node': name });
      res.end(req.url.endsWith('.bin') ? Buffer.concat([Buffer.from([0x01, 0x11, 0x01, 0x01, 0xff, 0x00]), req.body]) : JSON.stringify({ node: name, status: 'OK' }));
    });
  const nodes = [await mk('zero'), await mk('one')];
  const relay = await startTestRelay({
    env: { RELAY_MONERO_NODES: nodes.map((n) => `http://127.0.0.1:${n.port}`).join(','), RELAY_RATE_REQUESTS_PER_MINUTE: '1000', ...env },
    deps: { registry: fakeRegistry([]) },
  });
  return { relay, nodes };
}

const rpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });

describe('Monero node proxy', () => {
  it('matches the allow-list the spec states', () => {
    expect([...MONERO_PROXY_PATHS]).toEqual([
      '/json_rpc',
      '/get_height',
      '/get_transactions',
      '/get_transaction_pool_hashes',
      '/get_o_indexes.bin',
      '/get_output_distribution.bin',
      '/get_outs.bin',
      '/send_raw_transaction',
    ]);
    expect([...MONERO_PROXY_JSON_RPC_METHODS]).toEqual(['get_info', 'get_block', 'get_block_count', 'get_fee_estimate']);
  });

  it('forwards every allow-listed path to the chosen node', async () => {
    const { relay, nodes } = await monero();
    for (const path of MONERO_PROXY_PATHS) {
      if (path === '/json_rpc') continue;
      const body = path.endsWith('.bin') ? Buffer.from([0x01, 0x11, 0x00, 0xfe, 0x80]) : Buffer.from(JSON.stringify({ txs_hashes: ['ab'], tx_as_hex: '00' }));
      const res = await call(relay.port, `/monero/1${path}`, { method: 'POST', body, headers: { cookie: 'c=1', 'x-forwarded-for': '198.51.100.9', authorization: 'Basic eDp5' } });
      expect([path, res.status]).toEqual([path, 200]);
      const seen = nodes[1]!.seen.at(-1)!;
      expect(seen.method).toBe('POST');
      expect(seen.url).toBe(path);
      expect(seen.body).toEqual(body);
      // Nothing about the client reaches the node, and nothing but the body comes back.
      expect(Object.keys(seen.headers).sort()).toEqual(['connection', 'content-length', 'content-type', 'host']);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-node']).toBeUndefined();
      if (path.endsWith('.bin')) {
        expect(res.headers['content-type']).toBe('application/octet-stream');
        expect(res.body).toEqual(Buffer.concat([Buffer.from([0x01, 0x11, 0x01, 0x01, 0xff, 0x00]), body]));
      } else {
        expect(res.json()).toEqual({ node: 'one', status: 'OK' });
      }
    }
    expect(nodes[0]!.seen).toHaveLength(0);
    expect((await call(relay.port, '/monero/0/get_height', { method: 'POST', body: '' })).json()).toEqual({ node: 'zero', status: 'OK' });
    expect(nodes[0]!.seen).toHaveLength(1);
  });

  it('forwards the four read-only json_rpc methods', async () => {
    const { relay, nodes } = await monero();
    for (const method of MONERO_PROXY_JSON_RPC_METHODS) {
      const res = await call(relay.port, '/monero/0/json_rpc', { method: 'POST', body: rpc(method, { height: 12 }) });
      expect([method, res.status]).toEqual([method, 200]);
      expect(JSON.parse(nodes[0]!.seen.at(-1)!.body.toString())).toEqual({ jsonrpc: '2.0', id: '0', method, params: { height: 12 } });
    }
  });

  it('refuses every other json_rpc method', async () => {
    const { relay, nodes } = await monero();
    const refused = [
      'submit_block',
      'generateblocks',
      'get_block_template',
      'set_bans',
      'get_bans',
      'banned',
      'flush_txpool',
      'flush_cache',
      'relay_tx',
      'get_connections',
      'get_peer_list',
      'sync_info',
      'prune_blockchain',
      'add_aux_pow',
      'get_output_histogram',
      'get_txpool_backlog',
      'on_get_block_hash',
      'get_last_block_header',
      'GET_INFO',
      'get_info ',
      '',
    ];
    for (const method of refused) {
      const res = await call(relay.port, '/monero/0/json_rpc', { method: 'POST', body: rpc(method) });
      expect([method, res.status, res.json()]).toEqual([method, 403, { error: 'monero_method_not_allowed' }]);
    }
    for (const body of [JSON.stringify({ jsonrpc: '2.0', id: '0' }), JSON.stringify({ method: 7 }), JSON.stringify({ method: ['get_info'] }), JSON.stringify({ method: null })])
      expect((await call(relay.port, '/monero/0/json_rpc', { method: 'POST', body })).status).toBe(403);
    // No batches, nothing that is not one JSON object.
    for (const body of [JSON.stringify([JSON.parse(rpc('get_info')), JSON.parse(rpc('submit_block'))]), '[]', 'null', '"get_info"', 'get_info', '', '{'])
      expect([body, (await call(relay.port, '/monero/0/json_rpc', { method: 'POST', body })).status]).toEqual([body, 400]);
    expect(nodes[0]!.seen).toHaveLength(0);
  });

  it('forwards what it checked: a second "method" key cannot reach the node', async () => {
    const { relay, nodes } = await monero();
    // A node whose parser kept the FIRST duplicate key would otherwise run `flush_txpool`.
    const body = '{"jsonrpc":"2.0","id":"0","method":"flush_txpool","method":"get_info"}';
    const res = await call(relay.port, '/monero/0/json_rpc', { method: 'POST', body });
    expect(res.status).toBe(200);
    const sent = nodes[0]!.seen[0]!.body.toString();
    expect(sent).not.toContain('flush_txpool');
    expect(JSON.parse(sent)).toEqual({ jsonrpc: '2.0', id: '0', method: 'get_info' });
  });

  it('refuses every path that is not allow-listed', async () => {
    const { relay, nodes } = await monero();
    const refused = [
      '/stop_daemon',
      '/start_mining',
      '/stop_mining',
      '/mining_status',
      '/save_bc',
      '/get_peer_list',
      '/get_public_nodes',
      '/set_log_level',
      '/set_log_categories',
      '/set_limit',
      '/out_peers',
      '/in_peers',
      '/get_net_stats',
      '/get_transaction_pool',
      '/get_transaction_pool_stats',
      '/get_info',
      '/getinfo',
      '/getheight',
      '/gettransactions',
      '/sendrawtransaction',
      '/get_blocks.bin',
      '/get_hashes.bin',
      '/update',
      '/pop_blocks',
      '/is_key_image_spent',
      '/json_rpc2',
      '/JSON_RPC',
      '/get_height/',
      '/get_height.bin',
      '/get_outs.bin%00',
      '/%2e%2e%2fstop_daemon',
      '/get_height%2f..%2fstop_daemon',
    ];
    for (const path of refused) {
      const res = await call(relay.port, `/monero/0${path}`, { method: 'POST', body: '{}' });
      expect([path, res.status === 403 || res.status === 404]).toEqual([path, true]);
    }
    for (const path of ['/monero/0/get_height/../stop_daemon', '/monero/0/json_rpc/../stop_daemon', '/monero/0//stop_daemon', '/monero/0', '/monero/', '/monero', '/monero/x/get_height', '/monero/-1/get_height', '/monero/0x0/get_height']) {
      const res = await call(relay.port, path, { method: 'POST', body: '{}' });
      expect([path, res.status === 403 || res.status === 404]).toEqual([path, true]);
    }
    expect(nodes[0]!.seen).toHaveLength(0);
    expect(nodes[1]!.seen).toHaveLength(0);
  });

  it('refuses a node that is not configured', async () => {
    const { relay, nodes } = await monero();
    for (const n of ['2', '3', '99', '9999']) {
      const res = await call(relay.port, `/monero/${n}/get_height`, { method: 'POST', body: '' });
      expect([n, res.status, res.json()]).toEqual([n, 404, { error: 'no_such_node' }]);
    }
    expect(nodes.flatMap((n) => n.seen)).toHaveLength(0);
  });

  it('is off when no node is configured, and cannot be pointed anywhere by the client', async () => {
    const other = await startBackend((_req, res) => res.end('other'));
    const relay = await startTestRelay({ deps: { registry: fakeRegistry([]) } });
    expect((await call(relay.port, '/monero/0/get_height', { method: 'POST', body: '' })).status).toBe(404);
    for (const path of [`/monero/127.0.0.1:${other.port}/get_height`, `/monero/0/get_height?node=http://127.0.0.1:${other.port}`, `/monero/http://127.0.0.1:${other.port}/get_height`]) {
      const res = await call(relay.port, path, { method: 'POST', body: '', headers: { host: `127.0.0.1:${other.port}` } });
      expect(res.status).toBe(404);
    }
    expect(other.seen).toHaveLength(0);
  });

  it('accepts POST only and never forwards a query string', async () => {
    const { relay, nodes } = await monero();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const res = await call(relay.port, '/monero/0/get_height', { method });
      expect([method, res.status]).toEqual([method, 405]);
    }
    expect(nodes[0]!.seen).toHaveLength(0);
    expect((await call(relay.port, '/monero/0/get_height?stop=1&x=/../stop_daemon', { method: 'POST', body: '' })).status).toBe(200);
    expect(nodes[0]!.seen[0]!.url).toBe('/get_height');
  });

  it('does not follow a redirect from a node', async () => {
    const elsewhere = await startBackend((_req, res) => res.end('elsewhere'));
    const node = await startBackend((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${elsewhere.port}/stop_daemon` });
      res.end();
    });
    const relay = await startTestRelay({ env: { RELAY_MONERO_NODES: `http://127.0.0.1:${node.port}` }, deps: { registry: fakeRegistry([]) } });
    const res = await call(relay.port, '/monero/0/get_height', { method: 'POST', body: '' });
    expect(res.status).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream_redirect' });
    expect(res.headers.location).toBeUndefined();
    expect(elsewhere.seen).toHaveLength(0);
  });

  it('applies the 96 kB request limit, the response cap, the timeout and the rate limits', async () => {
    const node = await startBackend((req, res) => {
      if (req.url === '/get_outs.bin') return void res.end(Buffer.alloc(5_000, 1));
      if (req.url === '/get_transactions') return;
      res.end('{}');
    });
    const relay = await startTestRelay({
      env: { RELAY_MONERO_NODES: `http://127.0.0.1:${node.port}`, RELAY_MONERO_MAX_RESPONSE_BYTES: '4999', RELAY_RATE_REQUESTS_PER_MINUTE: '5' },
      deps: { registry: fakeRegistry([]), upstreamTimeoutMs: 150 },
    });
    const big = await call(relay.port, '/monero/0/send_raw_transaction', { method: 'POST', body: Buffer.alloc(98_305, 0x61) });
    expect([big.status, big.json()]).toEqual([413, { error: 'too_large' }]);
    const ok = await call(relay.port, '/monero/0/send_raw_transaction', { method: 'POST', body: Buffer.alloc(98_304, 0x61) });
    expect(ok.status).toBe(200);
    const large = await call(relay.port, '/monero/0/get_outs.bin', { method: 'POST', body: Buffer.from([1]) });
    expect([large.status, large.json()]).toEqual([502, { error: 'upstream_too_large' }]);
    const slow = await call(relay.port, '/monero/0/get_transactions', { method: 'POST', body: '{}' });
    expect([slow.status, slow.json()]).toEqual([504, { error: 'upstream_timeout' }]);
    expect((await call(relay.port, '/monero/0/get_height', { method: 'POST', body: '' })).status).toBe(200);
    expect((await call(relay.port, '/monero/0/get_height', { method: 'POST', body: '' })).status).toBe(429);
  });

  it('reaches an onion Monero node through Tor, by name', async () => {
    const socks = await startFakeSocks();
    const node = await startBackend((_req, res) => res.end(JSON.stringify({ height: 77 })));
    const host = `${'m'.repeat(56)}.onion`;
    socks.map.set(host, node.port);
    const relay = await startTestRelay({
      env: { RELAY_MONERO_NODES: `http://${host}:18081`, RELAY_TOR_SOCKS: `127.0.0.1:${socks.port}` },
      deps: { registry: fakeRegistry([]) },
    });
    expect((await call(relay.port, '/monero/0/get_height', { method: 'POST', body: '' })).json()).toEqual({ height: 77 });
    expect(socks.connects).toEqual([{ atyp: 3, host, port: 18081 }]);
    expect(node.seen[0]!.headers.host).toBe(`${host}:18081`);
  });
});
