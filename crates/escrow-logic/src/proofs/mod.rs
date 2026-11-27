//! Kani proof harnesses (SPEC 11.4). `cargo kani -p escrow-logic`; see `KANI.md` for the table
//! of harnesses, their bounds and their last results.
//!
//! Conventions:
//!
//! * A *single-step* harness takes a fully symbolic swap record ([`any_swap`]), call, caller and
//!   time. The record is constrained only by [`sane`], which states the ranges the on-chain
//!   types and the opening checks guarantee, never by reachability, so what is proved holds for
//!   every record, reachable or not, unless the harness says it assumes an invariant.
//! * Properties of whole runs are proved by **induction**: a harness shows that `lock`/`take`
//!   establish an invariant, another that every call preserves it for every record that has it.
//!   That covers any number of calls and swaps. The *sequence* harnesses SPEC 11.4 asks for
//!   (open with symbolic in-bounds arguments, then symbolic calls by symbolic callers at
//!   non-decreasing symbolic times) are kept as bounded cross-checks; their bounds are in their
//!   names.
//! * `fee_of` and `deposit_of` are replaced by "any value not above the amount" in the
//!   state-machine harnesses (Kani stubbing): the solver cannot carry a 128-bit multiply-divide
//!   through the machine. `arith::fee_and_deposit_never_exceed_the_amount` proves that contract
//!   for the real function at every share the machine can pass it (the fee constant and any
//!   deposit share within `MAX_DEPOSIT_BPS`), so the replacement only widens what is checked.
//! * The solver is the SAT solver Kani ships (CaDiCaL). It cannot reorder long sums or relate a
//!   product to its factors at 128 bits; where a harness needs that, it is narrowed and the
//!   width is in its name. `KANI.md` lists what that leaves unproven.

use crate::{
  bounds::{ChainConsts, ETHEREUM, SOLANA},
  machine::*,
};

mod arith;
mod conservation;
mod encodings;
mod exits;
mod freeze;
mod switches;
mod windows;

/// Amounts in the state-machine harnesses stay below this, so that the sums a harness itself
/// forms (escrow ledgers of up to five terms) cannot wrap `u128`. It covers every `u64` amount
/// (all of Solana) and every Ethereum amount below 2^124 base units.
pub const AMOUNT_BOUND: u128 = 1 << 124;
/// Times stay within ±2^40 seconds of the epoch (34,000 years), so deadline sums cannot wrap.
pub const TIME_BOUND: i64 = 1 << 40;

/// Either chain's constants.
pub fn any_consts() -> &'static ChainConsts {
  if kani::any() {
    &SOLANA
  } else {
    &ETHEREUM
  }
}

pub fn any_time() -> i64 {
  let t: i64 = kani::any();
  kani::assume(t >= -TIME_BOUND && t <= TIME_BOUND);
  t
}

/// The ranges every on-chain record satisfies by its types and by the opening checks:
/// times within [`TIME_BOUND`]; amounts within [`AMOUNT_BOUND`] and the chain's amount type;
/// the deposit at most the amount in direction A (it is a share of it) and `amount + deposit`
/// within the amount type in direction B (the counted value, checked at `take`); the fee share
/// the chain's constant, as `lock`/`take` write it.
pub fn sane(s: &Swap, c: &ChainConsts) -> bool {
  let t_ok = |t: i64| t >= -TIME_BOUND && t <= TIME_BOUND;
  let a_ok = |a: u128| a < AMOUNT_BOUND && a <= c.max_amount;
  t_ok(s.t_lock)
    && t_ok(s.t_pending_deadline)
    && t_ok(s.t_active)
    && t_ok(s.t_note_deadline)
    && t_ok(s.t_notice)
    && t_ok(s.t_cut)
    && t_ok(s.t_claim_open)
    && t_ok(s.t_ready)
    && t_ok(s.t_claim_deadline)
    && t_ok(s.t_final)
    && t_ok(s.t_refund)
    && t_ok(s.t_settled)
    && t_ok(s.t_freeze)
    && a_ok(s.amount)
    && a_ok(s.deposit)
    && a_ok(s.owed_taker)
    && a_ok(s.owed_maker)
    && a_ok(s.owed_treasury)
    && s.fee_bps == c.fee_bps
    && if s.is_a() { s.deposit <= s.amount } else { s.amount + s.deposit <= c.max_amount }
}

/// A fully symbolic swap record that exists (state is not NONE), within [`sane`].
pub fn any_swap(c: &ChainConsts) -> Swap {
  let s: Swap = kani::any();
  kani::assume(!matches!(s.state, State::None));
  kani::assume(sane(&s, c));
  s
}

/// [`any_swap`] with every amount below `2^bits`: for the harnesses whose own bookkeeping (sums
/// of several amounts in an order other than the machine's) is beyond the SAT solver at full
/// width. The bound is in the harness name.
pub fn any_swap_below(c: &ChainConsts, bits: u32) -> Swap {
  let s = any_swap(c);
  let limit = 1u128 << bits;
  kani::assume(s.amount < limit && s.deposit < limit && s.owed_taker < limit && s.owed_maker < limit && s.owed_treasury < limit);
  s
}

/// The escrowed stake of the swap's state, without parked balances.
pub fn stake(s: &Swap) -> u128 {
  match (s.state, s.is_a()) {
    (State::None | State::Done, _) => 0,
    (State::Pending, true) => s.amount,
    (State::Pending, false) => s.deposit,
    (State::Hold | State::Withheld, _) => s.deposit,
    // ACTIVE, NOTICED, READY, FROZEN, ABORTED_*: the whole escrow.
    (_, true) => s.amount,
    (_, false) => s.amount + s.deposit,
  }
}

/// The deadline order of SPEC 3.2 and 11.6 as an invariant of the record: what `lock`/`take`
/// establish from the accepted bounds and every later call preserves
/// (`exits::open_establishes_the_deadline_order`, `exits::every_step_keeps_the_deadline_order`).
/// Stated on stored fields only. `T_nl = T_final − D_c − W_z − W_c − 86,400`.
pub fn deadline_order(s: &Swap, c: &ChainConsts) -> bool {
  use crate::bounds::{delta_cut, freeze_window_ok, min_claim_delay, min_claim_window};
  let nl = s.t_nl();
  // The accepted parameters.
  let params = s.depth != 0
    && s.d_c as i64 >= min_claim_delay(s.depth, c)
    && s.w_c as i64 >= min_claim_window(c)
    && s.w_c <= c.max_final_secs
    && freeze_window_ok(s.w_z)
    && (!s.watcher || s.w_z != 0);
  let noticed = s.t_notice < nl
    && s.t_cut == s.t_notice + delta_cut(s.depth, c)
    && s.t_claim_open == s.t_notice + s.d_c as i64;
  let by_state = match s.state {
    State::None => false,
    // The latest activation still leaves the notice window before T_nl.
    State::Pending => s.t_pending_deadline + s.w_n as i64 <= nl,
    State::Active => s.t_note_deadline <= nl,
    State::Noticed | State::AbortedFree | State::AbortedHold => noticed,
    State::Frozen => noticed && s.watcher && s.t_freeze < s.t_claim_open,
    State::Ready => noticed && s.t_claim_deadline == s.t_ready + s.w_c as i64 && s.t_claim_deadline < s.t_final - crate::bounds::DAY_SECS,
    // Only the deposit is left: no deadline of the main machine matters any more.
    State::Hold | State::Withheld | State::Done => true,
  };
  params && by_state
}

/// Any call on an existing swap (everything but `lock`/`take`).
pub fn any_call() -> Call {
  let call: Call = kani::any();
  kani::assume(!matches!(call, Call::Open(_)));
  call
}

/// Any environment: destinations that can or cannot receive, any caps, any pause.
pub fn any_env() -> Env {
  kani::any()
}

/// Any row with any counter byte: more than [`gate`] can return.
pub fn any_row() -> Row {
  kani::any()
}

/// Any payout plan at all, with amounts inside [`AMOUNT_BOUND`].
pub fn any_plan() -> Plan {
  let p: Plan = kani::any();
  kani::assume(p.pays[0].amount < AMOUNT_BOUND && p.pays[1].amount < AMOUNT_BOUND);
  p
}

/// Stand-in for `fee_of` and `deposit_of`: any share of the amount.
pub fn any_share(amount: u128, _bps: u16) -> u128 {
  let v: u128 = kani::any();
  kani::assume(v <= amount);
  v
}

/// A deterministic stand-in for `deposit_of`, for harnesses that compare two runs: half the
/// amount. (Any function of the amount would do: the harness is about the times.)
pub fn fixed_share(amount: u128, _bps: u16) -> u128 {
  amount / 2
}

/// What the escrow holds for a swap according to its record: the stake of its state plus what
/// is parked. This is the specification the conservation harnesses check the machine against.
pub fn held(s: &Swap) -> u128 {
  let stake = match (s.state, s.is_a()) {
    (State::None | State::Done, _) => 0,
    (State::Pending, true) => s.amount,
    (State::Pending, false) => s.deposit,
    (State::Hold | State::Withheld, _) => s.deposit,
    // ACTIVE, NOTICED, READY, FROZEN, ABORTED_*: the whole escrow.
    (_, true) => s.amount,
    (_, false) => s.amount + s.deposit,
  };
  stake + s.owed_taker + s.owed_maker + s.owed_treasury
}

/// The counted value of SPEC 11.1.
pub fn counted(s: &Swap) -> u128 {
  if s.is_a() {
    s.amount
  } else {
    s.amount + s.deposit
  }
}

/// The invariant of the open-value accounting: a swap is flagged `counted` exactly while it is
/// in an open state. `open` establishes it and every transition preserves it
/// (`switches::counted_flag_is_an_invariant`).
pub fn counted_invariant(s: &Swap) -> bool {
  s.has(flag::COUNTED) == s.state.is_open()
}
