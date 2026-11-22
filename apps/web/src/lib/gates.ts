/**
 * Why a lock button is disabled. Every reason is shown under the button; an empty list is the
 * only way it becomes clickable, and the first click only opens the confirmation (SPEC 8.5
 * items 1 and 2). `App.openSwap` re-checks the backup and the tick, so the gate cannot be
 * bypassed by a stale screen.
 */
import type { ChainName } from '@xmrswap/protocol';
import { type Settings, settingsProblems } from './settings.js';

export interface GateInput {
  backedUp: boolean;
  chain: ChainName;
  walletConnected: boolean;
  settings: Settings;
  /** A problem with what the user typed (amount, address), or `null`. */
  inputError: string | null;
  /** Why the offer cannot be locked against, or `null`. */
  offerProblem: string | null;
  /** The offer needs an advance approval and none that is valid is stored. */
  approvalMissing?: boolean;
}

export const BACKUP_BLOCKER = 'Save your recovery file first. Without it, a closed tab or a lost browser means your funds cannot be refunded or collected.';

export function lockBlockers(i: GateInput): string[] {
  const out: string[] = [];
  if (!i.backedUp) out.push(BACKUP_BLOCKER);
  if (i.inputError) out.push(i.inputError);
  if (i.offerProblem) out.push(i.offerProblem);
  for (const p of settingsProblems(i.settings)) {
    if (p.field === 'moneroNodes' || p.field === 'solanaRpc' || (i.chain === 'ethereum' && (p.field === 'ethereumRpc' || p.field === 'contract'))) out.push(p.message);
  }
  if (i.chain === 'ethereum' && !i.settings.ethereumRpc) out.push('Set an Ethereum RPC URL in Settings.');
  if (i.approvalMissing) out.push('This maker only swaps with takers it approved in advance. Ask for an approval on the maker page.');
  if (!i.walletConnected) out.push(`Connect your ${i.chain === 'solana' ? 'Solana' : 'Ethereum'} wallet. It signs the lock; every later step is signed in this page.`);
  return out;
}
