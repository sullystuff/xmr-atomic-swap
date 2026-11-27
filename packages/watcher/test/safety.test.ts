// The hard safety properties (SPEC 11.6): the watcher can only ever call `freeze`; it never
// holds or derives a spend share; and no endpoint, however wrong or dishonest, can make it sign
// anything but a freeze of a swap that endpoint says names it, within the operator's fee bounds.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import { PROGRAM_ID, SWAP_FLAG, SWAP_STATE, base58Encode } from '@xmrswap/protocol';
import { hex0x, watchRequest } from '@xmrswap/sdk';
import { parseTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import { ETH_FREEZE_GAS_LIMIT } from '../src/chains.js';
import { WatcherKeys } from '../src/keys.js';
import type { Watcher } from '../src/service.js';
import { CONTRACT, ENC, HALVES, type World, hex, makeWorld, passes, unhex } from './world.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readdirSync(path.join(here, '../src')).filter((f) => f.endsWith('.ts'));
/** Source with comments and string literals removed: only what executes. */
const code = (file: string): string =>
  readFileSync(path.join(here, '../src', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

async function watch(w: World, svc: Watcher, spec: Parameters<World['addSwap']>[0] = {}) {
  const s = await w.addSwap(spec);
  expect((await svc.register(watchRequest({ chain: w.chain, swapRef: s.ref, noticeKey: s.noticeKey, watcherSolanaKey: w.keys.solana }))).status).toBe(200);
  return s;
}

describe('it can only ever call freeze', () => {
  it('the source builds one instruction and one function, signs in one place, and imports nothing that could do more', () => {
    expect(SRC.sort()).toEqual(['app.ts', 'chains.ts', 'cli.ts', 'config.ts', 'index.ts', 'keys.ts', 'log.ts', 'ratelimit.ts', 'run.ts', 'service.ts', 'store.ts']);
    const all = SRC.map((f) => [f, code(f)] as const);
    // Every builder call on the SDK's program and contract objects is `freeze`.
    const builders = all.flatMap(([f, c]) => [...c.matchAll(/client\.(program|contract)\.([A-Za-z]+)\(/g)].map((m) => `${f}:${m[1]}.${m[2]}`));
    expect(builders.sort()).toEqual(['chains.ts:contract.freeze', 'chains.ts:program.freeze']);
    expect(all.flatMap(([, c]) => c.match(/\.(program|contract)\.(?!freeze\(|toLowerCase\()[A-Za-z]+\(/g) ?? [])).toEqual([]);
    expect(all.flatMap(([f, c]) => [...c.matchAll(/new XmrSwapContract\([^)]*\)\.([A-Za-z]+)\(/g)].map((m) => `${f}:${m[1]}`))).toEqual(['keys.ts:freeze']);
    // No other way to make a call exists in the source: no flow executor, no raw instruction or calldata encoder, no other SDK flow.
    const banned = /\b(solanaInstruction|ethereumCall|buildInstruction|encodeFunctionData|takerStep|makerStep|planSolanaOpen|planEthereumOpen|setReady|postNotice|withdrawOwed|pushOwed|publishEvidence|withhold|refund|claim|abort|sendAndConfirm|signAndSend|SystemProgram|TransactionInstruction|sendTransaction|eth_sendTransaction|personal_sign|eth_sign)\b/;
    for (const [f, c] of all) expect(banned.exec(c)?.[0], f).toBeUndefined();
    // Key material is touched in keys.ts only, and transactions are signed in exactly two guarded methods.
    for (const [f, c] of all) {
      if (f === 'keys.ts') continue;
      expect(/seedSigner|privateKeyToAccount|signTransaction|\.sign\(|ed25519|secp256k1|passphraseOpen/.exec(c)?.[0], f).toBeUndefined();
    }
    const keys = code('keys.ts');
    expect((keys.match(/\.signTransaction\(/g) ?? []).length).toBe(1);
    expect((keys.match(/\.sign\(/g) ?? []).length).toBe(1);
    expect(keys.indexOf('assertEthereumFreeze(tx, swapRef, pins);')).toBeLessThan(keys.indexOf('.signTransaction('));
    expect(keys.indexOf('assertSolanaFreeze(message, this.solana, swapRef, pins);')).toBeLessThan(keys.indexOf('.sign('));
    // `eth_sendRawTransaction` and the Solana `send` carry only bytes that came out of those two methods.
    expect(all.filter(([, c]) => /eth_sendRawTransaction|transport\.send\(/.test(c)).map(([f]) => f)).toEqual(['chains.ts']);
  });

  it.each(['solana', 'ethereum'] as const)('on %s, across every outcome, each transaction simulated, signed or broadcast is one freeze of a watched swap', async (chain) => {
    const w = await makeWorld(chain);
    const svc = w.service();
    const watched = [await watch(w, svc, { notice: 'garbage' }), await watch(w, svc, { notice: 'no-such-tx' }), await watch(w, svc, { notice: 'good' }), await watch(w, svc, { direction: 1, notice: 'no-such-tx' }), await watch(w, svc)];
    const unwatched = await w.addSwap({ notice: 'garbage' });
    for (const t of [w.times.tNotice + 1n, w.times.tCut, w.times.tCut + 60n, w.times.tCo - w.times.margin + 1n, w.times.tCo + w.times.margin + 5n]) {
      w.setTime(t);
      await passes(svc, 3, w);
    }
    expect(w.broadcasts.length).toBe(3);
    const refs = new Set(watched.map((s) => (chain === 'solana' ? base58Encode(s.ref) : hex(s.ref))));
    for (const b of w.broadcasts) {
      expect(b.calls.filter((c) => c !== 'compute-budget')).toEqual(['freeze']);
      expect(refs.has(b.swapRef)).toBe(true);
    }
    for (const t of w.signedOrSimulated()) expect(t.calls.filter((c) => c !== 'compute-budget')).toEqual(['freeze']);
    expect(await w.chainState(unwatched.ref)).toBe(SWAP_STATE.NOTICED);
    expect(await w.chainState(watched[2]!.ref)).toBe(SWAP_STATE.NOTICED);
  });
});

describe('it never holds or derives a spend share', () => {
  it('no source file names a spend secret, the joint spend key, a sweep, or a key derivation that yields one', () => {
    const banned = /\b(jointSpendKey|sweepJoint|sweep|spendKey|spendPriv|spend_priv|addScalars|takerSwapKeys|makerShareKeys|resumeSwapKeys|deriveKeys|walletSeed|unlockWalletSeed|secretOpens|revealed|encSecret|noticeKeyFor|openNotice|x25519)\b/;
    for (const f of SRC) expect(banned.exec(code(f))?.[0], f).toBeUndefined();
    // The only thing read from a notice is what the SDK's view-only `watcherFacts` reads.
    expect(SRC.filter((f) => /watcherFacts\(/.test(code(f)))).toEqual(['service.ts']);
  });

  it.each(['solana', 'ethereum'] as const)('on %s, after swaps that were frozen, completed and claimed, neither the database, the log nor any answer holds a spend share', async (chain) => {
    const w = await makeWorld(chain);
    const lines: string[] = [];
    const store = w.store();
    const svc = w.service({ store, logSink: (l) => lines.push(l), debug: true });
    const frozen = await watch(w, svc, { notice: 'no-such-tx' });
    const claimed = await watch(w, svc, { notice: 'good' });
    w.setTime(w.times.tCut);
    await passes(svc, 3, w);
    // The claimer claims: its spend share is now public on chain, in the swap the watcher reads.
    const makerSpend = unhex(HALVES.maker.spend);
    w.patch(claimed.ref, chain === 'solana' ? { state: SWAP_STATE.DONE, flags: SWAP_FLAG.NOTICE | SWAP_FLAG.REVEALED, revealed: makerSpend } : { state: SWAP_STATE.DONE, flags: SWAP_FLAG.NOTICE | SWAP_FLAG.REVEALED, revealed: BigInt(hex0x(makerSpend.slice().reverse())) });
    await passes(svc, 3, w);
    expect(svc.status(hex(claimed.ref))).toMatchObject({ status: 'not_needed' });
    expect(svc.status(hex(frozen.ref))).toMatchObject({ status: 'frozen' });
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    const file = readFileSync(path.join(w.dir, 'watcher.sqlite'));
    const outputs = [lines.join('\n'), JSON.stringify(svc.status(hex(frozen.ref))), JSON.stringify(svc.status(hex(claimed.ref))), JSON.stringify(svc.info()), JSON.stringify(await svc.health()), file.toString('latin1')].join('\n');
    const secrets = { makerSpend: HALVES.maker.spend, takerSpend: HALVES.taker.spend, jointSpend: HALVES.joint.spend_priv, makerView: HALVES.maker.view, takerEnc: ENC.taker_secret, makerEnc: ENC.maker_secret };
    for (const [name, secret] of Object.entries(secrets)) {
      expect(outputs.includes(secret), name).toBe(false);
      expect(file.includes(Buffer.from(secret, 'hex')), name).toBe(false);
      expect(file.includes(Buffer.from(secret, 'hex').reverse()), name).toBe(false);
    }
    store.close();
  });
});

describe('a wrong or lying endpoint', () => {
  it.each(['solana', 'ethereum'] as const)('on %s: one answer that the swap is gone, ended, ready, or names someone else ends nothing and deletes no key', async (chain) => {
    const w = await makeWorld(chain);
    const store = w.store();
    const svc = w.service({ store, settings: { stopConfirmations: 3 } });
    const s = await watch(w, svc);
    const other = new WatcherKeys(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    const lies: (() => void)[] = [() => w.setState(s.ref, SWAP_STATE.DONE), () => w.setState(s.ref, SWAP_STATE.READY), () => w.setState(s.ref, SWAP_STATE.FROZEN), () => w.patch(s.ref, { watcher: chain === 'solana' ? other.solana : other.ethereum })];
    const truth = (): void => w.patch(s.ref, { state: SWAP_STATE.ACTIVE, watcher: w.port.address });
    for (const lie of lies) {
      lie();
      await passes(svc, 2, w);
      truth();
      await passes(svc, 1, w);
      expect(store.getWatch(chain, hex(s.ref))).toMatchObject({ status: 'watching', terminal_at: null, stop_seen: 0 });
      expect(store.keyCount(chain, hex(s.ref))).toBe(1);
    }
    // The watch is still alive for the real thing.
    await w.postNotice(s.ref, 'no-such-tx');
    w.setTime(w.times.tCut);
    await passes(svc, 4, w);
    expect(svc.status(hex(s.ref))).toMatchObject({ status: 'frozen' });
    // Told the same thing three passes running, the watcher believes it: it has no other source.
    const t = await watch(w, svc);
    w.patch(t.ref, { watcher: chain === 'solana' ? other.solana : other.ethereum });
    await passes(svc, 3, w);
    expect(svc.status(hex(t.ref))).toMatchObject({ status: 'not_needed', reason: 'the swap does not name this watcher (not-named)' });
    expect(w.broadcasts.length).toBe(1);
    store.close();
  });

  it('on Solana: an inflated compute-unit figure cannot raise the fee past the bound, and a refused simulation signs nothing', async () => {
    const w = await makeWorld('solana');
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'no-such-tx' });
    w.setTime(w.times.tCut);
    w.net.simRefuses = true;
    await passes(svc, 2, w);
    expect(w.broadcasts).toEqual([]);
    expect(w.store().getWatch('solana', hex(s.ref))).toMatchObject({ status: 'freezing', last_error: 'BadState' });
    w.net.simRefuses = false;
    w.net.simUnits = 1_399_999_999;
    await passes(svc, 3, w);
    expect(w.rawBroadcasts.length).toBe(1);
    const tx = Transaction.from(w.rawBroadcasts[0]!);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.signatures.map((x) => x.publicKey.toBase58())).toEqual([w.keys.solana]);
    const [limit, price, freeze] = tx.instructions;
    expect(limit!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(limit!.data.readUInt32LE(1)).toBe(200_000);
    expect(price!.data.readBigUInt64LE(1)).toBe(1_000n);
    expect(freeze!.programId.toBase58()).toBe(PROGRAM_ID);
    expect(freeze!.keys.map((k) => k.pubkey.toBase58()).slice(0, 2)).toEqual([w.keys.solana, base58Encode(s.ref)]);
    expect(BigInt(w.store().attempts('solana', hex(s.ref))[0]!.max_fee)).toBe(w.port.freezeReserve());
  });

  it('on Ethereum: a false chain id, gas estimate, nonce or fee cannot change what is signed beyond a bounded freeze for the configured chain', async () => {
    const w = await makeWorld('ethereum');
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'no-such-tx' });
    w.setTime(w.times.tCut);
    // The endpoint claims to be mainnet, estimates absurd gas, and reports a far-off nonce.
    w.net.chainIdAnswer = 1n;
    w.net.gasEstimate = 30_000_000n;
    w.net.pendingNonce = 4_000_000;
    w.net.baseFee = 45_000_000_000n;
    await svc.tick();
    expect(w.rawBroadcasts.length).toBe(1);
    const tx = parseTransaction(hex0x(w.rawBroadcasts[0]!));
    expect(tx).toMatchObject({ chainId: 31337, to: CONTRACT, gas: ETH_FREEZE_GAS_LIMIT, maxFeePerGas: 91_000_000_000n, nonce: 4_000_000 });
    expect(tx.value ?? 0n).toBe(0n);
    expect(BigInt(w.store().attempts('ethereum', hex(s.ref))[0]!.max_fee) <= w.port.freezeReserve()).toBe(true);
    // A base fee past the operator's maximum: nothing more is signed, whatever else it says.
    w.net.baseFee = 10n ** 15n;
    w.clock.ms += 200_000;
    await passes(svc, 3, w, 200_000);
    expect(w.rawBroadcasts.every((r) => parseTransaction(hex0x(r)).maxFeePerGas! <= 100_000_000_000n)).toBe(true);
    for (const t of w.signedOrSimulated()) expect(t.calls).toEqual(['freeze']);
  });

  it.each(['solana', 'ethereum'] as const)('on %s: an endpoint that says a simulation fails, or stops answering, costs nothing and is recorded', async (chain) => {
    const w = await makeWorld(chain);
    const svc = w.service();
    const s = await watch(w, svc, { notice: 'garbage' });
    w.setTime(w.times.tNotice + 5n);
    w.net.simRefuses = true;
    await passes(svc, 2, w);
    w.net.simRefuses = false;
    w.net.readsFail = true;
    await passes(svc, 2, w);
    expect(w.rawBroadcasts).toEqual([]);
    expect(w.store().committed(chain, {})).toBe(0n);
    w.net.readsFail = false;
    await passes(svc, 4, w);
    expect(svc.status(hex(s.ref))).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: notice-invalid' });
    expect(w.rawBroadcasts.length).toBe(1);
  });
});

describe('a notice key the watcher cannot check', () => {
  it.each(['solana', 'ethereum'] as const)('on %s: with only a wrong key on file the notice does not open, which the spec calls "no lock": the watcher freezes (the documented limit of key authentication)', async (chain) => {
    // DEVIATIONS.md, W-A1: a watch request does not prove it comes from the locker. A stranger who
    // posts a wrong key for a swap whose locker never registered causes one freeze of a good lock:
    // a delay of at most W_z that the returning locker undoes with set_ready. It costs no funds.
    const w = await makeWorld(chain);
    const svc = w.service();
    const s = await w.addSwap({ notice: 'good' });
    expect((await svc.register(watchRequest({ chain, swapRef: s.ref, noticeKey: new Uint8Array(32).fill(0x66), watcherSolanaKey: w.keys.solana }))).status).toBe(200);
    w.setTime(w.times.tNotice + 5n);
    await passes(svc, 3, w);
    expect(svc.status(hex(s.ref))).toMatchObject({ status: 'frozen', reason: 'frozen by this watcher: notice-invalid' });
  });
});

describe('why the service does not send through the SDK\'s EthereumClient.send (DEVIATIONS.md, S1)', () => {
  it('reproduction: the SDK signs for whatever chain id and gas the endpoint reports, with no bound of its own', async () => {
    const { FakeEthereum } = await import('@xmrswap/sdk/testing');
    const { EthereumClient } = await import('@xmrswap/sdk');
    const { privateKeyToAccount } = await import('viem/accounts');
    const fake = new FakeEthereum(CONTRACT);
    fake.views['freeze'] = () => undefined;
    fake.chainId = 1n; // the endpoint lies about the chain
    fake.gasEstimate = 25_000_000n; // and about the gas
    const client = new EthereumClient({ transport: fake, contract: CONTRACT });
    await client.send(client.contract.freeze(new Uint8Array(32).fill(4)), privateKeyToAccount(`0x${'07'.repeat(32)}`));
    const signed = parseTransaction(fake.sentRaw[0]!);
    expect(signed.chainId).toBe(1);
    expect(signed.gas).toBe(30_000_000n);
    // The watcher's own path pins both (see "a false chain id, gas estimate, nonce or fee" above).
  });
});
