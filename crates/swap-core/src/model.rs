//! The pure reference model of the state machine of SPEC 3 and 11.
//!
//! One escrow machine serves both directions and both chains. This module has no I/O and no
//! cryptography: a secret is modelled as "it opens the commitment or it does not", evidence as
//! "it opens the notice commitment or it does not", the open hash of SPEC 3.12 as "it matches
//! or it does not", an address as "the taker's own, another, or invalid". The Solana program
//! and the Ethereum contract MUST behave exactly as [`apply`] does; `transitions.json` is
//! generated from it.
//!
//! The rules themselves are in the dependency-free `escrow-logic` crate (SPEC 11.4), which the
//! Solana program links directly: [`escrow_logic::machine::gate`] decides a call,
//! [`escrow_logic::machine::plan`] says who is paid, [`escrow_logic::machine::execute`] applies
//! it. This module re-exports its types under the names the model has always used and adds what
//! needs allocation: [`Effects`] with a `Vec` of payouts, and [`MakerRecord`].
//!
//! Conventions fixed by the model because the specification leaves them open (SPEC 3.13; also
//! recorded in `docs/research/wp1-deviations.md` and `a1-deviations.md`):
//!
//! * **Check order**: direction, caller, state, open hash, time gate, then secret, evidence or
//!   watcher. For `lock`/`take`: state, caller, pause, mode, approval, bounds, amount, payout,
//!   watcher, caps, `MAX_OPEN_PENDING`.
//! * **`TooEarly` or `TooLate`**: when a call is refused only because of the time, it is
//!   `TooLate` if some window of that call in that state has already closed, else `TooEarly`.
//! * **"Closed" rows** (A3, A4, A5, A7a, A8, B2, B3, B4) end in `Done` with
//!   [`Effects::closed`] set when nothing was parked. Solana then closes the account in the same
//!   instruction; Ethereum never deletes a swap.
//! * A payout of zero is not a payout: it is neither paid nor parked and does not appear.

pub use escrow_logic::caps::Caps;
pub use escrow_logic::machine::{
  counter, deposit_state, flag, gate, mode, plan, Call, Direction, Env, Evidence, GateError as ModelError, OpenArgs, Party,
  Pay, Payout, PayoutArg, PayoutTo, Plan, RejectReason, Role, Row, State, Swap as SwapState,
};

use crate::amounts::ChainConsts;

/// Everything a successful call does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effects {
  /// The swap after the call, including every `t_*` field and the `owed_*` balances.
  pub state: SwapState,
  pub payouts: Vec<Payout>,
  /// Funds this call moved into escrow (`lock`: `amount`; `take`: the deposit; `fund`: `amount`).
  pub escrow_in: u128,
  /// The one counter this transition increments, if any.
  pub counter: Option<u8>,
  /// `now − t_lock`, added to `response_secs_sum` (approve, fund).
  pub response_secs: Option<u64>,
  /// Added to `volume[asset]` (claims).
  pub volume: u128,
  /// Added to `withheld_volume[asset]` (withhold).
  pub withheld_volume: u128,
  /// Change of the maker's `open_pending`: +1, 0 or −1.
  pub open_pending: i8,
  /// The row is marked "closed" in SPEC 3.4/3.5 and nothing was parked: Solana closes the swap
  /// account in the same instruction.
  pub closed: bool,
  /// The asset's open value after the call (SPEC 11.1).
  pub open_value_after: u128,
}
impl From<escrow_logic::machine::Effects> for Effects {
  fn from(fx: escrow_logic::machine::Effects) -> Self {
    Effects {
      state: fx.state,
      payouts: fx.payouts.as_slice().to_vec(),
      escrow_in: fx.escrow_in,
      counter: fx.counter,
      response_secs: fx.response_secs,
      volume: fx.volume,
      withheld_volume: fx.withheld_volume,
      open_pending: fx.open_pending,
      closed: fx.closed,
      open_value_after: fx.open_value_after,
    }
  }
}

/// Apply one call. `state` is [`SwapState::NONE`] for [`Call::Open`].
pub fn apply(
  state: SwapState,
  call: Call,
  caller: Role,
  now: i64,
  env: &Env,
  consts: &ChainConsts,
) -> Result<Effects, ModelError> {
  escrow_logic::machine::apply(&state, &call, caller, now, env, consts).map(Effects::from)
}

/// A maker's counters and totals (SPEC 3.7). Every update saturates and can never fail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MakerRecord {
  pub counters: [u32; counter::COUNT],
  pub response_secs_sum: u64,
  pub volume: u128,
  pub withheld_volume: u128,
  pub open_pending: u16,
}
impl Default for MakerRecord {
  fn default() -> Self {
    MakerRecord { counters: [0; counter::COUNT], response_secs_sum: 0, volume: 0, withheld_volume: 0, open_pending: 0 }
  }
}
impl MakerRecord {
  /// Record a transition. `max_total` is the largest value the chain's volume type holds.
  pub fn record(&mut self, fx: &Effects, max_total: u128) {
    if let Some(c) = fx.counter {
      let slot = &mut self.counters[c as usize];
      *slot = slot.saturating_add(1);
    }
    if let Some(secs) = fx.response_secs {
      self.response_secs_sum = self.response_secs_sum.saturating_add(secs);
    }
    self.volume = self.volume.saturating_add(fx.volume).min(max_total);
    self.withheld_volume = self.withheld_volume.saturating_add(fx.withheld_volume).min(max_total);
    self.open_pending = match fx.open_pending {
      1 => self.open_pending.saturating_add(1),
      -1 => self.open_pending.saturating_sub(1),
      _ => self.open_pending,
    };
  }
}

/// Whether a call would succeed. Used by the property tests and by clients that grey out
/// buttons.
pub fn enabled(state: &SwapState, call: Call, caller: Role, now: i64, consts: &ChainConsts) -> bool {
  apply(*state, call, caller, now, &Env::OK, consts).is_ok()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::amounts::SOLANA;

  #[test]
  fn names_cover_every_assigned_counter() {
    assert_eq!(counter::NAMES.len(), 37);
    assert_eq!(counter::NAMES[counter::CLAIMS_AFTER_FREEZE as usize], "claims_after_freeze");
    assert_eq!(counter::NAMES[counter::FREEZES as usize], "freezes");
    assert_eq!(counter::NAMES[counter::REJECTIONS_NO_FAULT as usize], "rejections_no_fault");
    assert_eq!(counter::NAMES[counter::SPLITS as usize], "splits");
    assert_eq!(counter::NAMES[counter::COMPLETED as usize], "completed");
  }

  #[test]
  fn counters_saturate_and_never_fail() {
    let mut m = MakerRecord::default();
    m.counters[counter::COMPLETED as usize] = u32::MAX;
    m.response_secs_sum = u64::MAX - 1;
    m.volume = u64::MAX as u128 - 5;
    let fx = Effects {
      state: SwapState::NONE,
      payouts: vec![],
      escrow_in: 0,
      counter: Some(counter::COMPLETED),
      response_secs: Some(10),
      volume: 100,
      withheld_volume: 0,
      open_pending: -1,
      closed: false,
      open_value_after: 0,
    };
    m.record(&fx, SOLANA.max_amount);
    assert_eq!(m.counters[counter::COMPLETED as usize], u32::MAX);
    assert_eq!(m.response_secs_sum, u64::MAX);
    assert_eq!(m.volume, u64::MAX as u128);
    assert_eq!(m.open_pending, 0);
  }

  #[test]
  fn nothing_happens_to_a_swap_that_does_not_exist() {
    for call in [Call::CancelPending, Call::Refund { secret_ok: true }, Call::Claim { secret_ok: true }, Call::ReleaseDeposit] {
      assert_eq!(apply(SwapState::NONE, call, Role::TakerWallet, 0, &Env::OK, &SOLANA), Err(ModelError::BadState));
    }
  }
}
