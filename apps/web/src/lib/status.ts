/**
 * The status page's checks (SPEC 8.2 "Status", DESIGN "Checking it works"): RPC connected,
 * Monero nodes in agreement, relay reachable, "Tor proxy reachable" (the relay's `tor_ok`, which
 * is only a SOCKS handshake), "maker reachable over Tor" (a real forward to a maker's `/info`),
 * and the upgrade status of both contracts.
 */
import { MakerHttp, type MakerProfile, type NodeInfo, daemonNode, relayEndpoint, relayStatus } from '@xmrswap/sdk';
import type { App } from './app.js';
import type { UpgradeStatus } from './market.js';
import { relayUrlOf } from './settings.js';

export type CheckState = 'ok' | 'warn' | 'fail' | 'off';
export interface Check {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface NodeAnswer {
  url: string;
  info: NodeInfo | null;
  error: string | null;
}

/**
 * Whether the configured Monero nodes agree. Every node must answer; heights may differ by one
 * block (a block in flight); nodes at the same height must report the same top block.
 */
export function moneroAgreement(answers: readonly NodeAnswer[], ownNode: boolean): { state: CheckState; detail: string } {
  if (answers.length === 0) return { state: 'fail', detail: 'No Monero node is configured. Swaps cannot be verified, so locking is disabled.' };
  const dead = answers.filter((a) => a.info === null);
  if (dead.length > 0) return { state: 'fail', detail: `${dead.map((d) => `${d.url} did not answer (${d.error})`).join('; ')}. While a node is unreachable no lock counts as confirmed.` };
  if (answers.length === 1 && !ownNode) return { state: 'fail', detail: 'Only one node is configured and it is not marked as your own. A single dishonest node could fake a lock. Add a second node.' };
  const heights = answers.map((a) => a.info!.height);
  const max = Math.max(...heights);
  const min = Math.min(...heights);
  const list = answers.map((a) => `${a.url} at height ${a.info!.height}`).join('; ');
  if (max - min > 1) return { state: 'fail', detail: `The nodes are ${max - min} blocks apart: ${list}. One of them is out of sync or on another chain; locks will not count as confirmed until they agree.` };
  const top = new Map<number, Set<string>>();
  for (const a of answers) top.set(a.info!.height, (top.get(a.info!.height) ?? new Set()).add(a.info!.top_block_hash));
  if ([...top.values()].some((s) => s.size > 1)) return { state: 'fail', detail: `Nodes at the same height report different blocks: ${list}. They are on different chains; locks will not count as confirmed.` };
  if (answers.some((a) => a.info!.synchronized === false)) return { state: 'warn', detail: `A node reports it is still synchronising: ${list}.` };
  return { state: 'ok', detail: answers.length === 1 ? `Your own node, ${list}.` : `${answers.length} nodes in agreement: ${list}.` };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function upgradeCheck(id: string, name: string, u: UpgradeStatus, configured: boolean): Check {
  if (!configured) return { id, label: `${name}: upgrade status`, state: 'off', detail: 'Not configured.' };
  if (u.frozen === true) return { id, label: `${name}: immutable`, state: 'ok', detail: 'The upgrade authority has been given up. Nobody can change the rules.' };
  if (u.frozen === false) return { id, label: `${name}: still upgradable`, state: 'warn', detail: `The upgrade key is held by ${u.authority ?? 'the project owner'}. Until it is given up you are trusting the key holder not to change the rules; a malicious upgrade could take funds in escrow.` };
  return { id, label: `${name}: upgrade status unknown`, state: 'warn', detail: 'It could not be read. Treat the code as upgradable.' };
}

export async function runStatus(app: App, nodeInfo: (url: string) => Promise<NodeInfo> = (u) => daemonNode(u).info()): Promise<Check[]> {
  const s = app.settings.get();
  const out: Check[] = [];
  const sol = app.solana();
  if (!sol) out.push({ id: 'solana', label: 'Solana RPC', state: 'fail', detail: 'No Solana RPC URL is set. Nothing can be read or sent.' });
  else {
    try {
      const [now, genesis, cfg] = await Promise.all([sol.chainTime(), sol.transport.getGenesisHash(), sol.getConfig()]);
      const skew = Math.round(Date.now() / 1000 - Number(now));
      out.push({ id: 'solana', label: 'Solana RPC connected', state: 'ok', detail: `Genesis ${genesis}. Chain time ${new Date(Number(now) * 1000).toLocaleString()}${Math.abs(skew) > 30 ? `; your clock differs by ${Math.abs(skew)} s` : ''}.` });
      out.push(cfg ? { id: 'program', label: 'Swap program found', state: 'ok', detail: `Program ${sol.programId} is initialised. USDC mint ${cfg.usdcMint}.` } : { id: 'program', label: 'Swap program not found', state: 'fail', detail: `No initialised program at ${sol.programId} on this cluster. Check the program id against the published one.` });
    } catch (e) {
      out.push({ id: 'solana', label: 'Solana RPC unreachable', state: 'fail', detail: msg(e) });
    }
  }
  const eth = app.ethereum();
  if (!eth) out.push({ id: 'ethereum', label: 'Ethereum RPC', state: 'off', detail: 'Not configured. ETH and USDC-on-Ethereum markets are switched off.' });
  else {
    try {
      await eth.verifyChainId(s.ethereumChainId);
      const now = await eth.chainTime('latest');
      out.push({ id: 'ethereum', label: 'Ethereum RPC connected', state: 'ok', detail: `Chain id ${s.ethereumChainId}, contract ${s.contract}. Chain time ${new Date(Number(now) * 1000).toLocaleString()}.` });
    } catch (e) {
      out.push({ id: 'ethereum', label: 'Ethereum RPC problem', state: 'fail', detail: msg(e) });
    }
  }
  const nodes = s.moneroNodes.map((n) => n.trim()).filter(Boolean);
  const answers = await Promise.all(nodes.map(async (url): Promise<NodeAnswer> => nodeInfo(url).then((info) => ({ url, info, error: null }), (e: unknown) => ({ url, info: null, error: msg(e) }))));
  const agree = moneroAgreement(answers, s.ownNode);
  out.push({ id: 'monero', label: agree.state === 'ok' ? 'Monero nodes in agreement' : 'Monero nodes', ...agree });

  const relay = relayUrlOf(s);
  let makers: MakerProfile[] = app.registry.get().snapshot?.makers ?? [];
  if (s.mode === 'onchain' || s.mode === 'tor-direct') out.push({ id: 'relay', label: 'Relay', state: 'off', detail: s.mode === 'onchain' ? 'On-chain only mode: no relay is used. Messages cost a transaction fee and who messaged whom is public.' : 'Tor Browser mode: maker endpoints are called directly, no relay.' });
  else if (!relay) out.push({ id: 'relay', label: 'Relay', state: 'warn', detail: 'No relay URL is set. Messages fall back to on-chain; Ethereum swaps need a relay or a maker HTTPS endpoint.' });
  else {
    try {
      const st = await relayStatus(relay);
      out.push({ id: 'relay', label: 'Relay reachable', state: 'ok', detail: `${relay}. It knows ${st.makers} maker${st.makers === 1 ? '' : 's'}${st.registry_age_secs < 0 ? '; it has not read the registry yet' : `; registry read ${st.registry_age_secs} s ago`}.` });
      out.push({ id: 'tor-proxy', label: st.tor_ok ? 'Tor proxy reachable' : 'Tor proxy not reachable', state: st.tor_ok ? 'ok' : 'fail', detail: st.tor_ok ? 'The relay\'s SOCKS proxy answered a handshake. That alone does not prove Tor has connected; the next check does.' : 'The relay cannot reach its Tor proxy. Messages fall back to on-chain.' });
      makers = makers.filter((m) => m.onion);
      if (makers.length === 0) out.push({ id: 'tor-maker', label: 'Maker reachable over Tor', state: 'off', detail: 'No maker in the registry lists an onion address, so there is nothing to test against.' });
      else {
        let reached: string | null = null;
        let last = '';
        for (const m of makers.slice(0, 3)) {
          try {
            const info = await new MakerHttp(relayEndpoint(relay, m.onion!)).info();
            if (info.maker === m.pda) {
              reached = m.pda;
              break;
            }
            last = 'the endpoint answered for another maker';
          } catch (e) {
            last = msg(e);
          }
        }
        out.push(reached ? { id: 'tor-maker', label: 'Maker reachable over Tor', state: 'ok', detail: `Maker ${reached.slice(0, 8)}… answered through the relay and Tor.` } : { id: 'tor-maker', label: 'No maker reachable over Tor', state: 'fail', detail: `${last}. Tor may still be starting. Messages fall back to on-chain.` });
      }
    } catch (e) {
      out.push({ id: 'relay', label: 'Relay not reachable', state: 'fail', detail: `${relay}: ${msg(e)}. If the relay runs on another origin than this page it must be started with RELAY_ALLOWED_ORIGINS set to this page's origin. Messages fall back to on-chain.` });
    }
  }
  const up = app.upgrade.get();
  out.push(upgradeCheck('upgrade-solana', 'Solana program', up.solana, sol !== null));
  out.push(upgradeCheck('upgrade-ethereum', 'Ethereum contract', up.ethereum, eth !== null));
  return out;
}
