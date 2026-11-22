/** A daemon over the in-memory fakes: the real wiring, a real SQLite file, real cryptography, no sockets. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, x25519Public } from '@xmrswap/core-wasm';
import { Daemon, type DaemonOptions } from '../src/daemon.js';
import { Keystore } from '../src/keystore/index.js';
import type { PriceSourceClient } from '../src/pricing/sources.js';
import type { CrashHook } from '../src/store/journal.js';
import { FakeMonero, SimSolana } from './sim.js';

const fill = (n: number) => new Uint8Array(32).fill(n);
export const ENC_SECRET_V1 = fill(0x31);

export const BASE_TOML = `
[daemon]
mode = "live"

[solana]
maker_owner = "__OWNER__"
rpc_url_env = "TEST_SOL_RPC"

[monero]
network = "regtest"
node_url_envs = ["TEST_XMR_A", "TEST_XMR_B"]

[pricing]
refresh_seconds = 1
max_age_seconds = 600

[markets.sol.sell_xmr]
enabled = true
min_xmr = 0.1
max_xmr = 20
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[markets.usdc_sol.buy_xmr]
enabled = true
min_xmr = 0.1
max_xmr = 20
confirmation_depth = [{ above_xmr = 0, depth = 2 }]

[liquidity]
output_ladder = [{ size_xmr = 5, count = 4 }]
`;

export interface World {
  dir: string;
  configPath: string;
  sim: SimSolana;
  xmr: FakeMonero;
  log: string[];
  keystore: Keystore;
  prices: { xmr: number; sol: number; eth: number };
  /** Start (or restart) the daemon on the same data directory and the same chain. */
  boot(extra?: Partial<DaemonOptions> & { crash?: CrashHook }): Promise<Daemon>;
}

export async function makeWorld(toml: string = BASE_TOML, opts: { outputs?: bigint[] } = {}): Promise<World> {
  await init();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xmrswap-daemon-test-'));
  const keystore = new Keystore({ seed: fill(77), solanaOperator: fill(3), ethereumOperator: fill(12) });
  const log: string[] = [];
  const sim = new SimSolana(keystore.solana.publicKey, x25519Public(ENC_SECRET_V1), log);
  const xmr = new FakeMonero(log);
  for (const amount of opts.outputs ?? [5_050_000_000_000n, 5_050_000_000_000n, 5_050_000_000_000n, 5_050_000_000_000n]) xmr.addOutput(amount);
  const configPath = path.join(dir, 'maker.toml');
  writeFileSync(configPath, toml.replaceAll('__OWNER__', sim.owner));
  const prices = { xmr: 150, sol: 100, eth: 3000 };
  const source = (name: 'coingecko' | 'coinmarketcap'): PriceSourceClient => ({ name, fetch: async () => ({ ...prices }) });
  let clock = 0;
  const w: World = {
    dir, configPath, sim, xmr, log, keystore, prices,
    async boot(extra = {}) {
      const d = await Daemon.create({
        configPath, dataDir: dir, keystore, solanaTransport: sim.fake, solanaBlockHeight: async () => sim.blockHeight, wallet: xmr, monero: xmr, broadcaster: xmr,
        priceSources: { coingecko: source('coingecko'), coinmarketcap: source('coinmarketcap') }, timers: false, env: () => undefined, now: () => Number(sim.now) + clock++ * 0, ...extra,
      });
      // The first encryption key is the one the registry already shows (registered before the test starts).
      if (!d.store.encKey(1) || d.store.encKey(1)!.public_key !== Buffer.from(x25519Public(ENC_SECRET_V1)).toString('hex')) {
        d.store.deleteEncKeyRow(1);
        d.encKeys.ensure(1, ENC_SECRET_V1);
      }
      d.encKeys.markPublished(1);
      return d;
    },
  };
  return w;
}
