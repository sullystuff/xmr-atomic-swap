//! The vector files on disk, consumed the way the contract test harnesses consume them:
//!
//! * `interfaces/vectors/` is byte-identical to what the crate generates (`gen-vectors --check`);
//! * every row and sequence of `transitions.json` can be replayed **from the JSON alone**: the
//!   call, its arguments, the caller, the time and the environment are enough to reproduce the
//!   expected result, state, timestamps, payouts and counters.

use std::path::PathBuf;

use serde_json::Value;
use swap_core::amounts::{Chain, SwapParams};
use swap_core::model::{
  apply, Call, Direction, Effects, Env, Evidence, MakerRecord, OpenArgs, Party, RejectReason, Role, State,
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
      },
    }),
    "approve" => Call::Approve { open_ok: b("open_ok") },
    "fund" => Call::Fund { open_ok: b("open_ok") },
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
    "withdraw_owed" => Call::WithdrawOwed(match a["who"].as_str().unwrap() {
      "taker" => Party::Taker,
      "maker" => Party::Maker,
      "treasury" => Party::Treasury,
      other => panic!("who {other}"),
    }),
    other => panic!("call {other}"),
  }
}
fn env_of(step: &Value) -> Env {
  let e = &step["env"];
  Env {
    taker_can_receive: e["taker_can_receive"].as_bool().unwrap(),
    maker_can_receive: e["maker_can_receive"].as_bool().unwrap(),
    treasury_can_receive: e["treasury_can_receive"].as_bool().unwrap(),
    open_pending: num(&e["open_pending"]),
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
  ] {
    assert_eq!(value, j[name].as_i64().unwrap_or_else(|| panic!("{ctx}: {name} missing")), "{ctx}: {name}");
  }
  for (name, value) in [("amount", s.amount), ("deposit", s.deposit), ("owed_taker", s.owed_taker), ("owed_maker", s.owed_maker), ("owed_treasury", s.owed_treasury)] {
    assert_eq!(value, num::<u128>(&j[name]), "{ctx}: {name}");
  }
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
  assert!(rows.len() >= 700, "{} rows", rows.len());
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
  assert!(ok > 300 && rejected > 300, "{ok} accepted, {rejected} rejected");
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
  assert!(sequences.len() >= 300, "{} sequences", sequences.len());
  for seq in sequences {
    let chain = chain_of(&seq["chain"]);
    let mut state = SwapState::NONE;
    let mut maker = maker_of(&seq["initial_maker"]);
    let mut last = i64::MIN;
    for (i, step) in seq["steps"].as_array().unwrap().iter().enumerate() {
      let ctx = format!("sequence {} ({}) step {i} {}", seq["name"], seq["chain"], step["call"]);
      let at = step["at"].as_i64().unwrap();
      assert!(at >= last, "{ctx}: time runs backwards");
      last = at;
      if let Some(fx) = check_step(state, step, chain, &ctx) {
        state = fx.state;
        maker.record(&fx, chain.consts().max_amount);
        assert_maker(&maker, &step["expect"]["maker"], &ctx);
      }
    }
    let ctx = format!("sequence {} ({}) final", seq["name"], seq["chain"]);
    assert_swap(&state, &seq["final"]["swap"], &ctx);
    assert_maker(&maker, &seq["final"]["maker"], &ctx);
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
    for deadline in ["T_pend", "T_note", "T_cut", "T_co", "T_cd", "T_final", "T_exp", "T_hold", "T_split"] {
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
