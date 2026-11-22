// The two chains of the harness, both on loopback and both throw-away:
//   - Solana: the built program inside tools/svm-rpc (an in-memory LiteSVM behind JSON-RPC; not a
//     validator, not a cluster), initialised, with a mock USDC mint.
//   - Ethereum: a local anvil (chain id 31337, never a fork) with the contract deployed behind its
//     proxy by WP3's anvil-only forge script, and its mock USDC.
// Time is driven explicitly with `advance`. svm-rpc's clock moves only on `svm_warp`. anvil mines a
// block every second so that the `finalized` tag (two blocks behind the head here) keeps moving
// without any test sleeping for it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Connection, type TransactionInstruction } from '@solana/web3.js';
import { type Address, type Hex, PROGRAM_ID, base58Decode } from '@xmrswap/protocol';
import { type EthCall, type EthTransport, EthereumClient, SolanaClient, type SolanaSigner, type SolanaTransport, type SwapView, ata, connectionTransport, hex0x, seedSigner, treasuryPda, treasuryVaultPda } from '@xmrswap/sdk';
import { type SvmRpc, startSvmRpc } from '@xmrswap/svm-rpc';
import { encodeFunctionData, parseAbi } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type Proc, startProc } from './procs.js';
import { fill, freePort, jsonRpc, repoRoot, waitFor } from './util.js';

const SO = process.env['XMR_SWAP_SO'] ?? path.join(repoRoot, 'solana/program/target/deploy/xmr_swap.so');
/** anvil's first development account: the unlocked sender of the deploy script. Only its address is used. */
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const USDC_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function setBlacklisted(address who, bool on)',
  'function blacklist(address who)',
  'function unBlacklist(address who)',
]);
export const ETH_NATIVE = '0x0000000000000000000000000000000000000000' as Address;

// ------------------------------------------------------------------ Solana

export interface SolWorld {
  svm: SvmRpc;
  url: string;
  transport: SolanaTransport;
  client: SolanaClient;
  usdc: string;
  genesis: string;
  admin: SolanaSigner;
  taker: SolanaSigner;
  taker2: SolanaSigner;
  stranger: SolanaSigner;
  rent0: bigint;
  now(): Promise<bigint>;
  warp(secs: number | bigint): Promise<void>;
  warpTo(t: bigint): Promise<void>;
  send(ixs: TransactionInstruction[], signers: SolanaSigner[]): Promise<string>;
  swap(ref: string): Promise<SwapView | null>;
  balance(pubkey: string): Promise<bigint>;
  /** USDC of an owner's associated token account (0 when it has none). */
  usdcBalance(owner: string): Promise<bigint>;
  /** What the protocol treasury holds: lamports above rent, and USDC in its vault. */
  treasury(): Promise<{ sol: bigint; usdc: bigint }>;
  fund(pubkey: string, lamports?: bigint, usdc?: bigint): Promise<void>;
  stop(): Promise<void>;
}

export async function startSolana(): Promise<SolWorld> {
  if (!existsSync(SO)) throw new Error(`e2e: ${SO} is missing; build it with \`cd solana/program && cargo build-sbf\``);
  // Chain time starts at the wall clock, so clock-skew warnings appear only after a test warped far ahead.
  const svm = await startSvmRpc({ programs: [{ programId: PROGRAM_ID, soPath: SO }], unixTimestamp: Math.floor(Date.now() / 1000) });
  const transport = connectionTransport(new Connection(svm.url, 'confirmed'), { subscriptions: false });
  const [admin, taker, stranger, taker2] = [1, 5, 6, 7].map((n) => seedSigner(fill(n))) as [SolanaSigner, SolanaSigner, SolanaSigner, SolanaSigner];
  for (const s of [admin, taker, stranger, taker2]) await svm.airdrop(s.publicKey, 1_000_000_000_000n);
  await svm.setUpgradeAuthority(PROGRAM_ID, admin.publicKey);
  const usdc = await svm.createMint(6, admin.publicKey);
  for (const s of [taker, taker2]) await svm.mintTo(usdc, s.publicKey, 1_000_000_000_000n);
  const client = new SolanaClient({ transport, programId: PROGRAM_ID, usdcMint: usdc, subscriptions: false });
  const genesis = await transport.getGenesisHash();
  const send = (ixs: TransactionInstruction[], signers: SolanaSigner[]) => client.sendAndConfirm(ixs, signers, { intervalMs: 20 });
  await send([client.program.initialize({ authority: admin.publicKey, usdcMint: usdc, clusterTag: base58Decode(genesis), treasuryAuthority: admin.publicKey, splitMode: 0 })], [admin]);
  const rent0 = await transport.getMinimumBalanceForRentExemption(0);
  const tokenAmount = async (account: string): Promise<bigint> => {
    const a = await transport.getAccount(account);
    return a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
  };
  const treasuryKey = treasuryPda(PROGRAM_ID).toBase58();
  const treasuryBase = (await transport.getAccount(treasuryKey))?.lamports ?? 0n;
  const w: SolWorld = {
    svm, url: svm.url, transport, client, usdc, genesis, admin, taker, taker2, stranger, rent0,
    now: () => client.chainTime(),
    warp: async (secs) => void (await svm.warp(Number(secs))),
    async warpTo(t) {
      const now = await client.chainTime();
      if (t > now) await svm.warp(Number(t - now));
    },
    send,
    swap: (ref) => client.getSwap(ref),
    balance: async (pubkey) => (await transport.getAccount(pubkey))?.lamports ?? 0n,
    usdcBalance: (owner) => tokenAmount(ata(owner, usdc).toBase58()),
    treasury: async () => ({ sol: ((await transport.getAccount(treasuryKey))?.lamports ?? 0n) - treasuryBase, usdc: await tokenAmount(treasuryVaultPda(PROGRAM_ID, usdc).toBase58()) }),
    async fund(pubkey, lamports = 1_000_000_000_000n, usdcAmount = 0n) {
      if (lamports > 0n) await svm.airdrop(pubkey, lamports);
      await svm.mintTo(usdc, pubkey, usdcAmount);
    },
    stop: () => svm.stop(),
  };
  return w;
}

// ------------------------------------------------------------------ Ethereum

export interface EthWorld {
  url: string;
  proc: Proc;
  transport: EthTransport;
  client: EthereumClient;
  contract: Address;
  usdc: Address;
  treasury: Address;
  taker: PrivateKeyAccount;
  taker2: PrivateKeyAccount;
  stranger: PrivateKeyAccount;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  now(): Promise<bigint>;
  advance(secs: number | bigint): Promise<void>;
  advanceTo(t: bigint): Promise<void>;
  /** Mine until the `finalized` tag has passed the current head. */
  finalize(): Promise<void>;
  /** Simulate, sign, send and wait for the receipt. */
  send(call: EthCall, from: PrivateKeyAccount, opts?: { secret?: boolean }): Promise<Hex>;
  swap(id: Uint8Array): Promise<SwapView | null>;
  balance(a: string): Promise<bigint>;
  usdcBalance(a: string): Promise<bigint>;
  usdcApprove(from: PrivateKeyAccount, amount: bigint): Promise<void>;
  setBlacklisted(who: string, on: boolean): Promise<void>;
  treasuryAccrued(): Promise<{ eth: bigint; usdc: bigint }>;
  fund(a: string, wei?: bigint, usdc?: bigint): Promise<void>;
  stop(): Promise<void>;
}

export const ethAccount = (n: number): PrivateKeyAccount => privateKeyToAccount(hex0x(fill(n)));

export async function startEthereum(): Promise<EthWorld> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // --slots-in-an-epoch 1: `safe` is one block and `finalized` two blocks behind the head, so finality
  // costs seconds, not the 64 blocks of the default. --block-time 1: blocks keep coming on their own.
  const proc = startProc('anvil', process.env['ANVIL'] ?? 'anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--slots-in-an-epoch', '1', '--silent']);
  const rpc = <T = unknown>(method: string, params: unknown[] = []): Promise<T> => jsonRpc<T>(url, method, params);
  await waitFor('anvil', async () => (await rpc<string>('eth_chainId')) === '0x7a69', { timeoutMs: 30_000, intervalMs: 100 });
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
  const transport: EthTransport = { request: ({ method, params }) => rpc(method, (params as unknown[]) ?? []) };
  const client = new EthereumClient({ transport, contract });
  await client.verifyChainId(31337);
  const [taker, stranger, taker2] = [14, 15, 16].map(ethAccount) as [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
  const read = async (to: string, data: Hex): Promise<bigint> => BigInt(await rpc<Hex>('eth_call', [{ to, data }, 'latest']));
  const SWAP_ABI = parseAbi(['function treasuryAccrued(address token) view returns (uint256)']);
  const w: EthWorld = {
    url, proc, transport, client, contract, usdc, treasury, taker, taker2, stranger, rpc,
    now: () => client.chainTime('latest'),
    async advance(secs) {
      await rpc('evm_increaseTime', [`0x${BigInt(secs).toString(16)}`]);
      await rpc('evm_mine', []);
    },
    async advanceTo(t) {
      const now = await client.chainTime('latest');
      if (t > now) await w.advance(t - now);
    },
    finalize: async () => void (await rpc('anvil_mine', ['0x3', '0x1'])),
    async send(call, from, opts = {}) {
      const hash = await client.send(call, from, opts);
      await client.waitMined(hash, { intervalMs: 100 });
      return hash;
    },
    swap: (id) => client.getSwap(id, 'latest'),
    balance: async (a) => BigInt(await rpc<string>('eth_getBalance', [a, 'latest'])),
    usdcBalance: (a) => read(usdc, encodeFunctionData({ abi: USDC_ABI, functionName: 'balanceOf', args: [a as Address] })),
    async usdcApprove(from, amount) {
      await w.send({ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [contract, amount] }), value: 0n }, from);
    },
    async setBlacklisted(who, on) {
      await w.send({ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'setBlacklisted', args: [who as Address, on] }), value: 0n }, stranger);
    },
    treasuryAccrued: async () => ({
      eth: await read(contract, encodeFunctionData({ abi: SWAP_ABI, functionName: 'treasuryAccrued', args: [ETH_NATIVE] })),
      usdc: await read(contract, encodeFunctionData({ abi: SWAP_ABI, functionName: 'treasuryAccrued', args: [usdc] })),
    }),
    async fund(a, wei = 1000n * 10n ** 18n, usdcAmount = 0n) {
      if (wei > 0n) await rpc('anvil_setBalance', [a, `0x${wei.toString(16)}`]);
      if (usdcAmount > 0n) await w.send({ to: usdc, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'mint', args: [a as Address, usdcAmount] }), value: 0n }, stranger);
    },
    stop: () => proc.stop(2_000),
  };
  await w.fund(stranger.address);
  for (const a of [taker, taker2]) await w.fund(a.address, 1000n * 10n ** 18n, 1_000_000_000_000n);
  // From here on a block every second (the deployment above ran with instant mining).
  await rpc('evm_setIntervalMining', [1]);
  return w;
}
