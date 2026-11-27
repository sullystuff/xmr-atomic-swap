// @vitest-environment node
// The SDK's bounded signing and authenticated watch requests, as the page uses them (SDK
// DEVIATIONS X1 to X5). Node environment: real Solana and Ethereum encodings.
import { PublicKey, SystemProgram, type Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { EthereumClient, SolanaClient, type SwapView, init, openWatchRequest, seedSigner, signWatchAck, watchDeployment } from '@xmrswap/sdk';
import { FakeEthereum, FakeSolana } from '@xmrswap/sdk/testing';
import { DEV_PROGRAM_ID } from '@xmrswap/protocol';
import { TransactionExpired, signingRefusalText, wrongWalletChain } from '../src/lib/errors.js';
import { EthereumPort, SolanaPort } from '../src/lib/ports.js';
import { acknowledged, registerWithWatcher, watcherRefusalText } from '../src/lib/watcher.js';
import { ModelChain, TAKER } from './fakes.js';

await init();
const WATCHER_SEED = new Uint8Array(32).fill(61);
const WATCHER = seedSigner(WATCHER_SEED).publicKey;
const CONTRACT = '0x00000000000000000000000000000000000000c1' as const;

describe('watch requests are authenticated as the locker (wire format 2)', () => {
  /** A watcher endpoint in memory: verifies the request against the swap it "reads from the chain", then acknowledges. */
  function watcher(swap: SwapView, opts: { deployment?: string; format1?: boolean } = {}) {
    const seen: unknown[] = [];
    const fetchFn = async (_url: string, init: { method: string; body?: Uint8Array | string }) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) as Record<string, unknown>;
      seen.push(body);
      const respond = (status: number, j: unknown) => ({ status, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(j)).slice().buffer as ArrayBuffer });
      if (opts.format1) return respond(400, { error: 'WatchFormatUnsupported', detail: 'WatchFormatUnsupported: this watcher accepts request format 1 only' });
      try {
        const r = openWatchRequest(body, { watcherSeed: WATCHER_SEED, swap, deployment: opts.deployment ?? watchDeployment({ programId: DEV_PROGRAM_ID }), now: swap.tLock + 5n });
        return respond(200, signWatchAck({ chain: r.chain, swapRef: r.swapRef, watchingUntil: Number(swap.tLock) + 4200, watcherSeed: WATCHER_SEED }));
      } catch (e) {
        return respond(400, { error: (e as { code?: string }).code ?? 'bad_request', detail: String((e as Error).message) });
      }
    };
    return { fetchFn, seen };
  }
  const chain = new ModelChain();
  const { view, keys } = chain.open({ wZ: 86_400, watcher: WATCHER });
  const note = { url: 'https://watch.example', solana: WATCHER, address: WATCHER };

  it('the page seals the request with the swap\'s own encryption secret and binds it to the deployment and the chain\'s time', async () => {
    const w = watcher(view);
    const ack = await registerWithWatcher(note, view, keys, { programId: DEV_PROGRAM_ID }, view.tLock + 3n, w.fetchFn);
    expect(w.seen[0]).toMatchObject({ v: 2, chain: 'solana', deployment: DEV_PROGRAM_ID, issued_at: Number(view.tLock + 3n) });
    expect(acknowledged({ ...note, ack }, view)).toBe(true);
  });

  it('a request sealed with any other secret is rejected by the watcher, and the swap is not treated as watched', async () => {
    const w = watcher(view);
    const other = chain.open({ wZ: 86_400, watcher: WATCHER }).keys;
    const err = await registerWithWatcher(note, view, other, { programId: DEV_PROGRAM_ID }, view.tLock + 3n, w.fetchFn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(watcherRefusalText(err)).toMatch(/^The watcher rejected the request/);
    expect(acknowledged(note, view)).toBe(false);
  });

  it('a watcher on another deployment, or one that speaks another request format, does not acknowledge: said with the reason', async () => {
    const elsewhere = await registerWithWatcher(note, view, keys, { programId: DEV_PROGRAM_ID }, view.tLock + 3n, watcher(view, { deployment: 'OtherProgram' }).fetchFn).catch((e: unknown) => e);
    expect(watcherRefusalText(elsewhere)).toMatch(/^The watcher rejected the request/);
    const old = await registerWithWatcher(note, view, keys, { programId: DEV_PROGRAM_ID }, view.tLock + 3n, watcher(view, { format1: true }).fetchFn).catch((e: unknown) => e);
    expect(watcherRefusalText(old)).toBe('The watcher speaks an older or newer request format than this page and did not accept the request');
  });
});

describe('Ethereum: signing is bound to the pinned chain id, a gas cap and a fee cap', () => {
  function rig(chainId = 1) {
    const fake = new FakeEthereum(CONTRACT);
    fake.chainId = 1n;
    fake.views.setReady = () => undefined;
    const client = new EthereumClient({ transport: fake, contract: CONTRACT, chainId });
    const sent: unknown[] = [];
    const port = new EthereumPort(client, () => ({ address: '0x00000000000000000000000000000000000000aa', sendTransaction: async (c) => (sent.push(c), '0x01') }), 1);
    const eth = new ModelChain('ethereum');
    const { view, keys } = eth.open();
    return { fake, client, port, sent, view, keys };
  }
  const ready = { do: 'call' as const, call: { name: 'set_ready' as const }, caller: 'session' as const, secret: false, notAfter: null, row: 'A9' };

  it('a fee above the cap is "network fee above your limit", with the numbers, and nothing is sent', async () => {
    const r = rig();
    r.fake.baseFeePerGas = 200_000_000_000n;
    const err = (await r.port.exec(r.view, ready, r.keys, {}).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^Network fee above your limit: the network asks 40\d\.\d\d gwei per unit of gas and this page signs at most 300\.00 gwei\. Nothing was signed or sent\./);
    expect(err.message).toMatch(/can cost you your funds/);
    expect(r.fake.sentRaw).toEqual([]);
  });

  it('an RPC on another chain is a plain, blocking message before any signature; the wallet is never asked', async () => {
    const r = rig();
    r.fake.chainId = 5n;
    const err = (await r.port.sendWithWallet({ to: CONTRACT, data: '0x', value: 0n }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^The Ethereum RPC is on a different chain than this site is for .*Nothing was signed\./);
    expect(r.sent).toEqual([]);
    const session = (await r.port.exec(r.view, ready, r.keys, {}).catch((e: unknown) => e)) as Error;
    expect(session.message).toMatch(/different chain than this site is for/);
    expect(r.fake.sentRaw).toEqual([]);
  });

  it('a wallet on another chain is told which chain it is on and which this site is for', () => {
    expect(wrongWalletChain(5, 1)).toBe('Your wallet is on chain 5; this site is for chain 1. Switch networks in the wallet. Nothing was signed or sent.');
  });

  it('an inflated gas estimate is refused, in words', () => {
    expect(signingRefusalText(Object.assign(new Error('GasLimitTooHigh: the endpoint estimates 9000000 gas; 10800000 is over the cap of 150000 for this call'), { code: 'GasLimitTooHigh' }))).toMatch(/needs far more gas than it should .*nothing was signed/);
    expect(signingRefusalText(new Error('User rejected the request.'))).toBeNull();
  });
});

describe('Solana: a transaction is dead only when its blockhash has expired by block height', () => {
  it('keeps waiting while the blockhash is valid, returns when it lands, and says "safe to send again" only after expiry', async () => {
    const fake = new FakeSolana({ subscriptions: false });
    const client = new SolanaClient({ transport: fake, programId: DEV_PROGRAM_ID, subscriptions: false });
    const key = seedSigner(new Uint8Array(32).fill(5));
    const wallet = {
      address: TAKER,
      signTransaction: async (tx: Transaction) => {
        tx.addSignature(new PublicKey(TAKER), Buffer.from(await key.sign(Uint8Array.from(tx.serializeMessage()))));
        return tx;
      },
    };
    const port = new SolanaPort(client, () => wallet, 5);
    const ix = SystemProgram.transfer({ fromPubkey: new PublicKey(TAKER), toPubkey: new PublicKey(TAKER), lamports: 1 });

    // Not landed, blockhash still valid: still pending after many polls (a wall-clock timeout would have given up).
    fake.blockHeight = 900;
    let settled: unknown = 'pending';
    const p = port.sendWithWallet([ix]).then(
      (v) => (settled = v),
      (e: unknown) => (settled = e),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(settled).toBe('pending');
    expect(fake.sent).toHaveLength(1);
    // The blockhash expires without the transaction landing: now, and only now, it is dead.
    // (The fake issues blockhashes valid for 150 blocks: this one until height 1050.)
    fake.blockHeight = 1051;
    await p;
    expect(settled).toBeInstanceOf(TransactionExpired);
    expect((settled as Error).message).toMatch(/never will\. Nothing changed on-chain; it is safe to send it again\./);

    // A transaction that lands is returned even if the height has moved on.
    fake.blockHeight = 900;
    fake.onSend = () => 'landed';
    const q = port.sendWithWallet([ix]);
    await new Promise((r) => setTimeout(r, 20));
    fake.addTransaction({ signature: 'landed', slot: 1, blockTime: null, err: null, logs: [], instructions: [] }, [TAKER]);
    expect(await q).toBe('landed');
  });
});
