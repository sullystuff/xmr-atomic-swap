//! The property test of SPEC 2.12: for random parameters within the bounds and random call
//! sequences at random times,
//!
//! * **rule 1** (invariant 1, exclusive windows): never are secret-bearing calls by two
//!   different parties enabled at the same instant;
//! * **the exit invariant** (invariant 2): from every funded state each party with funds at
//!   stake has a call that becomes enabled;
//!
//! plus what follows from the same walk: escrow is conserved (nothing is created, nothing is
//! stranded), every counter the chain can reach is reached, and, for Amendment 1 (SPEC 11):
//! the open value is exactly the swap's counted value while it is open and zero afterwards; no
//! cap or pause changes the answer of any call on an existing swap (invariant 3); a watcher can
//! do nothing a stranger cannot except freeze; claim proceeds of a swap with a payout address go
//! to it and nowhere else.

use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use swap_core::amounts::{
  check_bounds, min_claim_delay, min_claim_window, min_final_window, pending_window, Caps, ChainConsts, Pending, SwapParams,
  ETHEREUM, MAX_FREEZE_SECS, MIN_FREEZE_SECS, SOLANA,
};
use swap_core::model::{
  apply, counter, enabled, flag, mode, Call, Direction, Env, Evidence, ModelError, OpenArgs, Party, PayoutArg, PayoutTo,
  RejectReason, Role, State, SwapState,
};

const T0: i64 = 1_800_000_000;
const ROLES: [Role; 7] = [Role::TakerWallet, Role::Session, Role::Operator, Role::Owner, Role::Watcher, Role::Payout, Role::Anyone];

fn below(rng: &mut ChaCha20Rng, n: u64) -> u64 {
  if n == 0 {
    0
  } else {
    rng.next_u64() % n
  }
}
fn between(rng: &mut ChaCha20Rng, lo: i64, hi: i64) -> i64 {
  lo + below(rng, (hi - lo + 1).max(1) as u64) as i64
}

/// Random per-swap parameters inside the bounds of SPEC 3.1 for the swap's own `W_p`. Extremes
/// (the minimum and the cap of every window) are drawn often.
fn random_open(rng: &mut ChaCha20Rng, c: &ChainConsts) -> (OpenArgs, Pending) {
  let direction = if below(rng, 2) == 0 { Direction::A } else { Direction::B };
  let (offer_mode, approval) = match below(rng, 6) {
    0 => (mode::AUTO, false),
    1 => (mode::WINDOW, false),
    2 => (mode::WINDOW, true),
    3 => (mode::ADVANCE, true),
    4 => (mode::QUOTE, false),
    _ => (mode::AUTO, true),
  };
  let window = offer_mode == mode::WINDOW && !approval;
  let pending = match direction {
    _ if c.explicit_approve || window => Pending::ApprovalWindow,
    Direction::A => Pending::None,
    Direction::B => Pending::FundingWindow,
  };
  let pick = |rng: &mut ChaCha20Rng, lo: i64, hi: i64| match below(rng, 4) {
    0 => lo,
    1 => hi,
    _ => between(rng, lo, hi),
  };
  let depth = match below(rng, 8) {
    0 => 1,
    1 => 255,
    2 => 2,
    3 => 10,
    4 => 25,
    _ => between(rng, 1, 60) as u8,
  };
  let mut p = SwapParams {
    w_a: pick(rng, 30, c.max_approval_secs as i64) as u32,
    w_n: pick(rng, c.min_notice_secs as i64, c.max_notice_secs as i64) as u32,
    d_c: 0,
    w_c: 0,
    w_f: 0,
    depth,
    dep_bps: pick(rng, 0, c.max_deposit_bps as i64) as u16,
    // Half the offers accept a watcher.
    w_z: if below(rng, 2) == 0 { 0 } else { pick(rng, MIN_FREEZE_SECS as i64, MAX_FREEZE_SECS as i64) as u32 },
  };
  let dc_min = min_claim_delay(depth, c);
  p.d_c = pick(rng, dc_min, dc_min + 20_000) as u32;
  let wc_min = min_claim_window(c);
  p.w_c = pick(rng, wc_min, wc_min + 20_000) as u32;
  let wf_min = min_final_window(&p, pending_window(&p, pending));
  p.w_f = pick(rng, wf_min, c.max_final_secs as i64) as u32;
  assert_eq!(check_bounds(&p, pending, c), Ok(()), "generator stays inside the bounds");
  // The largest amount the chain accepts for this swap: the counted value of SPEC 11.1
  // (amount in A, amount + deposit in B) must fit the amount type. `u64` is the ceiling here
  // because the walks run under caps of that size.
  let limit = c.max_amount.min(u64::MAX as u128);
  let counted_of = |a: u128| a + if direction == Direction::B { swap_core::amounts::deposit_of(a, p.dep_bps) } else { 0 };
  let mut largest = limit * 10_000 / (10_000 + if direction == Direction::B { p.dep_bps as u128 } else { 0 });
  while counted_of(largest + 1) <= limit {
    largest += 1;
  }
  assert!(counted_of(largest) <= limit && counted_of(largest + 1) > limit);
  let amount = match below(rng, 5) {
    0 => 1,
    1 => largest,
    _ => 1 + below(rng, 1_000_000_000_000) as u128,
  };
  let payout = if below(rng, 2) == 0 { PayoutArg::Taker } else { PayoutArg::Other };
  let watcher = p.w_z > 0 && below(rng, 4) != 0;
  (OpenArgs { direction, offer_mode, approval, xmr: 1 + below(rng, 1_000_000_000_000_000), amount, params: p, payout, watcher }, pending)
}

/// Every instant at which something can change, and its neighbours.
fn instants(s: &SwapState, c: &ChainConsts) -> Vec<i64> {
  let mut base = vec![s.t_lock, s.t_final, s.t_nl(), s.t_exp(c)];
  for t in [s.t_pending_deadline, s.t_active, s.t_note_deadline, s.t_notice, s.t_cut, s.t_claim_open, s.t_ready, s.t_claim_deadline] {
    if t != 0 {
      base.push(t);
    }
  }
  if s.t_notice != 0 {
    base.push(s.t_ready_min(c));
  }
  if s.t_refund != 0 {
    base.extend([s.t_refund, s.t_hold(c), s.t_split(c)]);
  }
  if s.t_freeze != 0 {
    base.extend([s.t_freeze, s.t_ff()]);
  }
  let mut out = Vec::new();
  for t in base {
    out.extend([t - 1, t, t + 1]);
  }
  out.push(s.t_exp(c).max(s.t_split(c)) + 400_000_000);
  out.sort();
  out.dedup();
  out
}

const SECRET_CALLS: [Call; 2] = [Call::Refund { secret_ok: true }, Call::Claim { secret_ok: true }];

/// Rule 1 at one instant. The refund reveals the locker's share and the claim the claimer's:
/// they are calls "by two different parties" whoever submits them, so at most one of the two
/// may be enabled for anybody.
fn rule_1(s: &SwapState, now: i64, c: &ChainConsts, seed: u64) {
  let any = |call: Call| ROLES.iter().any(|r| enabled(s, call, *r, now, c));
  let refund = any(SECRET_CALLS[0]);
  let claim = any(SECRET_CALLS[1]);
  assert!(
    !(refund && claim),
    "seed {seed}: refund and claim both enabled in {:?} {:?} at t_lock{:+}",
    s.direction,
    s.state,
    now - s.t_lock
  );
  // Outside Ethereum's open calls, the caller is the party: the locker's roles can never
  // claim and the claimer's roles can never refund, at any instant.
  if !c.open_secret_calls {
    let (locker, claimer): (&[Role], &[Role]) = match s.direction {
      Direction::A => (&[Role::TakerWallet, Role::Session], &[Role::Operator]),
      Direction::B => (&[Role::Operator], &[Role::TakerWallet, Role::Session]),
    };
    for r in locker {
      assert!(!enabled(s, SECRET_CALLS[1], *r, now, c), "seed {seed}: locker can claim");
    }
    for r in claimer {
      assert!(!enabled(s, SECRET_CALLS[0], *r, now, c), "seed {seed}: claimer can refund");
    }
    for r in [Role::Anyone, Role::Owner, Role::Watcher, Role::Payout] {
      for call in SECRET_CALLS {
        assert!(!enabled(s, call, r, now, c), "seed {seed}: a stranger can {}", call.name());
      }
    }
  }
  // A claim is never possible without a notice on record.
  if matches!(s.state, State::Pending | State::Active) {
    assert!(!claim, "seed {seed}: claim without a notice");
  }
}

/// Does `call` by `role` become enabled at `now` or at any later instant of interest?
fn becomes_enabled(s: &SwapState, call: Call, role: Role, now: i64, c: &ChainConsts) -> bool {
  enabled(s, call, role, now, c) || instants(s, c).into_iter().filter(|t| *t > now).any(|t| enabled(s, call, role, t, c))
}

/// Invariant 2, encoded from the table of SPEC 3.2 (not from the model).
fn exit_invariant(s: &SwapState, now: i64, c: &ChainConsts, seed: u64) {
  let refund = Call::Refund { secret_ok: true };
  let claim = Call::Claim { secret_ok: true };
  let ctx = format!("seed {seed}: {:?} {:?} at t_lock{:+}", s.direction, s.state, now - s.t_lock);
  let post_notice = matches!(s.state, State::Noticed | State::Ready | State::AbortedFree | State::AbortedHold | State::Frozen);
  if s.state == State::Frozen {
    // SPEC 11.6: the locker's refund and set_ready are enabled until T_ff, whatever the watcher did.
    let locker = if s.direction == Direction::A { Role::Session } else { Role::Operator };
    let claimer = if s.direction == Direction::A { Role::Operator } else { Role::Session };
    // T_ff, computed here and not by the model: the later of t_Z + W_z and T_co.
    let t_ff = (s.t_freeze + s.w_z as i64).max(s.t_claim_open);
    assert_eq!(s.t_ff(), t_ff, "{ctx}");
    assert!(s.t_freeze < s.t_claim_open && t_ff < s.t_claim_open + s.w_z as i64, "{ctx}: t_Z < T_co, T_ff < T_co + W_z");
    assert!(t_ff < s.t_final - s.w_c as i64 - 86_400, "{ctx}: T_ff < T_final − W_c − 86,400");
    assert_eq!(enabled(s, refund, locker, now, c), now < t_ff || now >= s.t_exp(c), "{ctx}: locker refund until T_ff");
    assert_eq!(enabled(s, Call::SetReady, locker, now, c), now >= s.t_ready_min(c) && now < t_ff, "{ctx}: set_ready until T_ff");
    assert_eq!(enabled(s, claim, claimer, now, c), now >= t_ff && now < s.t_exp(c), "{ctx}: claim from T_ff");
    // The freeze took nothing from the locker: wherever it could refund or set ready before
    // (until T_co), it still can; and the claimer gained nothing.
    if now < s.t_claim_open {
      assert!(enabled(s, refund, locker, now, c), "{ctx}: the freeze closed the locker's refund early");
      assert!(!enabled(s, claim, claimer, now, c), "{ctx}: the freeze opened the claim early");
      assert_eq!(enabled(s, Call::SetReady, locker, now, c), now >= s.t_ready_min(c), "{ctx}: the freeze blocked set_ready");
    }
    // Unfreezing is always possible at some instant.
    assert!(s.t_ready_min(c) < t_ff, "{ctx}: no instant at which the locker can set ready");
  }
  match (s.state, s.direction) {
    (State::Pending, _) => {
      // Taker: cancel_pending at any time; anyone's expire_pending after T_pend.
      assert!(enabled(s, Call::CancelPending, Role::TakerWallet, now, c), "{ctx}: cancel");
      assert!(enabled(s, Call::CancelPending, Role::Session, now, c), "{ctx}: cancel by session");
      assert!(becomes_enabled(s, Call::ExpirePending, Role::Anyone, now, c), "{ctx}: expire_pending");
    }
    (State::Active, Direction::A) => {
      // Taker: refund at any time; anyone's refund_unnoticed after T_note.
      assert!(enabled(s, refund, Role::Session, now, c), "{ctx}: refund now");
      assert!(enabled(s, refund, Role::TakerWallet, now, c), "{ctx}: refund now by wallet");
      assert!(becomes_enabled(s, Call::RefundUnnoticed, Role::Anyone, now, c), "{ctx}: refund_unnoticed");
    }
    (State::Active, Direction::B) => {
      // Maker: refund at any time. Taker: post_notice until T_nl for XMR already paid, and
      // anyone's expire_unnoticed at T_exp for the take deposit.
      assert!(enabled(s, refund, Role::Operator, now, c), "{ctx}: maker refund now");
      assert!(becomes_enabled(s, Call::ExpireUnnoticed, Role::Anyone, now, c), "{ctx}: expire_unnoticed");
      assert_eq!(enabled(s, Call::PostNotice, Role::Session, now, c), now < s.t_nl(), "{ctx}: post_notice until T_nl");
    }
    (_, Direction::A) if post_notice => {
      // Taker: refund in its windows and again from T_exp. Maker: claim in its windows.
      assert!(becomes_enabled(s, refund, Role::Session, now, c), "{ctx}: taker refund");
      assert!(enabled(s, refund, Role::Session, now.max(s.t_exp(c)), c), "{ctx}: taker refund at T_exp");
      if now < s.t_exp(c) {
        assert!(becomes_enabled(s, claim, Role::Operator, now, c), "{ctx}: maker claim");
      }
    }
    (_, Direction::B) if post_notice => {
      // Taker: claim from T_co or T_final. Maker: refund in its windows and again from T_exp.
      if now < s.t_exp(c) {
        assert!(becomes_enabled(s, claim, Role::Session, now, c), "{ctx}: taker claim");
      }
      assert!(enabled(s, refund, Role::Operator, now.max(s.t_exp(c)), c), "{ctx}: maker refund at T_exp");
    }
    (State::Hold, _) => {
      // Anyone's release_deposit at T_hold.
      assert!(enabled(s, Call::ReleaseDeposit, Role::Anyone, now.max(s.t_hold(c)), c), "{ctx}: release at T_hold");
    }
    (State::Withheld, _) => {
      // Anyone's split_deposit at T_split.
      assert!(enabled(s, Call::SplitDeposit, Role::Anyone, now.max(s.t_split(c)), c), "{ctx}: split at T_split");
    }
    _ => {}
  }
}

fn random_call(rng: &mut ChaCha20Rng) -> Call {
  match below(rng, 24) {
    0 => Call::Approve { open_ok: true },
    1 => Call::Fund { open_ok: true, watcher: below(rng, 2) == 0 },
    20 | 21 => Call::Freeze,
    22 => Call::WithdrawOwed(Party::Payout),
    23 => Call::PushOwed([Party::Taker, Party::Maker, Party::Treasury, Party::Payout][below(rng, 4) as usize]),
    2 => Call::Reject {
      open_ok: true,
      reason: [RejectReason::MakerChoice, RejectReason::UnusableInput, RejectReason::LeafConsumed][below(rng, 3) as usize],
    },
    3 => Call::CancelPending,
    4 => Call::ExpirePending,
    5 => Call::PostNotice,
    6 => Call::SetReady,
    7 => Call::Abort,
    8 => Call::RefundUnnoticed,
    9 => Call::ExpireUnnoticed,
    10 => Call::Refund { secret_ok: true },
    11 => Call::Claim { secret_ok: true },
    12 => Call::ReleaseDeposit,
    13 => Call::Withhold(Evidence::Opens),
    14 => Call::Withhold(Evidence::Absent),
    15 => Call::SplitDeposit,
    16 => Call::PublishEvidence { opens: true },
    17 => Call::Refund { secret_ok: false },
    18 => Call::Claim { secret_ok: false },
    _ => Call::WithdrawOwed([Party::Taker, Party::Maker, Party::Treasury][below(rng, 3) as usize]),
  }
}

struct Coverage {
  counters: [u64; counter::COUNT],
  states: std::collections::BTreeSet<(u8, State)>,
  transitions: u64,
  parked: u64,
  /// Swaps opened with a payout address other than the taker's, and payouts made to one.
  payout_other: u64,
  payout_paid: u64,
}

/// The counted value of SPEC 11.1.
fn counted(s: &SwapState) -> u128 {
  s.amount + if s.direction == Direction::B { s.deposit } else { 0 }
}

fn walk(seed: u64, c: &ChainConsts, cov: &mut Coverage) {
  let mut rng = ChaCha20Rng::seed_from_u64(seed);
  let (args, _) = random_open(&mut rng, c);
  let mut now = T0 + below(&mut rng, 1_000_000) as i64;
  // Other swaps of the same asset are open: the accounting must add to and subtract from that.
  let room = c.max_amount.min(u64::MAX as u128) - (args.amount + if args.direction == Direction::B { swap_core::amounts::deposit_of(args.amount, args.params.dep_bps) } else { 0 });
  let others = (below(&mut rng, 1_000_000_000) as u128).min(room);
  // One unit more than fits is refused, and only at the open.
  if room < 1_000 && c.max_amount <= u64::MAX as u128 {
    let over = Env { caps: Caps { on: false, max_swap: 0, max_open: 0, open_value: room + 1 }, ..Env::OK };
    assert_eq!(apply(SwapState::NONE, Call::Open(args), Role::TakerWallet, now, &over, c), Err(ModelError::MathOverflow), "seed {seed}");
  }
  let caps_off = Caps { on: false, max_swap: 0, max_open: 0, open_value: others };
  let fx = apply(SwapState::NONE, Call::Open(args), Role::TakerWallet, now, &Env { caps: caps_off, ..Env::OK }, c).expect("in-bounds open");
  let mut s = fx.state;
  let mut open_value = fx.open_value_after;
  assert_eq!(open_value, others + counted(&s), "seed {seed}: the open adds the counted value");
  assert!(s.has(flag::COUNTED));
  cov.payout_other += (s.payout == PayoutTo::Other) as u64;
  // Escrow ledger: funds in minus funds actually transferred out.
  let mut escrow = fx.escrow_in;
  cov.counters[fx.counter.unwrap() as usize] += 1;
  cov.states.insert((s.direction as u8, s.state));

  for _ in 0..40 {
    let times = instants(&s, c);
    // Both invariants hold now and at every boundary second from here on.
    for t in times.iter().copied().filter(|t| *t >= now).chain([now]) {
      rule_1(&s, t, c, seed);
    }
    exit_invariant(&s, now, c, seed);
    // ...and at a few arbitrary instants.
    for _ in 0..3 {
      let t = now + below(&mut rng, 4_000_000) as i64;
      rule_1(&s, t, c, seed);
      exit_invariant(&s, t, c, seed);
    }

    // Choose when to act: one of the next few boundary seconds (so walks go deep instead of
    // jumping straight to the expiry), any later boundary, a short wait, or a long one.
    let future: Vec<i64> = times.iter().copied().filter(|t| *t >= now).collect();
    let at = match below(&mut rng, 12) {
      0..=4 if !future.is_empty() => future[below(&mut rng, future.len().min(5) as u64) as usize],
      5 | 6 if !future.is_empty() => future[below(&mut rng, future.len() as u64) as usize],
      7 | 8 => now + below(&mut rng, 600) as i64,
      9 => now + below(&mut rng, 100_000) as i64,
      _ => now,
    };
    // Choose what to do: mostly something that is enabled then (preferring calls that keep the
    // swap open, or the walk would end at the first cancel), sometimes anything at all.
    // The admin's and the maker's switches take a random position at every step: caps on or
    // off, at zero or anywhere, the maker paused or not.
    let caps = Caps {
      on: below(&mut rng, 2) == 0,
      max_swap: if below(&mut rng, 2) == 0 { 0 } else { below(&mut rng, u64::MAX) as u128 },
      max_open: if below(&mut rng, 2) == 0 { 0 } else { below(&mut rng, u64::MAX) as u128 },
      open_value,
    };
    let env = Env {
      taker_can_receive: below(&mut rng, 8) != 0,
      maker_can_receive: below(&mut rng, 8) != 0,
      treasury_can_receive: c.open_secret_calls || below(&mut rng, 8) != 0,
      payout_can_receive: below(&mut rng, 4) != 0,
      open_pending: below(&mut rng, 100) as u16,
      caps,
      maker_paused: below(&mut rng, 2) == 0,
    };
    let (call, caller) = if below(&mut rng, 5) != 0 {
      let mut options = Vec::new();
      // Seven roles and twenty-four calls: draw enough pairs to find what is enabled.
      for _ in 0..160 {
        let call = random_call(&mut rng);
        let caller = ROLES[below(&mut rng, ROLES.len() as u64) as usize];
        if let Ok(fx) = apply(s, call, caller, at, &Env::OK, c) {
          options.push((call, caller, fx.state.state != State::Done));
        }
      }
      let open: Vec<_> = options.iter().copied().filter(|o| o.2).collect();
      let pool = if !open.is_empty() && below(&mut rng, 3) != 0 { open } else { options };
      if pool.is_empty() {
        now = at;
        continue;
      }
      let (call, caller, _) = pool[below(&mut rng, pool.len() as u64) as usize];
      (call, caller)
    } else {
      (random_call(&mut rng), ROLES[below(&mut rng, ROLES.len() as u64) as usize])
    };

    // Invariant 3: with the same destinations, the answer does not depend on any switch.
    let calm = Env { open_pending: 0, caps: Caps { open_value, ..Caps::UNLIMITED }, maker_paused: false, ..env };
    assert_eq!(apply(s, call, caller, at, &env, c), apply(s, call, caller, at, &calm, c), "seed {seed}: a switch changed {}", call.name());
    // A watcher can do what a stranger can, and freeze.
    if caller == Role::Watcher && call != Call::Freeze {
      assert_eq!(apply(s, call, Role::Watcher, at, &env, c), apply(s, call, Role::Anyone, at, &env, c), "seed {seed}: watcher power in {}", call.name());
    }

    match apply(s, call, caller, at, &env, c) {
      Err(_) => {
        // A refused call changes nothing; time still passes.
        now = at;
      }
      Ok(fx) => {
        now = at;
        cov.transitions += 1;
        if let Some(id) = fx.counter {
          cov.counters[id as usize] += 1;
        }
        escrow += fx.escrow_in;
        for p in &fx.payouts {
          if p.parked {
            cov.parked += 1;
          } else {
            assert!(escrow >= p.amount, "seed {seed}: {} pays {} with {escrow} in escrow", call.name(), p.amount);
            escrow -= p.amount;
          }
        }
        let n = fx.state;
        // SPEC 11.1: one subtraction, at the transition that leaves the open states.
        let expect_value = if s.has(flag::COUNTED) && !n.state.is_open() { open_value - counted(&s) } else { open_value };
        assert_eq!(fx.open_value_after, expect_value, "seed {seed}: open value after {}", call.name());
        assert_eq!(n.has(flag::COUNTED), n.state.is_open(), "seed {seed}: counted flag in {:?}", n.state);
        open_value = fx.open_value_after;
        assert_eq!(open_value, others + if n.state.is_open() { counted(&n) } else { 0 }, "seed {seed}: open value is the sum of the open swaps");
        // SPEC 11.6: a freeze moves nothing.
        if call == Call::Freeze {
          assert!(fx.payouts.is_empty() && fx.escrow_in == 0, "seed {seed}: a freeze moved funds");
          assert_eq!(SwapState { state: s.state, t_freeze: 0, ..n }, s, "seed {seed}: a freeze changed more than the state and t_freeze");
        }
        // SPEC 11.2: only a direction-B claim pays the payout address, and then the taker gets nothing.
        for p in &fx.payouts {
          if p.to == Party::Payout {
            assert!(n.direction == Direction::B && n.payout == PayoutTo::Other, "seed {seed}: payout paid in {}", call.name());
            assert!(matches!(call, Call::Claim { .. } | Call::WithdrawOwed(Party::Payout) | Call::PushOwed(Party::Payout)), "seed {seed}: {} paid the payout address", call.name());
            cov.payout_paid += 1;
          }
        }
        if matches!(call, Call::Claim { .. }) && n.payout == PayoutTo::Other {
          assert!(fx.payouts.iter().all(|p| p.to != Party::Taker), "seed {seed}: a claim paid the taking wallet");
        }
        let owed = n.owed_taker + n.owed_maker + n.owed_treasury;
        // Conservation: what is still in escrow is exactly what the state says is there.
        let expected = owed
          + match (n.state, n.direction) {
            (State::Pending, Direction::A) => n.amount,
            (State::Pending, Direction::B) => n.deposit,
            (State::Active | State::Noticed | State::Ready | State::AbortedFree | State::AbortedHold | State::Frozen, Direction::A) => n.amount,
            (State::Active | State::Noticed | State::Ready | State::AbortedFree | State::AbortedHold | State::Frozen, Direction::B) => {
              n.amount + n.deposit
            }
            (State::Hold | State::Withheld, _) => n.deposit,
            (State::Done, _) => 0,
            (State::None, _) => unreachable!(),
          };
        assert_eq!(escrow, expected, "seed {seed}: escrow after {} in {:?} {:?}", call.name(), n.direction, n.state);
        // Time never moves a deadline that is already set.
        assert_eq!((n.t_lock, n.t_final), (s.t_lock, s.t_final));
        // Once settled, the outcome is the settling counter; before, it is 0xff.
        assert_eq!(n.outcome == counter::NONE, n.state != State::Done);
        s = n;
        cov.states.insert((s.direction as u8, s.state));
      }
    }
  }
  // Whatever happened, the swap can always be driven to DONE with nothing left in escrow:
  // every party pulls what it is owed.
  let mut t = now;
  for _ in 0..12 {
    if s.state == State::Done {
      break;
    }
    let far = t.max(s.t_exp(c)).max(if s.t_refund != 0 { s.t_split(c) } else { 0 });
    let steps: [(Call, Role, i64); 8] = [
      (Call::CancelPending, Role::TakerWallet, t),
      (Call::Refund { secret_ok: true }, if s.direction == Direction::A { Role::Session } else { Role::Operator }, t),
      (Call::ReleaseDeposit, Role::Anyone, t.max(if s.t_refund != 0 { s.t_hold(c) } else { t })),
      (Call::SplitDeposit, Role::Anyone, far),
      (Call::Refund { secret_ok: true }, if s.direction == Direction::A { Role::Session } else { Role::Operator }, far),
      (Call::ExpireUnnoticed, Role::Anyone, far),
      (Call::RefundUnnoticed, Role::Anyone, far),
      (Call::ReleaseDeposit, Role::Anyone, far),
    ];
    let mut moved = false;
    for (call, role, at) in steps {
      if let Ok(fx) = apply(s, call, role, at, &Env::OK, c) {
        escrow += fx.escrow_in;
        escrow -= fx.payouts.iter().filter(|p| !p.parked).map(|p| p.amount).sum::<u128>();
        s = fx.state;
        t = at;
        moved = true;
        break;
      }
    }
    assert!(moved, "seed {seed}: stuck in {:?} {:?}", s.direction, s.state);
  }
  assert_eq!(s.state, State::Done, "seed {seed}");
  assert!(!s.has(flag::COUNTED), "seed {seed}: a settled swap is still counted");
  // Parked claim proceeds of a swap with a payout address belong to that address: the taking
  // wallet cannot pull them.
  let taker_side = if s.payout_owed() {
    let refused = apply(s, Call::WithdrawOwed(Party::Taker), Role::TakerWallet, t, &Env::OK, c).unwrap_err();
    assert_eq!(refused, if c.pull_own_owed { ModelError::NothingOwed } else { ModelError::Unauthorized }, "seed {seed}");
    (Party::Payout, Role::Payout)
  } else {
    (Party::Taker, Role::TakerWallet)
  };
  for (who, role) in [taker_side, (Party::Maker, Role::Owner), (Party::Treasury, Role::Anyone)] {
    match apply(s, Call::WithdrawOwed(who), role, t, &Env::OK, c) {
      Ok(fx) => {
        assert_eq!(fx.payouts[0].to, who, "seed {seed}");
        escrow -= fx.payouts[0].amount;
        s = fx.state;
      }
      Err(e) => assert_eq!(e, ModelError::NothingOwed),
    }
  }
  assert_eq!(escrow, 0, "seed {seed}: funds stranded in escrow");
}

fn run_chain(c: &ChainConsts, seeds: std::ops::Range<u64>) -> Coverage {
  let mut cov = Coverage { counters: [0; counter::COUNT], states: Default::default(), transitions: 0, parked: 0, payout_other: 0, payout_paid: 0 };
  for seed in seeds {
    walk(seed, c, &mut cov);
  }
  cov
}

#[test]
fn rule_1_and_exit_invariant_solana() {
  let cov = run_chain(&SOLANA, 0..6_000);
  // A swap has at most a handful of transitions; require an average of two accepted calls
  // after the opening one so the walks cannot all have died at the first step.
  assert!(cov.transitions > 12_000, "{} transitions", cov.transitions);
  assert!(cov.parked > 100);
  // Every assigned counter is reachable on Solana, the four of SPEC 11.6 included.
  for id in 0..=counter::CLAIMS_AFTER_FREEZE {
    assert!(cov.counters[id as usize] > 0, "counter {} ({}) never moved", id, counter::NAMES[id as usize]);
  }
  for id in 37..counter::COUNT {
    assert_eq!(cov.counters[id], 0, "reserved counter {id} moved");
  }
  assert!(cov.payout_other > 1_000 && cov.payout_paid > 50, "{} swaps with a payout address, {} payouts to one", cov.payout_other, cov.payout_paid);
  // Every state in both directions, except ABORTED_FREE in B, which does not exist.
  for dir in [0u8, 1] {
    for st in [State::Pending, State::Active, State::Noticed, State::Ready, State::AbortedFree, State::AbortedHold, State::Hold, State::Withheld, State::Done, State::Frozen] {
      assert_eq!(cov.states.contains(&(dir, st)), !(dir == 1 && st == State::AbortedFree), "direction {dir} {st:?}");
    }
  }
}

#[test]
fn rule_1_and_exit_invariant_ethereum() {
  let cov = run_chain(&ETHEREUM, 1_000_000..1_006_000);
  // A swap has at most a handful of transitions; require an average of two accepted calls
  // after the opening one so the walks cannot all have died at the first step.
  assert!(cov.transitions > 12_000, "{} transitions", cov.transitions);
  for id in 0..=counter::CLAIMS_AFTER_FREEZE {
    // Counter 13 (missed_funds) is reachable only where EXPLICIT_APPROVE is false.
    assert_eq!(cov.counters[id as usize] > 0, id != counter::MISSED_FUNDS, "counter {} ({})", id, counter::NAMES[id as usize]);
  }
  for dir in [0u8, 1] {
    for st in [State::Pending, State::Active, State::Noticed, State::Ready, State::AbortedFree, State::AbortedHold, State::Hold, State::Withheld, State::Done, State::Frozen] {
      assert_eq!(cov.states.contains(&(dir, st)), !(dir == 1 && st == State::AbortedFree), "direction {dir} {st:?}");
    }
  }
  // Fewer than on Solana: every swap starts PENDING here, so fewer walks reach a claim.
  assert!(cov.payout_other > 1_000 && cov.payout_paid > 10, "{} swaps with a payout address, {} payouts to one", cov.payout_other, cov.payout_paid);
}

/// The derivation of SPEC 3.2 on random in-bounds swaps: the order
/// `t_lock <= t_A < t_N < T_cut < T_co`, `t_R < T_co`, `T_cd < T_final − 86,400 < T_final < T_exp`
/// holds whenever the calls are accepted, including at every last second.
#[test]
fn deadline_order_on_every_accepted_path() {
  for (c, base) in [(&SOLANA, 0u64), (&ETHEREUM, 50_000)] {
    for seed in base..base + 3_000 {
      let mut rng = ChaCha20Rng::seed_from_u64(seed);
      let (args, pending) = random_open(&mut rng, c);
      let last = below(&mut rng, 2) == 0;
      let mut s = apply(SwapState::NONE, Call::Open(args), Role::TakerWallet, T0, &Env::OK, c).unwrap().state;
      let (claimer, locker) = match args.direction {
        Direction::A => (Role::Operator, Role::Session),
        Direction::B => (Role::Session, Role::Operator),
      };
      if pending != Pending::None {
        let at = if last { s.t_pending_deadline - 1 } else { between(&mut rng, T0, s.t_pending_deadline - 1) };
        let call = if args.direction == Direction::A { Call::Approve { open_ok: true } } else { Call::Fund { open_ok: true, watcher: s.w_z > 0 } };
        s = apply(s, call, Role::Operator, at, &Env::OK, c).unwrap().state;
      }
      assert!(s.t_lock <= s.t_active);
      assert!(s.t_note_deadline <= s.t_nl(), "seed {seed}: T_note <= T_nl");
      // The latest notice either direction accepts.
      let latest = if args.direction == Direction::A { s.t_note_deadline - 1 } else { s.t_nl() - 1 };
      let at = if last { latest } else { between(&mut rng, s.t_active, latest) };
      s = apply(s, Call::PostNotice, claimer, at, &Env::OK, c).unwrap().state;
      assert!(s.t_active <= s.t_notice && s.t_notice < s.t_nl());
      assert!(s.t_notice < s.t_cut);
      assert!(s.t_cut <= s.t_claim_open - 2 * c.margin_secs, "seed {seed}: T_cut <= T_co − 2M");
      assert!(s.t_claim_open < s.t_final - s.w_c as i64 - 86_400);
      assert!(s.t_ready_min(c) < s.t_claim_open, "seed {seed}: ready is possible before T_co");
      // SPEC 11.6: with a watcher, half the walks freeze first (at the last second, or anywhere)
      // and set ready out of FROZEN; the algebra must hold with W_z added.
      let frozen = s.watcher && below(&mut rng, 2) == 0;
      if frozen {
        let at = if last { s.t_claim_open - 1 } else { between(&mut rng, s.t_notice, s.t_claim_open - 1) };
        s = apply(s, Call::Freeze, Role::Watcher, at, &Env::OK, c).unwrap().state;
        assert_eq!(s.state, State::Frozen);
        assert!(s.t_ff() < s.t_claim_open + s.w_z as i64, "seed {seed}: T_ff < T_co + W_z");
        assert!(s.t_claim_open + (s.w_z as i64) < s.t_final - s.w_c as i64 - 86_400, "seed {seed}: T_co + W_z < T_final − W_c − 86,400");
        let at = if last { s.t_ff() - 1 } else { between(&mut rng, s.t_ready_min(c).max(s.t_freeze), s.t_ff() - 1) };
        s = apply(s, Call::SetReady, locker, at, &Env::OK, c).unwrap_or_else(|e| panic!("seed {seed}: set_ready in FROZEN at {at}: {e:?} {s:?}")).state;
        assert!(s.t_ready < s.t_ff());
      } else {
        let at = if last { s.t_claim_open - 1 } else { between(&mut rng, s.t_ready_min(c), s.t_claim_open - 1) };
        s = apply(s, Call::SetReady, locker, at, &Env::OK, c).unwrap().state;
        assert!(s.t_ready < s.t_claim_open);
      }
      assert!(s.t_claim_deadline < s.t_final - 86_400, "seed {seed}: T_cd < T_final − 86,400");
      assert!(s.t_final < s.t_exp(c));
    }
  }
}
