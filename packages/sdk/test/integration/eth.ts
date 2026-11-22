// An Ethereum world for the integration tests: a local anvil (chain id 31337, loopback, never a
// fork of a live network) with the contract deployed behind its proxy by the anvil-only forge
// script of WP3 (the bytecode has library link placeholders, so forge links and deploys it).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DerivedKeys, dleqProve, dleqVerify, keyLeaf, merkleRoot, twinCommitments } from '@xmrswap/core-wasm';
import { type Address, type Hex, MAKER_ROUTES } from '@xmrswap/protocol';
import { encodeFunctionData, parseAbi } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type EthCall, type EthMaker, type EthTransport, EthereumClient } from '../../src/ethereum/client.js';
import { type CallMaterial, ethereumCall } from '../../src/flows/execute.js';
import { makerShareKeys } from '../../src/flows/keys.js';
import type { Decision } from '../../src/flows/types.js';
import type { SwapView } from '../../src/machine/view.js';
import { MakerHttp } from '../../src/messages/transports.js';
import type { EthDeployment } from '../../src/signing/eip712.js';
import { fakeMakerEndpoint } from '../../src/testing/maker.js';
import { type Bytes, hex, hex0x, unhex } from '../../src/util.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** anvil's first development account: the unlocked sender of the deploy script. Only its address is used. */
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const USDC_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
export const ETH_NATIVE = '0x0000000000000000000000000000000000000000' as Address;

async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code, data: body.error.data });
  return body.result as T;
}
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
/** A throwaway test key: 32 bytes of one value. Funded with `anvil_setBalance`; never a real account. */
const account = (n: number): PrivateKeyAccount => privateKeyToAccount(hex0x(new Uint8Array(32).fill(n)));

export interface EthWorld {
  url: string;
  transport: EthTransport;
  client: EthereumClient;
  deployment: EthDeployment;
  contract: Address;
  usdc: Address;
  treasury: Address;
  owner: PrivateKeyAccount;
  operator: PrivateKeyAccount;
  /** The operator's private key: signs quotes and approvals (EIP-712). */
  operatorKey: Hex;
  payout: PrivateKeyAccount;
  taker: PrivateKeyAccount;
  stranger: PrivateKeyAccount;
  makerSeed: Bytes;
  /** The maker's X25519 key pair (published in its Solana record; version 1). */
  makerEnc: DerivedKeys;
  /** The maker's shares by hex of the spend commitment, and the DLEQ blobs its endpoint serves (its own and takers'). */
  shares: Map<string, DerivedKeys>;
  blobs: Map<string, Uint8Array>;
  pools: Map<string, string>;
  /** The maker's `/xs/v1` endpoint, in memory. */
  http: MakerHttp;
  now(): Promise<bigint>;
  /** Mine a block at chain time `t` (never backwards). */
  advanceTo(t: bigint): Promise<void>;
  /** Mine enough blocks for the `finalized` tag to pass the current head. */
  finalize(): Promise<void>;
  /** Simulate, sign, send and wait for the receipt. */
  send(call: EthCall, from: PrivateKeyAccount, opts?: { secret?: boolean }): Promise<Hex>;
  maker(): Promise<EthMaker>;
  swap(swapId: Bytes): Promise<SwapView | null>;
  /** A fresh maker share with its DLEQ proof served. */
  newShare(): { keys: DerivedKeys; key: Address; key2: Address };
  /** A key pool of `n` fresh shares, served by the endpoint. Returns its root. */
  newPool(n: number): Bytes;
  exec(s: SwapView, d: Decision, signers: { session?: PrivateKeyAccount }, m?: CallMaterial): Promise<Hex>;
  balance(a: Address): Promise<bigint>;
  usdcBalance(a: Address): Promise<bigint>;
  usdcApprove(from: PrivateKeyAccount, amount: bigint): Promise<void>;
  stop(): Promise<void>;
}

export async function startEthereum(): Promise<EthWorld> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.env.ANVIL ?? 'anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--timestamp', '1800000000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`anvil did not start:\n${buf}`)), 30_000);
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString();
      if (buf.includes('Listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`anvil exited with ${code}:\n${buf}`)));
  });
  // XMRSWAP_DEPLOY_OUT=-: the script writes no file; the addresses are read from its output.
  const out = execFileSync('forge', ['script', 'script/DeployAnvil.s.sol', '--rpc-url', url, '--broadcast', '--unlocked', '--sender', DEPLOYER], { cwd: path.join(repoRoot, 'ethereum'), env: { ...process.env, XMRSWAP_DEPLOY_OUT: '-' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const addr = (label: string): Address => {
    const m = new RegExp(`${label}:\\s+(0x[0-9a-fA-F]{40})`).exec(out);
    if (!m) throw new Error(`the deploy script did not print ${label}:\n${out}`);
    return m[1]!.toLowerCase() as Address;
  };
  const contract = addr('XmrSwap proxy');
  const usdc = addr('USDC');
  const treasury = addr('treasury');
  const transport: EthTransport = { request: ({ method, params }) => rpc(url, method, params ?? []) };
  const client = new EthereumClient({ transport, contract });
  await client.verifyChainId(31337);

  const [owner, operator, payout, taker, stranger] = [11, 12, 13, 14, 15].map(account) as [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
  for (const a of [owner, operator, taker, stranger]) await rpc(url, 'anvil_setBalance', [a.address, `0x${(1000n * 10n ** 18n).toString(16)}`]);
  const makerSeed = new Uint8Array(32).fill(88);
  const makerEnc = makerShareKeys(makerSeed, 'ethereum', new Uint8Array(16).fill(1));
  const shares = new Map<string, DerivedKeys>();
  const blobs = new Map<string, Uint8Array>();
  const pools = new Map<string, string>();
  let shareCounter = 1;

  const endpoint = fakeMakerEndpoint((method, p, body) => {
    const dleq = /^\/xs\/v1\/dleq\/([0-9a-f]{64})$/.exec(p);
    if (dleq && method === 'GET') return blobs.has(dleq[1]!) ? { status: 200, body: blobs.get(dleq[1]!)! } : { status: 404 };
    if (dleq && method === 'PUT') {
      // The daemon keeps a taker's proof only if it verifies and its S equals the path.
      try {
        if (hex(dleqVerify(body!).spendPub) !== dleq[1]) return { status: 400, body: '{"code":"bad_request"}' };
      } catch {
        return { status: 400, body: '{"code":"bad_request"}' };
      }
      blobs.set(dleq[1]!, body!);
      return { status: 204 };
    }
    const pool = /^\/xs\/v1\/pool\/([0-9a-f]{64})$/.exec(p);
    if (pool) return pools.has(pool[1]!) ? { status: 200, body: pools.get(pool[1]!)! } : { status: 404 };
    if (p === MAKER_ROUTES.info) return { status: 200, body: JSON.stringify({ maker: 'maker', operator: operator.address, enc_key_version: 1, chain_time: 0 }) };
    return { status: 404 };
  });

  const w: EthWorld = {
    url, transport, client, contract, usdc, treasury, deployment: { chainId: 31337n, contract }, owner, operator, operatorKey: hex0x(new Uint8Array(32).fill(12)), payout, taker, stranger,
    makerSeed, makerEnc, shares, blobs, pools, http: new MakerHttp(endpoint),
    now: () => client.chainTime('latest'),
    async advanceTo(t) {
      if (t <= (await client.chainTime('latest'))) return;
      await rpc(url, 'evm_setNextBlockTimestamp', [`0x${t.toString(16)}`]);
      await rpc(url, 'evm_mine', []);
    },
    // anvil reports `finalized` 64 blocks behind the head.
    finalize: async () => void (await rpc(url, 'anvil_mine', ['0x41', '0x1'])),
    async send(call, from, opts = {}) {
      const hash = await client.send(call, from, opts);
      await client.waitMined(hash, { intervalMs: 20 });
      return hash;
    },
    async maker() {
      return (await client.getMaker(owner.address.toLowerCase() as Address, 'latest'))!;
    },
    swap: (id) => client.getSwap(id, 'latest'),
    newShare() {
      const id = new Uint8Array(16);
      new DataView(id.buffer).setUint32(0, ++shareCounter);
      const keys = makerShareKeys(makerSeed, 'ethereum', id);
      const twin = twinCommitments(keys.spend);
      shares.set(hex(keys.spendPub), keys);
      blobs.set(hex(keys.spendPub), dleqProve(keys.spend));
      return { keys, key: hex0x(twin.keyAddr) as Address, key2: hex0x(twin.keyAddr2) as Address };
    },
    newPool(n) {
      const leaves = Array.from({ length: n }, (_, index) => ({ index, ...w.newShare() }));
      const root = merkleRoot(leaves.map((l) => keyLeaf(l.index, unhex(l.key), unhex(l.key2), l.keys.spendPub)));
      pools.set(hex(root), JSON.stringify({ leaves: leaves.map((l) => ({ index: l.index, key: l.key, key2: l.key2, spend_pub: hex(l.keys.spendPub) })) }));
      return root;
    },
    async exec(s, d, signers, m = {}) {
      if (d.do !== 'call') throw new Error(`not a call: ${JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      const signer = d.caller === 'operator' ? operator : d.caller === 'taker' ? taker : d.caller === 'owner' ? owner : d.caller === 'anyone' ? stranger : signers.session;
      if (!signer) throw new Error('the session key is needed for this call');
      const call = ethereumCall(client.contract, s, d.call, m);
      if (!call) throw new Error('nothing to send on Ethereum for this call');
      return w.send(call, signer, { secret: d.secret });
    },
    balance: async (a) => BigInt(await rpc<string>(url, 'eth_getBalance', [a, 'latest'])),
    async usdcBalance(a) {
      const data = await rpc<Hex>(url, 'eth_call', [{ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'balanceOf', args: [a] }) }, 'latest']);
      return BigInt(data);
    },
    async usdcApprove(from, amount) {
      await w.send({ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [contract, amount] }), value: 0n }, from);
    },
    async stop() {
      child.kill();
    },
  };
  // Register the maker from its owner address, linked to a Solana owner key.
  await w.send(client.contract.registerMaker(operator.address, payout.address, new Uint8Array(32).fill(7)), owner);
  for (const a of [operator, taker]) await w.send({ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'mint', args: [a.address, 1_000_000_000_000n] }), value: 0n }, stranger);
  return w;
}

/** Give a test account ETH for gas (anvil only). */
export async function fundForGas(w: EthWorld, a: Address): Promise<void> {
  await rpc(w.url, 'anvil_setBalance', [a, `0x${(10n ** 18n).toString(16)}`]);
}
