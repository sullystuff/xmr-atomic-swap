/**
 * What the page says when something the user asked for cannot be done (the SDK's `refused`
 * reasons). Each says why, and what happens instead: a confirmed request never ends in silence.
 */
import type { Refusal } from '@xmrswap/sdk';

export interface RefusalText {
  title: string;
  text: string;
  /** Label of the disabled control that replaces the action once it would be refused. */
  control: string;
}

export function refusalText(reason: Refusal, buying: boolean): RefusalText {
  switch (reason) {
    case 'ready-already-set':
      return {
        title: 'This swap can no longer be refunded',
        text: 'Ready is already set, so this swap can no longer be refunded. The maker will claim and this tab will collect your XMR. If the maker does not claim by its deadline, the tab refunds you in full by itself.',
        control: 'Refund not possible: ready is set',
      };
    case 'refund-window-closed':
      return {
        title: 'It is too late to refund safely',
        text: 'The refund window has closed: a refund sent now could land after the maker is allowed to claim and would hand it both keys, so the tab will not send one. If the maker claims, its key becomes public and the tab collects the XMR it locked; if it locked none, your payment is lost. If the maker never claims, the tab refunds at the expiry.',
        control: 'Refund window closed',
      };
    case 'abort-window-closed':
      return {
        title: 'It is too late to abort',
        text: 'An abort is only accepted before the final deadline, which has passed. The tab carries on instead: it claims your payment if that is still possible; otherwise the maker takes its escrow back and your XMR is recovered to your refund address.',
        control: 'Abort window closed',
      };
    case 'already-settled':
      return {
        title: 'This swap is already complete',
        text: buying ? 'The maker has taken the payment, so there is nothing left to refund. Its key is public and the XMR is yours: the tab sweeps it to your address.' : 'You have been paid, so there is nothing left to cancel.',
        control: 'Already complete',
      };
    case 'cannot-exit-after-funding':
      return {
        title: 'You backed out: do not send any XMR',
        text: 'The maker has already funded this swap, and no transaction of yours can end it now. The payment address is no longer shown and you must not pay. The maker will take its escrow back; your deposit is then returned, but because you did not pay, the maker can withhold it for up to 60 days and half of it can be lost.',
        control: 'Backed out',
      };
    case 'reject-not-available':
      return { title: 'This take cannot be rejected', text: 'A pending take outside window mode cannot be rejected; it lapses by itself when the funding deadline passes, and the deposit returns in full.', control: 'Cannot be rejected' };
    case 'hold-ended':
      return { title: 'The 30-minute hold is over', text: 'A deposit can only be withheld during the 30 minutes after a refund. That time has passed, so the deposit returns to you: anyone can send the transaction, and the tab offers it.', control: 'Hold ended' };
    case 'no-deposit-held':
      return { title: 'No deposit is being held', text: 'There is no deposit in the hold or withheld for this swap, so there is nothing to collect or release. Whatever was owed to you has already been paid.', control: 'Nothing to collect' };
  }
}

export const REFUSALS: readonly Refusal[] = ['ready-already-set', 'refund-window-closed', 'abort-window-closed', 'already-settled', 'cannot-exit-after-funding', 'reject-not-available', 'hold-ended', 'no-deposit-held'];
