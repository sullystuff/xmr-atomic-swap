// `pnpm --filter @xmrswap/e2e stack`: the whole system on loopback for a look by hand. Prints the
// URLs and stays up until Ctrl-C. Regtest only; nothing here is a live network.
import { reapStale } from '../src/procs.js';
import { startRegtest, stopRegtest } from '../src/monero.js';
import { startWorld, stopShared } from '../src/world.js';

reapStale();
startRegtest();
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await stopShared().catch(() => undefined);
  stopRegtest();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
try {
  const w = await startWorld();
  console.log(`taker UI   ${w.ui.url}`);
  console.log(`console    ${w.maker.apiUrl}  (token ${w.maker.dir}/data/api-token)`);
  console.log(`relay      ${w.relay.url}`);
  console.log(`solana     ${w.sol.url}`);
  console.log(`ethereum   ${w.eth?.url}`);
  console.log(JSON.stringify(await w.maker.status(), null, 1).slice(0, 3000));
  if (process.env['E2E_ONCE']) await stop();
} catch (e) {
  console.error(e);
  await stop();
}
