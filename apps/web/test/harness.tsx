// A whole `App` over the test doubles, and the real React tree rendered on top of it.
import { act, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { App, type LegRequest, type ProgramBuild } from '../src/lib/app.js';
import type { ServedRelease } from '../src/lib/release.js';
import { Root } from '../src/App.js';
import type { OfferRow, RegistrySnapshot, UpgradeStatus } from '../src/lib/market.js';
import type { Settings } from '../src/lib/settings.js';
import { MemoryKV } from '../src/lib/storage.js';
import { createRecoveryFile, hex, writeRecoveryFile } from '@xmrswap/sdk';
import { FakeMonero, ModelChain, TAKER, TAKER_SEED, fakeGuardEnv, row } from './fakes.js';

/** Put the test seed in the tab's storage without any backup: what a reload finds when the file was never confirmed as saved. */
export function seedWithoutBackup(): void {
  sessionStorage.setItem('xmrswap.seed', hex(TAKER_SEED));
}

export const DEST = `4${'A'.repeat(94)}`;
const live: App[] = [];
afterEach(() => {
  for (const a of live.splice(0)) a.stop();
});

export interface Rig {
  app: App;
  chain: ModelChain;
  monero: FakeMonero;
  env: ReturnType<typeof fakeGuardEnv>;
  kv: MemoryKV;
  rows: OfferRow[];
  /** Legs the opener was asked to open, in order. */
  opened: { offer: string; xmr: bigint; payout?: string; watcher?: string | null }[];
  /** The requests exactly as the opener received them. */
  requests: LegRequest[];
  /** Make the next open fail with this message (the wallet refused, the offer changed). */
  failOpen: { message: string | null };
  /** One engine pass plus a guard update, inside `act`. */
  pass(): Promise<void>;
  connect(): Promise<void>;
  /** Load the recovery file of the seed the test chain's swaps were opened with: the backup exists. */
  backup(): void;
}

export function makeRig(o: { rows?: OfferRow[]; chain?: ModelChain; kv?: MemoryKV; upgrade?: UpgradeStatus; settings?: Partial<Settings>; wakeLock?: boolean; makerProof?: NonNullable<ConstructorParameters<typeof App>[0]['makerProof']>; caps?: RegistrySnapshot['caps']; release?: ServedRelease; programBuild?: ProgramBuild; extra?: Partial<ConstructorParameters<typeof App>[0]> } = {}): Rig {
  const chain = o.chain ?? new ModelChain();
  const monero = new FakeMonero();
  const env = fakeGuardEnv(o.wakeLock === false ? { wakeLock: false } : {});
  const kv = o.kv ?? new MemoryKV();
  const rows = o.rows ?? [row(1)];
  const opened: Rig['opened'] = [];
  const requests: LegRequest[] = [];
  const failOpen: Rig['failOpen'] = { message: null };
  const app = new App({
    kv,
    guardEnv: env,
    deployment: { solanaRpc: 'http://127.0.0.1:9', moneroNodes: ['http://node-a.test', 'http://node-b.test'], pollMs: 3_600_000, mode: 'onchain', ...o.settings },
    ports: () => ({ [chain.chain]: chain }),
    ...(o.makerProof ? { makerProof: o.makerProof } : {}),
    monero,
    readRegistry: async () => ({ makers: rows.map((r) => r.maker), rows, discarded: [], caps: o.caps ?? {}, now: { solana: chain.now_, ethereum: null } }),
    fetchRelease: async () => o.release ?? null,
    programBuild: async () => o.programBuild ?? { status: 'unpublished', hash: 'ab'.repeat(32), published: null },
    ...(o.extra ?? {}),
    upgrade: async () => ({ solana: o.upgrade ?? { frozen: false, authority: 'UpgradeAuthority1111' }, ethereum: { frozen: null, authority: null } }),
    openLegs: async (legs) => {
      if (failOpen.message) {
        const m = failOpen.message;
        failOpen.message = null;
        return { opened: legs.map(() => null), errors: legs.map(() => m) };
      }
      return {
        opened: legs.map((l) => {
          opened.push({ offer: l.row.id, xmr: l.xmr });
          requests.push(l);
          return chain.open({ xmr: l.xmr, price: l.row.basePrice, makerPda: l.row.maker.pda, mode: l.row.mode, direction: l.row.direction, depBps: l.row.depBps, wZ: l.row.freezeWindow, dC: l.row.claimDelay, ...(l.payout ? { payout: l.payout } : {}), ...(l.watcher ? { watcher: l.watcher } : {}) }).view;
        }),
        errors: legs.map(() => null),
      };
    },
  });
  live.push(app);
  return {
    app,
    chain,
    monero,
    env,
    kv,
    rows,
    opened,
    requests,
    failOpen,
    async pass() {
      await act(async () => {
        await app.engine.poll();
        app.guard.update(app.engine.getState(), app.safety());
      });
    },
    async connect() {
      await act(async () => {
        app.setWallet('solana', { address: TAKER, signTransaction: async (tx) => tx });
        if (chain.chain === 'ethereum') app.setWallet('ethereum', { address: TAKER as `0x${string}`, sendTransaction: async () => '0x' });
      });
    },
    backup() {
      act(() => {
        app.vault.load(writeRecoveryFile(createRecoveryFile({ seed: TAKER_SEED, programId: app.settings.get().programId, contract: '' })));
      });
    },
  };
}

/** Start the app and render the real tree at a route. */
export async function mount(rig: Rig, hash = '#/') {
  window.location.hash = hash;
  await act(async () => {
    await rig.app.start();
  });
  const view = render(<Root app={rig.app} />);
  await rig.connect();
  await rig.pass();
  return view;
}
