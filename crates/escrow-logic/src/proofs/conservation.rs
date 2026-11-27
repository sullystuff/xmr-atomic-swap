//! Group `conservation`: for every row that moves funds, payouts paid plus parked plus what
//! stays held equals what the swap escrowed; nothing is paid to a party the row does not name;
//! the deposit never reaches the maker. Over sequences: total paid and parked never exceeds
//! what was locked, and no portion leaves twice.

use crate::{amounts::split_of, machine::*};

use super::*;

/// One step, every record: nothing is created, lost or paid twice.
///
/// * the stake of the state: `stake(before) + escrow_in == stake(after) + paid + parked`;
/// * each parked balance grows by exactly what the step parked for that party and by nothing
///   else, and a balance that leaves (`withdraw_owed`, `pushOwed`) leaves whole, once, to its
///   own party, while the stake stands still.
///
/// Summing the two lines gives `held(before) + escrow_in == held(after) + paid`, with
/// `held = stake + owed_taker + owed_maker + owed_treasury`; the SAT solver is given the two
/// lines instead of the sum because it cannot reorder five 128-bit additions (the sequence
/// harness at the end of this file checks the sum itself, on a narrow width). The harnesses below cover every call between them, one group each.
fn step_conserves(call: Call) {
  let c = any_consts();
  let s = any_swap(c);
  let env = any_env();
  if let Ok(fx) = apply(&s, &call, kani::any(), any_time(), &env, c) {
    let n = fx.state;
    let parked_for = |who: Party| {
      let mut sum = 0u128;
      let mut i = 0;
      while i < fx.payouts.len() {
        let p = fx.payouts.as_slice()[i];
        // The payout address's balance is kept in `owed_taker`.
        let slot = if matches!(p.to, Party::Payout) { Party::Taker } else { p.to };
        if p.parked && slot == who {
          sum += p.amount;
        }
        i += 1;
      }
      sum
    };
    let mut i = 0;
    while i < fx.payouts.len() {
      assert!(fx.payouts.as_slice()[i].amount != 0);
      i += 1;
    }
    if matches!(call, Call::WithdrawOwed(_) | Call::PushOwed(_)) {
      // One balance leaves whole; nothing else moves.
      assert!(stake(&n) == stake(&s) && n.state == s.state && fx.escrow_in == 0);
      assert!(fx.payouts.len() == 1 && !fx.payouts.as_slice()[0].parked);
      let (who, amount) = (fx.payouts.as_slice()[0].to, fx.payouts.as_slice()[0].amount);
      match who {
        Party::Taker | Party::Payout => assert!(amount == s.owed_taker && n.owed_taker == 0 && n.owed_maker == s.owed_maker && n.owed_treasury == s.owed_treasury),
        Party::Maker => assert!(amount == s.owed_maker && n.owed_maker == 0 && n.owed_taker == s.owed_taker && n.owed_treasury == s.owed_treasury),
        Party::Treasury => assert!(amount == s.owed_treasury && n.owed_treasury == 0 && n.owed_taker == s.owed_taker && n.owed_maker == s.owed_maker),
      }
    } else {
      let out = fx.payouts.total_for(Party::Taker) + fx.payouts.total_for(Party::Maker) + fx.payouts.total_for(Party::Treasury) + fx.payouts.total_for(Party::Payout);
      assert!(stake(&s) + fx.escrow_in == stake(&n) + out);
      assert!(n.owed_taker == s.owed_taker + parked_for(Party::Taker));
      assert!(n.owed_maker == s.owed_maker + parked_for(Party::Maker));
      assert!(n.owed_treasury == s.owed_treasury + parked_for(Party::Treasury));
    }
    // Only fund brings funds in after the open, and it brings the amount.
    assert!(fx.escrow_in == if matches!(call, Call::Fund { .. }) { s.amount } else { 0 });
    // The amounts the stake is made of never change.
    assert!(n.amount == s.amount && n.deposit == s.deposit && n.direction == s.direction && n.fee_bps == s.fee_bps);
  }
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn pending_rows_conserve_the_escrow() {
  let call = any_call();
  kani::assume(matches!(call, Call::Approve { .. } | Call::Fund { .. } | Call::Reject { .. } | Call::CancelPending | Call::ExpirePending));
  step_conserves(call);
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn notice_ready_freeze_and_abort_conserve_the_escrow() {
  let call = any_call();
  kani::assume(matches!(call, Call::PostNotice | Call::SetReady | Call::Freeze | Call::Abort | Call::RefundUnnoticed | Call::ExpireUnnoticed | Call::PublishEvidence { .. }));
  step_conserves(call);
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn refunds_conserve_the_escrow() {
  let secret_ok: bool = kani::any();
  step_conserves(Call::Refund { secret_ok });
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn claims_conserve_the_escrow() {
  let secret_ok: bool = kani::any();
  step_conserves(Call::Claim { secret_ok });
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn deposit_rows_conserve_the_escrow() {
  let call = any_call();
  kani::assume(matches!(call, Call::ReleaseDeposit | Call::Withhold(_) | Call::SplitDeposit));
  step_conserves(call);
}

#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn parked_balances_conserve_the_escrow() {
  let call = any_call();
  kani::assume(matches!(call, Call::WithdrawOwed(_) | Call::PushOwed(_)));
  step_conserves(call);
}

/// One step, every record: who may be paid by which call, and how much.
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn nobody_is_paid_who_the_row_does_not_name() {
  let c = any_consts();
  let s = any_swap(c);
  let call = any_call();
  let env = any_env();
  if let Ok(fx) = apply(&s, &call, kani::any(), any_time(), &env, c) {
    let to = |p: Party| fx.payouts.total_for(p);
    let (taker, maker, treasury, payout) = (to(Party::Taker), to(Party::Maker), to(Party::Treasury), to(Party::Payout));
    let is_a = s.is_a();
    match call {
      // Pending exits, the keyless refund and a returned deposit pay the taker and nobody else.
      Call::Reject { .. } | Call::CancelPending | Call::ExpirePending | Call::RefundUnnoticed | Call::ReleaseDeposit => {
        assert!(maker == 0 && treasury == 0 && payout == 0);
        assert!(taker == if matches!(call, Call::RefundUnnoticed) { s.amount } else if matches!(call, Call::ReleaseDeposit) || !is_a { s.deposit } else { s.amount });
      }
      // An abort before the notice returns the amount; later aborts move nothing.
      Call::Abort => assert!(maker == 0 && treasury == 0 && payout == 0 && (taker == 0 || taker == s.amount)),
      Call::ExpireUnnoticed => assert!(taker == s.deposit && maker == s.amount && treasury == 0 && payout == 0),
      // A refund returns the locker's escrow to the locker; the deposit goes to the taker now
      // or stays held; the maker never receives more than the amount it funded.
      Call::Refund { .. } => {
        assert!(treasury == 0 && payout == 0);
        if is_a {
          assert!(maker == 0 && (taker == s.amount || taker == s.amount - s.deposit));
        } else {
          assert!(maker == s.amount && (taker == 0 || taker == s.deposit));
        }
      }
      // A claim pays the claimer's side and the fee, never the locker.
      Call::Claim { .. } => {
        assert!(treasury <= s.amount);
        if is_a {
          assert!(taker == 0 && payout == 0 && maker + treasury == s.amount);
        } else {
          assert!(maker == 0);
          // SPEC 11.2: to the payout address and to no other, when one is named.
          if matches!(s.payout, PayoutTo::Other) {
            assert!(taker == 0 && payout + treasury == s.amount + s.deposit);
          } else {
            assert!(payout == 0 && taker + treasury == s.amount + s.deposit);
          }
        }
      }
      Call::SplitDeposit => {
        let (t, r) = split_of(s.deposit);
        assert!(taker == t && treasury == r && maker == 0 && payout == 0);
      }
      Call::WithdrawOwed(who) | Call::PushOwed(who) => {
        // A parked balance leaves for the party it is owed to, whoever calls.
        assert!(fx.payouts.len() == 1 && fx.payouts.as_slice()[0].to == who && !fx.payouts.as_slice()[0].parked);
        assert!(matches!(who, Party::Payout) == s.payout_owed() || !matches!(who, Party::Taker | Party::Payout));
      }
      // Everything else moves no funds.
      Call::Approve { .. } | Call::Fund { .. } | Call::PostNotice | Call::SetReady | Call::Freeze | Call::Withhold(_) | Call::PublishEvidence { .. } => {
        assert!(fx.payouts.is_empty());
      }
      Call::Open(_) => unreachable!(),
    }
    // The payout address exists only on a direction-B swap that named one.
    if payout != 0 {
      assert!(!is_a && matches!(s.payout, PayoutTo::Other));
    }
  }
}

/// The deposit never reaches the maker: once a swap is in HOLD or WITHHELD (only the deposit is
/// left), no call pays or parks anything for the maker, its payout address or its operator.
/// The only maker-side payment possible is a balance parked earlier.
#[kani::proof]
#[kani::unwind(3)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
fn the_deposit_never_reaches_the_maker() {
  let c = any_consts();
  let s = any_swap(c);
  kani::assume(matches!(s.state, State::Hold | State::Withheld));
  let call = any_call();
  let env = any_env();
  if let Ok(fx) = apply(&s, &call, kani::any(), any_time(), &env, c) {
    if !matches!(call, Call::WithdrawOwed(Party::Maker) | Call::PushOwed(Party::Maker)) {
      assert!(fx.payouts.total_for(Party::Maker) == 0);
      assert!(fx.state.owed_maker == s.owed_maker);
    } else {
      assert!(fx.payouts.total_for(Party::Maker) == s.owed_maker);
    }
    // Destinations of the deposit: the taker and the treasury.
    assert!(fx.payouts.total_for(Party::Payout) == 0 || matches!(call, Call::WithdrawOwed(Party::Payout) | Call::PushOwed(Party::Payout)));
  }
}

/// Sequences (a bounded cross-check of the single-step harnesses above, which by induction on
/// the calls give the same without any bound): open, then eight symbolic calls by symbolic
/// callers at non-decreasing symbolic times, with destinations that can or cannot receive at
/// every step. The ledger (funds in minus funds paid out) never goes negative and after every
/// call equals what the record says is held. So the total paid never exceeds the total locked,
/// no portion leaves twice, and a settled swap with nothing parked holds nothing.
/// **Amounts below 2^12**: the ledger is a sum the solver cannot carry at full width over eight
/// calls (at this width they take about a quarter of an hour).
#[kani::proof]
#[kani::unwind(9)]
#[kani::stub(crate::amounts::fee_of, super::any_share)]
#[kani::stub(crate::amounts::deposit_of, super::any_share)]
fn sequences_of_8_never_pay_more_than_was_locked_u12() {
  let c = any_consts();
  let args: OpenArgs = kani::any();
  kani::assume(args.amount < (1 << 12));
  let mut now = 0i64;
  let fx = match open(&Swap::NONE, &args, Role::TakerWallet, now, &Env::OK, c) {
    Ok(fx) => fx,
    Err(_) => return,
  };
  let mut s = fx.state;
  let mut ledger = fx.escrow_in;
  assert!(ledger == held(&s));
  let mut i = 0;
  while i < 8 {
    i += 1;
    let call = any_call();
    let at = any_time();
    kani::assume(at >= now);
    now = at;
    let env = any_env();
    if let Ok(fx) = apply(&s, &call, kani::any(), at, &env, c) {
      ledger += fx.escrow_in;
      let out = fx.payouts.paid();
      assert!(out <= ledger);
      ledger -= out;
      s = fx.state;
      assert!(ledger == held(&s));
    }
  }
}
