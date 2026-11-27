//! The JSON form of the reference model: the shapes used by `transitions.json` and by the wasm
//! exports `modelApply` / `modelEnabled`. One vocabulary, so a row of the vectors can be fed to
//! the model as it stands.
//!
//! * swap record: the `swap` object of a vector step (`state`, `direction`, every `t_*`, amounts
//!   as decimal strings); `null` means "no such swap" (the state a `lock` or `take` starts from);
//! * call: its name (`"lock"`, `"refund"`, …) and an `args` object;
//! * caller: `"taker"`, `"session"`, `"operator"`, `"owner"`, `"watcher"`, `"payout"`, `"anyone"`;
//! * env: which destinations can receive, the maker's `open_pending` and pause, and the asset's
//!   caps with its open value before the call;
//! * result: `{ "ok": true, state, counter, payouts, …, swap }` or `{ "ok": false, "error" }`
//!   with the chain's error name.

use serde_json::{json, Value};

use crate::{
  amounts::{Caps, Chain, SwapParams},
  model::{
    apply, counter, Call, Direction, Effects, Env, Evidence, MakerRecord, ModelError, OpenArgs, Party, PayoutArg,
    PayoutTo, RejectReason, Role, State, SwapState,
  },
};

fn d(v: impl ToString) -> String {
  v.to_string()
}
pub fn dir_name(d: Direction) -> &'static str {
  match d {
    Direction::A => "A",
    Direction::B => "B",
  }
}

pub fn call_args(call: &Call) -> Value {
  match call {
    Call::Open(a) => json!({
      "direction": dir_name(a.direction), "offer_mode": a.offer_mode, "approval": a.approval, "xmr": d(a.xmr),
      "amount": d(a.amount),
      "w_a": a.params.w_a, "w_n": a.params.w_n, "d_c": a.params.d_c, "w_c": a.params.w_c, "w_f": a.params.w_f,
      "depth": a.params.depth, "dep_bps": a.params.dep_bps, "w_z": a.params.w_z,
      "payout": a.payout.name(), "watcher": a.watcher,
    }),
    Call::Approve { open_ok } => json!({ "open_ok": open_ok }),
    Call::Fund { open_ok, watcher } => json!({ "open_ok": open_ok, "watcher": watcher }),
    Call::Reject { open_ok, reason } => json!({ "open_ok": open_ok, "reason": *reason as u8 }),
    Call::Refund { secret_ok } | Call::Claim { secret_ok } => json!({ "secret_ok": secret_ok }),
    Call::Withhold(e) => json!({ "evidence": match e { Evidence::Absent => "absent", Evidence::Opens => "opens", Evidence::Mismatch => "mismatch" } }),
    Call::PublishEvidence { opens } => json!({ "opens": opens }),
    Call::WithdrawOwed(who) | Call::PushOwed(who) => json!({ "who": who.name() }),
    _ => json!({}),
  }
}
pub fn env_json(e: &Env) -> Value {
  json!({
    "taker_can_receive": e.taker_can_receive, "maker_can_receive": e.maker_can_receive,
    "treasury_can_receive": e.treasury_can_receive, "payout_can_receive": e.payout_can_receive,
    "open_pending": e.open_pending, "maker_paused": e.maker_paused,
    "caps": { "on": e.caps.on, "max_swap": d(e.caps.max_swap), "max_open": d(e.caps.max_open), "open_value": d(e.caps.open_value) },
  })
}
pub fn swap_json(s: &SwapState) -> Value {
  json!({
    "state": s.state.name(), "state_code": s.state as u8, "direction": dir_name(s.direction), "mode": s.mode,
    "outcome": s.outcome, "deposit_state": s.deposit_state, "depth": s.depth, "flags": s.flags,
    "amount": d(s.amount), "deposit": d(s.deposit), "fee_bps": s.fee_bps, "w_n": s.w_n, "d_c": s.d_c, "w_c": s.w_c,
    "t_lock": s.t_lock, "t_pending_deadline": s.t_pending_deadline, "t_active": s.t_active,
    "t_note_deadline": s.t_note_deadline, "t_notice": s.t_notice, "t_cut": s.t_cut, "t_claim_open": s.t_claim_open,
    "t_ready": s.t_ready, "t_claim_deadline": s.t_claim_deadline, "t_final": s.t_final, "t_refund": s.t_refund,
    "t_settled": s.t_settled,
    "owed_taker": d(s.owed_taker), "owed_maker": d(s.owed_maker), "owed_treasury": d(s.owed_treasury),
    "payout": s.payout.name(), "watcher": s.watcher, "w_z": s.w_z, "t_freeze": s.t_freeze,
  })
}
pub fn maker_json(m: &MakerRecord) -> Value {
  json!({
    "counters": m.counters.to_vec(), "response_secs_sum": d(m.response_secs_sum), "volume": d(m.volume),
    "withheld_volume": d(m.withheld_volume), "open_pending": m.open_pending,
  })
}
/// The `expect` object of a vector step.
pub fn expect_json(result: &Result<Effects, ModelError>, chain: Chain, maker: Option<&MakerRecord>) -> Value {
  match result {
    Err(e) => json!({ "ok": false, "error": e.chain_name(chain) }),
    Ok(fx) => {
      let mut v = json!({
        "ok": true,
        "state": fx.state.state.name(),
        "counter": fx.counter,
        "counter_name": fx.counter.map(|c| counter::NAMES[c as usize]),
        "payouts": fx.payouts.iter().map(|p| json!({ "to": p.to.name(), "amount": d(p.amount), "parked": p.parked })).collect::<Vec<_>>(),
        "escrow_in": d(fx.escrow_in),
        "response_secs": fx.response_secs,
        "volume": d(fx.volume),
        "withheld_volume": d(fx.withheld_volume),
        "open_pending": fx.open_pending,
        "closed": fx.closed,
        "open_value_after": d(fx.open_value_after),
        "swap": swap_json(&fx.state),
      });
      if let Some(m) = maker {
        v.as_object_mut().unwrap().insert("maker".into(), maker_json(m));
      }
      v
    }
  }
}

// ------------------------------------------------------------------ parsing

type Parsed<T> = Result<T, String>;

fn num<T: std::str::FromStr>(v: &Value, what: &str) -> Parsed<T> {
  let s = match v {
    Value::String(s) => s.clone(),
    Value::Number(n) => n.to_string(),
    _ => return Err(format!("{what}: expected a number or a decimal string")),
  };
  s.parse().map_err(|_| format!("{what}: out of range or not an integer"))
}
fn flag(v: &Value, what: &str) -> Parsed<bool> {
  v.as_bool().ok_or_else(|| format!("{what}: expected a boolean"))
}
fn text<'a>(v: &'a Value, what: &str) -> Parsed<&'a str> {
  v.as_str().ok_or_else(|| format!("{what}: expected a string"))
}
fn direction(v: &Value) -> Parsed<Direction> {
  match text(v, "direction")? {
    "A" => Ok(Direction::A),
    "B" => Ok(Direction::B),
    other => Err(format!("direction: {other}")),
  }
}

fn party(v: &Value) -> Parsed<Party> {
  match text(v, "who")? {
    "taker" => Ok(Party::Taker),
    "maker" => Ok(Party::Maker),
    "treasury" => Ok(Party::Treasury),
    "payout" => Ok(Party::Payout),
    other => Err(format!("who: {other}")),
  }
}

pub fn chain_from_name(name: &str) -> Parsed<Chain> {
  match name {
    "solana" => Ok(Chain::Solana),
    "ethereum" => Ok(Chain::Ethereum),
    other => Err(format!("chain: {other}")),
  }
}
pub fn role_from_name(name: &str) -> Parsed<Role> {
  match name {
    "taker" => Ok(Role::TakerWallet),
    "session" => Ok(Role::Session),
    "operator" => Ok(Role::Operator),
    "owner" => Ok(Role::Owner),
    "watcher" => Ok(Role::Watcher),
    "payout" => Ok(Role::Payout),
    "anyone" => Ok(Role::Anyone),
    other => Err(format!("caller: {other}")),
  }
}
pub fn call_from_json(name: &str, a: &Value) -> Parsed<Call> {
  Ok(match name {
    "lock" | "take" => {
      let dir = direction(&a["direction"])?;
      if (name == "lock") != (dir == Direction::A) {
        return Err(format!("{name}: direction {} does not match the call", dir_name(dir)));
      }
      Call::Open(OpenArgs {
        direction: dir,
        offer_mode: num(&a["offer_mode"], "offer_mode")?,
        approval: flag(&a["approval"], "approval")?,
        xmr: num(&a["xmr"], "xmr")?,
        amount: num(&a["amount"], "amount")?,
        params: SwapParams {
          w_a: num(&a["w_a"], "w_a")?,
          w_n: num(&a["w_n"], "w_n")?,
          d_c: num(&a["d_c"], "d_c")?,
          w_c: num(&a["w_c"], "w_c")?,
          w_f: num(&a["w_f"], "w_f")?,
          depth: num(&a["depth"], "depth")?,
          dep_bps: num(&a["dep_bps"], "dep_bps")?,
          w_z: if a["w_z"].is_null() { 0 } else { num(&a["w_z"], "w_z")? },
        },
        payout: if a["payout"].is_null() {
          PayoutArg::Taker
        } else {
          match text(&a["payout"], "payout")? {
            "taker" => PayoutArg::Taker,
            "other" => PayoutArg::Other,
            "invalid" => PayoutArg::Invalid,
            other => return Err(format!("payout: {other}")),
          }
        },
        watcher: if a["watcher"].is_null() { false } else { flag(&a["watcher"], "watcher")? },
      })
    }
    "approve" => Call::Approve { open_ok: flag(&a["open_ok"], "open_ok")? },
    "fund" => Call::Fund {
      open_ok: flag(&a["open_ok"], "open_ok")?,
      watcher: if a["watcher"].is_null() { false } else { flag(&a["watcher"], "watcher")? },
    },
    "reject" => Call::Reject {
      open_ok: flag(&a["open_ok"], "open_ok")?,
      reason: match num::<u8>(&a["reason"], "reason")? {
        0 => RejectReason::MakerChoice,
        1 => RejectReason::UnusableInput,
        2 => RejectReason::LeafConsumed,
        other => return Err(format!("reason: {other}")),
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
    "refund" => Call::Refund { secret_ok: flag(&a["secret_ok"], "secret_ok")? },
    "claim" => Call::Claim { secret_ok: flag(&a["secret_ok"], "secret_ok")? },
    "release_deposit" => Call::ReleaseDeposit,
    "withhold" => Call::Withhold(match text(&a["evidence"], "evidence")? {
      "absent" => Evidence::Absent,
      "opens" => Evidence::Opens,
      "mismatch" => Evidence::Mismatch,
      other => return Err(format!("evidence: {other}")),
    }),
    "split_deposit" => Call::SplitDeposit,
    "publish_evidence" => Call::PublishEvidence { opens: flag(&a["opens"], "opens")? },
    "withdraw_owed" => Call::WithdrawOwed(party(&a["who"])?),
    "push_owed" => Call::PushOwed(party(&a["who"])?),
    other => return Err(format!("call: {other}")),
  })
}
/// An absent or `null` env is [`Env::OK`]: everything can receive, no pending swaps, caps on and
/// out of reach, not paused. An absent key takes its value from there.
pub fn env_from_json(e: &Value) -> Parsed<Env> {
  if e.is_null() {
    return Ok(Env::OK);
  }
  let get = |k: &str| if e[k].is_null() { Ok(true) } else { flag(&e[k], k) };
  Ok(Env {
    taker_can_receive: get("taker_can_receive")?,
    maker_can_receive: get("maker_can_receive")?,
    treasury_can_receive: get("treasury_can_receive")?,
    payout_can_receive: get("payout_can_receive")?,
    open_pending: if e["open_pending"].is_null() { 0 } else { num(&e["open_pending"], "open_pending")? },
    caps: {
      let c = &e["caps"];
      if c.is_null() {
        Caps::UNLIMITED
      } else {
        Caps {
          on: flag(&c["on"], "caps.on")?,
          max_swap: num(&c["max_swap"], "caps.max_swap")?,
          max_open: num(&c["max_open"], "caps.max_open")?,
          open_value: num(&c["open_value"], "caps.open_value")?,
        }
      }
    },
    maker_paused: if e["maker_paused"].is_null() { false } else { flag(&e["maker_paused"], "maker_paused")? },
  })
}
/// `null` is "no such swap".
pub fn swap_from_json(j: &Value) -> Parsed<SwapState> {
  if j.is_null() {
    return Ok(SwapState::NONE);
  }
  let state = match text(&j["state"], "state")? {
    "NONE" => State::None,
    "PENDING" => State::Pending,
    "ACTIVE" => State::Active,
    "NOTICED" => State::Noticed,
    "READY" => State::Ready,
    "ABORTED_FREE" => State::AbortedFree,
    "ABORTED_HOLD" => State::AbortedHold,
    "HOLD" => State::Hold,
    "WITHHELD" => State::Withheld,
    "DONE" => State::Done,
    "FROZEN" => State::Frozen,
    other => return Err(format!("state: {other}")),
  };
  if !j["state_code"].is_null() && num::<u8>(&j["state_code"], "state_code")? != state as u8 {
    return Err("state_code does not match state".into());
  }
  Ok(SwapState {
    state,
    direction: direction(&j["direction"])?,
    mode: num(&j["mode"], "mode")?,
    outcome: num(&j["outcome"], "outcome")?,
    deposit_state: num(&j["deposit_state"], "deposit_state")?,
    depth: num(&j["depth"], "depth")?,
    flags: num(&j["flags"], "flags")?,
    amount: num(&j["amount"], "amount")?,
    deposit: num(&j["deposit"], "deposit")?,
    fee_bps: num(&j["fee_bps"], "fee_bps")?,
    w_n: num(&j["w_n"], "w_n")?,
    d_c: num(&j["d_c"], "d_c")?,
    w_c: num(&j["w_c"], "w_c")?,
    t_lock: num(&j["t_lock"], "t_lock")?,
    t_pending_deadline: num(&j["t_pending_deadline"], "t_pending_deadline")?,
    t_active: num(&j["t_active"], "t_active")?,
    t_note_deadline: num(&j["t_note_deadline"], "t_note_deadline")?,
    t_notice: num(&j["t_notice"], "t_notice")?,
    t_cut: num(&j["t_cut"], "t_cut")?,
    t_claim_open: num(&j["t_claim_open"], "t_claim_open")?,
    t_ready: num(&j["t_ready"], "t_ready")?,
    t_claim_deadline: num(&j["t_claim_deadline"], "t_claim_deadline")?,
    t_final: num(&j["t_final"], "t_final")?,
    t_refund: num(&j["t_refund"], "t_refund")?,
    t_settled: num(&j["t_settled"], "t_settled")?,
    owed_taker: num(&j["owed_taker"], "owed_taker")?,
    owed_maker: num(&j["owed_maker"], "owed_maker")?,
    owed_treasury: num(&j["owed_treasury"], "owed_treasury")?,
    payout: match text(&j["payout"], "payout")? {
      "none" => PayoutTo::None,
      "taker" => PayoutTo::Taker,
      "other" => PayoutTo::Other,
      other => return Err(format!("payout: {other}")),
    },
    watcher: flag(&j["watcher"], "watcher")?,
    w_z: num(&j["w_z"], "w_z")?,
    t_freeze: num(&j["t_freeze"], "t_freeze")?,
  })
}

/// `modelApply`: run one call. `input` is
/// `{ "chain", "state": swap | null, "call", "args", "caller", "at", "env"? }`; the result is the
/// `expect` object of a vector step (`ok: false` with the chain's error name when refused).
/// `Err` means the input itself is malformed.
pub fn apply_json(input: &Value) -> Parsed<Value> {
  let chain = chain_from_name(text(&input["chain"], "chain")?)?;
  let state = swap_from_json(&input["state"])?;
  let call = call_from_json(text(&input["call"], "call")?, &input["args"])?;
  let caller = role_from_name(text(&input["caller"], "caller")?)?;
  let at: i64 = num(&input["at"], "at")?;
  let env = env_from_json(&input["env"])?;
  Ok(expect_json(&apply(state, call, caller, at, &env, chain.consts()), chain, None))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::amounts::{ETHEREUM, SOLANA};

  #[test]
  fn swap_round_trips_through_json() {
    let open = json!({
      "chain": "solana", "state": null, "call": "lock", "caller": "taker", "at": 1_800_000_000,
      "args": { "direction": "A", "offer_mode": 0, "approval": false, "xmr": "1000000000000", "amount": "1500000000",
                "w_a": 60, "w_n": 600, "d_c": 5400, "w_c": 1800, "w_f": 604800, "depth": 10, "dep_bps": 100 },
    });
    let r = apply_json(&open).unwrap();
    assert_eq!(r["ok"], true);
    assert_eq!(r["state"], "ACTIVE");
    let s = swap_from_json(&r["swap"]).unwrap();
    assert_eq!(swap_json(&s), r["swap"]);
    assert_eq!(s.deposit, 15_000_000);
    // The next call starts from the returned record.
    let next = json!({ "chain": "solana", "state": r["swap"], "call": "post_notice", "args": {}, "caller": "operator", "at": 1_800_000_100 });
    assert_eq!(apply_json(&next).unwrap()["state"], "NOTICED");
    let wrong = json!({ "chain": "solana", "state": r["swap"], "call": "post_notice", "args": {}, "caller": "session", "at": 1_800_000_100 });
    assert_eq!(apply_json(&wrong).unwrap(), json!({ "ok": false, "error": "Unauthorized" }));
  }

  #[test]
  fn malformed_input_is_an_error_not_a_verdict() {
    let base = json!({ "chain": "solana", "state": null, "call": "refund", "args": { "secret_ok": true }, "caller": "taker", "at": 1 });
    assert_eq!(apply_json(&base).unwrap()["error"], "BadState");
    for (key, value) in [("chain", json!("bitcoin")), ("call", json!("steal")), ("caller", json!("root")), ("at", json!("soon")), ("args", json!({}))] {
      let mut bad = base.clone();
      bad[key] = value;
      assert!(apply_json(&bad).is_err(), "{key}");
    }
    let mut bad = base.clone();
    bad["state"] = json!({ "state": "ACTIVE" });
    assert!(apply_json(&bad).is_err());
    // lock with direction B is a contradiction.
    assert!(call_from_json("lock", &json!({ "direction": "B" })).is_err());
  }

  #[test]
  fn chain_specific_error_names() {
    let _ = (&SOLANA, &ETHEREUM);
    let state = json!({
      "state": "READY", "state_code": 4, "direction": "A", "mode": 0, "outcome": 255, "deposit_state": 0, "depth": 2, "flags": 1,
      "amount": "1000", "deposit": "10", "fee_bps": 5, "w_n": 600, "d_c": 3600, "w_c": 1800,
      "t_lock": 0, "t_pending_deadline": 0, "t_active": 0, "t_note_deadline": 600, "t_notice": 100, "t_cut": 1375, "t_claim_open": 3700,
      "t_ready": 1500, "t_claim_deadline": 3300, "t_final": 604800, "t_refund": 0, "t_settled": 0,
      "owed_taker": "0", "owed_maker": "0", "owed_treasury": "0",
      "payout": "none", "watcher": false, "w_z": 0, "t_freeze": 0,
    });
    let claim = |chain: &str, caller: &str| {
      apply_json(&json!({ "chain": chain, "state": state, "call": "claim", "args": { "secret_ok": false }, "caller": caller, "at": 1600 })).unwrap()
    };
    assert_eq!(claim("solana", "operator")["error"], "ScalarMismatch");
    assert_eq!(claim("ethereum", "anyone")["error"], "BadSecret");
    assert_eq!(claim("solana", "anyone")["error"], "Unauthorized");
  }
}
