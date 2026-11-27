//! Vector suites for SPEC 3 and 4.2: terms, amounts, deadlines, transitions.
//!
//! `transitions.json` is the executable form of the state machine. It is generated from the
//! reference model, per chain, in two parts:
//!
//! * `rows`: every row of SPEC 3.4 to 3.6, each at the first and last second of its window and
//!   one second either side of every boundary, plus wrong-caller, wrong-secret and wrong-state
//!   cases. A row is replayed by running its `open` call, then its `setup` steps, then `step`.
//! * `sequences`: multi-step scripts with absolute times. Every step lists the expected result,
//!   the whole swap record (state, every `t_*` field, flags, parked balances), the payouts paid
//!   and parked, and all of the maker's counters.

use serde_json::{json, Map, Value};

use super::{d, err_case, h, ok_case, suite, suite_lines, VectorFile};
use crate::{
  amounts::{
    self, check_bounds, deadlines as derive_deadlines, delta_cut, min_claim_delay, min_claim_window, min_final_window,
    pending_window, tier_value, Chain, ChainConsts, EventTimes, Pending, SwapParams, ETHEREUM, SOLANA,
  },
  model::{
    apply, counter, flag, mode, Call, Caps, Direction, Effects, Env, Evidence, MakerRecord, ModelError, OpenArgs, Party,
    PayoutArg, PayoutTo, RejectReason, Role, State, SwapState,
  },
  solana::{terms_hash, terms_preimage, OfferTermsHashInput},
};

// ------------------------------------------------------------------ terms

pub fn terms() -> VectorFile {
  let base = OfferTermsHashInput {
    asset: 0,
    direction: 0,
    mode: 0,
    dep_bps: 100,
    fee_bps: SOLANA.fee_bps,
    w_a: 60,
    w_n: 600,
    d_c: 6_060,
    w_c: 1_800,
    w_f: 604_800,
    depth_above: [0, 1_000_000_000_000, 50_000_000_000_000],
    depths: [2, 10, 25],
    w_z: 0,
  };
  let variants: Vec<(&str, OfferTermsHashInput)> = vec![
    ("sol-a-auto", base.clone()),
    ("usdc-a-window", OfferTermsHashInput { asset: 1, mode: 1, ..base.clone() }),
    ("sol-b-advance", OfferTermsHashInput { direction: 1, mode: 2, dep_bps: 500, ..base.clone() }),
    ("one-depth-tier", OfferTermsHashInput { depth_above: [0, 0, 0], depths: [10, 0, 0], d_c: 5_400, ..base.clone() }),
    ("no-deposit", OfferTermsHashInput { dep_bps: 0, ..base.clone() }),
    ("claim-delay-one-second-longer", OfferTermsHashInput { d_c: base.d_c + 1, ..base.clone() }),
    // SPEC 11.6: the freeze window is a term of the offer.
    ("freeze-window-one-hour", OfferTermsHashInput { w_z: 3_600, ..base.clone() }),
    ("freeze-window-one-day", OfferTermsHashInput { w_z: 86_400, ..base.clone() }),
    ("freeze-window-three-days-sell", OfferTermsHashInput { direction: 1, w_z: 259_200, ..base.clone() }),
    (
      "extremes",
      OfferTermsHashInput {
        asset: 1,
        direction: 1,
        mode: 2,
        dep_bps: u16::MAX,
        fee_bps: u16::MAX,
        w_a: u32::MAX,
        w_n: u32::MAX,
        d_c: u32::MAX,
        w_c: u32::MAX,
        w_f: u32::MAX,
        depth_above: [0, u64::MAX - 1, u64::MAX],
        depths: [255, 254, 253],
        w_z: u32::MAX,
      },
    ),
  ];
  let mut cases = Vec::new();
  let mut seen = std::collections::BTreeSet::new();
  for (name, t) in variants {
    let hash = terms_hash(&t);
    assert!(seen.insert(hash), "{name}: terms hash collides with another case");
    cases.push(ok_case(
      name,
      json!({
        "asset": t.asset, "direction": t.direction, "mode": t.mode, "dep_bps": t.dep_bps, "fee_bps": t.fee_bps,
        "w_a": t.w_a, "w_n": t.w_n, "d_c": t.d_c, "w_c": t.w_c, "w_f": t.w_f,
        "depth_above": t.depth_above.map(d), "depths": t.depths, "w_z": t.w_z,
      }),
      json!({ "preimage": h(terms_preimage(&t)), "terms_hash": h(terms_hash(&t)) }),
    ));
  }
  suite(
    "terms",
    cases,
    vec![("layout", json!("SHA256(DS(\"terms\") || asset u8 || direction u8 || mode u8 || dep_bps u16 || fee_bps u16 || w_a || w_n || d_c || w_c || w_f (u32 each) || 3 x (depth_above u64 || depth u8) || w_z u32), little-endian; 58 bytes after the tag"))],
  )
}

// ------------------------------------------------------------------ amounts

pub fn amounts() -> VectorFile {
  let mut cases: Vec<Value> = Vec::new();
  // Every case says which chains' contracts can replay it: a value above u64 cannot be encoded
  // in a Solana instruction, so such a case is Ethereum-only.
  let with_chains = |mut case: Value, chains: &[Chain]| {
    case.as_object_mut().unwrap().insert("chains".into(), json!(chains.iter().map(|c| c.name()).collect::<Vec<_>>()));
    case
  };
  let both = [Chain::Solana, Chain::Ethereum];
  let fits_u64 = |v: u128| v <= u64::MAX as u128;
  let chains_for = |values: &[u128]| if values.iter().all(|v| fits_u64(*v)) { both.to_vec() } else { vec![Chain::Ethereum] };
  let xmr1 = 1_000_000_000_000u64;
  // (name, xmr, price): evaluated as pay (ceil) and receive (floor) under each chain's amount
  // type. A price above u64 exists only as an Ethereum case.
  let prices: Vec<(&str, u64, u128)> = vec![
    ("one-xmr", xmr1, 150_000_000),
    ("one-piconero-at-price-one", 1, 1),
    ("third-of-an-xmr", 333_333_333_333, 3),
    ("exact-division", 333_333_333_333, 3_000_000_000_000),
    ("zero-xmr", 0, 150_000_000),
    ("typical-sol", 2_500_000_000_000, 1_512_345_678),
    ("typical-usdc", 2_500_000_000_000, 165_250_000),
    ("typical-eth", 2_500_000_000_000, 61_234_567_890_123_456),
    ("u64-max-at-10^12", u64::MAX, 1_000_000_000_000),
    ("u64-max-just-over-solana", u64::MAX, 1_000_000_000_001),
    ("u64-max-times-two", u64::MAX, 2_000_000_000_000),
    ("wide-intermediate", u64::MAX, 1u128 << 100),
    ("above-u128", u64::MAX, u128::MAX / 1_000_000),
  ];
  for (name, xmr, price) in &prices {
    for chain in both {
      if chain == Chain::Solana && !fits_u64(*price) {
        continue;
      }
      for (op, f) in [
        ("pay", amounts::pay_amount as fn(u64, u128, &ChainConsts) -> crate::error::Result<u128>),
        ("receive", amounts::receive_amount),
      ] {
        let input = json!({ "op": op, "chain": chain.name(), "xmr": d(xmr), "price": d(price) });
        let case_name = format!("{op}-{name}-{}", chain.name());
        let case = match f(*xmr, *price, chain.consts()) {
          Ok(amount) => ok_case(&case_name, input, json!({ "amount": d(amount) })),
          Err(e) => err_case(&case_name, input, &e.to_string()),
        };
        cases.push(with_chains(case, &[chain]));
      }
    }
  }
  // The amount of a swap (SPEC 3.1): pay in direction A, receive in direction B, and a swap
  // whose xmr or amount is zero is refused. `lock`/`take` must agree.
  let swaps: Vec<(&str, &str, u64, u128)> = vec![
    ("a-one-xmr", "A", xmr1, 150_000_000),
    ("b-one-xmr", "B", xmr1, 150_000_000),
    ("a-zero-xmr", "A", 0, 150_000_000),
    ("b-zero-xmr", "B", 0, 150_000_000),
    ("a-one-piconero-pays-one", "A", 1, 1),
    ("b-dust-take-rounds-to-zero", "B", 1, 1),
    ("b-largest-take-that-rounds-to-zero", "B", 999_999, 1_000_000),
    ("b-smallest-take-that-does-not", "B", 1_000_000, 1_000_000),
    ("a-zero-price", "A", xmr1, 0),
    ("b-zero-price", "B", xmr1, 0),
  ];
  for (name, direction, xmr, price) in &swaps {
    for chain in both {
      let input = json!({ "op": "swap", "chain": chain.name(), "direction": direction, "xmr": d(xmr), "price": d(price) });
      let case_name = format!("swap-{name}-{}", chain.name());
      let case = match amounts::swap_amount(*direction == "A", *xmr, *price, chain.consts()) {
        Ok(amount) => ok_case(&case_name, input, json!({ "amount": d(amount) })),
        Err(e) => err_case(&case_name, input, &e.to_string()),
      };
      cases.push(with_chains(case, &[chain]));
    }
  }
  for (amount, bps) in [(1_000_000u128, 500u16), (19_999, 500), (1_999, 5), (2_000, 5), (0, 500), (1, 1), (u64::MAX as u128, 500), (u128::MAX, 500), (u128::MAX, 5), (123_456_789_012_345_678, 137)] {
    cases.push(with_chains(
      ok_case(
        &format!("bps-{amount}-{bps}"),
        json!({ "op": "bps", "amount": d(amount), "bps": bps }),
        json!({ "result": d(amounts::bps_of(amount, bps)) }),
      ),
      &chains_for(&[amount]),
    ));
  }
  for deposit in [0u128, 1, 2, 7, 8, 15_000_001, u64::MAX as u128, u128::MAX] {
    let (taker, treasury) = amounts::split_of(deposit);
    cases.push(with_chains(
      ok_case(
        &format!("split-{deposit}"),
        json!({ "op": "split", "deposit": d(deposit) }),
        json!({ "to_taker": d(taker), "to_treasury": d(treasury) }),
      ),
      &chains_for(&[deposit]),
    ));
  }
  // Tiers: "the highest used tier with xmr >= tier threshold"; value 0 = unused; unused trail.
  let tier_case = |cases: &mut Vec<Value>, name: &str, xmr: u64, above: [u64; 3], values: [u64; 3]| {
    let input = json!({ "op": "tier", "xmr": d(xmr), "above": above.map(d), "values": values.map(d) });
    let case = match tier_value(xmr, &above, &values) {
      Some(v) => ok_case(name, input, json!({ "value": d(v) })),
      None => err_case(name, input, "TiersInvalid"),
    };
    cases.push(with_chains(case, &both));
  };
  let above = [0, xmr1, 50 * xmr1];
  for (name, xmr) in [("zero", 0), ("below-tier-1", xmr1 - 1), ("at-tier-1", xmr1), ("below-tier-2", 50 * xmr1 - 1), ("at-tier-2", 50 * xmr1), ("max", u64::MAX)] {
    tier_case(&mut cases, &format!("tier-three-{name}"), xmr, above, [2, 10, 25]);
  }
  tier_case(&mut cases, "tier-two-used", u64::MAX, [0, 5, 0], [7, 9, 0]);
  tier_case(&mut cases, "tier-one-used", 4, [0, 0, 0], [7, 0, 0]);
  tier_case(&mut cases, "tier-unused-threshold-ignored", 9, [0, 5, 9], [1, 2, 0]);
  tier_case(&mut cases, "tier-first-threshold-nonzero", 9, [1, 5, 9], [1, 2, 3]);
  tier_case(&mut cases, "tier-zero-unused", 9, [0, 5, 9], [0, 2, 3]);
  tier_case(&mut cases, "tier-gap", 9, [0, 0, 9], [1, 0, 3]);
  tier_case(&mut cases, "tier-equal-thresholds", 9, [0, 5, 5], [1, 2, 3]);
  tier_case(&mut cases, "tier-decreasing-thresholds", 9, [0, 5, 4], [1, 2, 3]);
  // Exactly seven cases are Ethereum-only because a value exceeds u64: four pay/receive, two
  // bps, one split.
  let over_u64 = cases
    .iter()
    .filter(|c| c["chains"] == json!(["ethereum"]) && c["input"].as_object().unwrap().values().any(|v| v.as_str().and_then(|s| s.parse::<u128>().ok()).is_some_and(|n| n > u64::MAX as u128)))
    .count();
  assert_eq!(over_u64, 7);
  suite(
    "amounts",
    cases,
    vec![(
      "rules",
      json!({
        "pay": "direction A: ceil(xmr * price / 10^12)",
        "receive": "direction B: floor(xmr * price / 10^12)",
        "swap": "the escrowed amount of a swap: pay (A) or receive (B); refused with AmountOutOfRange when xmr or the amount is zero",
        "bps": "floor(amount * bps / 10^4): the deposit and the fee",
        "split": "ceil(D / 2) to the taker, floor(D / 2) to the treasury",
        "chains": "which chains' contracts can replay the case; a value above u64 cannot be encoded on Solana",
        "max_amount": { "solana": d(SOLANA.max_amount), "ethereum": d(ETHEREUM.max_amount) },
      }),
    )],
  )
}

// ------------------------------------------------------------------ deadlines

fn consts_json(c: &ChainConsts) -> Value {
  json!({
    "FEE_BPS": c.fee_bps, "MAX_DEPOSIT_BPS": c.max_deposit_bps, "HOLD_SECS": c.hold_secs, "SPLIT_SECS": c.split_secs,
    "EXPIRY_SECS": c.expiry_secs, "BLOCK_ALLOWANCE_SECS": c.block_allowance_secs, "CUT_MARGIN_SECS": c.cut_margin_secs,
    "MARGIN_SECS": c.margin_secs, "FINALITY_SECS": c.finality_secs, "MIN_NOTICE_SECS": c.min_notice_secs,
    "MAX_NOTICE_SECS": c.max_notice_secs, "MIN_CLAIM_DELAY_SECS": c.min_claim_delay_secs,
    "MIN_APPROVAL_SECS": amounts::MIN_APPROVAL_SECS, "MAX_APPROVAL_SECS": c.max_approval_secs,
    "MAX_FINAL_SECS": c.max_final_secs, "READY_MIN_SECS_PER_CONF": c.ready_min_secs_per_conf,
    "CLOSE_GRACE_SECS": c.close_grace_secs, "LINK_DELAY_SECS": c.link_delay_secs, "MAX_OPEN_PENDING": c.max_open_pending,
    "EXPLICIT_APPROVE": c.explicit_approve, "OPEN_SECRET_CALLS": c.open_secret_calls, "LAPSE_IS_FAULT": c.lapse_is_fault,
    "MIN_FREEZE_SECS": amounts::MIN_FREEZE_SECS, "MAX_FREEZE_SECS": amounts::MAX_FREEZE_SECS,
  })
}
fn params_json(p: &SwapParams) -> Value {
  json!({ "w_a": p.w_a, "w_n": p.w_n, "d_c": p.d_c, "w_c": p.w_c, "w_f": p.w_f, "depth": p.depth, "dep_bps": p.dep_bps, "w_z": p.w_z })
}
fn pending_name(p: Pending) -> &'static str {
  match p {
    Pending::None => "none",
    Pending::ApprovalWindow => "approval",
    Pending::FundingWindow => "funding",
  }
}

/// Per-chain parameters used across the suites: the daemon defaults at depth 10.
pub(crate) fn canonical(chain: Chain) -> SwapParams {
  match chain {
    Chain::Solana => SwapParams { w_a: 60, w_n: 600, d_c: 5_400, w_c: 1_800, w_f: 604_800, depth: 10, dep_bps: 100, w_z: 0 },
    Chain::Ethereum => SwapParams { w_a: 120, w_n: 1_800, d_c: 10_800, w_c: 5_400, w_f: 604_800, depth: 10, dep_bps: 100, w_z: 0 },
  }
}
pub(crate) fn canonical_amount(chain: Chain) -> u128 {
  match chain {
    Chain::Solana => 1_500_000_000,              // 1.5 SOL: D = 15,000,000, fee = 750,000
    Chain::Ethereum => 122_000_000_000_000_000,  // 0.122 ETH: D = 1.22e15, fee = 6.1e13
  }
}
pub(crate) const T0: i64 = 1_800_000_000;
/// The size of the canonical swap: 1 XMR.
pub(crate) const CANONICAL_XMR: u64 = 1_000_000_000_000;
/// The freeze window of the watched swaps in the suites: 24 hours.
pub(crate) const FREEZE_SECS: u32 = 86_400;

pub fn deadlines() -> VectorFile {
  let mut cases = Vec::new();
  for chain in [Chain::Solana, Chain::Ethereum] {
    let c = chain.consts();
    let ok = canonical(chain);
    let mut bounds = |name: &str, p: SwapParams, pending: Pending| {
      let input = json!({ "op": "bounds", "chain": chain.name(), "pending": pending_name(pending), "params": params_json(&p) });
      let name = format!("{}-{name}", chain.name());
      match check_bounds(&p, pending, c) {
        Ok(()) => cases.push(ok_case(
          &name,
          input,
          json!({
            "w_p": pending_window(&p, pending),
            "delta_cut": delta_cut(p.depth, c),
            "min_claim_delay": min_claim_delay(p.depth, c),
            "min_claim_window": min_claim_window(c),
            "min_final_window": min_final_window(&p, pending_window(&p, pending)),
          }),
        )),
        Err(e) => cases.push(err_case(&name, input, ModelError::Bound(e).name())),
      }
    };
    use Pending::*;
    bounds("defaults-active", ok, None);
    bounds("defaults-approval", ok, ApprovalWindow);
    bounds("defaults-funding", ok, FundingWindow);
    // Each bound at its edge and one step past it.
    bounds("deposit-at-cap", SwapParams { dep_bps: c.max_deposit_bps, ..ok }, None);
    bounds("deposit-over-cap", SwapParams { dep_bps: c.max_deposit_bps + 1, ..ok }, None);
    bounds("approval-window-30", SwapParams { w_a: 30, ..ok }, ApprovalWindow);
    bounds("approval-window-29", SwapParams { w_a: 29, ..ok }, ApprovalWindow);
    bounds("approval-window-at-cap", SwapParams { w_a: c.max_approval_secs, ..ok }, ApprovalWindow);
    bounds("approval-window-over-cap", SwapParams { w_a: c.max_approval_secs + 1, ..ok }, ApprovalWindow);
    bounds("approval-window-unchecked-when-active", SwapParams { w_a: 0, ..ok }, None);
    bounds("approval-window-unchecked-when-funding", SwapParams { w_a: 0, ..ok }, FundingWindow);
    bounds("notice-window-at-floor", SwapParams { w_n: c.min_notice_secs, ..ok }, None);
    bounds("notice-window-below-floor", SwapParams { w_n: c.min_notice_secs - 1, ..ok }, None);
    bounds("notice-window-at-cap", SwapParams { w_n: c.max_notice_secs, ..ok }, None);
    bounds("notice-window-over-cap", SwapParams { w_n: c.max_notice_secs + 1, ..ok }, None);
    bounds("depth-zero", SwapParams { depth: 0, ..ok }, None);
    for depth in [1u8, 2, 10, 25, 255] {
      let floor = min_claim_delay(depth, c) as u32;
      bounds(&format!("claim-delay-at-floor-depth-{depth}"), SwapParams { depth, d_c: floor, ..ok }, None);
      bounds(&format!("claim-delay-below-floor-depth-{depth}"), SwapParams { depth, d_c: floor - 1, ..ok }, None);
    }
    let wc = min_claim_window(c) as u32;
    bounds("claim-window-at-floor", SwapParams { w_c: wc, ..ok }, None);
    bounds("claim-window-below-floor", SwapParams { w_c: wc - 1, ..ok }, None);
    for pending in [None, ApprovalWindow, FundingWindow] {
      let floor = min_final_window(&ok, pending_window(&ok, pending)) as u32;
      bounds(&format!("final-window-at-floor-{}", pending_name(pending)), SwapParams { w_f: floor, ..ok }, pending);
      bounds(&format!("final-window-below-floor-{}", pending_name(pending)), SwapParams { w_f: floor - 1, ..ok }, pending);
    }
    bounds("final-window-at-cap", SwapParams { w_f: c.max_final_secs, ..ok }, None);
    bounds("final-window-over-cap", SwapParams { w_f: c.max_final_secs + 1, ..ok }, None);
    // SPEC 11.6: the freeze window is zero or within [MIN_FREEZE_SECS, MAX_FREEZE_SECS], and it
    // extends the final-window bound.
    bounds("freeze-window-one", SwapParams { w_z: 1, ..ok }, None);
    bounds("freeze-window-below-floor", SwapParams { w_z: amounts::MIN_FREEZE_SECS - 1, ..ok }, None);
    bounds("freeze-window-at-floor", SwapParams { w_z: amounts::MIN_FREEZE_SECS, ..ok }, None);
    bounds("freeze-window-one-day", SwapParams { w_z: 86_400, ..ok }, ApprovalWindow);
    bounds("freeze-window-at-cap", SwapParams { w_z: amounts::MAX_FREEZE_SECS, ..ok }, None);
    bounds("freeze-window-over-cap", SwapParams { w_z: amounts::MAX_FREEZE_SECS + 1, ..ok }, None);
    for pending in [None, ApprovalWindow, FundingWindow] {
      let frozen = SwapParams { w_z: amounts::MAX_FREEZE_SECS, ..ok };
      let floor = min_final_window(&frozen, pending_window(&frozen, pending)) as u32;
      assert_eq!(floor, min_final_window(&ok, pending_window(&ok, pending)) as u32 + amounts::MAX_FREEZE_SECS);
      bounds(&format!("freeze-window-final-window-at-floor-{}", pending_name(pending)), SwapParams { w_f: floor, ..frozen }, pending);
      bounds(&format!("freeze-window-final-window-below-floor-{}", pending_name(pending)), SwapParams { w_f: floor - 1, ..frozen }, pending);
    }
    // A freeze window out of range is reported before a final window it would also break.
    bounds("freeze-window-over-cap-and-final-window-too-short", SwapParams { w_z: amounts::MAX_FREEZE_SECS + 1, w_f: 100_000, ..ok }, None);

    // Deadline derivation from event times.
    let mut derive = |name: &str, p: SwapParams, pending: Pending, t: EventTimes| {
      assert_eq!(check_bounds(&p, pending, c), Ok(()));
      let dl = derive_deadlines(&p, pending, &t, c);
      cases.push(ok_case(
        &format!("{}-{name}", chain.name()),
        json!({
          "op": "derive", "chain": chain.name(), "pending": pending_name(pending), "params": params_json(&p),
          "t_lock": t.t_lock, "t_active": t.t_active, "t_notice": t.t_notice, "t_ready": t.t_ready, "t_refund": t.t_refund,
          "t_freeze": t.t_freeze,
        }),
        json!({
          "t_pend": dl.t_pend, "t_note": dl.t_note, "t_cut": dl.t_cut, "t_co": dl.t_co, "t_ready_min": dl.t_ready_min, "t_ff": dl.t_ff,
          "t_cd": dl.t_cd, "t_final": dl.t_final, "t_nl": dl.t_nl, "t_exp": dl.t_exp, "t_hold": dl.t_hold, "t_split": dl.t_split,
        }),
      ));
      dl
    };
    derive("derive-at-lock-active", ok, None, EventTimes { t_lock: T0, t_active: Some(T0), ..Default::default() });
    derive("derive-at-lock-pending", ok, ApprovalWindow, EventTimes { t_lock: T0, ..Default::default() });
    derive("derive-at-take-funding", ok, FundingWindow, EventTimes { t_lock: T0, ..Default::default() });
    derive(
      "derive-full",
      ok,
      ApprovalWindow,
      EventTimes { t_lock: T0, t_active: Some(T0 + 20), t_notice: Some(T0 + 120), t_ready: Some(T0 + 2_000), t_refund: Some(T0 + 4_000), t_freeze: Option::None },
    );
    // The extreme of SPEC 3.2: direction B funded at the last second with W_n at its cap and the
    // smallest final window, a notice at the last second, ready at the last second.
    for depth in [2u8, 10, 25] {
      let mut p = SwapParams { w_n: c.max_notice_secs, d_c: min_claim_delay(depth, c) as u32, w_c: min_claim_window(c) as u32, depth, ..ok };
      let pending = if c.explicit_approve { ApprovalWindow } else { FundingWindow };
      p.w_f = min_final_window(&p, pending_window(&p, pending)) as u32;
      let d0 = derive_deadlines(&p, pending, &EventTimes { t_lock: T0, ..Default::default() }, c);
      let t_active = d0.t_pend.unwrap() - 1;
      let t_notice = d0.t_nl - 1;
      let t_ready = t_notice + p.d_c as i64 - 1;
      let dl = derive(
        &format!("derive-extreme-depth-{depth}"),
        p,
        pending,
        EventTimes { t_lock: T0, t_active: Some(t_active), t_notice: Some(t_notice), t_ready: Some(t_ready), t_refund: Option::None, t_freeze: Option::None },
      );
      // The order the contracts rely on.
      assert!(dl.t_note.unwrap() <= dl.t_nl);
      assert!(t_notice < dl.t_cut.unwrap() && dl.t_cut.unwrap() <= dl.t_co.unwrap() - 2 * c.margin_secs);
      assert!(dl.t_cd.unwrap() < dl.t_final - amounts::DAY_SECS && dl.t_final < dl.t_exp);
      // SPEC 11.6, the same extreme with the freeze window at its cap: a freeze at T_co − 1 and
      // a ready at T_ff − 1.
      let mut z = SwapParams { w_z: amounts::MAX_FREEZE_SECS, ..p };
      z.w_f = min_final_window(&z, pending_window(&z, pending)) as u32;
      let d0 = derive_deadlines(&z, pending, &EventTimes { t_lock: T0, ..Default::default() }, c);
      let t_active = d0.t_pend.unwrap() - 1;
      let t_notice = d0.t_nl - 1;
      let t_freeze = t_notice + z.d_c as i64 - 1;
      let t_ready = t_freeze + z.w_z as i64 - 1;
      let dl = derive(
        &format!("derive-extreme-frozen-depth-{depth}"),
        z,
        pending,
        EventTimes { t_lock: T0, t_active: Some(t_active), t_notice: Some(t_notice), t_freeze: Some(t_freeze), t_ready: Some(t_ready), t_refund: Option::None },
      );
      assert!(dl.t_note.unwrap() <= dl.t_nl);
      assert!(t_freeze < dl.t_co.unwrap());
      // T_ff < T_co + W_z < T_final − W_c − 86,400; T_cd < T_final − 86,400.
      assert!(dl.t_ff.unwrap() < dl.t_co.unwrap() + z.w_z as i64);
      assert!(dl.t_co.unwrap() + (z.w_z as i64) < dl.t_final - z.w_c as i64 - amounts::DAY_SECS);
      assert!(t_ready < dl.t_ff.unwrap() && dl.t_cd.unwrap() < dl.t_final - amounts::DAY_SECS);
    }
  }
  suite(
    "deadlines",
    cases,
    vec![
      ("constants", json!({ "solana": consts_json(&SOLANA), "ethereum": consts_json(&ETHEREUM) })),
      (
        "formulas",
        json!({
          "delta_cut": "FINALITY_SECS + depth * BLOCK_ALLOWANCE_SECS + CUT_MARGIN_SECS",
          "min_claim_delay": "max(MIN_CLAIM_DELAY_SECS, delta_cut + 2 * MARGIN_SECS)",
          "min_claim_window": "FINALITY_SECS + 2 * MARGIN_SECS",
          "min_final_window": "w_p + w_n + d_c + w_z + w_c + 86400",
          "freeze_window": "w_z == 0 (no watcher accepted) or MIN_FREEZE_SECS <= w_z <= MAX_FREEZE_SECS",
          "t_ff": "max(t_freeze + w_z, t_co): a freeze never opens the claim earlier than t_co",
          "w_p": "none: 0; approval: w_a; funding: w_n",
          "t_pend": "t_lock + w_p", "t_note": "t_active + w_n", "t_cut": "t_notice + delta_cut", "t_co": "t_notice + d_c",
          "t_ready_min": "t_notice + depth * READY_MIN_SECS_PER_CONF", "t_cd": "t_ready + w_c", "t_final": "t_lock + w_f",
          "t_nl": "t_final - d_c - w_z - w_c - 86400", "t_exp": "t_final + EXPIRY_SECS", "t_hold": "t_refund + HOLD_SECS",
          "t_split": "t_refund + SPLIT_SECS",
        }),
      ),
      ("bound_check_order", json!(["DepositTooHigh", "ApprovalWindowOutOfRange", "NoticeWindowOutOfRange", "DepthInvalid", "ClaimDelayTooShort", "ClaimWindowTooShort", "FreezeWindowOutOfRange", "FinalWindowOutOfRange"])),
    ],
  )
}

// ------------------------------------------------------------------ transitions

/// A deadline or event time of a swap, resolved against its current record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Anchor {
  Lock,
  Pend,
  Active,
  Note,
  Notice,
  ReadyMin,
  Cut,
  Co,
  Ready,
  Cd,
  Final,
  Nl,
  Exp,
  Refund,
  Hold,
  Split,
  /// `t_Z`, the freeze time.
  Freeze,
  /// `T_ff = max(t_Z + W_z, T_co)`.
  Ff,
}
impl Anchor {
  fn name(self) -> &'static str {
    match self {
      Anchor::Lock => "t_lock",
      Anchor::Pend => "T_pend",
      Anchor::Active => "t_A",
      Anchor::Note => "T_note",
      Anchor::Notice => "t_N",
      Anchor::ReadyMin => "T_ready_min",
      Anchor::Cut => "T_cut",
      Anchor::Co => "T_co",
      Anchor::Ready => "t_R",
      Anchor::Cd => "T_cd",
      Anchor::Final => "T_final",
      Anchor::Nl => "T_nl",
      Anchor::Exp => "T_exp",
      Anchor::Refund => "t_refund",
      Anchor::Hold => "T_hold",
      Anchor::Split => "T_split",
      Anchor::Freeze => "t_Z",
      Anchor::Ff => "T_ff",
    }
  }
  fn resolve(self, s: &SwapState, c: &ChainConsts) -> i64 {
    let set = |t: i64| {
      assert!(t != 0, "anchor {} is not set in state {:?}", self.name(), s.state);
      t
    };
    match self {
      Anchor::Lock => s.t_lock,
      Anchor::Pend => set(s.t_pending_deadline),
      Anchor::Active => set(s.t_active),
      Anchor::Note => set(s.t_note_deadline),
      Anchor::Notice => set(s.t_notice),
      Anchor::ReadyMin => {
        set(s.t_notice);
        s.t_ready_min(c)
      }
      Anchor::Cut => set(s.t_cut),
      Anchor::Co => set(s.t_claim_open),
      Anchor::Ready => set(s.t_ready),
      Anchor::Cd => set(s.t_claim_deadline),
      Anchor::Final => s.t_final,
      Anchor::Nl => s.t_nl(),
      Anchor::Exp => s.t_exp(c),
      Anchor::Refund => set(s.t_refund),
      Anchor::Hold => {
        set(s.t_refund);
        s.t_hold(c)
      }
      Anchor::Split => {
        set(s.t_refund);
        s.t_split(c)
      }
      Anchor::Freeze => set(s.t_freeze),
      Anchor::Ff => {
        set(s.t_freeze);
        s.t_ff()
      }
    }
  }
}

#[derive(Clone, Copy)]
struct Step {
  call: Call,
  caller: Role,
  anchor: Anchor,
  offset: i64,
  env: Env,
}
fn step(call: Call, caller: Role, anchor: Anchor, offset: i64) -> Step {
  Step { call, caller, anchor, offset, env: Env::OK }
}
impl Step {
  fn env(mut self, env: Env) -> Self {
    self.env = env;
    self
  }
}

const REFUND: Call = Call::Refund { secret_ok: true };
const CLAIM: Call = Call::Claim { secret_ok: true };
const APPROVE: Call = Call::Approve { open_ok: true };
const FUND: Call = Call::Fund { open_ok: true, watcher: false };
const FUND_WATCHED: Call = Call::Fund { open_ok: true, watcher: true };
fn reject(reason: RejectReason) -> Call {
  Call::Reject { open_ok: true, reason }
}

use crate::model_json::{call_args, dir_name, env_json, expect_json, maker_json, swap_json};

/// A scripted swap on one chain.
struct Run {
  chain: Chain,
  c: &'static ChainConsts,
  state: SwapState,
  maker: MakerRecord,
  /// The asset's open value (SPEC 11.1): every step's `env.caps.open_value` is this.
  open_value: u128,
  now: i64,
}
impl Run {
  fn new(chain: Chain) -> Self {
    Run { chain, c: chain.consts(), state: SwapState::NONE, maker: MakerRecord::default(), open_value: 0, now: T0 }
  }
  /// Run one call; on success the swap and the maker record advance. Returns the step as JSON.
  fn exec(&mut self, call: Call, caller: Role, at: i64, anchor: Option<(Anchor, i64)>, env: &Env, with_maker: bool) -> (Value, Result<Effects, ModelError>) {
    assert!(at >= self.now, "{}: time runs backwards ({} < {})", call.name(), at, self.now);
    self.now = at;
    let mut env = *env;
    if matches!(call, Call::Open(_)) {
      env.open_pending = self.maker.open_pending;
    }
    env.caps.open_value = self.open_value;
    let result = apply(self.state, call, caller, at, &env, self.c);
    if let Ok(fx) = &result {
      self.state = fx.state;
      self.maker.record(fx, self.c.max_amount);
      self.open_value = fx.open_value_after;
    }
    let mut v = json!({
      "call": call.name(), "args": call_args(&call), "caller": caller.name(), "at": at, "env": env_json(&env),
      "expect": expect_json(&result, self.chain, with_maker.then_some(&self.maker)),
    });
    if let Some((a, off)) = anchor {
      v.as_object_mut().unwrap().insert("anchor".into(), json!({ "name": a.name(), "offset": off }));
    }
    (v, result)
  }
  fn step(&mut self, s: &Step, with_maker: bool) -> (Value, Result<Effects, ModelError>) {
    let at = s.anchor.resolve(&self.state, self.c) + s.offset;
    self.exec(s.call, s.caller, at, Some((s.anchor, s.offset)), &s.env, with_maker)
  }
}

/// Where a row starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
  /// PENDING. `window`: the offer is in window mode.
  Pending { window: bool },
  /// PENDING in direction B against an offer with a freeze window.
  PendingFreeze,
  Active,
  Noticed { late: bool },
  Ready,
  AbortedFree,
  AbortedHold,
  /// HOLD after a refund; `notice`: a lock notice is on record.
  Hold { notice: bool },
  Withheld { notice: bool },
  /// ACTIVE, NOTICED and READY of a swap with a freeze window that names a watcher.
  ActiveWatched,
  NoticedWatched,
  ReadyWatched,
  /// NOTICED with a freeze window but no watcher named.
  NoticedUnwatched,
  /// FROZEN by the watcher ten seconds after the notice.
  Frozen,
  /// FROZEN ten seconds after the notice against the shortest freeze window, which ends before
  /// `T_co`: `T_ff` is then `T_co`, because a freeze never opens the claim earlier.
  FrozenShort,
}
impl Target {
  fn label(self) -> String {
    match self {
      Target::Pending { window: true } => "PENDING (window mode)".into(),
      Target::Pending { window: false } => "PENDING".into(),
      Target::PendingFreeze => "PENDING (freeze window)".into(),
      Target::Active => "ACTIVE".into(),
      Target::Noticed { late: false } => "NOTICED".into(),
      Target::Noticed { late: true } => "NOTICED (late notice)".into(),
      Target::Ready => "READY".into(),
      Target::AbortedFree => "ABORTED_FREE".into(),
      Target::AbortedHold => "ABORTED_HOLD".into(),
      Target::Hold { notice: true } => "HOLD".into(),
      Target::Hold { notice: false } => "HOLD (no notice on record)".into(),
      Target::Withheld { notice: true } => "WITHHELD".into(),
      Target::Withheld { notice: false } => "WITHHELD (no notice on record)".into(),
      Target::ActiveWatched => "ACTIVE (watcher named)".into(),
      Target::NoticedWatched => "NOTICED (watcher named)".into(),
      Target::ReadyWatched => "READY (watcher named)".into(),
      Target::NoticedUnwatched => "NOTICED (freeze window, no watcher named)".into(),
      Target::Frozen => "FROZEN".into(),
      Target::FrozenShort => "FROZEN (t_Z + W_z before T_co)".into(),
    }
  }
}

fn open_args(chain: Chain, direction: Direction, offer_mode: u8, approval: bool, dep_bps: Option<u16>) -> OpenArgs {
  let mut params = canonical(chain);
  if let Some(b) = dep_bps {
    params.dep_bps = b;
  }
  OpenArgs { direction, offer_mode, approval, xmr: CANONICAL_XMR, amount: canonical_amount(chain), params, payout: PayoutArg::Taker, watcher: false }
}

/// The open call and the steps that bring a fresh swap to `target`.
fn reach(chain: Chain, dir: Direction, target: Target, dep_bps: Option<u16>) -> (OpenArgs, Vec<Step>) {
  use Direction::*;
  let (claimer, locker) = match dir {
    A => (Role::Operator, Role::Session),
    B => (Role::Session, Role::Operator),
  };
  let window = matches!(target, Target::Pending { window: true });
  let mut open = open_args(chain, dir, if window { mode::WINDOW } else { mode::AUTO }, false, dep_bps);
  let watched = matches!(target, Target::ActiveWatched | Target::NoticedWatched | Target::ReadyWatched | Target::Frozen | Target::FrozenShort);
  if watched || matches!(target, Target::NoticedUnwatched | Target::PendingFreeze) {
    open.params.w_z = FREEZE_SECS;
  }
  if target == Target::FrozenShort {
    open.params.w_z = amounts::MIN_FREEZE_SECS;
    assert!(amounts::MIN_FREEZE_SECS + 10 < open.params.d_c, "the short freeze window ends before T_co");
  }
  // Direction A names the watcher at lock, direction B at fund.
  open.watcher = watched && dir == A;
  let mut steps = Vec::new();
  if matches!(target, Target::Pending { .. } | Target::PendingFreeze) {
    return (open, steps);
  }
  // Leave PENDING if the swap starts there (always on Ethereum; direction B on Solana).
  let starts_pending = chain.consts().explicit_approve || dir == B;
  if starts_pending {
    steps.push(step(if dir == A { APPROVE } else if watched { FUND_WATCHED } else { FUND }, Role::Operator, Anchor::Lock, 20));
  }
  let notice = |late: bool| if late { step(Call::PostNotice, claimer, Anchor::Note, 50) } else { step(Call::PostNotice, claimer, Anchor::Active, 100) };
  match target {
    Target::Pending { .. } | Target::PendingFreeze => unreachable!(),
    Target::Active | Target::ActiveWatched => {}
    Target::Noticed { late } => steps.push(notice(late)),
    Target::NoticedWatched | Target::NoticedUnwatched => steps.push(notice(false)),
    Target::Frozen | Target::FrozenShort => {
      steps.push(notice(false));
      steps.push(step(Call::Freeze, Role::Watcher, Anchor::Notice, 10));
    }
    Target::Ready | Target::ReadyWatched => {
      steps.push(notice(false));
      steps.push(step(Call::SetReady, locker, Anchor::ReadyMin, 300));
    }
    Target::AbortedFree => {
      assert_eq!(dir, A, "ABORTED_FREE exists only in direction A");
      steps.push(notice(false));
      steps.push(step(Call::Abort, claimer, Anchor::Notice, 200));
    }
    Target::AbortedHold => {
      steps.push(notice(false));
      steps.push(if dir == A { step(Call::Abort, claimer, Anchor::Co, 10) } else { step(Call::Abort, claimer, Anchor::Notice, 200) });
    }
    Target::Hold { notice: with_notice } | Target::Withheld { notice: with_notice } => {
      match (dir, with_notice) {
        (A, true) => {
          steps.push(notice(false));
          steps.push(step(REFUND, locker, Anchor::Notice, 300)); // A10b
        }
        (A, false) => steps.push(step(REFUND, locker, Anchor::Active, 50)), // A10a
        (B, true) => {
          steps.push(notice(false));
          steps.push(step(REFUND, locker, Anchor::Cut, 10)); // B9d
        }
        (B, false) => steps.push(step(REFUND, locker, Anchor::Note, 10)), // B9b
      }
      if matches!(target, Target::Withheld { .. }) {
        let evidence = if dir == A && with_notice { Evidence::Opens } else { Evidence::Absent };
        steps.push(step(Call::Withhold(evidence), Role::Operator, Anchor::Refund, 60));
      }
    }
  }
  (open, steps)
}

/// One group of rows: a call from a state, tried at several instants and by several callers.
struct RowSpec {
  id: &'static str,
  dir: Direction,
  target: Target,
  dep_bps: Option<u16>,
  call: Call,
  /// Callers the row is tried with at every point.
  callers: Vec<Role>,
  /// Instants: (anchor, offset).
  points: Vec<(Anchor, i64)>,
  /// Other callers, tried at the first point only (wrong-caller cases).
  others: Vec<Role>,
  /// Environment for the call (pay-or-park).
  env: Env,
}
fn spec(id: &'static str, dir: Direction, target: Target, call: Call, caller: Role, points: &[(Anchor, i64)]) -> RowSpec {
  RowSpec { id, dir, target, dep_bps: None, call, callers: vec![caller], points: points.to_vec(), others: vec![], env: Env::OK }
}
impl RowSpec {
  fn also(mut self, caller: Role) -> Self {
    self.callers.push(caller);
    self
  }
  fn others(mut self, roles: &[Role]) -> Self {
    self.others = roles.to_vec();
    self
  }
  fn no_deposit(mut self) -> Self {
    self.dep_bps = Some(0);
    self
  }
  fn env(mut self, env: Env) -> Self {
    self.env = env;
    self
  }
}

/// SPEC 11.1, invariant 3: every cap zero with the switch on, and the maker paused. (A replay
/// also bumps both epochs, which the model has no notion of: they concern offers and approvals.)
const HOSTILE: Env = Env { caps: Caps::INITIAL, maker_paused: true, ..Env::OK };

fn row_specs(chain: Chain) -> Vec<RowSpec> {
  use Anchor::*;
  use Direction::{A, B};
  use Role::{Anyone, Operator, Owner, Session, TakerWallet};
  let _ = Owner;
  let pend_w = Target::Pending { window: true };
  let pend = Target::Pending { window: false };
  let active = Target::Active;
  let noticed = Target::Noticed { late: false };
  let late = Target::Noticed { late: true };
  let ready = Target::Ready;
  let aborted_free = Target::AbortedFree;
  let aborted_hold = Target::AbortedHold;
  let hold = Target::Hold { notice: true };
  let hold_nn = Target::Hold { notice: false };
  let withheld = Target::Withheld { notice: true };
  let bad_refund = Call::Refund { secret_ok: false };
  let bad_claim = Call::Claim { secret_ok: false };
  let mut v = vec![
    // ---------------------------------------------------------------- direction A (SPEC 3.4)
    spec("A2", A, pend_w, APPROVE, Operator, &[(Lock, 0), (Pend, -1), (Pend, 0)]).others(&[TakerWallet, Session, Anyone]),
    spec("A2 stale open hash", A, pend_w, Call::Approve { open_ok: false }, Operator, &[(Lock, 5)]),
    spec("A2 not pending", A, active, APPROVE, Operator, &[(Active, 5)]),
    spec("A3 reason 0", A, pend_w, reject(RejectReason::MakerChoice), Operator, &[(Lock, 5), (Pend, 100)]).others(&[TakerWallet, Session, Anyone]),
    spec("A3 reason 1", A, pend_w, reject(RejectReason::UnusableInput), Operator, &[(Lock, 5)]),
    spec("A3 reason 2", A, pend_w, reject(RejectReason::LeafConsumed), Operator, &[(Lock, 5)]),
    spec("A3 stale open hash", A, pend_w, Call::Reject { open_ok: false, reason: RejectReason::MakerChoice }, Operator, &[(Lock, 5)]),
    spec("A4", A, pend_w, Call::CancelPending, TakerWallet, &[(Lock, 0), (Pend, 9)]).also(Session).others(&[Operator, Anyone]),
    spec("A4 not pending", A, active, Call::CancelPending, Session, &[(Active, 5)]),
    spec("A5", A, pend_w, Call::ExpirePending, Anyone, &[(Pend, -1), (Pend, 0), (Pend, 500)]).also(Operator),
    spec("A6", A, active, Call::PostNotice, Operator, &[(Active, 0), (Note, -1), (Note, 0)]).others(&[TakerWallet, Session, Anyone]),
    spec("A6 twice", A, noticed, Call::PostNotice, Operator, &[(Notice, 1)]),
    spec("A7a", A, active, Call::Abort, Operator, &[(Active, 0), (Note, -1), (Note, 0)]).others(&[TakerWallet, Session, Anyone]),
    spec("A7b/A7c", A, noticed, Call::Abort, Operator, &[(Notice, 0), (Co, -1), (Co, 0), (Final, -1), (Final, 0)]),
    spec("A7d", A, ready, Call::Abort, Operator, &[(Ready, 0), (Final, -1), (Final, 0)]),
    spec("A7 twice", A, aborted_free, Call::Abort, Operator, &[(Notice, 400)]),
    spec("A8", A, active, Call::RefundUnnoticed, Anyone, &[(Note, -1), (Note, 0), (Final, 5)]).also(TakerWallet),
    spec("A8 after a notice", A, noticed, Call::RefundUnnoticed, Anyone, &[(Note, 0)]),
    spec("A9", A, noticed, Call::SetReady, Session, &[(ReadyMin, -1), (ReadyMin, 0), (Co, -1), (Co, 0)]).also(TakerWallet).others(&[Operator, Anyone]),
    spec("A9 not noticed", A, active, Call::SetReady, Session, &[(Active, 700)]),
    spec("A10a/A10g", A, active, REFUND, Session, &[(Active, 0), (Note, -1), (Note, 0), (Final, 1)]).also(TakerWallet).others(&[Operator, Anyone]),
    spec("A10 wrong secret", A, active, bad_refund, Session, &[(Active, 0)]),
    spec("A10 while pending", A, pend_w, REFUND, Session, &[(Lock, 5)]),
    spec("A10b/A10f", A, noticed, REFUND, Session, &[(Notice, 0), (Co, -1), (Co, 0), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("A10c/A10f", A, aborted_hold, REFUND, Session, &[(Co, 20), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("A10d/A10f", A, aborted_free, REFUND, Session, &[(Notice, 300), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("A10e/A10f", A, ready, REFUND, Session, &[(Ready, 1), (Cd, -1), (Cd, 0), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("A11a/A11c", A, ready, CLAIM, Operator, &[(Ready, 0), (Cd, -1), (Cd, 0), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]).others(&[TakerWallet, Session, Anyone]),
    spec("A11 wrong secret", A, ready, bad_claim, Operator, &[(Ready, 0)]),
    spec("A11b/A11c", A, noticed, CLAIM, Operator, &[(Notice, 0), (Co, -1), (Co, 0), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("A11c after abort (free)", A, aborted_free, CLAIM, Operator, &[(Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("A11c after abort (hold)", A, aborted_hold, CLAIM, Operator, &[(Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("A11 without a notice", A, active, CLAIM, Operator, &[(Active, 0), (Final, 0)]),
    // "When D == 0, a refund that would enter HOLD goes straight to DONE."
    spec("A10a D == 0", A, active, REFUND, Session, &[(Active, 0)]).no_deposit(),
    spec("A10b D == 0", A, noticed, REFUND, Session, &[(Notice, 0)]).no_deposit(),
    spec("A10c D == 0", A, aborted_hold, REFUND, Session, &[(Co, 20)]).no_deposit(),
    spec("fund in A", A, pend_w, FUND, Operator, &[(Lock, 5)]),
    spec("expire_unnoticed in A", A, active, Call::ExpireUnnoticed, Anyone, &[(Exp, 0)]),
    // ---------------------------------------------------------------- direction B (SPEC 3.5)
    spec("B2", B, pend, Call::CancelPending, TakerWallet, &[(Lock, 1), (Pend, 9)]).also(Session).others(&[Operator, Anyone]),
    spec("B2 window", B, pend_w, Call::CancelPending, Session, &[(Lock, 1)]),
    spec("B3 window, reason 0", B, pend_w, reject(RejectReason::MakerChoice), Operator, &[(Lock, 1), (Pend, 100)]).others(&[TakerWallet, Session, Anyone]),
    spec("B3 window, reason 1", B, pend_w, reject(RejectReason::UnusableInput), Operator, &[(Lock, 1)]),
    spec("B3 window, reason 2", B, pend_w, reject(RejectReason::LeafConsumed), Operator, &[(Lock, 1)]),
    spec("B3 outside window mode", B, pend, reject(RejectReason::MakerChoice), Operator, &[(Lock, 1)]),
    spec("B4", B, pend, Call::ExpirePending, Anyone, &[(Pend, -1), (Pend, 0)]),
    spec("B4 window", B, pend_w, Call::ExpirePending, Anyone, &[(Pend, -1), (Pend, 0)]),
    spec("B5", B, pend, FUND, Operator, &[(Lock, 1), (Pend, -1), (Pend, 0)]).others(&[TakerWallet, Session, Anyone]),
    spec("B5 window", B, pend_w, FUND, Operator, &[(Pend, -1), (Pend, 0)]),
    spec("B5 stale open hash", B, pend, Call::Fund { open_ok: false, watcher: false }, Operator, &[(Lock, 1)]),
    spec("approve in B", B, pend, APPROVE, Operator, &[(Lock, 1)]),
    spec("B6", B, active, Call::PostNotice, Session, &[(Active, 0), (Note, -1), (Note, 0), (Nl, -1), (Nl, 0)]).also(TakerWallet).others(&[Operator, Anyone]),
    spec("B7", B, noticed, Call::SetReady, Operator, &[(ReadyMin, -1), (ReadyMin, 0), (Co, -1), (Co, 0)]).others(&[TakerWallet, Session, Anyone]),
    spec("B8 noticed", B, noticed, Call::Abort, Session, &[(Notice, 0), (Final, -1), (Final, 0)]).also(TakerWallet).others(&[Operator, Anyone]),
    spec("B8 ready", B, ready, Call::Abort, Session, &[(Ready, 0), (Final, -1), (Final, 0)]),
    spec("B8 before a notice", B, active, Call::Abort, Session, &[(Active, 0)]),
    spec("B8 twice", B, aborted_hold, Call::Abort, Session, &[(Notice, 300)]),
    spec("B9a/B9b", B, active, REFUND, Operator, &[(Active, 0), (Note, -1), (Note, 0), (Final, 7)]).others(&[TakerWallet, Session, Anyone]),
    spec("B9 wrong secret", B, active, bad_refund, Operator, &[(Active, 0)]),
    spec("B9 while pending", B, pend, REFUND, Operator, &[(Lock, 1)]),
    spec("B9c/B9d/B9g", B, noticed, REFUND, Operator, &[(Notice, 0), (Cut, -1), (Cut, 0), (Co, -1), (Co, 0), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("B9h/B9d/B9g", B, late, REFUND, Operator, &[(Notice, 0), (Cut, -1), (Cut, 0), (Co, -1), (Co, 0), (Exp, -1), (Exp, 0)]),
    spec("B9e/B9g", B, ready, REFUND, Operator, &[(Ready, 1), (Cd, -1), (Cd, 0), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("B9f/B9g", B, aborted_hold, REFUND, Operator, &[(Notice, 300), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("B10a/B10c", B, ready, CLAIM, Session, &[(Ready, 0), (Cd, -1), (Cd, 0), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]).also(TakerWallet).others(&[Operator, Anyone]),
    spec("B10 wrong secret", B, ready, bad_claim, Session, &[(Ready, 0)]),
    spec("B10b/B10c", B, noticed, CLAIM, Session, &[(Notice, 0), (Co, -1), (Co, 0), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("B10b late notice", B, late, CLAIM, Session, &[(Co, -1), (Co, 0)]),
    spec("B10c after abort", B, aborted_hold, CLAIM, Session, &[(Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]),
    spec("B10 without a notice", B, active, CLAIM, Session, &[(Active, 0), (Final, 0)]),
    spec("B11", B, active, Call::ExpireUnnoticed, Anyone, &[(Exp, -1), (Exp, 0)]).also(Operator),
    spec("B11 after a notice", B, noticed, Call::ExpireUnnoticed, Anyone, &[(Exp, 0)]),
    spec("B9b D == 0", B, active, REFUND, Operator, &[(Note, 0)]).no_deposit(),
    spec("B9h D == 0", B, late, REFUND, Operator, &[(Notice, 0)]).no_deposit(),
    spec("B9d D == 0", B, noticed, REFUND, Operator, &[(Cut, 0)]).no_deposit(),
    spec("B9e D == 0", B, ready, REFUND, Operator, &[(Cd, 0)]).no_deposit(),
    spec("B9f D == 0", B, aborted_hold, REFUND, Operator, &[(Notice, 300)]).no_deposit(),
    spec("refund_unnoticed in B", B, active, Call::RefundUnnoticed, Anyone, &[(Note, 0)]),
  ];
  // ---------------------------------------------------------------- deposit sub-machine (SPEC 3.6)
  for dir in [A, B] {
    let claimer = if dir == A { Operator } else { Session };
    let not_claimer = if dir == A { Session } else { Operator };
    v.extend([
      spec("release held, anyone", dir, hold, Call::ReleaseDeposit, Anyone, &[(Hold, -1), (Hold, 0), (Split, 5)]).also(TakerWallet),
      spec("release held, operator", dir, hold, Call::ReleaseDeposit, Operator, &[(Refund, 1), (Hold, -1), (Hold, 0)]),
      spec("release withheld", dir, withheld, Call::ReleaseDeposit, Operator, &[(Hold, -1), (Hold, 99), (Split, 99)]).others(&[TakerWallet, Session, Anyone]),
      spec("withhold", dir, hold, Call::Withhold(if dir == A { Evidence::Opens } else { Evidence::Absent }), Operator, &[(Refund, 1), (Hold, -1), (Hold, 0)]).others(&[TakerWallet, Session, Anyone]),
      spec("withhold, no notice on record", dir, hold_nn, Call::Withhold(Evidence::Absent), Operator, &[(Refund, 1), (Hold, -1), (Hold, 0)]),
      spec("withhold twice", dir, withheld, Call::Withhold(Evidence::Opens), Operator, &[(Refund, 90)]),
      spec("split", dir, withheld, Call::SplitDeposit, Anyone, &[(Split, -1), (Split, 0)]).also(Operator),
      spec("split of a held deposit", dir, hold, Call::SplitDeposit, Anyone, &[(Split, 0)]),
      spec("publish_evidence noticed", dir, noticed, Call::PublishEvidence { opens: true }, claimer, &[(Notice, 5)]).others(&[not_claimer, Anyone]),
      spec("publish_evidence ready", dir, ready, Call::PublishEvidence { opens: true }, claimer, &[(Ready, 5)]),
      spec("publish_evidence after a refund", dir, hold, Call::PublishEvidence { opens: true }, claimer, &[(Refund, 5)]),
      spec("publish_evidence withheld", dir, withheld, Call::PublishEvidence { opens: true }, claimer, &[(Split, 5)]),
      spec("publish_evidence mismatch", dir, noticed, Call::PublishEvidence { opens: false }, claimer, &[(Notice, 5)]),
      spec("publish_evidence before a notice", dir, active, Call::PublishEvidence { opens: true }, claimer, &[(Active, 5)]),
      spec("publish_evidence, hold without a notice", dir, hold_nn, Call::PublishEvidence { opens: true }, claimer, &[(Refund, 5)]),
    ]);
  }
  v.push(spec("withhold A without evidence", A, hold, Call::Withhold(Evidence::Absent), Operator, &[(Refund, 1)]));
  v.push(spec("withhold A with wrong evidence", A, hold, Call::Withhold(Evidence::Mismatch), Operator, &[(Refund, 1)]));
  // ---------------------------------------------------------------- Amendment 1 (SPEC 11)
  // 11.1: no cap and no pause touches a call on an existing swap. `fund` is never refused by a
  // cap, even with every cap at zero.
  v.push(spec("B5 with every cap at zero and the maker paused", B, pend, FUND, Operator, &[(Lock, 1)]).env(HOSTILE));
  v.push(spec("A2 with every cap at zero and the maker paused", A, pend_w, APPROVE, Operator, &[(Lock, 1)]).env(HOSTILE));
  v.push(spec("B5 naming a watcher against W_z = 0", B, pend, FUND_WATCHED, Operator, &[(Lock, 1)]));
  v.push(spec("B5 naming a watcher", B, Target::PendingFreeze, FUND_WATCHED, Operator, &[(Lock, 1)]));
  // 11.6: freeze and the rows Z1 to Z6.
  let watched = Target::NoticedWatched;
  let unwatched = Target::NoticedUnwatched;
  let frozen = Target::Frozen;
  for dir in [A, B] {
    let (claimer, locker) = if dir == A { (Operator, Session) } else { (Session, Operator) };
    // Callers that are neither the watcher nor the locker.
    let strangers: &[Role] = if dir == A { &[Operator, Owner, Anyone] } else { &[TakerWallet, Session, Owner, Anyone] };
    let mut z1 = spec("Z1", dir, watched, Call::Freeze, Role::Watcher, &[(Notice, 0), (Co, -1), (Co, 0)]).also(locker);
    if dir == A {
      z1 = z1.also(TakerWallet);
    }
    v.push(z1.others(strangers));
    v.push(spec("Z1 with no watcher named", dir, unwatched, Call::Freeze, locker, &[(Notice, 5)]).others(&[Role::Watcher, Anyone]));
    v.push(spec("Z1 against W_z = 0", dir, noticed, Call::Freeze, locker, &[(Notice, 5)]).others(&[Role::Watcher]));
    v.push(spec("Z1 twice", dir, frozen, Call::Freeze, Role::Watcher, &[(Freeze, 1)]).also(locker));
    v.push(spec("Z1 in READY", dir, Target::ReadyWatched, Call::Freeze, Role::Watcher, &[(Ready, 1)]).also(locker));
    v.push(spec("Z1 before a notice", dir, Target::ActiveWatched, Call::Freeze, Role::Watcher, &[(Active, 5)]).also(locker));
    let not_locker: &[Role] = if dir == A { &[Operator, Role::Watcher, Anyone] } else { &[TakerWallet, Session, Role::Watcher, Anyone] };
    let not_claimer: &[Role] = if dir == A { &[TakerWallet, Session, Role::Watcher, Anyone] } else { &[Operator, Role::Watcher, Anyone] };
    v.push(spec("Z2", dir, frozen, Call::SetReady, locker, &[(ReadyMin, -1), (ReadyMin, 0), (Ff, -1), (Ff, 0)]).others(not_locker));
    v.push(spec("Z3/Z6", dir, frozen, REFUND, locker, &[(Freeze, 0), (Ff, -1), (Ff, 0), (Final, 0), (Exp, -1), (Exp, 0)]).others(not_locker));
    v.push(spec("Z3 wrong secret", dir, frozen, bad_refund, locker, &[(Freeze, 0)]));
    v.push(spec("Z3 D == 0", dir, frozen, REFUND, locker, &[(Freeze, 0)]).no_deposit());
    v.push(spec("Z4/Z6", dir, frozen, CLAIM, claimer, &[(Freeze, 0), (Co, 0), (Ff, -1), (Ff, 0), (Final, -1), (Final, 0), (Exp, -1), (Exp, 0)]).others(not_claimer));
    v.push(spec("Z4 wrong secret", dir, frozen, bad_claim, claimer, &[(Ff, 0)]));
    v.push(spec("Z5", dir, frozen, Call::Abort, claimer, &[(Freeze, 0), (Ff, -1), (Ff, 0), (Final, -1), (Final, 0)]).others(not_claimer));
    v.push(spec("publish_evidence frozen", dir, frozen, Call::PublishEvidence { opens: true }, claimer, &[(Freeze, 5)]).others(&[Role::Watcher]));
    // A freeze never shortens the locker's window: when t_Z + W_z falls before T_co, T_ff is
    // T_co. (Freeze, 3600) is t_Z + W_z.
    let short = Target::FrozenShort;
    let w = amounts::MIN_FREEZE_SECS as i64;
    v.push(spec("Z2 when t_Z + W_z < T_co", dir, short, Call::SetReady, locker, &[(Freeze, w), (Co, -1), (Co, 0)]));
    v.push(spec("Z3 when t_Z + W_z < T_co", dir, short, REFUND, locker, &[(Freeze, w), (Co, -1), (Co, 0)]));
    v.push(spec("Z4 when t_Z + W_z < T_co", dir, short, CLAIM, claimer, &[(Freeze, w), (Co, -1), (Co, 0)]));
    // A watcher has no other power: the calls a stranger cannot make, it cannot make either.
    v.push(spec("watcher: set_ready in NOTICED", dir, watched, Call::SetReady, Role::Watcher, &[(ReadyMin, 0)]));
    v.push(spec("watcher: abort in NOTICED", dir, watched, Call::Abort, Role::Watcher, &[(Notice, 5)]));
    v.push(spec("watcher: post_notice", dir, Target::ActiveWatched, Call::PostNotice, Role::Watcher, &[(Active, 5)]));
    v.push(spec("watcher: release_deposit before T_hold", dir, hold, Call::ReleaseDeposit, Role::Watcher, &[(Hold, -1)]));
    v.push(spec("watcher: withhold", dir, hold, Call::Withhold(Evidence::Opens), Role::Watcher, &[(Refund, 1)]));
  }
  let _ = chain;
  v
}

/// Rows for opening a swap (A1, B1) and the approval-mode table of SPEC 3.8.
fn open_rows(chain: Chain) -> Vec<Value> {
  let c = chain.consts();
  let mut rows = Vec::new();
  let mut push = |id: &str, case: &str, args: OpenArgs, caller: Role, env: Env| {
    let mut run = Run::new(chain);
    run.maker.open_pending = env.open_pending;
    run.open_value = env.caps.open_value;
    let (step_json, result) = run.exec(Call::Open(args), caller, T0, Option::None, &env, false);
    rows.push(json!({
      "id": id, "case": case, "chain": chain.name(), "direction": dir_name(args.direction), "mode": args.offer_mode,
      "from_state": "NONE", "setup": [], "step": step_json, "ok": result.is_ok(),
    }));
  };
  for (dir, id) in [(Direction::A, "A1"), (Direction::B, "B1")] {
    for (m, approval, case) in [
      (mode::AUTO, false, "AUTO offer"),
      (mode::AUTO, true, "AUTO offer, advance approval presented"),
      (mode::WINDOW, false, "WINDOW offer"),
      (mode::WINDOW, true, "WINDOW offer, advance approval presented"),
      (mode::ADVANCE, false, "ADVANCE offer, no approval"),
      (mode::ADVANCE, true, "ADVANCE offer, advance approval presented"),
      (mode::QUOTE, false, "taker-bound quote"),
    ] {
      push(id, case, open_args(chain, dir, m, approval, Option::None), Role::TakerWallet, Env::OK);
    }
    // SPEC 3.13: where the taker is whoever sends the call (Ethereum), "opened by someone else"
    // cannot be expressed, so no such row exists there.
    if !c.taker_is_sender {
      for caller in [Role::Session, Role::Operator, Role::Anyone] {
        push(id, &format!("wrong caller: {}", caller.name()), open_args(chain, dir, mode::AUTO, false, Option::None), caller, Env::OK);
      }
    }
    // SPEC 3.1: a swap whose amount or xmr is zero is refused.
    let zero = |f: &dyn Fn(&mut OpenArgs)| {
      let mut a = open_args(chain, dir, mode::AUTO, false, Option::None);
      f(&mut a);
      a
    };
    push(id, "amount zero", zero(&|a| a.amount = 0), Role::TakerWallet, Env::OK);
    push(id, "xmr zero", zero(&|a| a.xmr = 0), Role::TakerWallet, Env::OK);
    push(id, "amount one, xmr one piconero", zero(&|a| { a.amount = 1; a.xmr = 1; }), Role::TakerWallet, Env::OK);
    push(id, "no deposit", open_args(chain, dir, mode::AUTO, false, Some(0)), Role::TakerWallet, Env::OK);
    // MAX_OPEN_PENDING: the 65th pending swap is refused.
    push(id, "63 pending swaps open", open_args(chain, dir, mode::WINDOW, false, Option::None), Role::TakerWallet, Env { open_pending: c.max_open_pending - 1, ..Env::OK });
    push(id, "64 pending swaps open", open_args(chain, dir, mode::WINDOW, false, Option::None), Role::TakerWallet, Env { open_pending: c.max_open_pending, ..Env::OK });
    // One violated bound each.
    let base = open_args(chain, dir, mode::WINDOW, false, Option::None);
    let with = |f: &dyn Fn(&mut SwapParams)| {
      let mut a = base;
      f(&mut a.params);
      a
    };
    push(id, "deposit over the cap", with(&|p| p.dep_bps = c.max_deposit_bps + 1), Role::TakerWallet, Env::OK);
    push(id, "approval window too short", with(&|p| p.w_a = 29), Role::TakerWallet, Env::OK);
    push(id, "notice window too long", with(&|p| p.w_n = c.max_notice_secs + 1), Role::TakerWallet, Env::OK);
    push(id, "depth zero", with(&|p| p.depth = 0), Role::TakerWallet, Env::OK);
    push(id, "claim delay too short", with(&|p| p.d_c = min_claim_delay(p.depth, c) as u32 - 1), Role::TakerWallet, Env::OK);
    push(id, "claim window too short", with(&|p| p.w_c = min_claim_window(c) as u32 - 1), Role::TakerWallet, Env::OK);
    push(id, "final window too short", with(&|p| p.w_f = (p.w_a + p.w_n + p.d_c + p.w_c + 86_400) - 1), Role::TakerWallet, Env::OK);
    push(id, "final window over the cap", with(&|p| p.w_f = c.max_final_secs + 1), Role::TakerWallet, Env::OK);

    // ------------------------------------------------------------ Amendment 1 (SPEC 11)
    let taker = Role::TakerWallet;
    let auto = open_args(chain, dir, mode::AUTO, false, Option::None);
    let amount = auto.amount;
    // The counted value: amount in A, amount + deposit in B.
    let counted = amount + if dir == Direction::B { amounts::deposit_of(amount, auto.params.dep_bps) } else { 0 };
    let caps = |on: bool, max_swap: u128, max_open: u128| Env { caps: Caps { on, max_swap, max_open, open_value: 0 }, ..Env::OK };
    let far = u64::MAX as u128;
    // 11.1: exactly at a cap is allowed, one unit above is not.
    push(id, "caps: amount exactly max_swap", auto, taker, caps(true, amount, far));
    push(id, "caps: amount one above max_swap", auto, taker, caps(true, amount - 1, far));
    push(id, "caps: counted value exactly max_open", auto, taker, caps(true, far, counted));
    push(id, "caps: counted value one above max_open", auto, taker, caps(true, far, counted - 1));
    push(id, "caps: other swaps open, the sum exactly max_open", auto, taker, Env { caps: Caps { on: true, max_swap: far, max_open: 7 * counted, open_value: 6 * counted }, ..Env::OK });
    push(id, "caps: other swaps open, the sum one above max_open", auto, taker, Env { caps: Caps { on: true, max_swap: far, max_open: 7 * counted - 1, open_value: 6 * counted }, ..Env::OK });
    push(id, "caps: a fresh deployment (switch on, every cap zero)", auto, taker, Env { caps: Caps::INITIAL, ..Env::OK });
    push(id, "caps: switched off with every cap zero", auto, taker, caps(false, 0, 0));
    push(id, "caps: switched off, other swaps open above max_open", auto, taker, Env { caps: Caps { on: false, max_swap: 0, max_open: counted, open_value: 6 * counted }, ..Env::OK });
    push(id, "maker paused", auto, taker, Env { maker_paused: true, ..Env::OK });
    // 11.6: the freeze window and the watcher.
    let frozen = |w_z: u32, watcher: bool| {
      let mut a = open_args(chain, dir, mode::WINDOW, false, Option::None);
      a.params.w_z = w_z;
      a.watcher = watcher && dir == Direction::A;
      a
    };
    push(id, "freeze window at its floor", frozen(amounts::MIN_FREEZE_SECS, true), taker, Env::OK);
    push(id, "freeze window below its floor", frozen(amounts::MIN_FREEZE_SECS - 1, true), taker, Env::OK);
    push(id, "freeze window at its cap", frozen(amounts::MAX_FREEZE_SECS, true), taker, Env::OK);
    push(id, "freeze window over its cap", frozen(amounts::MAX_FREEZE_SECS + 1, true), taker, Env::OK);
    push(id, "freeze window, no watcher named", frozen(FREEZE_SECS, false), taker, Env::OK);
    let floor = |a: &OpenArgs| (a.params.w_a + a.params.w_n + a.params.d_c + a.params.w_z + a.params.w_c + 86_400) as u32;
    let mut tight = frozen(amounts::MAX_FREEZE_SECS, true);
    tight.params.w_f = floor(&tight);
    push(id, "freeze window: final window exactly W_p + W_n + D_c + W_z + W_c + 86,400", tight, taker, Env::OK);
    tight.params.w_f -= 1;
    push(id, "freeze window: final window one second short", tight, taker, Env::OK);
    if dir == Direction::A {
      let mut a = auto;
      a.watcher = true;
      push(id, "watcher named against W_z = 0", a, taker, Env::OK);
    } else {
      // 11.2: the payout address.
      let mut a = auto;
      a.payout = PayoutArg::Other;
      push(id, "payout to another address", a, taker, Env::OK);
      a.payout = PayoutArg::Invalid;
      push(id, "invalid payout address", a, taker, Env::OK);
    }
  }
  rows
}

fn rows(chain: Chain) -> Vec<Value> {
  let mut out = open_rows(chain);
  for spec in row_specs(chain) {
    let (open, setup) = reach(chain, spec.dir, spec.target, spec.dep_bps);
    let mut attempts: Vec<(Role, (Anchor, i64), &str)> = Vec::new();
    for caller in &spec.callers {
      for point in &spec.points {
        attempts.push((*caller, *point, ""));
      }
    }
    for caller in &spec.others {
      attempts.push((*caller, spec.points[0], "other caller: "));
    }
    let mut any_ok = false;
    for (caller, (anchor, offset), prefix) in attempts {
      // Replay from scratch for every attempt: a row never depends on another row.
      let mut run = Run::new(chain);
      let (open_json, opened) = run.exec(Call::Open(open), Role::TakerWallet, T0, Option::None, &Env::OK, false);
      opened.expect("row setup: open");
      let mut setup_json = Vec::new();
      for s in &setup {
        let (j, r) = run.step(s, false);
        r.unwrap_or_else(|e| panic!("row {}: setup step {} failed with {e:?}", spec.id, s.call.name()));
        setup_json.push(strip_expect(j));
      }
      let from = run.state;
      let the_step = Step { call: spec.call, caller, anchor, offset, env: spec.env };
      let (step_json, result) = run.step(&the_step, false);
      any_ok |= result.is_ok();
      let sign = if offset < 0 { "-" } else { "+" };
      out.push(json!({
        "id": spec.id,
        "case": format!("{prefix}{} at {}{sign}{}", caller.name(), anchor.name(), offset.abs()),
        "chain": chain.name(),
        "direction": dir_name(spec.dir),
        "mode": from.mode,
        "from_state": from.state.name(),
        "from_label": spec.target.label(),
        "open": strip_expect(open_json),
        "setup": setup_json,
        "from": swap_json(&from),
        "step": step_json,
        "ok": result.is_ok(),
      }));
    }
    let _ = any_ok;
  }
  out
}
fn strip_expect(mut step: Value) -> Value {
  step.as_object_mut().unwrap().remove("expect");
  step
}

// ------------------------------------------------------------------ sequences

struct Seq {
  name: String,
  about: &'static str,
  open: OpenArgs,
  steps: Vec<Step>,
  maker: Option<MakerRecord>,
  /// SPEC 11.1, invariant 3: after the open every cap is zero with the switch on and the maker
  /// is paused (a replay also bumps both epochs).
  hostile: bool,
}
fn seq(name: impl Into<String>, about: &'static str, open: OpenArgs, steps: Vec<Step>) -> Seq {
  Seq { name: name.into(), about, open, steps, maker: Option::None, hostile: false }
}

fn run_seq(chain: Chain, s: &Seq) -> (Value, SwapState) {
  let mut run = Run::new(chain);
  if let Some(m) = &s.maker {
    run.maker = m.clone();
  }
  let initial = maker_json(&run.maker);
  let mut steps = Vec::new();
  let (open_json, opened) = run.exec(Call::Open(s.open), Role::TakerWallet, T0, Option::None, &Env::OK, true);
  opened.unwrap_or_else(|e| panic!("sequence {}: open failed with {e:?}", s.name));
  steps.push(open_json);
  for st in &s.steps {
    let mut st = *st;
    if s.hostile {
      st.env = Env { caps: Caps::INITIAL, maker_paused: true, ..st.env };
    }
    let (j, _) = run.step(&st, true);
    steps.push(j);
  }
  (
    json!({
      "name": s.name, "chain": chain.name(), "direction": dir_name(s.open.direction), "about": s.about,
      "hostile_after_open": s.hostile,
      "initial_maker": initial, "steps": steps,
      "final": { "swap": swap_json(&run.state), "maker": maker_json(&run.maker), "open_value": d(run.open_value) },
    }),
    run.state,
  )
}

fn sequences(chain: Chain) -> Vec<Value> {
  use Anchor::*;
  use Direction::{A, B};
  use Role::{Anyone, Operator, Owner, Session, TakerWallet};
  let c = chain.consts();
  let out: std::cell::RefCell<Vec<Value>> = Default::default();
  let names: std::cell::RefCell<std::collections::BTreeSet<String>> = Default::default();
  let add = |s: Seq, expect_final: Option<State>| -> SwapState {
    assert!(names.borrow_mut().insert(s.name.clone()), "duplicate sequence {}", s.name);
    let (v, state) = run_seq(chain, &s);
    if let Some(want) = expect_final {
      assert_eq!(state.state, want, "sequence {} ends in {:?}", s.name, state.state);
    }
    out.borrow_mut().push(v);
    state
  };
  let leave_pending = |dir: Direction, open: &OpenArgs| -> Vec<Step> {
    // Whether this swap starts PENDING on this chain (SPEC 3.8).
    let window = open.offer_mode == mode::WINDOW && !open.approval;
    if c.explicit_approve || dir == B || window {
      vec![step(if dir == A { APPROVE } else { FUND }, Operator, Lock, 12)]
    } else {
      vec![]
    }
  };
  let roles = |dir: Direction| if dir == A { (Operator, Session) } else { (Session, Operator) }; // (claimer, locker)

  // 1. A happy path per direction and mode.
  for dir in [A, B] {
    for (m, approval, label) in [(mode::AUTO, false, "auto"), (mode::WINDOW, false, "window"), (mode::ADVANCE, true, "advance"), (mode::QUOTE, false, "quote")] {
      let open = open_args(chain, dir, m, approval, Option::None);
      let (claimer, locker) = roles(dir);
      let mut steps = leave_pending(dir, &open);
      steps.push(step(Call::PostNotice, claimer, Active, 90));
      steps.push(step(Call::SetReady, locker, ReadyMin, 600));
      steps.push(step(CLAIM, claimer, Ready, 60));
      add(seq(format!("happy/{}/{label}", dir_name(dir)), "lock or take, approve or fund where the swap starts pending, notice, ready, claim", open, steps), Some(State::Done));
    }
  }

  // 2. For each deadline, the last enabled second and the first disabled second of every call it
  //    gates: two sequences per call, one acting at T − 1 and one at T.
  struct Gate {
    deadline: Anchor,
    dir: Direction,
    target: Target,
    what: &'static str,
    call: Call,
    caller: Role,
  }
  let g = |deadline, dir, target, what, call, caller| Gate { deadline, dir, target, what, call, caller };
  let noticed = Target::Noticed { late: false };
  let late = Target::Noticed { late: true };
  let hold = Target::Hold { notice: true };
  let withheld = Target::Withheld { notice: true };
  let pend_w = Target::Pending { window: true };
  let pend = Target::Pending { window: false };
  let gates = vec![
    // T_appr / T_fund
    g(Pend, A, pend_w, "approve", APPROVE, Operator),
    g(Pend, A, pend_w, "expire_pending", Call::ExpirePending, Anyone),
    g(Pend, B, pend, "fund", FUND, Operator),
    g(Pend, B, pend, "expire_pending", Call::ExpirePending, Anyone),
    g(Pend, B, pend_w, "expire_pending-window", Call::ExpirePending, Anyone),
    // T_note
    g(Note, A, Target::Active, "post_notice", Call::PostNotice, Operator),
    g(Note, A, Target::Active, "abort", Call::Abort, Operator),
    g(Note, A, Target::Active, "refund_unnoticed", Call::RefundUnnoticed, Anyone),
    g(Note, A, Target::Active, "refund", REFUND, Session),
    g(Note, B, Target::Active, "refund", REFUND, Operator),
    g(Note, B, Target::Active, "post_notice", Call::PostNotice, Session),
    // T_nl (direction B)
    g(Nl, B, Target::Active, "post_notice", Call::PostNotice, Session),
    // T_cut (direction B)
    g(Cut, B, noticed, "refund", REFUND, Operator),
    g(Cut, B, late, "refund-late-notice", REFUND, Operator),
    // T_co
    g(Co, A, noticed, "refund", REFUND, Session),
    g(Co, A, noticed, "abort", Call::Abort, Operator),
    g(Co, A, noticed, "set_ready", Call::SetReady, Session),
    g(Co, A, noticed, "claim", CLAIM, Operator),
    g(Co, B, noticed, "refund", REFUND, Operator),
    g(Co, B, noticed, "set_ready", Call::SetReady, Operator),
    g(Co, B, noticed, "claim", CLAIM, Session),
    // T_cd
    g(Cd, A, Target::Ready, "claim", CLAIM, Operator),
    g(Cd, A, Target::Ready, "refund", REFUND, Session),
    g(Cd, B, Target::Ready, "claim", CLAIM, Session),
    g(Cd, B, Target::Ready, "refund", REFUND, Operator),
    // T_final
    g(Final, A, noticed, "abort-noticed", Call::Abort, Operator),
    g(Final, A, Target::Ready, "abort-ready", Call::Abort, Operator),
    g(Final, A, Target::AbortedHold, "refund-aborted-hold", REFUND, Session),
    g(Final, A, Target::AbortedFree, "refund-aborted-free", REFUND, Session),
    g(Final, A, Target::Ready, "refund-ready", REFUND, Session),
    g(Final, A, noticed, "claim-noticed", CLAIM, Operator),
    g(Final, A, Target::Ready, "claim-ready", CLAIM, Operator),
    g(Final, A, Target::AbortedFree, "claim-aborted-free", CLAIM, Operator),
    g(Final, A, Target::AbortedHold, "claim-aborted-hold", CLAIM, Operator),
    g(Final, B, noticed, "abort-noticed", Call::Abort, Session),
    g(Final, B, Target::Ready, "abort-ready", Call::Abort, Session),
    g(Final, B, Target::Ready, "refund-ready", REFUND, Operator),
    g(Final, B, Target::AbortedHold, "refund-aborted-hold", REFUND, Operator),
    g(Final, B, noticed, "claim-noticed", CLAIM, Session),
    g(Final, B, Target::Ready, "claim-ready", CLAIM, Session),
    g(Final, B, Target::AbortedHold, "claim-aborted-hold", CLAIM, Session),
    // T_exp
    g(Exp, A, noticed, "claim-noticed", CLAIM, Operator),
    g(Exp, A, Target::Ready, "claim-ready", CLAIM, Operator),
    g(Exp, A, Target::AbortedFree, "claim-aborted-free", CLAIM, Operator),
    g(Exp, A, Target::AbortedHold, "claim-aborted-hold", CLAIM, Operator),
    g(Exp, A, noticed, "refund-noticed", REFUND, Session),
    g(Exp, A, Target::Ready, "refund-ready", REFUND, Session),
    g(Exp, A, Target::AbortedFree, "refund-aborted-free", REFUND, Session),
    g(Exp, A, Target::AbortedHold, "refund-aborted-hold", REFUND, Session),
    g(Exp, B, noticed, "claim-noticed", CLAIM, Session),
    g(Exp, B, Target::Ready, "claim-ready", CLAIM, Session),
    g(Exp, B, Target::AbortedHold, "claim-aborted-hold", CLAIM, Session),
    g(Exp, B, noticed, "refund-noticed", REFUND, Operator),
    g(Exp, B, Target::Ready, "refund-ready", REFUND, Operator),
    g(Exp, B, Target::AbortedHold, "refund-aborted-hold", REFUND, Operator),
    g(Exp, B, Target::Active, "expire_unnoticed", Call::ExpireUnnoticed, Anyone),
    // T_hold
    g(Hold, A, hold, "release_deposit", Call::ReleaseDeposit, Anyone),
    g(Hold, A, hold, "withhold", Call::Withhold(Evidence::Opens), Operator),
    g(Hold, B, hold, "release_deposit", Call::ReleaseDeposit, Anyone),
    g(Hold, B, hold, "withhold", Call::Withhold(Evidence::Absent), Operator),
    // T_split
    g(Split, A, withheld, "split_deposit", Call::SplitDeposit, Anyone),
    g(Split, B, withheld, "split_deposit", Call::SplitDeposit, Anyone),
    // SPEC 11.6. T_co: the last second a freeze is possible.
    g(Co, A, Target::NoticedWatched, "freeze", Call::Freeze, Role::Watcher),
    g(Co, B, Target::NoticedWatched, "freeze", Call::Freeze, Role::Watcher),
    // T_ff: the locker's side closes, the claimer's opens.
    g(Ff, A, Target::Frozen, "set_ready", Call::SetReady, Session),
    g(Ff, A, Target::Frozen, "refund", REFUND, Session),
    g(Ff, A, Target::Frozen, "claim", CLAIM, Operator),
    g(Ff, B, Target::Frozen, "set_ready", Call::SetReady, Operator),
    g(Ff, B, Target::Frozen, "refund", REFUND, Operator),
    g(Ff, B, Target::Frozen, "claim", CLAIM, Session),
    // T_final and T_exp with FROZEN among the post-notice states (Z5, Z6).
    g(Final, A, Target::Frozen, "abort-frozen", Call::Abort, Operator),
    g(Final, A, Target::Frozen, "claim-frozen", CLAIM, Operator),
    g(Final, B, Target::Frozen, "abort-frozen", Call::Abort, Session),
    g(Final, B, Target::Frozen, "claim-frozen", CLAIM, Session),
    g(Exp, A, Target::Frozen, "claim-frozen", CLAIM, Operator),
    g(Exp, A, Target::Frozen, "refund-frozen", REFUND, Session),
    g(Exp, B, Target::Frozen, "claim-frozen", CLAIM, Session),
    g(Exp, B, Target::Frozen, "refund-frozen", REFUND, Operator),
  ];
  for gate in &gates {
    let (open, setup) = reach(chain, gate.dir, gate.target, Option::None);
    let mut enabled = [false; 2];
    for (i, (offset, label)) in [(-1i64, "T-1"), (0, "T")].into_iter().enumerate() {
      let mut steps = setup.clone();
      steps.push(step(gate.call, gate.caller, gate.deadline, offset));
      let s = seq(
        format!("boundary/{}/{}/{}/{label}", gate.deadline.name(), dir_name(gate.dir), gate.what),
        "the call one second before the deadline and at the deadline (two sequences)",
        open,
        steps,
      );
      let (v, _) = run_seq(chain, &s);
      enabled[i] = v["steps"].as_array().unwrap().last().unwrap()["expect"]["ok"] == true;
      assert!(names.borrow_mut().insert(s.name.clone()));
      out.borrow_mut().push(v);
    }
    // Every gate either flips at the deadline, or (a keyed refund in ACTIVE, a direction-B
    // notice, a NOTICED claim at T_final) stays enabled and changes row.
    let changes_row = matches!(
      (gate.deadline, gate.what),
      (Note, "refund") | (Note, "post_notice") | (Cut, _) | (Co, "abort") | (Final, "claim-noticed") | (Final, "claim-frozen")
    ) && !(gate.deadline == Note && gate.dir == A && gate.what == "post_notice");
    assert_eq!(enabled[0] != enabled[1], !changes_row, "gate {}/{}/{}", gate.deadline.name(), dir_name(gate.dir), gate.what);
    if changes_row {
      assert!(enabled[0] && enabled[1], "gate {}/{}/{}", gate.deadline.name(), dir_name(gate.dir), gate.what);
    }
  }

  // 3. Direction B funded at the last second with W_n at its cap and the smallest final window,
  //    then a notice at the last second, then ready at the last second.
  {
    let mut open = open_args(chain, B, mode::AUTO, false, Option::None);
    open.params.w_n = c.max_notice_secs;
    let pending = if c.explicit_approve { Pending::ApprovalWindow } else { Pending::FundingWindow };
    open.params.w_f = min_final_window(&open.params, pending_window(&open.params, pending)) as u32;
    let steps = vec![
      step(FUND, Operator, Pend, -1),
      step(Call::PostNotice, Session, Nl, -1),
      step(Call::SetReady, Operator, Co, -1),
      step(REFUND, Operator, Cd, -1),  // refused: the taker's window
      step(CLAIM, Session, Cd, -1),    // the last second of the claim window
    ];
    let s = add(seq("extreme/B/last-second-everywhere", "the latest reachable T_cd still precedes T_final - 86,400", open, steps), Some(State::Done));
    assert!(s.t_claim_deadline < s.t_final - amounts::DAY_SECS);
    assert!(s.has(flag::LATE_NOTICE) || s.t_notice < s.t_note_deadline);
  }
  // The same in direction A (notice at T_note − 1), for symmetry.
  {
    let mut open = open_args(chain, A, mode::WINDOW, false, Option::None);
    open.params.w_n = c.max_notice_secs;
    open.params.w_f = min_final_window(&open.params, open.params.w_a) as u32;
    let steps = vec![
      step(APPROVE, Operator, Pend, -1),
      step(Call::PostNotice, Operator, Note, -1),
      step(Call::SetReady, Session, Co, -1),
      step(CLAIM, Operator, Cd, -1),
    ];
    let s = add(seq("extreme/A/last-second-everywhere", "approval, notice, ready and claim each at their last second", open, steps), Some(State::Done));
    assert!(s.t_claim_deadline < s.t_final - amounts::DAY_SECS);
  }

  // 4. Direction B late notice followed by a refund, and by a claim at T_co.
  {
    let open = open_args(chain, B, mode::AUTO, false, Option::None);
    let base = vec![step(FUND, Operator, Lock, 12), step(Call::PostNotice, Session, Note, 30)];
    let mut steps = base.clone();
    steps.extend([
      step(REFUND, Operator, Notice, 60),                 // B9h: the deposit is held
      step(Call::Withhold(Evidence::Absent), Operator, Refund, 30),
      step(Call::ReleaseDeposit, Operator, Refund, 600),  // released on request
    ]);
    add(seq("B/late-notice-then-refund", "a notice after T_note is accepted; the maker's refund then holds the take deposit (B9h)", open, steps), Some(State::Done));
    let mut steps = base;
    steps.extend([
      step(CLAIM, Session, Co, -1), // refused
      step(CLAIM, Session, Co, 0),  // B10b: the taker never depends on the maker
    ]);
    add(seq("B/late-notice-then-claim-at-T_co", "after its own late notice the taker can always claim at T_co (B10b)", open, steps), Some(State::Done));
  }

  // 5. A keyed refund in ACTIVE after T_note (A10g), and the keyless one (A8).
  {
    let open = open_args(chain, A, mode::AUTO, false, Option::None);
    let mut steps = leave_pending(A, &open);
    steps.push(step(Call::PostNotice, Operator, Note, 0)); // refused: too late
    steps.push(step(REFUND, Session, Note, 5));
    add(seq("A/refund-in-active-after-T_note", "A10g: the same result as the keyless A8, with the share revealed", open, steps), Some(State::Done));
    let mut steps = leave_pending(A, &open);
    steps.push(step(Call::RefundUnnoticed, Anyone, Note, 0));
    add(seq("A/refund_unnoticed", "A8: a stranger returns the escrow once the notice deadline has passed", open, steps), Some(State::Done));
  }

  // 6. expire_unnoticed (B11): nobody acts after funding.
  {
    let open = open_args(chain, B, mode::AUTO, false, Option::None);
    let steps = vec![
      step(FUND, Operator, Lock, 12),
      step(Call::ExpireUnnoticed, Anyone, Exp, -1), // refused
      step(Call::ExpireUnnoticed, Anyone, Exp, 0),
      step(Call::WithdrawOwed(Party::Maker), Operator, Exp, 10), // refused: not the owner
      step(Call::WithdrawOwed(Party::Maker), Owner, Exp, 20),
      step(Call::WithdrawOwed(Party::Maker), Owner, Exp, 30), // refused: nothing owed
    ];
    add(seq("B/expire_unnoticed", "B11: the take deposit returns to the taker; the maker's escrow is parked and pulled", open, steps), Some(State::Done));
  }

  // 7. A parked payout on each secret-bearing call, followed by withdraw_owed.
  {
    let no_taker = Env { taker_can_receive: false, ..Env::OK };
    // On Ethereum the treasury share only increments treasuryAccrued and cannot be parked.
    let no_maker = Env { maker_can_receive: false, treasury_can_receive: c.open_secret_calls, ..Env::OK };
    let open_a = open_args(chain, A, mode::AUTO, false, Option::None);
    let open_b = open_args(chain, B, mode::AUTO, false, Option::None);

    let mut steps = leave_pending(A, &open_a);
    steps.extend([
      step(Call::PostNotice, Operator, Active, 90),
      step(REFUND, Session, Notice, 200).env(no_taker),
      step(Call::WithdrawOwed(Party::Taker), Session, Refund, 10), // refused: the wallet only
      step(Call::WithdrawOwed(Party::Taker), TakerWallet, Refund, 20),
      step(Call::ReleaseDeposit, Anyone, Hold, 0),
    ]);
    add(seq("parked/A/refund", "the taker cannot receive: the refund still succeeds and reveals the share; the payout is parked", open_a, steps), Some(State::Done));

    let mut steps = leave_pending(A, &open_a);
    steps.extend([
      step(Call::PostNotice, Operator, Active, 90),
      step(Call::SetReady, Session, ReadyMin, 600),
      step(CLAIM, Operator, Ready, 60).env(no_maker),
      step(Call::WithdrawOwed(Party::Maker), Owner, Ready, 120),
    ]);
    if !c.open_secret_calls {
      steps.push(step(Call::WithdrawOwed(Party::Treasury), Anyone, Ready, 180));
    }
    add(seq("parked/A/claim", "the maker's payout address cannot receive: the claim still succeeds", open_a, steps), Some(State::Done));

    let steps = vec![
      step(FUND, Operator, Lock, 12),
      step(Call::PostNotice, Session, Active, 90),
      step(REFUND, Operator, Cut, 10).env(no_maker),
      step(Call::WithdrawOwed(Party::Maker), Owner, Refund, 30),
      step(Call::ReleaseDeposit, Anyone, Hold, 0).env(no_taker),
      step(Call::WithdrawOwed(Party::Taker), TakerWallet, Hold, 60),
    ];
    add(seq("parked/B/refund", "the operator cannot receive its own refund, then the taker cannot receive the released deposit", open_b, steps), Some(State::Done));

    let steps = vec![
      step(FUND, Operator, Lock, 12),
      step(Call::PostNotice, Session, Active, 90),
      step(Call::SetReady, Operator, ReadyMin, 600),
      step(CLAIM, Session, Ready, 60).env(no_taker),
      step(Call::WithdrawOwed(Party::Taker), TakerWallet, Ready, 120),
    ];
    add(seq("parked/B/claim", "the taker cannot receive: the claim still succeeds and reveals the share", open_b, steps), Some(State::Done));

    // A keyless exit with a parked payout ends in DONE and is not closed.
    let open_w = open_args(chain, A, mode::WINDOW, false, Option::None);
    let steps = vec![step(Call::CancelPending, Session, Lock, 5).env(no_taker), step(Call::WithdrawOwed(Party::Taker), TakerWallet, Lock, 50)];
    add(seq("parked/A/cancel_pending", "a row marked closed stays open (DONE) while a payout is parked", open_w, steps), Some(State::Done));
  }

  // 8. D == 0 on every held-refund row: straight to DONE, no deposit counter moves.
  {
    let held: [(&str, Direction, Target, (Anchor, i64)); 8] = [
      ("A10a", A, Target::Active, (Active, 30)),
      ("A10b", A, noticed, (Notice, 30)),
      ("A10c", A, Target::AbortedHold, (Co, 30)),
      ("B9b", B, Target::Active, (Note, 30)),
      ("B9h", B, late, (Notice, 30)),
      ("B9d", B, noticed, (Cut, 30)),
      ("B9e", B, Target::Ready, (Cd, 30)),
      ("B9f", B, Target::AbortedHold, (Notice, 400)),
    ];
    for (id, dir, target, (anchor, offset)) in held {
      let (open, mut steps) = reach(chain, dir, target, Some(0));
      let (_, locker) = roles(dir);
      steps.push(step(REFUND, locker, anchor, offset));
      steps.push(step(Call::ReleaseDeposit, Anyone, Split, 0)); // refused: there is no deposit to release
      let s = add(seq(format!("no-deposit/{id}"), "with D == 0 a refund that would enter HOLD goes straight to DONE", open, steps), Some(State::Done));
      assert_eq!(s.deposit_state, 0);
    }
  }

  // 9. Counters at their maximum: updates saturate and never fail.
  {
    let open = open_args(chain, A, mode::WINDOW, false, Option::None);
    let mut maker = MakerRecord::default();
    for id in [counter::LOCKS, counter::APPROVALS, counter::NOTICES, counter::COMPLETED] {
      maker.counters[id as usize] = u32::MAX;
    }
    maker.counters[counter::READIES as usize] = u32::MAX - 1;
    maker.response_secs_sum = u64::MAX - 5;
    maker.volume = c.max_amount - 7;
    let steps = vec![
      step(APPROVE, Operator, Lock, 12),
      step(Call::PostNotice, Operator, Active, 90),
      step(Call::SetReady, Session, ReadyMin, 600),
      step(CLAIM, Operator, Ready, 60),
    ];
    let mut s = seq("saturation/counters-at-u32-max", "a claim with completed, the response-time sum and the volume at their maxima still succeeds", open, steps);
    s.maker = Some(maker);
    add(s, Some(State::Done));
  }

  // 10. The deposit paths: hold then crank; withhold with evidence then release; then split.
  {
    let open = open_args(chain, A, mode::AUTO, false, Option::None);
    let base = {
      let mut s = leave_pending(A, &open);
      s.push(step(Call::PostNotice, Operator, Active, 90));
      s.push(step(REFUND, Session, Notice, 400));
      s
    };
    let mut steps = base.clone();
    steps.extend([step(Call::ReleaseDeposit, Anyone, Hold, -1), step(Call::Withhold(Evidence::Opens), Operator, Hold, 0), step(Call::ReleaseDeposit, Anyone, Hold, 0)]);
    add(seq("deposit/A/held-then-returned", "row 4: the deposit is returned by a stranger's crank after 30 minutes; withhold is refused at T_hold", open, steps), Some(State::Done));
    let mut steps = base.clone();
    steps.extend([
      step(Call::Withhold(Evidence::Absent), Operator, Refund, 30),   // refused: evidence required
      step(Call::Withhold(Evidence::Mismatch), Operator, Refund, 40), // refused: does not open the commitment
      step(Call::Withhold(Evidence::Opens), Operator, Refund, 50),
      step(Call::ReleaseDeposit, Anyone, Hold, 5),                    // refused: only the operator releases a withheld deposit
      step(Call::ReleaseDeposit, Operator, Hold, 3_600),
    ]);
    add(seq("deposit/A/withheld-then-released", "row 4 with withhold: evidence required and checked; released on request", open, steps), Some(State::Done));
    let mut steps = base;
    steps.extend([
      step(Call::Withhold(Evidence::Opens), Operator, Hold, -1),
      step(Call::SplitDeposit, Anyone, Split, -1), // refused
      step(Call::SplitDeposit, Anyone, Split, 0),
    ]);
    add(seq("deposit/A/withheld-then-split", "the 60-day split: ceil(D/2) to the taker, floor(D/2) to the treasury; the maker never receives D", open, steps), Some(State::Done));
    let mut odd = open_args(chain, B, mode::AUTO, false, Option::None);
    odd.amount += 77; // an odd deposit
    let steps = vec![
      step(FUND, Operator, Lock, 12),
      step(REFUND, Operator, Note, 5), // B9b
      step(Call::Withhold(Evidence::Absent), Operator, Refund, 10),
      step(Call::SplitDeposit, Anyone, Split, 0),
    ];
    add(seq("deposit/B/no-notice-withheld-then-split", "B9b, withhold without evidence, split", odd, steps), Some(State::Done));
  }

  // 11. Pending exits (row 1) and the approval bound to its lock (SPEC 3.12).
  {
    let open = open_args(chain, A, mode::WINDOW, false, Option::None);
    add(seq("pending/A/reject", "A3", open, vec![step(reject(RejectReason::MakerChoice), Operator, Lock, 10)]), Some(State::Done));
    add(seq("pending/A/reject-no-fault", "A3 with reason 1: counted apart from ordinary rejections", open, vec![step(reject(RejectReason::UnusableInput), Operator, Lock, 10)]), Some(State::Done));
    add(seq("pending/A/cancel", "A4", open, vec![step(Call::CancelPending, Session, Lock, 10)]), Some(State::Done));
    add(seq("pending/A/expire", "A5: expiry cranked by a stranger", open, vec![step(Call::ExpirePending, Anyone, Pend, 0)]), Some(State::Done));
    add(
      seq(
        "pending/A/stale-open-hash",
        "approve, reject and then approve again with the open hash of another lock fail with BadState; the right one succeeds",
        open,
        vec![
          step(Call::Approve { open_ok: false }, Operator, Lock, 5),
          step(Call::Reject { open_ok: false, reason: RejectReason::MakerChoice }, Operator, Lock, 6),
          step(APPROVE, Operator, Lock, 7),
        ],
      ),
      Some(State::Active),
    );
    let open_b = open_args(chain, B, mode::AUTO, false, Option::None);
    add(
      seq(
        "pending/B/lapse",
        "B4 outside window mode: missed_funds where a lapse is the maker's fault, approval_timeouts under EXPLICIT_APPROVE",
        open_b,
        vec![step(Call::Fund { open_ok: false, watcher: false }, Operator, Lock, 5), step(Call::ExpirePending, Anyone, Pend, 0)],
      ),
      Some(State::Done),
    );
    add(seq("pending/B/cancel", "B2", open_b, vec![step(Call::CancelPending, TakerWallet, Lock, 10)]), Some(State::Done));
  }

  // 12. The unhappy rows of SPEC 3.10 as whole stories.
  {
    let open = open_args(chain, A, mode::AUTO, false, Option::None);
    let start = leave_pending(A, &open);
    let with = |extra: Vec<Step>| {
      let mut s = start.clone();
      s.extend(extra);
      s
    };
    add(seq("rows/A/3-cancel-after-approval", "row 3: A10a then the deposit returns after 30 minutes", open, with(vec![step(REFUND, Session, Active, 60), step(Call::ReleaseDeposit, Anyone, Hold, 0)])), Some(State::Done));
    add(
      seq(
        "rows/A/5-abort-late-then-refund",
        "row 5: the taker never sets ready; the maker aborts after its claim delay; the taker returns and refunds",
        open,
        with(vec![step(Call::PostNotice, Operator, Active, 90), step(Call::Abort, Operator, Co, 5), step(CLAIM, Operator, Co, 6), step(REFUND, Session, Co, 3_600), step(Call::ReleaseDeposit, Anyone, Hold, 0)]),
      ),
      Some(State::Done),
    );
    add(seq("rows/A/6-claim-without-ready", "row 6: A11b at T_co", open, with(vec![step(Call::PostNotice, Operator, Active, 90), step(CLAIM, Operator, Co, 0)])), Some(State::Done));
    add(
      seq(
        "rows/A/7-missed-claim",
        "row 7: ready set, the maker misses its claim deadline, the taker refunds in full",
        open,
        with(vec![step(Call::PostNotice, Operator, Active, 90), step(Call::SetReady, Session, ReadyMin, 600), step(REFUND, Session, Cd, 0), step(CLAIM, Operator, Cd, 1)]),
      ),
      Some(State::Done),
    );
    add(seq("rows/A/8-claim-after-final", "row 8: the taker never returns; A11c", open, with(vec![step(Call::PostNotice, Operator, Active, 90), step(CLAIM, Operator, Final, 0)])), Some(State::Done));
    add(seq("rows/A/abort-pre-notice", "A7a: amount to the taker at once", open, with(vec![step(Call::Abort, Operator, Active, 30)])), Some(State::Done));
    add(seq("rows/A/abort-early-then-refund", "A7b then A10d: a full refund, no hold", open, with(vec![step(Call::PostNotice, Operator, Active, 90), step(Call::Abort, Operator, Notice, 60), step(REFUND, Session, Notice, 120)])), Some(State::Done));
    add(seq("rows/A/abort-after-ready-then-claim-at-final", "A7d then A11c: an abort is a waiver until the final deadline, not forever", open, with(vec![step(Call::PostNotice, Operator, Active, 90), step(Call::SetReady, Session, ReadyMin, 600), step(Call::Abort, Operator, Ready, 60), step(CLAIM, Operator, Final, -1), step(CLAIM, Operator, Final, 0)])), Some(State::Done));
    add(seq("rows/A/expired-refund", "A10f: after T_exp only the locker can refund", open, with(vec![step(Call::PostNotice, Operator, Active, 90), step(CLAIM, Operator, Exp, 0), step(REFUND, Session, Exp, 0)])), Some(State::Done));

    let open_b = open_args(chain, B, mode::AUTO, false, Option::None);
    let funded = vec![step(FUND, Operator, Lock, 12)];
    let with_b = |extra: Vec<Step>| {
      let mut s = funded.clone();
      s.extend(extra);
      s
    };
    add(seq("rows/B/backout-pre-notice", "B9a", open_b, with_b(vec![step(REFUND, Operator, Active, 60)])), Some(State::Done));
    add(seq("rows/B/backout-post-notice", "B9c: the maker's free option", open_b, with_b(vec![step(Call::PostNotice, Session, Active, 90), step(REFUND, Operator, Cut, -1)])), Some(State::Done));
    add(seq("rows/B/refund-unconfirmed", "B9d: the lock is not confirmed at T_cut", open_b, with_b(vec![step(Call::PostNotice, Session, Active, 90), step(REFUND, Operator, Cut, 0), step(Call::ReleaseDeposit, Anyone, Hold, 0)])), Some(State::Done));
    add(seq("rows/B/taker-misses-claim", "B9e", open_b, with_b(vec![step(Call::PostNotice, Session, Active, 90), step(Call::SetReady, Operator, ReadyMin, 600), step(REFUND, Operator, Cd, 0), step(Call::ReleaseDeposit, Anyone, Hold, 0)])), Some(State::Done));
    add(seq("rows/B/taker-abort-then-refund", "B8 then B9f", open_b, with_b(vec![step(Call::PostNotice, Session, Active, 90), step(Call::Abort, Session, Notice, 60), step(REFUND, Operator, Notice, 120), step(Call::ReleaseDeposit, Operator, Refund, 5)])), Some(State::Done));
    add(seq("rows/B/claim-without-ready", "B10b", open_b, with_b(vec![step(Call::PostNotice, Session, Active, 90), step(CLAIM, Session, Co, 0)])), Some(State::Done));
    add(seq("rows/B/claim-after-final", "B10c after an abort", open_b, with_b(vec![step(Call::PostNotice, Session, Active, 90), step(Call::Abort, Session, Notice, 60), step(CLAIM, Session, Final, 0)])), Some(State::Done));
    add(seq("rows/B/expired-refund", "B9g: the take deposit returns to the taker", open_b, with_b(vec![step(Call::PostNotice, Session, Active, 90), step(REFUND, Operator, Exp, 0)])), Some(State::Done));
    add(seq("rows/B/no-notice", "B9b then the deposit returns", open_b, with_b(vec![step(REFUND, Operator, Note, 0), step(Call::ReleaseDeposit, Anyone, Hold, 0)])), Some(State::Done));
  }

  // ---------------------------------------------------------------- Amendment 1 (SPEC 11.7)
  let step_values = |v: &Value| -> Vec<u128> {
    v["steps"].as_array().unwrap().iter().map(|st| st["expect"]["open_value_after"].as_str().map(|x| x.parse().unwrap())).scan(0u128, |last, x| { if let Some(x) = x { *last = x; } Some(*last) }).collect()
  };
  let all_exits = exit_scenarios(chain);

  // 13. Caps: for each exit type the open value before and after. One subtraction, at the
  //     transition that leaves the open states, and none at release, split or withdrawal.
  for e in &all_exits {
    let s = seq(format!("exit/{}/{}", dir_name(e.dir), e.name), "SPEC 11.1: the counted value is added at the open and subtracted exactly once, when the swap enters HOLD or DONE", e.open, e.steps.clone());
    let (v, end) = run_seq(chain, &s);
    assert!(names.borrow_mut().insert(s.name.clone()), "duplicate sequence {}", s.name);
    assert_eq!(end.state, State::Done, "{}", s.name);
    assert!(!end.has(flag::COUNTED), "{}", s.name);
    let counted = e.open.amount + if e.dir == B { amounts::deposit_of(e.open.amount, e.open.params.dep_bps) } else { 0 };
    let values = step_values(&v);
    assert_eq!(values[0], counted, "{}", s.name);
    assert_eq!(*values.last().unwrap(), 0, "{}", s.name);
    let drops: Vec<usize> = (1..values.len()).filter(|i| values[*i] != values[*i - 1]).collect();
    assert_eq!(drops.len(), 1, "{}: the open value changes once after the open", s.name);
    let at = &v["steps"][drops[0]]["expect"];
    assert!(at["state"] == "HOLD" || at["state"] == "DONE", "{}", s.name);
    assert_eq!(v["final"]["open_value"], "0");
    // The same walk with every cap at zero, the maker paused (and, in a replay, both epochs
    // bumped) right after the open: every step gives the same answer (invariant 3).
    let mut h = seq(format!("invariant3/{}/{}", dir_name(e.dir), e.name), "SPEC 11.1, invariant 3: after the open every cap is set to zero with the switch on, the maker is paused and both epochs are bumped; every exit runs to its end exactly as without them", e.open, e.steps.clone());
    h.hostile = true;
    let (hv, hend) = run_seq(chain, &h);
    assert!(names.borrow_mut().insert(h.name.clone()));
    assert_eq!(hend, end, "{}", h.name);
    for (a, b) in v["steps"].as_array().unwrap().iter().zip(hv["steps"].as_array().unwrap()) {
      assert_eq!(a["expect"], b["expect"], "{}: a switch changed the answer of {}", h.name, a["call"]);
    }
    out.borrow_mut().push(v);
    out.borrow_mut().push(hv);
  }

  // 14. Payout address (SPEC 11.2): every claim row pays the payout address; nothing else does.
  {
    let mut open = open_args(chain, B, mode::AUTO, false, Option::None);
    open.payout = PayoutArg::Other;
    let mut frozen_open = open;
    frozen_open.params.w_z = FREEZE_SECS;
    let noticed = vec![step(FUND, Operator, Lock, 12), step(Call::PostNotice, Session, Active, 90)];
    let with = |extra: Vec<Step>| {
      let mut s = noticed.clone();
      s.extend(extra);
      s
    };
    let pays_payout = |name: &str, about: &'static str, open: OpenArgs, steps: Vec<Step>| {
      let s = seq(name, about, open, steps);
      let (v, end) = run_seq(chain, &s);
      assert_eq!(end.state, State::Done, "{name}");
      let claim = v["steps"].as_array().unwrap().iter().find(|st| st["call"] == "claim" && st["expect"]["ok"] == true).unwrap_or_else(|| panic!("{name}: no claim")).clone();
      let amount = end.amount - amounts::fee_of(end.amount, end.fee_bps) + end.deposit;
      assert_eq!(claim["expect"]["payouts"][0], json!({ "to": "payout", "amount": d(amount), "parked": claim["env"]["payout_can_receive"] == false }), "{name}");
      for st in v["steps"].as_array().unwrap() {
        for p in st["expect"]["payouts"].as_array().into_iter().flatten() {
          assert_ne!(p["to"], "taker", "{name}: the taking wallet receives nothing");
        }
      }
      assert!(names.borrow_mut().insert(s.name.clone()));
      out.borrow_mut().push(v);
    };
    pays_payout("payout/B/claim-ready", "B10a pays amount - fee + Dp to the payout address, signed by the session key", open, with(vec![step(Call::SetReady, Operator, ReadyMin, 600), step(CLAIM, Session, Ready, 60)]));
    pays_payout("payout/B/claim-without-ready", "B10b pays the payout address", open, with(vec![step(CLAIM, TakerWallet, Co, 0)]));
    pays_payout("payout/B/claim-after-final", "B10c pays the payout address", open, with(vec![step(CLAIM, Session, Final, 0)]));
    pays_payout(
      "payout/B/claim-after-freeze",
      "Z4 pays the payout address",
      frozen_open,
      vec![step(FUND_WATCHED, Operator, Lock, 12), step(Call::PostNotice, Session, Active, 90), step(Call::Freeze, Role::Watcher, Notice, 30), step(CLAIM, Session, Ff, 0)],
    );
    let no_payout = Env { payout_can_receive: false, ..Env::OK };
    // A stranger delivers parked proceeds: on Solana with withdraw_owed and the destination
    // pinned to the payout address, on Ethereum with pushOwed. The taking wallet cannot redirect.
    let mut steps = with(vec![
      step(Call::SetReady, Operator, ReadyMin, 600),
      step(CLAIM, Session, Ready, 60).env(no_payout),
      step(Call::WithdrawOwed(Party::Taker), TakerWallet, Ready, 100), // refused: not the taker's
      step(Call::WithdrawOwed(Party::Payout), Anyone, Ready, 110),     // Solana: delivered. Ethereum: the caller is owed nothing
    ]);
    if c.push_owed {
      steps.push(step(Call::PushOwed(Party::Taker), Anyone, Ready, 120)); // refused: nothing is owed to the taker
      steps.push(step(Call::PushOwed(Party::Payout), Anyone, Ready, 130));
    }
    steps.push(step(Call::WithdrawOwed(Party::Payout), Role::Payout, Ready, 140)); // refused: already delivered
    pays_payout("payout/B/parked-then-delivered-by-a-stranger", "the payout address cannot receive: the proceeds are parked for it and a stranger's call delivers them to it and nowhere else", open, steps);
    let steps = with(vec![
      step(Call::SetReady, Operator, ReadyMin, 600),
      step(CLAIM, Session, Ready, 60).env(no_payout),
      step(Call::WithdrawOwed(Party::Payout), Role::Payout, Ready, 100),
      step(Call::WithdrawOwed(Party::Payout), Role::Payout, Ready, 110), // refused: nothing owed
    ]);
    pays_payout("payout/B/parked-then-withdrawn-by-the-payout-address", "the payout address pulls its own parked proceeds", open, steps);
    // Everything that is not a claim returns to the taker's own wallet.
    for e in all_exits.iter().filter(|e| e.dir == B && !e.name.contains("claim")) {
      let mut o = e.open;
      o.payout = PayoutArg::Other;
      let name = format!("payout/B/not-a-claim/{}", e.name);
      let s = seq(name.clone(), "SPEC 11.2: a swap with a payout address ends without a claim; the take deposit returns to the taker's own wallet, never to the payout address", o, e.steps.clone());
      let (v, end) = run_seq(chain, &s);
      assert_eq!(end.payout, PayoutTo::Other);
      let mut to_taker = 0u128;
      for st in v["steps"].as_array().unwrap() {
        for p in st["expect"]["payouts"].as_array().into_iter().flatten() {
          assert_ne!(p["to"], "payout", "{name}");
          if p["to"] == "taker" && (p["parked"] == false) {
            to_taker += p["amount"].as_str().unwrap().parse::<u128>().unwrap();
          }
        }
      }
      // The whole deposit, or its larger half after a split.
      let split = v["steps"].as_array().unwrap().iter().any(|st| st["call"] == "split_deposit");
      assert_eq!(to_taker, if split { amounts::split_of(end.deposit).0 } else { end.deposit }, "{name}");
      assert!(names.borrow_mut().insert(name));
      out.borrow_mut().push(v);
    }
  }

  // 15. Freeze (SPEC 11.6).
  for dir in [A, B] {
    let (claimer, locker) = roles(dir);
    let watcher = Role::Watcher;
    let mut open = open_args(chain, dir, mode::AUTO, false, Option::None);
    open.params.w_z = FREEZE_SECS;
    open.watcher = dir == A;
    let enter = |open: &OpenArgs| -> Vec<Step> {
      let mut s: Vec<Step> = if dir == B { vec![step(FUND_WATCHED, Operator, Lock, 12)] } else { leave_pending(dir, open) };
      s.push(step(Call::PostNotice, claimer, Active, 90));
      s
    };
    let with = |extra: Vec<Step>| {
      let mut s = enter(&open);
      s.extend(extra);
      s
    };
    let dn = dir_name(dir);
    add(
      seq(
        format!("freeze/{dn}/by-the-locker"),
        "Z1 by the locker itself, then Z2: it sets ready and the swap completes",
        open,
        with(vec![step(Call::Freeze, locker, Notice, 30), step(Call::SetReady, locker, ReadyMin, 600), step(CLAIM, claimer, Ready, 60)]),
      ),
      Some(State::Done),
    );
    add(
      seq(
        format!("freeze/{dn}/claim-waits-for-T_ff"),
        "a false notice is frozen and the locker never returns: the claim-without-ready is refused at T_co and until T_ff, then succeeds (Z4)",
        open,
        with(vec![step(Call::Freeze, watcher, Co, -1), step(CLAIM, claimer, Co, 0), step(CLAIM, claimer, Ff, -1), step(CLAIM, claimer, Ff, 0)]),
      ),
      Some(State::Done),
    );
    add(
      seq(
        format!("freeze/{dn}/watcher-has-no-other-power"),
        "the watcher freezes once; its second freeze, set_ready, abort, cancel, notice, withhold and release are all refused; the locker's set_ready is not delayed",
        open,
        with(vec![
          step(Call::SetReady, watcher, Notice, 20),
          step(Call::Abort, watcher, Notice, 21),
          step(Call::CancelPending, watcher, Notice, 22),
          step(Call::PostNotice, watcher, Notice, 23),
          step(Call::Freeze, watcher, Notice, 30),
          step(Call::Freeze, watcher, Freeze, 1),
          step(Call::Freeze, locker, Freeze, 2),
          step(Call::SetReady, watcher, ReadyMin, 0),
          step(Call::Abort, watcher, ReadyMin, 1),
          step(Call::Withhold(Evidence::Opens), watcher, ReadyMin, 2),
          step(Call::ReleaseDeposit, watcher, ReadyMin, 3),
          step(Call::WithdrawOwed(Party::Treasury), watcher, ReadyMin, 4),
          step(Call::SetReady, locker, ReadyMin, 5),
        ]),
      ),
      Some(State::Ready),
    );
    // The latest reachable T_cd: everything at its last second, W_n and W_z at their caps and
    // the smallest final window.
    let mut tight = open;
    tight.offer_mode = if dir == A { mode::WINDOW } else { mode::AUTO };
    tight.params.w_n = c.max_notice_secs;
    tight.params.w_z = amounts::MAX_FREEZE_SECS;
    let pending = if c.explicit_approve || dir == A { Pending::ApprovalWindow } else { Pending::FundingWindow };
    tight.params.w_f = min_final_window(&tight.params, pending_window(&tight.params, pending)) as u32;
    let steps = vec![
      step(if dir == A { APPROVE } else { FUND_WATCHED }, Operator, Pend, -1),
      step(Call::PostNotice, claimer, if dir == A { Note } else { Nl }, -1),
      step(Call::Freeze, watcher, Co, -1),
      step(Call::SetReady, locker, Ff, -1),
      step(REFUND, locker, Cd, -1), // refused: the claimer's window
      step(CLAIM, claimer, Cd, -1),
    ];
    let s = add(seq(format!("freeze/{dn}/latest-T_cd"), "a freeze at T_co - 1 and a ready at T_ff - 1 with W_n and W_z at their caps and the smallest final window: T_cd still precedes T_final - 86,400", tight, steps), Some(State::Done));
    assert!(s.t_claim_deadline < s.t_final - amounts::DAY_SECS, "freeze/{dn}/latest-T_cd");
    // Each event one second before its deadline: approval, notice, freeze and ready in A (four
    // seconds of slack); notice (against T_nl), freeze and ready in B (three).
    assert_eq!(s.t_claim_deadline, s.t_final - amounts::DAY_SECS - if dir == A { 4 } else { 3 }, "freeze/{dn}/latest-T_cd");
    assert!(s.t_freeze + (s.w_z as i64) < s.t_final - s.w_c as i64 - amounts::DAY_SECS);
  }

  // 16. Solana: split_deposit never fails on its treasury slot (SPEC 11.1). An account that is
  //     not the one the current split_mode names parks the treasury's half.
  if !c.open_secret_calls {
    let open = open_args(chain, A, mode::AUTO, false, Option::None);
    let wrong_slot = Env { treasury_can_receive: false, ..Env::OK };
    let mut steps = leave_pending(A, &open);
    steps.extend([
      step(Call::PostNotice, Operator, Active, 90),
      step(REFUND, Session, Notice, 400),
      step(Call::Withhold(Evidence::Opens), Operator, Refund, 50),
      step(Call::SplitDeposit, Anyone, Split, 0).env(wrong_slot),
      step(Call::WithdrawOwed(Party::Treasury), Anyone, Split, 60),
    ]);
    let s = seq("deposit/A/split-with-the-other-treasury-slot", "the admin flipped split_mode after the withhold: the taker's half is paid as always, the treasury's half is parked in owed_treasury, and the split does not fail", open, steps);
    let (v, end) = run_seq(chain, &s);
    let split = v["steps"].as_array().unwrap().iter().find(|st| st["call"] == "split_deposit").unwrap();
    assert_eq!(split["expect"]["payouts"][0]["parked"], false);
    assert_eq!(split["expect"]["payouts"][1], json!({ "to": "treasury", "amount": d(end.deposit / 2), "parked": true }));
    assert_eq!(end.owed_treasury, 0);
    assert!(names.borrow_mut().insert(s.name.clone()));
    out.borrow_mut().push(v);
  }
  out.into_inner()
}

/// One way out of a swap, from its open to its end in DONE.
struct Exit {
  name: &'static str,
  dir: Direction,
  open: OpenArgs,
  steps: Vec<Step>,
}

/// Every exit type of SPEC 3.4 to 3.6 and 11.6, per direction.
fn exit_scenarios(chain: Chain) -> Vec<Exit> {
  use Anchor::*;
  use Direction::{A, B};
  use Role::{Anyone, Operator, Owner, Session, TakerWallet};
  let c = chain.consts();
  let mut v = Vec::new();
  for dir in [A, B] {
    let (claimer, locker) = if dir == A { (Operator, Session) } else { (Session, Operator) };
    let auto = open_args(chain, dir, mode::AUTO, false, Option::None);
    let window = open_args(chain, dir, mode::WINDOW, false, Option::None);
    let mut watched = auto;
    watched.params.w_z = FREEZE_SECS;
    watched.watcher = dir == A;
    let leave = |watcher: bool| -> Vec<Step> {
      if dir == B {
        vec![step(if watcher { FUND_WATCHED } else { FUND }, Operator, Lock, 12)]
      } else if c.explicit_approve {
        vec![step(APPROVE, Operator, Lock, 12)]
      } else {
        vec![]
      }
    };
    let active = |extra: Vec<Step>| {
      let mut s = leave(false);
      s.extend(extra);
      s
    };
    let noticed = |extra: Vec<Step>| {
      let mut s = leave(false);
      s.push(step(Call::PostNotice, claimer, Active, 90));
      s.extend(extra);
      s
    };
    let ready = |extra: Vec<Step>| {
      let mut s = leave(false);
      s.push(step(Call::PostNotice, claimer, Active, 90));
      s.push(step(Call::SetReady, locker, ReadyMin, 600));
      s.extend(extra);
      s
    };
    let frozen = |extra: Vec<Step>| {
      let mut s = leave(true);
      s.push(step(Call::PostNotice, claimer, Active, 90));
      s.push(step(Call::Freeze, Role::Watcher, Notice, 30));
      s.extend(extra);
      s
    };
    let mut add = |name: &'static str, open: OpenArgs, steps: Vec<Step>| v.push(Exit { name, dir, open, steps });
    let release = step(Call::ReleaseDeposit, Anyone, Hold, 0);
    add("reject", window, vec![step(reject(RejectReason::MakerChoice), Operator, Lock, 10)]);
    add("cancel", window, vec![step(Call::CancelPending, Session, Lock, 10)]);
    add("expire", window, vec![step(Call::ExpirePending, Anyone, Pend, 0)]);
    if dir == A {
      add("refund_unnoticed", auto, active(vec![step(Call::RefundUnnoticed, Anyone, Note, 0)]));
      add("abort-before-notice", auto, active(vec![step(Call::Abort, Operator, Active, 30)]));
      add("abort-early-then-refund", auto, noticed(vec![step(Call::Abort, claimer, Notice, 60), step(REFUND, locker, Notice, 120)]));
      add("abort-late-then-refund-then-release", auto, noticed(vec![step(Call::Abort, claimer, Co, 5), step(REFUND, locker, Co, 600), release]));
      add("refund-active-then-release", auto, active(vec![step(REFUND, locker, Active, 60), release]));
      add("refund-noticed-then-withhold-then-split", auto, noticed(vec![step(REFUND, locker, Notice, 200), step(Call::Withhold(Evidence::Opens), Operator, Refund, 60), step(Call::SplitDeposit, Anyone, Split, 0)]));
      add("refund-after-T_note", auto, active(vec![step(REFUND, locker, Note, 5)]));
      add("refund-missed-claim", auto, ready(vec![step(REFUND, locker, Cd, 0)]));
      add("refund-expired", auto, noticed(vec![step(REFUND, locker, Exp, 0)]));
    } else {
      add("lapse", auto, vec![step(Call::ExpirePending, Anyone, Pend, 0)]);
      add("backout-before-notice", auto, active(vec![step(REFUND, locker, Active, 60)]));
      add("refund-no-notice-then-release", auto, active(vec![step(REFUND, locker, Note, 5), release]));
      add("backout-after-notice", auto, noticed(vec![step(REFUND, locker, Cut, -1)]));
      // B9h: a refund before T_cut after the taker's own late notice holds the deposit.
      add("refund-late-notice-then-release", auto, active(vec![step(Call::PostNotice, claimer, Note, 30), step(REFUND, locker, Notice, 60), release]));
      add("refund-unconfirmed-then-withhold-then-split", auto, noticed(vec![step(REFUND, locker, Cut, 10), step(Call::Withhold(Evidence::Absent), Operator, Refund, 60), step(Call::SplitDeposit, Anyone, Split, 0)]));
      add("refund-missed-claim-then-release", auto, ready(vec![step(REFUND, locker, Cd, 0), step(Call::ReleaseDeposit, Operator, Refund, 5)]));
      add("abort-then-refund-then-release", auto, noticed(vec![step(Call::Abort, claimer, Notice, 60), step(REFUND, locker, Notice, 120), release]));
      add("refund-expired", auto, noticed(vec![step(REFUND, locker, Exp, 0)]));
      add("expire_unnoticed-then-withdraw", auto, active(vec![step(Call::ExpireUnnoticed, Anyone, Exp, 0), step(Call::WithdrawOwed(Party::Maker), Owner, Exp, 20)]));
    }
    add("claim-ready", auto, ready(vec![step(CLAIM, claimer, Ready, 60)]));
    add("claim-without-ready", auto, noticed(vec![step(CLAIM, claimer, Co, 0)]));
    add("claim-after-final", auto, noticed(vec![step(CLAIM, claimer, Final, 0)]));
    if dir == A {
      let no_maker = Env { maker_can_receive: false, ..Env::OK };
      add("claim-parked-then-withdraw", auto, ready(vec![step(CLAIM, claimer, Ready, 60).env(no_maker), step(Call::WithdrawOwed(Party::Maker), Owner, Ready, 120)]));
    } else {
      let no_taker = Env { taker_can_receive: false, ..Env::OK };
      add("claim-parked-then-withdraw", auto, ready(vec![step(CLAIM, claimer, Ready, 60).env(no_taker), step(Call::WithdrawOwed(Party::Taker), TakerWallet, Ready, 120)]));
    }
    add("freeze-then-ready-then-claim", watched, frozen(vec![step(Call::SetReady, locker, ReadyMin, 600), step(CLAIM, claimer, Ready, 60)]));
    if dir == A {
      add("freeze-then-refund-then-withhold-then-release", watched, frozen(vec![step(REFUND, locker, Freeze, 60), step(Call::Withhold(Evidence::Opens), Operator, Refund, 60), step(Call::ReleaseDeposit, Operator, Refund, 600)]));
    } else {
      add("freeze-then-refund-deposit-returned-at-once", watched, frozen(vec![step(REFUND, locker, Freeze, 60)]));
    }
    add("freeze-then-claim-at-T_ff", watched, frozen(vec![step(CLAIM, claimer, Ff, 0)]));
    add("freeze-then-abort-then-refund-then-release", watched, frozen(vec![step(Call::Abort, claimer, Freeze, 60), step(REFUND, locker, Freeze, 120), release]));
  }
  v
}

/// Sequences over several swaps of one asset and one maker (SPEC 11.1): the caps are lowered
/// below the current open value, the existing swaps run their exits, and a new open is refused
/// until the value has fallen.
fn multi_sequences(chain: Chain) -> Vec<Value> {
  use Anchor::*;
  use Direction::{A, B};
  use Role::{Anyone, Operator, Session, TakerWallet};
  let c = chain.consts();
  let mut out = Vec::new();
  for dir in [A, B] {
    let (claimer, locker) = if dir == A { (Operator, Session) } else { (Session, Operator) };
    let open = open_args(chain, dir, mode::AUTO, false, Option::None);
    let amount = open.amount;
    let counted = amount + if dir == B { amounts::deposit_of(amount, open.params.dep_bps) } else { 0 };
    // Two swaps fit; then the admin lowers max_open so that only one does.
    let roomy = Env { caps: Caps { on: true, max_swap: amount, max_open: 2 * counted, open_value: 0 }, ..Env::OK };
    let lowered = Env { caps: Caps { on: true, max_swap: amount, max_open: counted, open_value: 0 }, ..Env::OK };
    let mut runs: Vec<Run> = (0..4).map(|_| Run::new(chain)).collect();
    let mut maker = MakerRecord::default();
    let mut open_value = 0u128;
    let mut now = T0;
    let mut steps: Vec<Value> = Vec::new();
    let initial = maker_json(&maker);
    let mut values: Vec<u128> = Vec::new();
    let mut act = |swap: usize, call: Call, caller: Role, when: Result<i64, (Anchor, i64)>, env: Env, want_ok: Option<&str>| {
      let run = &mut runs[swap];
      run.maker = maker.clone();
      run.open_value = open_value;
      run.now = now;
      let (at, anchor) = match when {
        Ok(at) => (at, Option::None),
        Err((a, off)) => (a.resolve(&run.state, c) + off, Some((a, off))),
      };
      let (mut j, result) = run.exec(call, caller, at, anchor, &env, true);
      match (want_ok, &result) {
        (Option::None, Ok(_)) => {}
        (Some(err), Err(e)) => assert_eq!(e.chain_name(chain), err, "multi-sequence {} swap {swap} {}", dir_name(dir), call.name()),
        (w, r) => panic!("multi-sequence {} swap {swap} {}: wanted {w:?}, got {r:?}", dir_name(dir), call.name()),
      }
      maker = run.maker.clone();
      open_value = run.open_value;
      now = run.now;
      values.push(open_value);
      j.as_object_mut().unwrap().insert("swap".into(), json!(swap));
      steps.push(j);
      run.state.state
    };
    let taker = TakerWallet;
    let start = |act: &mut dyn FnMut(usize, Call, Role, Result<i64, (Anchor, i64)>, Env, Option<&str>) -> State, swap: usize, env: Env| {
      if dir == B {
        act(swap, FUND, Operator, Err((Lock, 12)), env, Option::None);
      } else if c.explicit_approve {
        act(swap, APPROVE, Operator, Err((Lock, 12)), env, Option::None);
      }
    };
    act(0, Call::Open(open), taker, Ok(T0), roomy, Option::None);
    act(1, Call::Open(open), taker, Ok(T0 + 1), roomy, Option::None);
    act(2, Call::Open(open), taker, Ok(T0 + 2), roomy, Some("OpenCapExceeded")); // a third does not fit
    // The admin lowers max_open below the current open value. Nothing already open is touched.
    act(2, Call::Open(open), taker, Ok(T0 + 3), lowered, Some("OpenCapExceeded"));
    start(&mut act, 0, lowered);
    start(&mut act, 1, lowered);
    act(0, Call::PostNotice, claimer, Err((Active, 90)), lowered, Option::None);
    act(1, Call::PostNotice, claimer, Err((Active, 91)), lowered, Option::None);
    act(0, Call::SetReady, locker, Err((ReadyMin, 600)), lowered, Option::None);
    act(0, CLAIM, claimer, Err((Ready, 60)), lowered, Option::None); // swap 0 leaves: one swap is open
    act(2, Call::Open(open), taker, Ok(T0 + 3_000), lowered, Some("OpenCapExceeded")); // still full
    let after_refund = act(1, REFUND, locker, Err((Notice, 2_950)), lowered, Option::None); // swap 1 enters HOLD or DONE: nothing is open
    act(2, Call::Open(open), taker, Ok(T0 + 3_500), lowered, Option::None); // exactly at the cap
    act(3, Call::Open(open), taker, Ok(T0 + 3_501), lowered, Some("OpenCapExceeded"));
    if after_refund == State::Hold {
      // Releasing a held deposit moves no open value.
      act(1, Call::ReleaseDeposit, Anyone, Err((Hold, 0)), lowered, Option::None);
    }
    drop(act);
    assert_eq!(values[..4], [counted, 2 * counted, 2 * counted, 2 * counted]);
    assert_eq!(open_value, counted, "one swap is open at the end");
    out.push(json!({
      "name": format!("caps/{}/lowered-below-the-open-value", dir_name(dir)),
      "chain": chain.name(), "direction": dir_name(dir),
      "about": "SPEC 11.1: three takers, one asset, one maker. Two swaps fill max_open; the admin lowers max_open to one swap's counted value; both existing swaps run their exits untouched; a new open is refused until the open value has fallen to zero, then accepted exactly at the cap",
      "swaps": 4, "initial_maker": initial, "steps": steps,
      "final": { "swaps": runs.iter().map(|r| if r.state.state == State::None { Value::Null } else { swap_json(&r.state) }).collect::<Vec<_>>(), "maker": maker_json(&maker), "open_value": d(open_value) },
    }));
  }
  out
}

pub fn transitions() -> VectorFile {
  let mut all_rows = Vec::new();
  let mut all_sequences = Vec::new();
  let mut all_multi = Vec::new();
  let mut summary = Map::new();
  for chain in [Chain::Solana, Chain::Ethereum] {
    let r = rows(chain);
    let s = sequences(chain);
    let m = multi_sequences(chain);
    // Every counter the chain can reach is exercised by some row or sequence.
    let mut seen = [false; counter::COUNT];
    let mut mark = |expect: &Value| {
      if let Some(c) = expect["counter"].as_u64() {
        seen[c as usize] = true;
      }
    };
    for row in &r {
      mark(&row["step"]["expect"]);
    }
    for sq in &s {
      for st in sq["steps"].as_array().unwrap() {
        mark(&st["expect"]);
      }
    }
    for id in 0..=counter::CLAIMS_AFTER_FREEZE {
      let reachable = !(id == counter::MISSED_FUNDS && !chain.consts().lapse_is_fault);
      assert_eq!(seen[id as usize], reachable, "{}: counter {} ({})", chain.name(), id, counter::NAMES[id as usize]);
    }
    let rejected = r.iter().filter(|x| x["ok"] == false).count();
    summary.insert(chain.name().into(), json!({ "rows": r.len(), "rows_rejected": rejected, "sequences": s.len(), "multi_sequences": m.len() }));
    all_rows.extend(r);
    all_sequences.extend(s);
    all_multi.extend(m);
  }
  // The standard `cases` array carries one entry per row so generic tooling sees the suite.
  let cases: Vec<Value> = all_rows
    .iter()
    .enumerate()
    .map(|(i, r)| {
      let name = format!("{:04} {} {} {}: {}", i, r["chain"].as_str().unwrap(), r["direction"].as_str().unwrap(), r["id"].as_str().unwrap(), r["case"].as_str().unwrap());
      if r["ok"] == true {
        json!({ "name": name, "valid": true, "row": i })
      } else {
        json!({ "name": name, "valid": false, "row": i, "error": r["step"]["expect"]["error"] })
      }
    })
    .collect();
  suite_lines(
    "transitions",
    cases,
    vec![
      ("rows", Value::Array(all_rows)),
      ("sequences", Value::Array(all_sequences)),
      ("multi_sequences", Value::Array(all_multi)),
      ("summary", Value::Object(summary)),
      ("t0", json!(T0)),
      ("counter_names", json!(counter::NAMES.to_vec())),
      (
        "how_to_replay",
        json!({
          "row": "Start from no swap. Run `open` (lock or take) by the taker wallet at `open.at`, then each `setup` step at its `at`, check the swap equals `from`, then run `step` at `step.at` and compare with `step.expect`.",
          "sequence": "Start the maker record at `initial_maker`. Run every step at its `at`. A step with `expect.ok == false` must fail with `expect.error` and change nothing.",
          "multi_sequence": "As a sequence, over several swaps of one asset and one maker: every step names its swap by index in `swap`; the swaps have different takers. `final.swaps[i]` is null for a swap that never opened.",
          "callers": { "taker": "the taker's wallet", "session": "the swap's session key", "operator": "the maker's operator key", "owner": "Solana: the maker's owner key. Ethereum: the account the parked payout is owed to", "watcher": "the watcher key the swap names; on a swap that names none, any other key", "payout": "the payout address named at take, when it is not the taker's own", "anyone": "an unrelated fee payer" },
          "args": {
            "secret_ok": "true: the scalar that opens the commitment. false: any other scalar in range",
            "open_ok": "true: expected_open is the swap's open hash. false: any other 32 bytes",
            "evidence": "absent: none (Solana None, Ethereum zeros). opens: the notice opening. mismatch: any other pair",
            "opens": "as evidence",
            "offer_mode": "0 AUTO, 1 WINDOW, 2 ADVANCE, 3 taker-bound quote",
            "approval": "a valid advance approval accompanies the lock",
            "w_z": "the freeze window of the offer or quote (0: no watcher accepted)",
            "payout": "take only. taker: the taker's own address. other: another valid address. invalid: Solana, the default key, the program id or a token account; Ethereum, the zero address. lock ignores it (always `taker` in these vectors)",
            "watcher": "lock (direction A) and fund (direction B): a watcher key is named",
            "who": "withdraw_owed, push_owed: whose parked balance. `payout` is Solana withdraw_owed(0) on a direction-B swap that ended in a claim (signed by the payout address, or by anyone with the destination pinned to it), Ethereum withdrawOwed by the payout address. push_owed is Ethereum pushOwed(token, account) and exists in Ethereum sequences only",
          },
          "swap_fields": "`payout`: none (direction A, zeros on chain), taker (the taker's own address), other. `watcher`: a watcher is named. `flags` bit 5 (32): counted in the open value. On a direction-B swap that ended in a claim with `payout` = other, `owed_taker` is owed to the payout address (Ethereum: owed[token][payout])",
          "hostile_after_open": "true in the invariant3/ sequences: right after the open the replay sets every cap to zero with the switch on, sets both pause bits (Solana) or paused (Ethereum) and bumps both epochs; every later step must still match",
          "env": "which payout destinations can receive (pay or park), the maker's open_pending before a lock or take, `maker_paused` (the pause that applies to this open), and `caps`: the switch, max_swap and max_open of the swap's asset and its open_value before the call (decimal strings). Rows start from open_value 0 except the lock/take rows whose env says otherwise (as with open_pending, the replay presets it). On Ethereum the treasury share only increments treasuryAccrued: it is listed as paid to `treasury`. On Solana `treasury_can_receive: false` at split_deposit is also how the `treasury` slot of the other split_mode is expressed: the treasury's half is parked.",
          "open_value_after": "the asset's open value after the call: plus the counted value (amount in A, amount + deposit in B) at lock/take, minus it at the one transition that enters HOLD or DONE, otherwise unchanged",
          "payouts": "`parked: false` was transferred; `parked: true` stayed in escrow and was added to owed_*. A payout of zero is absent.",
          "closed": "the row is marked closed in SPEC 3.4/3.5 and nothing was parked: Solana closes the swap account in the same instruction (the state then reads as 0); Ethereum keeps the swap in DONE.",
          "error": "the chain's error name. A call refused only because of the time is TooLate if one of its windows in that state has already closed, else TooEarly. Check order: direction, caller, state and open hash, time, then secret or evidence.",
        }),
      ),
    ],
  )
}
