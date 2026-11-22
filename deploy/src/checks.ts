/**
 * The status check behind `pnpm --filter @xmrswap/deploy run status` (DESIGN "Checking it
 * works"): the UI is served, the relay answers, the Tor proxy is reachable, the Solana RPC is
 * connected and knows the program, and the Monero nodes agree. The page's own Status page
 * (`#/status`) runs the same questions from the browser.
 *
 * Nothing here prints an RPC URL: a provider URL usually contains an API key.
 */
import { PROGRAM_ID } from '@xmrswap/protocol';
import { probeSocks } from '@xmrswap/relay';
import { connectHost } from './server.js';
import type { BundleSettings } from './settings.js';

export type CheckState = 'ok' | 'warn' | 'fail' | 'off';
export interface Check {
  id: 'ui' | 'relay' | 'tor' | 'solana' | 'ethereum' | 'monero' | 'pinned';
  label: string;
  state: CheckState;
  detail: string;
}

const TIMEOUT_MS = 10_000;
const msg = (e: unknown): string => {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError') return 'no answer within 10 s';
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
};

async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

class RpcFailure extends Error {}
async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    throw new RpcFailure(`not reachable (${msg(e)})`);
  }
  if (res.status === 429) throw new RpcFailure('the endpoint is rate-limiting you (HTTP 429)');
  if (res.status === 401 || res.status === 403) throw new RpcFailure(`the endpoint refused the request (HTTP ${res.status}); check the API key in the URL`);
  if (!res.ok) throw new RpcFailure(`the endpoint answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { code?: number; message?: string } } | null;
  if (!body) throw new RpcFailure('the endpoint did not answer with JSON');
  if (body.error) throw new RpcFailure(body.error.code === 429 ? 'the endpoint is rate-limiting you (code 429)' : `${method} was refused: ${String(body.error.message ?? body.error.code)}`);
  return body.result;
}

export interface NodeAnswer {
  /** How the node is named in messages: "node 0", "node 1", ... */
  name: string;
  info: { height: number; top_block_hash: string; synchronized?: boolean } | null;
  error: string | null;
}

/**
 * Whether the Monero nodes agree. The rule is the page's (`moneroAgreement` in
 * `apps/web/src/lib/status.ts`; a test compares the two): every node must answer; heights may
 * differ by one block; nodes at the same height must report the same top block.
 */
export function moneroAgreement(answers: readonly NodeAnswer[], ownNode: boolean): { state: CheckState; detail: string } {
  if (answers.length === 0) return { state: 'fail', detail: 'No Monero node is configured ([relay] monero_nodes). The page cannot verify a lock, so locking is disabled.' };
  const dead = answers.filter((a) => a.info === null);
  if (dead.length > 0) return { state: 'fail', detail: `${dead.map((d) => `${d.name} did not answer (${d.error})`).join('; ')}. While a node is unreachable no lock counts as confirmed.` };
  if (answers.length === 1 && !ownNode) return { state: 'fail', detail: 'Only one node is configured and it is not marked as your own ([ui] own_node). A single dishonest node could fake a lock. Add a second node.' };
  const heights = answers.map((a) => a.info!.height);
  const max = Math.max(...heights);
  const min = Math.min(...heights);
  const list = answers.map((a) => `${a.name} at height ${a.info!.height}`).join('; ');
  if (max - min > 1) return { state: 'fail', detail: `The nodes are ${max - min} blocks apart: ${list}. One of them is out of sync or on another chain; locks will not count as confirmed until they agree.` };
  const top = new Map<number, Set<string>>();
  for (const a of answers) top.set(a.info!.height, (top.get(a.info!.height) ?? new Set()).add(a.info!.top_block_hash));
  if ([...top.values()].some((set) => set.size > 1)) return { state: 'fail', detail: `Nodes at the same height report different blocks: ${list}. They are on different chains; locks will not count as confirmed.` };
  if (answers.some((a) => a.info!.synchronized === false)) return { state: 'warn', detail: `A node reports it is still synchronising: ${list}.` };
  return { state: 'ok', detail: answers.length === 1 ? `Your own node, ${list}.` : `${answers.length} nodes in agreement: ${list}.` };
}

async function nodeInfo(base: string, name: string): Promise<NodeAnswer> {
  try {
    const res = await fetch(`${base}/json_rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info', params: {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    const body = (await res.json().catch(() => null)) as { result?: NodeAnswer['info']; error?: unknown } | null;
    if (!res.ok) return { name, info: null, error: `HTTP ${res.status}${body && typeof body.error === 'string' ? ` ${body.error}` : ''}` };
    const r = body?.result;
    if (!r || typeof r.height !== 'number' || typeof r.top_block_hash !== 'string') return { name, info: null, error: 'the answer is not a Monero get_info result' };
    return { name, info: r, error: null };
  } catch (e) {
    return { name, info: null, error: msg(e) };
  }
}

/** Run every check against the bundle described by `s` (it is expected to be running). */
export async function runChecks(s: BundleSettings): Promise<Check[]> {
  const out: Check[] = [];
  const host = connectHost(s.ui.listenHost);
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${s.ui.listenPort}`;
  const startHint = 'Start it with: pnpm --filter @xmrswap/deploy start';

  // ---- the UI and what it was told
  let running = false;
  let page: Record<string, unknown> | null = null;
  try {
    const index = await fetch(`${base}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const html = await index.text();
    const cfg = await getJson(`${base}/config.json`);
    if (index.status === 200 && /<div id="root"|<html/i.test(html) && cfg.status === 200 && cfg.json && typeof cfg.json === 'object') {
      running = true;
      page = cfg.json as Record<string, unknown>;
      out.push({ id: 'ui', label: 'Web UI served', state: 'ok', detail: `${s.ui.publicOrigin || base}/ (status page: ${s.ui.publicOrigin || base}/#/status).` });
    } else out.push({ id: 'ui', label: 'Web UI', state: 'fail', detail: `${base}/ answered, but not with the web UI (HTTP ${index.status}). Another program may be using the port.` });
  } catch (e) {
    out.push({ id: 'ui', label: 'Web UI not running', state: 'fail', detail: `Nothing answers at ${base}/ (${msg(e)}). ${startHint}` });
  }

  // ---- relay and Tor
  let relayStatus: { tor_ok: boolean; registry_age_secs: number; makers: number } | null = null;
  if (running) {
    try {
      const st = await getJson(`${base}/relay/v1/status`);
      if (st.status === 200 && st.json && typeof st.json.tor_ok === 'boolean') relayStatus = st.json;
      else out.push({ id: 'relay', label: 'Relay', state: 'fail', detail: `The relay answered HTTP ${st.status}${st.json?.error ? ` (${st.json.error})` : ''}.` });
    } catch (e) {
      out.push({ id: 'relay', label: 'Relay not reachable', state: 'fail', detail: `${msg(e)}. Messages fall back to on-chain.` });
    }
  } else out.push({ id: 'relay', label: 'Relay not running', state: 'fail', detail: `The relay is started together with the web UI. ${startHint}` });
  if (relayStatus) {
    const { makers, registry_age_secs: age } = relayStatus;
    if (!s.relay.solanaRpcUrl) out.push({ id: 'relay', label: 'Relay reachable, but it has no maker list', state: 'warn', detail: 'No Solana RPC URL is set, so the relay cannot read the registry and refuses every forward. Messages fall back to on-chain.' });
    else if (age < 0) out.push({ id: 'relay', label: 'Relay reachable, but it has not read the maker list', state: 'warn', detail: 'The registry has not been read yet. If this stays, the Solana RPC is refusing getProgramAccounts or rate-limiting; until then every forward is refused and messages fall back to on-chain.' });
    else out.push({ id: 'relay', label: 'Relay reachable', state: 'ok', detail: `It knows ${makers} maker${makers === 1 ? '' : 's'}; registry read ${age} s ago.` });
  }
  const torAddr = `${s.relay.torSocksHost}:${s.relay.torSocksPort}`;
  const torOk = relayStatus ? relayStatus.tor_ok : await probeSocks(s.relay.torSocksHost, s.relay.torSocksPort, 5_000);
  out.push(
    torOk
      ? { id: 'tor', label: 'Tor proxy reachable', state: 'ok', detail: `The SOCKS proxy at ${torAddr} answered a handshake. That alone does not prove Tor has connected to the network; the page's Status page tests a real maker.` }
      : { id: 'tor', label: 'Tor proxy not reachable', state: 'fail', detail: `Nothing answers as a SOCKS proxy at ${torAddr}. Start a Tor client or set [relay] tor_socks. Until then messages fall back to on-chain (Solana swaps only).` },
  );

  // ---- Solana
  const programId = s.relay.programId ?? PROGRAM_ID;
  if (!s.relay.solanaRpcUrl) out.push({ id: 'solana', label: 'Solana RPC', state: 'fail', detail: 'No Solana RPC URL is set. Export it in the variable named by [relay] solana_rpc_url_env (default SOLANA_RPC_URL) before starting.' });
  else {
    try {
      const genesis = (await rpc(s.relay.solanaRpcUrl, 'getGenesisHash', [])) as string;
      const account = (await rpc(s.relay.solanaRpcUrl, 'getAccountInfo', [programId, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])) as { value: { executable?: boolean } | null };
      if (account?.value?.executable === true) out.push({ id: 'solana', label: 'Solana RPC connected', state: 'ok', detail: `Genesis ${genesis}. Program ${programId} found.` });
      else out.push({ id: 'solana', label: 'Solana RPC connected, but the program is not there', state: 'fail', detail: `Genesis ${genesis}. No program at ${programId} on this cluster. Check the program id against the published one, and that the RPC is for the right cluster.` });
    } catch (e) {
      out.push({ id: 'solana', label: 'Solana RPC problem', state: 'fail', detail: `${e instanceof RpcFailure ? e.message : msg(e)}.` });
    }
  }

  // ---- Ethereum (optional)
  if (!s.ui.ethereumRpcUrl) out.push({ id: 'ethereum', label: 'Ethereum RPC', state: 'off', detail: 'Not configured. The ETH and USDC-on-Ethereum markets are switched off.' });
  else {
    try {
      const chain = Number.parseInt(String(await rpc(s.ui.ethereumRpcUrl, 'eth_chainId', [])), 16);
      if (chain !== s.ui.ethereumChainId) out.push({ id: 'ethereum', label: 'Ethereum RPC is on another chain', state: 'fail', detail: `It reports chain id ${chain}; the settings expect ${s.ui.ethereumChainId}.` });
      else if (!s.ui.contractAddress) out.push({ id: 'ethereum', label: 'Ethereum RPC connected, no contract address', state: 'warn', detail: `Chain id ${chain}. This release pins no contract address, so Ethereum swaps stay off.` });
      else out.push({ id: 'ethereum', label: 'Ethereum RPC connected', state: 'ok', detail: `Chain id ${chain}, contract ${s.ui.contractAddress}.` });
    } catch (e) {
      out.push({ id: 'ethereum', label: 'Ethereum RPC problem', state: 'fail', detail: `${e instanceof RpcFailure ? e.message : msg(e)}.` });
    }
  }

  // ---- Monero: through the proxy the page uses when the bundle runs, otherwise directly
  const answers = await Promise.all(
    s.relay.moneroNodes.map((node, i): Promise<NodeAnswer> => {
      if (running) return nodeInfo(`${base}/monero/${i}`, `node ${i}`);
      if (new URL(node).hostname.endsWith('.onion')) return Promise.resolve({ name: `node ${i}`, info: null, error: 'an onion node can only be checked while the bundle is running' });
      return nodeInfo(node, `node ${i}`);
    }),
  );
  const agree = moneroAgreement(answers, s.ui.ownNode);
  out.push({ id: 'monero', label: agree.state === 'ok' ? 'Monero nodes in agreement' : 'Monero nodes', ...agree });

  // ---- what the page was told, against what the release pins
  const pageProgram = page ? String(page['programId'] ?? '') : programId;
  if (pageProgram === PROGRAM_ID) out.push({ id: 'pinned', label: 'Program id is the one this release pins', state: 'ok', detail: `${PROGRAM_ID}. Compare it with the published id yourself; see "Verifying the download".` });
  else out.push({ id: 'pinned', label: 'Program id differs from the one this release pins', state: 'warn', detail: `The page is given ${pageProgram}; the release pins ${PROGRAM_ID}. A page pointed at another program could take your funds. Remove [relay] program_id unless you are testing.` });
  return out;
}

const STATE_TEXT: Readonly<Record<CheckState, string>> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', off: 'off ' };

/** The report the CLI prints: one line per check, the detail indented under it. */
export function formatChecks(checks: readonly Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${STATE_TEXT[c.state]}  ${c.label}`);
    lines.push(`      ${c.detail}`);
  }
  const failing = checks.filter((c) => c.state === 'fail').length;
  const warnings = checks.filter((c) => c.state === 'warn').length;
  lines.push('');
  lines.push(failing === 0 ? `All checks passed${warnings ? ` (${warnings} need attention)` : ''}.` : `${failing} problem${failing === 1 ? '' : 's'} to fix before swapping.`);
  return lines.join('\n');
}
