/**
 * Settings (SPEC 8.2 "Settings", DESIGN "Self-hosting the web UI"). Nothing has a hidden
 * default: the Solana RPC, the Ethereum RPC and the Monero nodes must be set by the user or by
 * the deployment's `config.json` (served next to the page; the self-hosting bundle writes it).
 * The program id and the contract address are pinned by the release and shown for checking.
 */
import { CONTRACT_ADDRESS, CONTRACT_CHAIN_ID, type MoneroNetwork, PROGRAM_ID } from '@xmrswap/protocol';

export type ConnectionMode = 'hosted' | 'self-hosted' | 'tor-direct' | 'onchain';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface Settings {
  solanaRpc: string;
  ethereumRpc: string;
  /** Chain id the Ethereum RPC must report. */
  ethereumChainId: number;
  moneroNodes: string[];
  /** The user declares the single node to be their own (SPEC 2.11 node policy). */
  ownNode: boolean;
  moneroNetwork: MoneroNetwork;
  relayUrl: string;
  mode: ConnectionMode;
  /** Pinned by the release; shown for checking. */
  programId: string;
  contract: string;
  /** The user's own minimum confirmation depth (0 = the protocol's tiers only). */
  minDepth: number;
  /** Reference prices in USD, typed by the user (the page fetches no price feed). Decimal strings; empty = none. */
  refXmrUsd: string;
  refSolUsd: string;
  refEthUsd: string;
  theme: ThemeChoice;
  /** State polling interval. */
  pollMs: number;
  /** Override of the sweep fee cap in piconero (regtest fees are far above mainnet's). Empty = the protocol cap. */
  sweepMaxFee: string;
}

export const DEFAULT_SETTINGS: Settings = {
  solanaRpc: '',
  ethereumRpc: '',
  ethereumChainId: CONTRACT_CHAIN_ID ?? 1,
  moneroNodes: [],
  ownNode: false,
  moneroNetwork: 'mainnet',
  relayUrl: '',
  mode: 'hosted',
  // The release's pinned deployment (`@xmrswap/protocol`); the contract slot is empty until the owner deploys.
  programId: PROGRAM_ID,
  contract: CONTRACT_ADDRESS ?? '',
  minDepth: 0,
  refXmrUsd: '',
  refSolUsd: '',
  refEthUsd: '',
  theme: 'system',
  pollMs: 4000,
  sweepMaxFee: '',
};

const KEY = 'xmrswap.settings.v1';

export interface SettingsProblem {
  field: keyof Settings;
  message: string;
}

const isUrl = (u: string): boolean => {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
};
const isLoopback = (u: string): boolean => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
};

/** What is wrong with a set of settings, field by field. An empty list means swaps can run. */
export function settingsProblems(s: Settings, pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:'): SettingsProblem[] {
  const out: SettingsProblem[] = [];
  if (!s.solanaRpc) out.push({ field: 'solanaRpc', message: 'Set a Solana RPC URL. There is no default: whoever runs it sees your queries and transactions.' });
  else if (!isUrl(s.solanaRpc)) out.push({ field: 'solanaRpc', message: 'The Solana RPC URL must start with http:// or https://.' });
  if (s.ethereumRpc && !isUrl(s.ethereumRpc)) out.push({ field: 'ethereumRpc', message: 'The Ethereum RPC URL must start with http:// or https://.' });
  if (s.ethereumRpc && !/^0x[0-9a-fA-F]{40}$/.test(s.contract)) out.push({ field: 'contract', message: 'Ethereum swaps need the contract address of this release.' });
  const nodes = s.moneroNodes.filter((n) => n.trim());
  if (nodes.length === 0) out.push({ field: 'moneroNodes', message: 'Add two or more independent Monero nodes, or one node that you run yourself. A single dishonest node could fake a lock and you could lose your funds.' });
  else if (nodes.length === 1 && !s.ownNode)
    out.push({ field: 'moneroNodes', message: 'One node is only enough if it is your own. Add a second, independently run node, or tick "This is my own node". A single dishonest node could fake a lock and you could lose your funds.' });
  for (const n of nodes) {
    if (!isUrl(n)) out.push({ field: 'moneroNodes', message: `"${n}" is not an http(s) URL.` });
    else if (pageIsHttps && n.startsWith('http://') && !isLoopback(n))
      out.push({ field: 'moneroNodes', message: `This page is served over HTTPS and cannot call ${n}. Use an https:// node, a node on localhost, or the relay's Monero proxy.` });
  }
  if (new Set(nodes).size !== nodes.length) out.push({ field: 'moneroNodes', message: 'The same node is listed twice. Two entries for one node are one source, not two.' });
  if ((s.mode === 'hosted' || s.mode === 'self-hosted') && s.relayUrl && !isUrl(s.relayUrl) && !s.relayUrl.startsWith('/')) out.push({ field: 'relayUrl', message: 'The relay URL must be an http(s) URL or a path on this site.' });
  if (!s.programId) out.push({ field: 'programId', message: 'The program id is missing.' });
  return out;
}

/** The relay to use in the current mode, or `null` when the mode uses none. A site-relative path is resolved against the page. */
export function relayUrlOf(s: Settings): string | null {
  if (s.mode !== 'hosted' && s.mode !== 'self-hosted') return null;
  if (!s.relayUrl) return null;
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  return new URL(s.relayUrl, base).toString().replace(/\/+$/, '');
}

export function loadSettings(deployment: Partial<Settings> = {}): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    stored = {};
  }
  return { ...DEFAULT_SETTINGS, ...deployment, ...stored };
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** The deployment's defaults: `config.json` next to the page, when the operator ships one. Same origin only. */
export async function fetchDeploymentConfig(fetchFn: typeof fetch = fetch): Promise<Partial<Settings>> {
  try {
    const res = await fetchFn(new URL('./config.json', location.href).toString(), { cache: 'no-store' });
    if (!res.ok) return {};
    const j = (await res.json()) as Partial<Settings>;
    return typeof j === 'object' && j !== null ? j : {};
  } catch {
    return {};
  }
}

/** What each connection mode reveals, in plain words (DESIGN "Connection modes"). */
export const MODE_INFO: Readonly<Record<ConnectionMode, { label: string; relay: string; learnsIp: string; note: string }>> = {
  hosted: {
    label: 'Hosted relay',
    relay: 'The site operator',
    learnsIp: 'The site operator sees your IP address, which maker you contact, message sizes and timing. It cannot read or change messages and cannot move funds.',
    note: 'The default. Convenient; one third party in the path.',
  },
  'self-hosted': {
    label: 'Self-hosted relay',
    relay: 'You, on your own machine',
    learnsIp: 'Nobody on the relay side learns your IP address.',
    note: 'Run the relay and a Tor client yourself. If the relay is on another origin than this page (another port counts), start it with RELAY_ALLOWED_ORIGINS set to this page\'s origin; it sends no CORS headers by default.',
  },
  'tor-direct': {
    label: 'Tor Browser, direct',
    relay: 'No relay',
    learnsIp: 'Nobody: requests go straight to the maker\'s onion address.',
    note: 'Only works inside Tor Browser. Untested.',
  },
  onchain: {
    label: 'On-chain only',
    relay: 'No relay',
    learnsIp: 'Your Solana RPC provider sees your messages being posted; who messaged whom, and when, is public on-chain.',
    note: 'Solana swaps only. Ethereum swaps need a relay or a maker HTTPS endpoint for key proofs. Each message costs a transaction fee.',
  },
};
