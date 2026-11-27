//! The vector files on disk, consumed the way the contract test harnesses consume them:
//!
//! * `interfaces/vectors/` is byte-identical to what the crate generates (`gen-vectors --check`);
//! * every row and sequence of `transitions.json` can be replayed **from the JSON alone**: the
//!   call, its arguments, the caller, the time and the environment are enough to reproduce the
//!   expected result, state, timestamps, payouts and counters.

use std::path::PathBuf;

use serde_json::Value;
use swap_core::amounts::{Caps, Chain, SwapParams};
use swap_core::model::{
  apply, Call, Direction, Effects, Env, Evidence, MakerRecord, OpenArgs, Party, PayoutArg, RejectReason, Role, State,
  SwapState,
};

fn vectors_dir() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../interfaces/vectors")
}
fn load(name: &str) -> Value {
  let path = vectors_dir().join(name);
  serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

#[test]
fn vectors_on_disk_are_what_the_crate_generates() {
  let problems = swap_core::vectors::check_dir(&vectors_dir());
  assert!(problems.is_empty(), "interfaces/vectors is stale:\n  {}", problems.join("\n  "));
}

fn chain_of(v: &Value) -> Chain {
  match v.as_str().unwrap() {
    "solana" => Chain::Solana,
    "ethereum" => Chain::Ethereum,
    other => panic!("chain {other}"),
  }
}
fn role_of(v: &Value) -> Role {
  match v.as_str().unwrap() {
    "taker" => Role::TakerWallet,
    "session" => Role::Session,
    "operator" => Role::Operator,
    "owner" => Role::Owner,
    "watcher" => Role::Watcher,
    "payout" => Role::Payout,
    "anyone" => Role::Anyone,
    other => panic!("caller {other}"),
  }
}
fn num<T: std::str::FromStr>(v: &Value) -> T
where
  T::Err: std::fmt::Debug,
{
  match v {
    Value::String(s) => s.parse().unwrap(),
    Value::Number(n) => n.to_string().parse().unwrap(),
    other => panic!("not a number: {other}"),
  }
}
fn call_of(step: &Value) -> Call {
  let a = &step["args"];
  let b = |k: &str| a[k].as_bool().unwrap_or_else(|| panic!("{k} in {step}"));
  match step["call"].as_str().unwrap() {
    "lock" | "take" => Call::Open(OpenArgs {
      direction: if a["direction"] == "A" { Direction::A } else { Direction::B },
      offer_mode: num(&a["offer_mode"]),
      approval: b("approval"),
      xmr: num(&a["xmr"]),
      amount: num(&a["amount"]),
      params: SwapParams {
        w_a: num(&a["w_a"]),
        w_n: num(&a["w_n"]),
        d_c: num(&a["d_c"]),
        w_c: num(&a["w_c"]),
        w_f: num(&a["w_f"]),
        depth: num(&a["depth"]),
        dep_bps: num(&a["dep_bps"]),
        w_z: num(&a["w_z"]),
      },
      payout: match a["payout"].as_str().unwrap() {
        "taker" => PayoutArg::Taker,
        "other" => PayoutArg::Other,
        "invalid" => PayoutArg::Invalid,
        other => panic!("payout {other}"),
      },
      watcher: b("watcher"),
    }),
    "approve" => Call::Approve { open_ok: b("open_ok") },
    "fund" => Call::Fund { open_ok: b("open_ok"), watcher: b("watcher") },
    "reject" => Call::Reject {
      open_ok: b("open_ok"),
      reason: match a["reason"].as_u64().unwrap() {
        0 => RejectReason::MakerChoice,
        1 => RejectReason::UnusableInput,
        2 => RejectReason::LeafConsumed,
        other => panic!("reason {other}"),
      },
    },
    "cancel_pending" => Call::CancelPending,
    "expire_pending" => Call::ExpirePending,
    "post_notice" => Call::PostNotice,
    "set_ready" => Call::SetReady,
    "freeze" => Call::Freeze,
    "abort" => Call::Abort,
    "refund_unnoticed" => Call::RefundUnnoticed,
    "expire_unnoticed" => Call::ExpireUnnoticed,
    "refund" => Call::Refund { secret_ok: b("secret_ok") },
    "claim" => Call::Claim { secret_ok: b("secret_ok") },
    "release_deposit" => Call::ReleaseDeposit,
    "withhold" => Call::Withhold(match a["evidence"].as_str().unwrap() {
      "absent" => Evidence::Absent,
      "opens" => Evidence::Opens,
      "mismatch" => Evidence::Mismatch,
      other => panic!("evidence {other}"),
    }),
    "split_deposit" => Call::SplitDeposit,
    "publish_evidence" => Call::PublishEvidence { opens: b("opens") },
    "withdraw_owed" => Call::WithdrawOwed(party_of(&a["who"])),
    "push_owed" => Call::PushOwed(party_of(&a["who"])),
    other => panic!("call {other}"),
  }
}
fn party_of(v: &Value) -> Party {
  match v.as_str().unwrap() {
    "taker" => Party::Taker,
    "maker" => Party::Maker,
    "treasury" => Party::Treasury,
    "payout" => Party::Payout,
    other => panic!("who {other}"),
  }
}
fn env_of(step: &Value) -> Env {
  let e = &step["env"];
  Env {
    taker_can_receive: e["taker_can_receive"].as_bool().unwrap(),
    maker_can_receive: e["maker_can_receive"].as_bool().unwrap(),
    treasury_can_receive: e["treasury_can_receive"].as_bool().unwrap(),
    payout_can_receive: e["payout_can_receive"].as_bool().unwrap(),
    open_pending: num(&e["open_pending"]),
    caps: Caps {
      on: e["caps"]["on"].as_bool().unwrap(),
      max_swap: num(&e["caps"]["max_swap"]),
      max_open: num(&e["caps"]["max_open"]),
      open_value: num(&e["caps"]["open_value"]),
    },
    maker_paused: e["maker_paused"].as_bool().unwrap(),
  }
}

/// Compare a swap record with its JSON form, field by field.
fn assert_swap(s: &SwapState, j: &Value, ctx: &str) {
  assert_eq!(s.state.name(), j["state"], "{ctx}: state");
  assert_eq!(s.state as u8 as u64, j["state_code"].as_u64().unwrap(), "{ctx}: state_code");
  assert_eq!(if s.direction == Direction::A { "A" } else { "B" }, j["direction"], "{ctx}");
  for (name, value) in [
    ("mode", s.mode as i64),
    ("outcome", s.outcome as i64),
    ("deposit_state", s.deposit_state as i64),
    ("depth", s.depth as i64),
    ("flags", s.flags as i64),
    ("fee_bps", s.fee_bps as i64),
    ("w_n", s.w_n as i64),
    ("d_c", s.d_c as i64),
    ("w_c", s.w_c as i64),
    ("t_lock", s.t_lock),
    ("t_pending_deadline", s.t_pending_deadline),
    ("t_active", s.t_active),
    ("t_note_deadline", s.t_note_deadline),
    ("t_notice", s.t_notice),
    ("t_cut", s.t_cut),
    ("t_claim_open", s.t_claim_open),
    ("t_ready", s.t_ready),
    ("t_claim_deadline", s.t_claim_deadline),
    ("t_final", s.t_final),
    ("t_refund", s.t_refund),
    ("t_settled", s.t_settled),
    ("w_z", s.w_z as i64),
    ("t_freeze", s.t_freeze),
  ] {
    assert_eq!(value, j[name].as_i64().unwrap_or_else(|| panic!("{ctx}: {name} missing")), "{ctx}: {name}");
  }
  for (name, value) in [("amount", s.amount), ("deposit", s.deposit), ("owed_taker", s.owed_taker), ("owed_maker", s.owed_maker), ("owed_treasury", s.owed_treasury)] {
    assert_eq!(value, num::<u128>(&j[name]), "{ctx}: {name}");
  }
  assert_eq!(s.payout.name(), j["payout"], "{ctx}: payout");
  assert_eq!(s.watcher, j["watcher"].as_bool().unwrap(), "{ctx}: watcher");
}
fn assert_maker(m: &MakerRecord, j: &Value, ctx: &str) {
  let counters: Vec<u64> = j["counters"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap()).collect();
  assert_eq!(counters.len(), 40, "{ctx}");
  assert_eq!(m.counters.iter().map(|c| *c as u64).collect::<Vec<_>>(), counters, "{ctx}: counters");
  assert_eq!(m.response_secs_sum, num::<u64>(&j["response_secs_sum"]), "{ctx}: response_secs_sum");
  assert_eq!(m.volume, num::<u128>(&j["volume"]), "{ctx}: volume");
  assert_eq!(m.withheld_volume, num::<u128>(&j["withheld_volume"]), "{ctx}: withheld_volume");
  assert_eq!(m.open_pending as u64, j["open_pending"].as_u64().unwrap(), "{ctx}: open_pending");
}
fn maker_of(j: &Value) -> MakerRecord {
  let mut m = MakerRecord::default();
  for (i, c) in j["counters"].as_array().unwrap().iter().enumerate() {
    m.counters[i] = c.as_u64().unwrap() as u32;
  }
  m.response_secs_sum = num(&j["response_secs_sum"]);
  m.volume = num(&j["volume"]);
  m.withheld_volume = num(&j["withheld_volume"]);
  m.open_pending = num(&j["open_pending"]);
  m
}

/// Run one step and compare with its `expect`. Returns the effects when it succeeded.
fn check_step(state: SwapState, step: &Value, chain: Chain, ctx: &str) -> Option<Effects> {
  let result = apply(state, call_of(step), role_of(&step["caller"]), step["at"].as_i64().unwrap(), &env_of(step), chain.consts());
  let expect = &step["expect"];
  match (&result, expect["ok"].as_bool().unwrap()) {
    (Err(e), false) => {
      assert_eq!(e.chain_name(chain), expect["error"], "{ctx}: error");
      None
    }
    (Ok(fx), true) => {
      assert_eq!(fx.state.state.name(), expect["state"], "{ctx}: state");
      assert_eq!(fx.counter.map(|c| c as u64), expect["counter"].as_u64(), "{ctx}: counter");
      let payouts: Vec<(String, u128, bool)> = fx.payouts.iter().map(|p| (p.to.name().to_string(), p.amount, p.parked)).collect();
      let want: Vec<(String, u128, bool)> = expect["payouts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["to"].as_str().unwrap().to_string(), num(&p["amount"]), p["parked"].as_bool().unwrap()))
        .collect();
      assert_eq!(payouts, want, "{ctx}: payouts");
      assert_eq!(fx.escrow_in, num::<u128>(&expect["escrow_in"]), "{ctx}: escrow_in");
      assert_eq!(fx.response_secs, expect["response_secs"].as_u64(), "{ctx}: response_secs");
      assert_eq!(fx.volume, num::<u128>(&expect["volume"]), "{ctx}: volume");
      assert_eq!(fx.withheld_volume, num::<u128>(&expect["withheld_volume"]), "{ctx}: withheld_volume");
      assert_eq!(fx.open_pending as i64, expect["open_pending"].as_i64().unwrap(), "{ctx}: open_pending");
      assert_eq!(fx.closed, expect["closed"].as_bool().unwrap(), "{ctx}: closed");
      assert_eq!(fx.open_value_after, num::<u128>(&expect["open_value_after"]), "{ctx}: open_value_after");
      assert_swap(&fx.state, &expect["swap"], ctx);
      result.ok()
    }
    (Err(e), true) => panic!("{ctx}: expected success, got {e:?}"),
    (Ok(fx), false) => panic!("{ctx}: expected {}, got {:?}", expect["error"], fx.state.state),
  }
}

#[test]
fn every_row_replays_from_the_json_alone() {
  let t = load("transitions.json");
  let rows = t["rows"].as_array().unwrap();
  assert!(rows.len() >= 1_100, "{} rows", rows.len());
  let mut ok = 0;
  let mut rejected = 0;
  for (i, row) in rows.iter().enumerate() {
    let chain = chain_of(&row["chain"]);
    let ctx = format!("row {i} [{} {} {}: {}]", row["chain"], row["direction"], row["id"], row["case"]);
    let mut state = SwapState::NONE;
    // `open` and `setup` carry no expectation: they must simply succeed.
    let mut prelude: Vec<&Value> = Vec::new();
    if let Some(open) = row.get("open") {
      prelude.push(open);
    }
    prelude.extend(row["setup"].as_array().unwrap());
    for step in prelude {
      let fx = apply(state, call_of(step), role_of(&step["caller"]), step["at"].as_i64().unwrap(), &env_of(step), chain.consts())
        .unwrap_or_else(|e| panic!("{ctx}: setup {} failed: {e:?}", step["call"]));
      state = fx.state;
    }
    if let Some(from) = row.get("from") {
      assert_swap(&state, from, &format!("{ctx}: from"));
      assert_eq!(row["from_state"], from["state"], "{ctx}");
    } else {
      assert_eq!(state.state, State::None, "{ctx}");
    }
    match check_step(state, &row["step"], chain, &ctx) {
      Some(_) => ok += 1,
      None => rejected += 1,
    }
    assert_eq!(row["ok"], row["step"]["expect"]["ok"], "{ctx}");
    // The time is the anchor plus the offset, where one is given.
    if let Some(anchor) = row["step"].get("anchor") {
      assert!(anchor["name"].is_string() && anchor["offset"].is_i64(), "{ctx}");
    }
  }
  // Both sides of every boundary: a healthy share of the rows are rejections.
  assert!(ok > 500 && rejected > 500, "{ok} accepted, {rejected} rejected");
  // The `cases` index points at the rows.
  let cases = t["cases"].as_array().unwrap();
  assert_eq!(cases.len(), rows.len());
  for c in cases {
    let row = &rows[c["row"].as_u64().unwrap() as usize];
    assert_eq!(c["valid"], row["ok"]);
  }
}

#[test]
fn every_sequence_replays_from_the_json_alone() {
  let t = load("transitions.json");
  let sequences = t["sequences"].as_array().unwrap();
  assert!(sequences.len() >= 600, "{} sequences", sequences.len());
  for seq in sequences {
    let chain = chain_of(&seq["chain"]);
    let mut state = SwapState::NONE;
    let mut maker = maker_of(&seq["initial_maker"]);
    let mut last = i64::MIN;
    // The asset's open value is state of the replay, like the maker record: every step's env
    // must carry the value the previous step left.
    let mut open_value = 0u128;
    for (i, step) in seq["steps"].as_array().unwrap().iter().enumerate() {
      let ctx = format!("sequence {} ({}) step {i} {}", seq["name"], seq["chain"], step["call"]);
      let at = step["at"].as_i64().unwrap();
      assert!(at >= last, "{ctx}: time runs backwards");
      last = at;
      assert_eq!(env_of(step).caps.open_value, open_value, "{ctx}: env.caps.open_value");
      if i > 0 && seq["hostile_after_open"] == true {
        let env = env_of(step);
        assert!(env.caps.on && env.caps.max_swap == 0 && env.caps.max_open == 0 && env.maker_paused, "{ctx}: not hostile");
      }
      if let Some(fx) = check_step(state, step, chain, &ctx) {
        state = fx.state;
        open_value = fx.open_value_after;
        maker.record(&fx, chain.consts().max_amount);
        assert_maker(&maker, &step["expect"]["maker"], &ctx);
      }
    }
    let ctx = format!("sequence {} ({}) final", seq["name"], seq["chain"]);
    assert_swap(&state, &seq["final"]["swap"], &ctx);
    assert_maker(&maker, &seq["final"]["maker"], &ctx);
    assert_eq!(open_value, num::<u128>(&seq["final"]["open_value"]), "{ctx}: open_value");
    // SPEC 11.1: the open value is exactly the counted value of the swap while it is open.
    let counted = if state.has(swap_core::model::flag::COUNTED) { state.amount + if state.direction == Direction::B { state.deposit } else { 0 } } else { 0 };
    assert_eq!(open_value, counted, "{ctx}: open value against the counted flag");
    assert_eq!(state.has(swap_core::model::flag::COUNTED), state.state.is_open(), "{ctx}: counted flag against the state");
  }
}

/// SPEC 11.1: the sequences over several swaps. The open value at every step is the sum of the
/// counted values of the swaps still open.
#[test]
fn every_multi_sequence_replays_from_the_json_alone() {
  let t = load("transitions.json");
  let multi = t["multi_sequences"].as_array().unwrap();
  assert_eq!(multi.len(), 4);
  for seq in multi {
    let chain = chain_of(&seq["chain"]);
    let n = seq["swaps"].as_u64().unwrap() as usize;
    let mut states = vec![SwapState::NONE; n];
    let mut maker = maker_of(&seq["initial_maker"]);
    let mut open_value = 0u128;
    let mut last = i64::MIN;
    let mut refused_opens = 0;
    for (i, step) in seq["steps"].as_array().unwrap().iter().enumerate() {
      let ctx = format!("multi-sequence {} ({}) step {i} {}", seq["name"], seq["chain"], step["call"]);
      let k = step["swap"].as_u64().unwrap() as usize;
      let at = step["at"].as_i64().unwrap();
      assert!(at >= last, "{ctx}: time runs backwards");
      last = at;
      assert_eq!(env_of(step).caps.open_value, open_value, "{ctx}: env.caps.open_value");
      match check_step(states[k], step, chain, &ctx) {
        Some(fx) => {
          states[k] = fx.state;
          open_value = fx.open_value_after;
          maker.record(&fx, chain.consts().max_amount);
          assert_maker(&maker, &step["expect"]["maker"], &ctx);
        }
        None => {
          // Only opens are ever refused here: no cap touches an existing swap.
          assert!(matches!(step["call"].as_str(), Some("lock" | "take")), "{ctx}: a cap refused an exit");
          assert_eq!(step["expect"]["error"], "OpenCapExceeded", "{ctx}");
          refused_opens += 1;
        }
      }
      let sum: u128 = states
        .iter()
        .filter(|s| s.state.is_open())
        .map(|s| s.amount + if s.direction == Direction::B { s.deposit } else { 0 })
        .sum();
      assert_eq!(open_value, sum, "{ctx}: open value is the sum of the counted values of the open swaps");
    }
    assert_eq!(refused_opens, 4, "{}", seq["name"]);
    for (k, s) in states.iter().enumerate() {
      let want = &seq["final"]["swaps"][k];
      if want.is_null() {
        assert_eq!(s.state, State::None);
      } else {
        assert_swap(s, want, &format!("multi-sequence {} final swap {k}", seq["name"]));
      }
    }
    assert_maker(&maker, &seq["final"]["maker"], "multi final");
    assert_eq!(open_value, num::<u128>(&seq["final"]["open_value"]));
  }
}

/// The sequences SPEC 2.12 requires "at minimum".
#[test]
fn required_sequences_are_present() {
  let t = load("transitions.json");
  for chain in ["solana", "ethereum"] {
    let names: Vec<&str> = t["sequences"].as_array().unwrap().iter().filter(|s| s["chain"] == chain).map(|s| s["name"].as_str().unwrap()).collect();
    let has = |n: &str| assert!(names.contains(&n), "{chain}: sequence {n} missing");
    // A happy path per direction and mode.
    for dir in ["A", "B"] {
      for mode in ["auto", "window", "advance", "quote"] {
        has(&format!("happy/{dir}/{mode}"));
      }
    }
    // For each deadline, the last enabled second and the first disabled second of every call it gates.
    for deadline in ["T_pend", "T_note", "T_cut", "T_co", "T_cd", "T_final", "T_exp", "T_hold", "T_split", "T_ff"] {
      let gated: Vec<&&str> = names.iter().filter(|n| n.starts_with(&format!("boundary/{deadline}/"))).collect();
      assert!(gated.len() >= 2 && gated.len() % 2 == 0, "{chain}: {deadline} has {} boundary sequences", gated.len());
      for n in &gated {
        let twin = if let Some(base) = n.strip_suffix("/T-1") { format!("{base}/T") } else { format!("{}/T-1", n.strip_suffix("/T").unwrap()) };
        has(&twin);
      }
    }
    has("extreme/B/last-second-everywhere");
    has("B/late-notice-then-refund");
    has("B/late-notice-then-claim-at-T_co");
    has("A/refund-in-active-after-T_note");
    has("B/expire_unnoticed");
    for n in ["parked/A/refund", "parked/A/claim", "parked/B/refund", "parked/B/claim"] {
      has(n);
    }
    for id in ["A10a", "A10b", "A10c", "B9b", "B9h", "B9d", "B9e", "B9f"] {
      has(&format!("no-deposit/{id}"));
    }
    has("saturation/counters-at-u32-max");
    // SPEC 11.7. Caps: each exit type, and the invariant-3 walk of each.
    let exits = [
      "A/reject", "A/cancel", "A/expire", "A/refund_unnoticed", "A/abort-before-notice", "A/abort-early-then-refund",
      "A/abort-late-then-refund-then-release", "A/refund-active-then-release", "A/refund-noticed-then-withhold-then-split",
      "A/refund-after-T_note", "A/refund-missed-claim", "A/refund-expired", "A/claim-ready", "A/claim-without-ready",
      "A/claim-after-final", "A/claim-parked-then-withdraw", "A/freeze-then-ready-then-claim",
      "A/freeze-then-refund-then-withhold-then-release", "A/freeze-then-claim-at-T_ff", "A/freeze-then-abort-then-refund-then-release",
      "B/reject", "B/cancel", "B/expire", "B/lapse", "B/backout-before-notice", "B/refund-no-notice-then-release",
      "B/backout-after-notice", "B/refund-late-notice-then-release", "B/refund-unconfirmed-then-withhold-then-split", "B/refund-missed-claim-then-release",
      "B/abort-then-refund-then-release", "B/refund-expired", "B/expire_unnoticed-then-withdraw", "B/claim-ready",
      "B/claim-without-ready", "B/claim-after-final", "B/claim-parked-then-withdraw", "B/freeze-then-ready-then-claim",
      "B/freeze-then-refund-deposit-returned-at-once", "B/freeze-then-claim-at-T_ff", "B/freeze-then-abort-then-refund-then-release",
    ];
    for e in exits {
      has(&format!("exit/{e}"));
      has(&format!("invariant3/{e}"));
    }
    // Payout: each claim row, parked proceeds delivered both ways, and every non-claim exit.
    for n in ["claim-ready", "claim-without-ready", "claim-after-final", "claim-after-freeze", "parked-then-delivered-by-a-stranger", "parked-then-withdrawn-by-the-payout-address"] {
      has(&format!("payout/B/{n}"));
    }
    for e in exits.iter().filter(|e| e.starts_with("B/") && !e.contains("claim")) {
      has(&format!("payout/B/not-a-claim/{}", &e[2..]));
    }
    // Freeze.
    for dir in ["A", "B"] {
      for n in ["by-the-locker", "claim-waits-for-T_ff", "watcher-has-no-other-power", "latest-T_cd"] {
        has(&format!("freeze/{dir}/{n}"));
      }
    }
    assert_eq!(names.contains(&"deposit/A/split-with-the-other-treasury-slot"), chain == "solana");
    let multi: Vec<&str> = t["multi_sequences"].as_array().unwrap().iter().filter(|s| s["chain"] == chain).map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(multi, vec!["caps/A/lowered-below-the-open-value", "caps/B/lowered-below-the-open-value"]);
  }
  // The parked sequences really park and then withdraw; the saturation sequence really saturates.
  let seq = |name: &str, chain: &str| t["sequences"].as_array().unwrap().iter().find(|s| s["name"] == name && s["chain"] == chain).unwrap().clone();
  for name in ["parked/A/refund", "parked/A/claim", "parked/B/refund", "parked/B/claim"] {
    for chain in ["solana", "ethereum"] {
      let s = seq(name, chain);
      let steps = s["steps"].as_array().unwrap();
      let parked = steps.iter().any(|st| {
        matches!(st["call"].as_str(), Some("refund" | "claim")) && st["expect"]["payouts"].as_array().is_some_and(|p| p.iter().any(|x| x["parked"] == true))
      });
      let withdrawn = steps.iter().any(|st| st["call"] == "withdraw_owed" && st["expect"]["ok"] == true);
      assert!(parked && withdrawn, "{name} on {chain}");
      let fin = &s["final"]["swap"];
      assert_eq!(fin["owed_taker"], "0");
      assert_eq!(fin["owed_maker"], "0");
      assert_eq!(fin["owed_treasury"], "0");
    }
  }
  let s = seq("saturation/counters-at-u32-max", "solana");
  let before = &s["initial_maker"]["counters"];
  let after = &s["final"]["maker"]["counters"];
  assert_eq!(before[8], u32::MAX);
  assert_eq!(after[8], u32::MAX, "completed stays at u32::MAX");
  assert_eq!(after[7], u32::MAX, "readies moved from MAX - 1 to MAX");
  assert_eq!(s["final"]["maker"]["response_secs_sum"], u64::MAX.to_string());
  assert_eq!(s["final"]["maker"]["volume"], u64::MAX.to_string());
  assert_eq!(s["steps"].as_array().unwrap().last().unwrap()["expect"]["ok"], true);
}

/// Wrong-caller cases exist for every authorised call, and on Ethereum a stranger's claim or
/// refund is accepted (the secret is the authorisation).
#[test]
fn wrong_caller_rows() {
  let t = load("transitions.json");
  let rows = t["rows"].as_array().unwrap();
  let unauthorized = |chain: &str| rows.iter().filter(|r| r["chain"] == chain && r["step"]["expect"]["error"] == "Unauthorized").count();
  // Ethereum has fewer: claim and refund are open to anyone there.
  assert!(unauthorized("solana") >= 60, "solana: only {} wrong-caller rejections", unauthorized("solana"));
  assert!(unauthorized("ethereum") >= 40, "ethereum: only {} wrong-caller rejections", unauthorized("ethereum"));
  assert!(unauthorized("ethereum") < unauthorized("solana"));
  let stranger_claim = |chain: &str| {
    rows
      .iter()
      .find(|r| r["chain"] == chain && r["id"] == "A11a/A11c" && r["case"].as_str().unwrap().starts_with("other caller: anyone"))
      .unwrap()["step"]["expect"]["ok"]
      .as_bool()
      .unwrap()
  };
  assert!(!stranger_claim("solana"));
  assert!(stranger_claim("ethereum"));
  // The secret names differ by chain.
  let bad_secret = |chain: &str| rows.iter().find(|r| r["chain"] == chain && r["id"] == "A11 wrong secret").unwrap()["step"]["expect"]["error"].clone();
  assert_eq!(bad_secret("solana"), "ScalarMismatch");
  assert_eq!(bad_secret("ethereum"), "BadSecret");
}

/// `deadlines.json` carries the constants of SPEC 3.1 exactly.
#[test]
fn constants_in_deadlines_json() {
  let d = load("deadlines.json");
  let s = &d["constants"]["solana"];
  let e = &d["constants"]["ethereum"];
  for (name, sol, eth) in [
    ("FEE_BPS", 5, 5),
    ("MAX_DEPOSIT_BPS", 500, 500),
    ("HOLD_SECS", 1_800, 1_800),
    ("SPLIT_SECS", 5_184_000, 5_184_000),
    ("EXPIRY_SECS", 2_592_000, 2_592_000),
    ("BLOCK_ALLOWANCE_SECS", 180, 180),
    ("CUT_MARGIN_SECS", 900, 900),
    ("MARGIN_SECS", 300, 1_800),
    ("FINALITY_SECS", 15, 1_200),
    ("MIN_NOTICE_SECS", 300, 1_500),
    ("MAX_NOTICE_SECS", 3_600, 3_600),
    ("MIN_CLAIM_DELAY_SECS", 3_600, 7_200),
    ("MAX_APPROVAL_SECS", 3_600, 3_600),
    ("MAX_FINAL_SECS", 2_592_000, 2_592_000),
    ("READY_MIN_SECS_PER_CONF", 60, 60),
    ("CLOSE_GRACE_SECS", 2_592_000, 0),
    ("LINK_DELAY_SECS", 604_800, 604_800),
    ("MAX_OPEN_PENDING", 64, 64),
  ] {
    assert_eq!(s[name], sol, "solana {name}");
    assert_eq!(e[name], eth, "ethereum {name}");
  }
  assert_eq!(s["EXPLICIT_APPROVE"], false);
  assert_eq!(e["EXPLICIT_APPROVE"], true);
  // SPEC 11.6: the freeze-window bounds are the same on both chains.
  for c in [s, e] {
    assert_eq!(c["MIN_FREEZE_SECS"], 3_600);
    assert_eq!(c["MAX_FREEZE_SECS"], 259_200);
  }
  // The Δ_cut and D_c rows of the table in SPEC 3.1.
  let case = |name: &str| d["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{name}")).clone();
  for (chain, depth, delta_cut, min_dc) in [
    ("solana", 2, 1_275, 3_600),
    ("solana", 10, 2_715, 3_600),
    ("solana", 25, 5_415, 6_015),
    ("ethereum", 2, 2_460, 7_200),
    ("ethereum", 10, 3_900, 7_500),
    ("ethereum", 25, 6_600, 10_200),
  ] {
    let c = case(&format!("{chain}-claim-delay-at-floor-depth-{depth}"));
    assert_eq!(c["output"]["delta_cut"], delta_cut);
    assert_eq!(c["output"]["min_claim_delay"], min_dc);
    assert_eq!(c["input"]["params"]["d_c"], min_dc);
    assert_eq!(case(&format!("{chain}-claim-delay-below-floor-depth-{depth}"))["error"], "ClaimDelayTooShort");
  }
}

/// SPEC 3.1 and 3.13 in the vectors: zero-amount swaps are refused on both chains, and the
/// Ethereum rows carry Ethereum's caller rules, so no replay needs a special case.
#[test]
fn zero_amount_and_chain_caller_rules() {
  let t = load("transitions.json");
  let rows = t["rows"].as_array().unwrap();
  for chain in ["solana", "ethereum"] {
    for id in ["A1", "B1"] {
      let find = |case: &str| rows.iter().find(|r| r["chain"] == chain && r["id"] == id && r["case"] == case).unwrap_or_else(|| panic!("{chain} {id} {case}"));
      assert_eq!(find("amount zero")["step"]["expect"]["error"], "AmountOutOfRange");
      assert_eq!(find("xmr zero")["step"]["expect"]["error"], "AmountOutOfRange");
      assert_eq!(find("amount one, xmr one piconero")["step"]["expect"]["ok"], true);
    }
    let foreign_opens = rows.iter().filter(|r| r["chain"] == chain && r["case"].as_str().unwrap().starts_with("wrong caller")).count();
    assert_eq!(foreign_opens, if chain == "solana" { 6 } else { 0 }, "{chain}: lock/take by someone else");
    // Every open call names its size.
    for r in rows.iter().filter(|r| r["chain"] == chain) {
      let open = r.get("open").unwrap_or(&r["step"]);
      assert!(open["args"]["xmr"].is_string(), "{chain} {}: open without xmr", r["id"]);
    }
  }
  // The two sequences in which a foreign account tries to pull a parked payout.
  let step = |name: &str, chain: &str, caller: &str| {
    let s = t["sequences"].as_array().unwrap().iter().find(|s| s["name"] == name && s["chain"] == chain).unwrap();
    s["steps"].as_array().unwrap().iter().find(|st| st["call"] == "withdraw_owed" && st["caller"] == caller).unwrap()["expect"].clone()
  };
  assert_eq!(step("parked/A/refund", "solana", "session")["error"], "Unauthorized");
  assert_eq!(step("parked/A/refund", "ethereum", "session")["error"], "NothingOwed");
  assert_eq!(step("B/expire_unnoticed", "solana", "operator")["error"], "Unauthorized");
  assert_eq!(step("B/expire_unnoticed", "ethereum", "operator")["error"], "NothingOwed");

  // amounts.json: every case says which chains replay it; seven are Ethereum-only for size.
  let a = load("amounts.json");
  let cases = a["cases"].as_array().unwrap();
  let mut eth_only_for_size = 0;
  for c in cases {
    let chains: Vec<&str> = c["chains"].as_array().unwrap_or_else(|| panic!("{}: no chains", c["name"])).iter().map(|x| x.as_str().unwrap()).collect();
    assert!(!chains.is_empty() && chains.iter().all(|x| *x == "solana" || *x == "ethereum"), "{}", c["name"]);
    let over = c["input"].as_object().unwrap().values().any(|v| v.as_str().and_then(|s| s.parse::<u128>().ok()).is_some_and(|n| n > u64::MAX as u128));
    if over {
      assert_eq!(chains, vec!["ethereum"], "{}", c["name"]);
      eth_only_for_size += 1;
    }
    if let Some(chain) = c["input"]["chain"].as_str() {
      assert_eq!(chains, vec![chain], "{}", c["name"]);
    }
  }
  assert_eq!(eth_only_for_size, 7);
  let case = |name: &str| cases.iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("{name}"));
  for chain in ["solana", "ethereum"] {
    assert_eq!(case(&format!("swap-b-dust-take-rounds-to-zero-{chain}"))["error"], "AmountOutOfRange");
    assert_eq!(case(&format!("swap-a-zero-xmr-{chain}"))["error"], "AmountOutOfRange");
    assert_eq!(case(&format!("swap-b-zero-xmr-{chain}"))["error"], "AmountOutOfRange");
    assert_eq!(case(&format!("swap-b-smallest-take-that-does-not-{chain}"))["output"]["amount"], "1");
  }
}

/// SPEC 11.7 in the vectors: the cap boundaries, the payout address, the freeze rows.
#[test]
fn amendment_one_rows() {
  let t = load("transitions.json");
  let rows = t["rows"].as_array().unwrap();
  for chain in ["solana", "ethereum"] {
    let find = |id: &str, case: &str| {
      rows.iter().find(|r| r["chain"] == chain && r["id"] == id && r["case"] == case).unwrap_or_else(|| panic!("{chain} {id} {case}"))["step"]["expect"].clone()
    };
    for id in ["A1", "B1"] {
      assert_eq!(find(id, "caps: amount exactly max_swap")["ok"], true);
      assert_eq!(find(id, "caps: amount one above max_swap")["error"], "SwapCapExceeded");
      assert_eq!(find(id, "caps: counted value exactly max_open")["ok"], true);
      assert_eq!(find(id, "caps: counted value one above max_open")["error"], "OpenCapExceeded");
      assert_eq!(find(id, "caps: other swaps open, the sum exactly max_open")["ok"], true);
      assert_eq!(find(id, "caps: other swaps open, the sum one above max_open")["error"], "OpenCapExceeded");
      assert_eq!(find(id, "caps: a fresh deployment (switch on, every cap zero)")["error"], "SwapCapExceeded");
      assert_eq!(find(id, "caps: switched off with every cap zero")["ok"], true);
      assert_eq!(find(id, "maker paused")["error"], "Paused");
      assert_eq!(find(id, "freeze window below its floor")["error"], "FreezeWindowOutOfRange");
      assert_eq!(find(id, "freeze window over its cap")["error"], "FreezeWindowOutOfRange");
      assert_eq!(find(id, "freeze window at its floor")["ok"], true);
      assert_eq!(find(id, "freeze window at its cap")["ok"], true);
      assert_eq!(find(id, "freeze window: final window one second short")["error"], "FinalWindowOutOfRange");
      // The counted value: amount in A, amount + deposit in B, and the flag.
      let open = find(id, "AUTO offer");
      let swap = &open["swap"];
      let amount: u128 = num(&swap["amount"]);
      let deposit: u128 = num(&swap["deposit"]);
      assert_eq!(num::<u128>(&open["open_value_after"]), if id == "A1" { amount } else { amount + deposit });
      assert_eq!(swap["flags"], 32);
    }
    assert_eq!(find("A1", "watcher named against W_z = 0")["error"], "WatcherNotAllowed");
    assert_eq!(find("B5 naming a watcher against W_z = 0", "operator at t_lock+1")["error"], "WatcherNotAllowed");
    assert_eq!(find("B5 naming a watcher", "operator at t_lock+1")["swap"]["watcher"], true);
    assert_eq!(find("B1", "payout to another address")["swap"]["payout"], "other");
    assert_eq!(find("B1", "AUTO offer")["swap"]["payout"], "taker");
    assert_eq!(find("A1", "AUTO offer")["swap"]["payout"], "none");
    assert_eq!(find("B1", "invalid payout address")["error"], if chain == "solana" { "PayoutInvalid" } else { "BadValue" });
    // fund is never refused by a cap.
    assert_eq!(find("B5 with every cap at zero and the maker paused", "operator at t_lock+1")["state"], "ACTIVE");
    // Z1 to Z5, one second either side of T_co and T_ff.
    for dir in ["A", "B"] {
      let z = |id: &str, case: &str| {
        rows
          .iter()
          .find(|r| r["chain"] == chain && r["direction"] == dir && r["id"] == id && r["case"] == case)
          .unwrap_or_else(|| panic!("{chain} {dir} {id} {case}"))["step"]["expect"]
          .clone()
      };
      let (locker, claimer) = if dir == "A" { ("session", "operator") } else { ("operator", "session") };
      assert_eq!(z("Z1", "watcher at T_co-1")["state"], "FROZEN");
      assert_eq!(z("Z1", "watcher at T_co-1")["counter_name"], "freezes");
      assert_eq!(z("Z1", "watcher at T_co+0")["error"], "TooLate");
      assert_eq!(z("Z1", &format!("{locker} at T_co-1"))["state"], "FROZEN");
      assert_eq!(z("Z1", "other caller: anyone at t_N+0")["error"], "Unauthorized");
      assert_eq!(z("Z1 with no watcher named", &format!("{locker} at t_N+5"))["error"], "BadState");
      assert_eq!(z("Z1 twice", "watcher at t_Z+1")["error"], "BadState");
      assert_eq!(z("Z1 in READY", "watcher at t_R+1")["error"], "BadState");
      // A freeze moves nothing and pays nobody.
      let frozen = z("Z1", "watcher at t_N+0");
      assert_eq!(frozen["payouts"].as_array().unwrap().len(), 0);
      assert_eq!(frozen["escrow_in"], "0");
      assert_eq!(z("Z2", &format!("{locker} at T_ff-1"))["state"], "READY");
      assert_eq!(z("Z2", &format!("{locker} at T_ff+0"))["error"], "TooLate");
      assert_eq!(z("Z2", "other caller: watcher at T_ready_min-1")["error"], "Unauthorized");
      let refund = z("Z3/Z6", &format!("{locker} at T_ff-1"));
      if dir == "A" {
        assert_eq!(refund["state"], "HOLD");
        assert_eq!(refund["counter_name"], "refunds_after_freeze");
      } else {
        // No maker bond: the take deposit returns at once and is never held.
        assert_eq!(refund["state"], "DONE");
        assert_eq!(refund["counter_name"], "backouts_after_freeze");
        assert_eq!(refund["payouts"][1]["to"], "taker");
      }
      assert_eq!(z("Z3/Z6", &format!("{locker} at T_ff+0"))["error"], "TooLate");
      assert_eq!(z("Z3/Z6", &format!("{locker} at T_exp+0"))["counter_name"], "expired_refunds");
      assert_eq!(z("Z4/Z6", &format!("{claimer} at T_co+0"))["error"], "TooEarly");
      assert_eq!(z("Z4/Z6", &format!("{claimer} at T_ff-1"))["error"], "TooEarly");
      assert_eq!(z("Z4/Z6", &format!("{claimer} at T_ff+0"))["counter_name"], "claims_after_freeze");
      assert_eq!(z("Z4/Z6", &format!("{claimer} at T_final+0"))["counter_name"], "claims_after_final");
      assert_eq!(z("Z5", &format!("{claimer} at T_ff-1"))["state"], "ABORTED_HOLD");
      assert_eq!(z("Z5", &format!("{claimer} at T_ff+0"))["state"], "ABORTED_HOLD");
      assert_eq!(z("Z5", &format!("{claimer} at T_final-1"))["state"], "ABORTED_HOLD");
      assert_eq!(z("Z5", &format!("{claimer} at T_final+0"))["error"], "TooLate");
    }
  }
  // No vector anywhere pays a watcher: there is no such destination.
  let text = std::fs::read_to_string(vectors_dir().join("transitions.json")).unwrap();
  assert!(!text.contains("\"to\":\"watcher\""));
  assert_eq!(t["counter_names"].as_array().unwrap().len(), 37);
}
