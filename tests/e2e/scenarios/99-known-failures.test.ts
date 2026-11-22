// KNOWN FAILURES: each test reproduces a bug in another package that this suite found and that
// tests/e2e/BUGS.md records. The body states the correct behaviour at full strength. While the bug
// exists the body throws and the test is reported as an expected failure, apart from the ordinary
// scenarios; when it stops throwing the test fails, so the fix is noticed (scenarios/known.ts).
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { type TakerTab, openTab, text } from '../src/ui.js';
import { type World, startWorld, stopShared } from '../src/world.js';
import { balances, readSwap, swapState, track, uiLockBuy, untilPhase, untilState } from './helpers.js';
import { knownFailure } from './known.js';

let w: World;
let tab: TakerTab;
beforeAll(async () => {
  w = await startWorld({ ethereum: false, inventoryBlocks: 8 });
  tab = track(await openTab({ solKey: w.sol.taker }), true);
});
afterAll(async () => {
  await tab?.close().catch(() => undefined);
  await w?.stop();
  await stopShared();
});

describe('KNOWN FAILURES (bugs in other packages; see tests/e2e/BUGS.md)', () => {
  knownFailure('BUG-1', 'packages/sdk takerStep: "Refund this swap" confirmed by the user after the XMR lock is confirmed must refund (A10b); instead the request is ignored and the tab later sets ready', async () => {
    const { page } = tab;
    const before = (await balances(w, 'sol')).taker;
    const { ref } = await uiLockBuy(tab, w, { market: 'sol', xmr: '0.4' });
    await untilPhase(w, ref, 'xmr_relayed');
    await w.mine(2);
    // The lock is at depth on both nodes; the contract's minimum wait for ready is still running (Solana time stands still here).
    await text(page, /2 of 2 confirmations on every node/).waitFor({ timeout: 90_000 });
    expect(await swapState(w, ref)).toBe('NOTICED');
    const s0 = (await readSwap(w, ref))!;
    await page.getByRole('button', { name: 'Refund this swap' }).click();
    // The page states what will happen and asks once more.
    await text(page, /You get .+ SOL back now\. The deposit of .+ SOL is held for 30 minutes/).waitFor();
    await page.getByRole('button', { name: 'Yes, refund' }).click();
    // Row 4 of the refund table (A10b): amount − D at once, the deposit in the hold.
    await untilState(w, ref, 'HOLD', 30_000);
    const out = before - (await balances(w, 'sol')).taker;
    expect(out >= s0.deposit && out < s0.deposit + 10_000_000n).toBe(true);
  });
});
