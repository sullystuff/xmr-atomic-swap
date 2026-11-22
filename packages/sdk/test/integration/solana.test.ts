// Solana integration (M2): the SDK's client and flows against the real program inside
// `tools/svm-rpc`. Needs WP2's built .so and WP4's binary; see harness.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init } from '@xmrswap/core-wasm';
import { DEV_PROGRAM_ID } from '@xmrswap/protocol';
import { SolanaClient, seedSigner } from '../../src/solana/client.js';
import { type SvmRpc, startSvmRpc } from './harness.js';

let svm: SvmRpc;
let client: SolanaClient;
const T0 = 1_800_000_000;
const admin = seedSigner(new Uint8Array(32).fill(1));

beforeAll(async () => {
  await init();
  svm = await startSvmRpc(T0);
  client = new SolanaClient({ transport: svm.transport, programId: DEV_PROGRAM_ID, subscriptions: false });
});
afterAll(async () => {
  await svm?.stop();
});

describe('svm-rpc endpoint', () => {
  it('is not a live cluster and tells the chain time the program sees', async () => {
    const genesis = await svm.transport.getGenesisHash();
    await expect(client.verifyGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')).rejects.toMatchObject({ code: 'WrongCluster' });
    await client.verifyGenesis(genesis);
    expect(await client.chainTime()).toBe(BigInt(T0));
    await svm.warp(90);
    expect(await client.chainTime()).toBe(BigInt(T0 + 90));
    expect(client.subscriptions).toBe(false);
  });

  it('initializes the program under a test upgrade authority and reads Config back', async () => {
    await svm.airdrop(admin.publicKey, 10_000_000_000n);
    await svm.setUpgradeAuthority(admin.publicKey);
    const usdc = await svm.createMint(6, admin.publicKey);
    const genesis = await svm.transport.getGenesisHash();
    const { base58Decode } = await import('@xmrswap/protocol');
    await client.send([client.program.initialize({ authority: admin.publicKey, usdcMint: usdc, clusterTag: base58Decode(genesis), treasuryAuthority: admin.publicKey, splitMode: 0 })], [admin]);
    const config = await client.getConfig();
    expect(config).toMatchObject({ admin: admin.publicKey, usdcMint: usdc, splitMode: 0 });
  });
});

describe('flows against the program', () => {
  it.todo('H-A sol and usdc_sol: lock, notice, ready, claim; taker sweeps with the revealed share (regtest)');
  it.todo('H-B sol and usdc_sol: take, fund, notice, ready, claim; maker sweeps');
  it.todo('M-1 window mode: approve, reject, expiry cranked by a stranger, taker cancel');
  it.todo('M-2 advance approval through the Ed25519 instruction: valid, expired, wrong taker, over limit, stale epoch');
  it.todo('M-3 taker-bound quote: post_quote then lock; second use refused');
  it.todo('M-4 approve carrying the open hash of a replaced lock fails with BadState');
  it.todo('every refund path of takerStep and makerStep, driven by svm_warp to each deadline');
  it.todo('X-1 boundary seconds: the flows never propose a secret-bearing call the program refuses');
  it.todo('P-1 pay-or-park with a frozen payout token account, then withdraw_owed');
  it.todo('transaction sizes of SPEC 4.10 accepted by the runtime; v0 with svm_createLookupTable (spike)');
  it.todo('post_message round trip: getSignaturesForAddress and getTransaction feed listMessages');
  it.todo('SwapWatcher over polling: new, changed and closed swap accounts');
});
