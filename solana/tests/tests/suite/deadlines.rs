//! Deadlines (SPEC 3.1, 3.2): `deadlines.json` (constants, the per-swap bounds, deadline
//! derivation) through real instructions, and invariant 1: every window is half-open and at no
//! instant can two different parties both submit a call that reveals a secret.
use crate::common::*;
use serde_json::Value;
use solana_signer::Signer;
use std::collections::BTreeSet;

fn solana_cases(op: &str) -> Vec<Value> {
    vectors("deadlines")["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["input"]["chain"] == "solana" && c["input"]["op"] == op)
        .cloned()
        .collect()
}

#[test]
fn program_constants_are_the_vectors_constants() {
    let v = vectors("deadlines");
    let want = v["constants"]["solana"].as_object().unwrap();
    let source = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../program/src/constants.rs")).unwrap();
    let mut found = std::collections::HashMap::new();
    for line in source.lines() {
        let Some(rest) = line.trim().strip_prefix("pub const ") else { continue };
        let Some((name, rest)) = rest.split_once(':') else { continue };
        let Some((_, value)) = rest.split_once('=') else { continue };
        found.insert(name.trim().to_string(), value.trim().trim_end_matches(';').replace('_', ""));
    }
    let mut checked = 0;
    for (name, value) in want {
        // Two entries are behaviours, not constants: both are exercised by the replay (a lapsed
        // take outside window mode is `missed_funds`; a stranger's claim or refund is refused).
        if name == "LAPSE_IS_FAULT" || name == "OPEN_SECRET_CALLS" {
            continue;
        }
        let got = found.get(name).unwrap_or_else(|| panic!("constants.rs has no {name}"));
        assert_eq!(*got, value.to_string(), "{name}");
        checked += 1;
    }
    assert_eq!(checked, want.len() - 2);
    assert!(checked >= 22, "the freeze bounds are among them");
    // The harness's own copies.
    assert_eq!(want["HOLD_SECS"], HOLD_SECS);
    assert_eq!(want["SPLIT_SECS"], SPLIT_SECS);
    assert_eq!(want["EXPIRY_SECS"], EXPIRY_SECS);
    assert_eq!(want["CLOSE_GRACE_SECS"], CLOSE_GRACE_SECS);
}

fn terms_from(params: &Value, mode: u8) -> Terms {
    let u = |k: &str| params[k].as_u64().unwrap();
    Terms {
        mode,
        depths: [u("depth") as u8, 0, 0],
        dep_bps: u("dep_bps") as u16,
        w_a: u("w_a") as u32,
        w_n: u("w_n") as u32,
        d_c: u("d_c") as u32,
        w_c: u("w_c") as u32,
        w_f: u("w_f") as u32,
        w_z: u("w_z") as u32,
        ..Terms::default()
    }
}

/// `pending`: none = a direction-A lock on an AUTO offer; approval = on a WINDOW offer;
/// funding = a take on an AUTO offer.
fn market_of(pending: &str) -> (u8, u8) {
    match pending {
        "none" => (DIR_A, 0),
        "approval" => (DIR_A, 1),
        "funding" => (DIR_B, 0),
        other => panic!("pending {other}"),
    }
}

#[test]
fn deadlines_json_bounds_at_set_offer_and_again_at_lock() {
    let cases = solana_cases("bounds");
    let (mut accepted, mut refused) = (0, 0);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let (direction, mode) = market_of(i["pending"].as_str().unwrap());
        let terms = terms_from(&i["params"], mode);
        let mut w = World::new();
        let mut m = w.register_maker();
        let res = w.set_offer(&m, ASSET_SOL, direction, &terms);
        if case["valid"].as_bool().unwrap() {
            ok(res);
            let out = &case["output"];
            let mut fx = w.swap_with(&mut m, ASSET_SOL, direction, &terms, Stage::Opened);
            let s = w.swap(&fx.pda).unwrap();
            // W_p: the pending window this swap actually uses.
            let w_p = out["w_p"].as_i64().unwrap();
            if w_p == 0 {
                assert_eq!((s.state, s.t_pending_deadline), (ACTIVE, 0), "{name}");
            } else {
                assert_eq!((s.state, s.t_pending_deadline - s.t_lock), (PENDING, w_p), "{name}");
                w.warp(1);
                if direction == DIR_A {
                    ok(w.approve(&mut m, &fx));
                } else {
                    ok(w.fund_swap(&mut m, &fx));
                }
            }
            w.warp(1);
            ok(w.notice(&m, &mut fx));
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!(s.t_cut - s.t_notice, out["delta_cut"].as_i64().unwrap(), "{name}: Δ_cut = F + depth × B + margin");
            assert_eq!(s.t_claim_open - s.t_notice, terms.d_c as i64, "{name}");
            assert_eq!(s.t_final - s.t_lock, terms.w_f as i64, "{name}");
            accepted += 1;
        } else {
            let error = case["error"].as_str().unwrap();
            assert!(is_err(&res, error), "{name}: set_offer: expected {error}, got {}", err_string(&res));
            // The same terms in an offer account written directly: lock/take refuses them too.
            let offer = w.craft_offer(&mut m, ASSET_SOL, direction, &terms, PRICE);
            let (fx, raw) = w.prepare_open(&m, ASSET_SOL, direction, XMR, Source::Offer(offer));
            let res = w.send_open(&fx, &raw);
            assert!(is_err(&res, error), "{name}: open: expected {error}, got {}", err_string(&res));
            // And a quote with them. A quote never waits in an approval window, so the cases
            // that depend on W_a do not apply to it.
            if i["pending"] != "approval" {
                let (_, share, pok) = m.new_share();
                let (ix, _) = w.post_quote_ix(&m, 1, &fx.taker.pubkey(), ASSET_SOL, direction, XMR, PRICE, &terms, &share, &pok, w.now() + 60);
                let op = m.operator.insecure_clone();
                let res = w.send(&[ix], &[&op]);
                assert!(is_err(&res, error), "{name}: post_quote: expected {error}, got {}", err_string(&res));
            }
            refused += 1;
        }
    }
    println!("deadlines.json bounds (solana): {accepted} accepted, {refused} refused");
    assert_eq!(accepted + refused, cases.len());
    assert!(accepted >= 26 && refused >= 23, "{accepted} {refused}");
}

fn t(v: &Value) -> Option<i64> {
    v.as_i64()
}

#[test]
fn deadlines_json_derivation_from_real_event_times() {
    let cases = solana_cases("derive");
    assert!(cases.len() >= 10);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let out = &case["output"];
        let (direction, mode) = market_of(i["pending"].as_str().unwrap());
        let terms = terms_from(&i["params"], mode);
        let mut w = World::new();
        let mut m = w.register_maker();
        w.set_time(t(&i["t_lock"]).unwrap());
        let mut fx = w.swap_with(&mut m, ASSET_SOL, direction, &terms, Stage::Opened);
        let watcher = w.fund(SOL);

        if let Some(t_active) = t(&i["t_active"]) {
            w.set_time(t_active);
            if w.swap(&fx.pda).unwrap().state == PENDING {
                if direction == DIR_A {
                    ok(w.approve(&mut m, &fx));
                } else {
                    // A case with a freeze names the maker's watcher at fund.
                    let named = t(&i["t_freeze"]).map(|_| watcher.pubkey());
                    ok(w.fund_swap_with(&mut m, &fx, named));
                }
            }
        }
        if let Some(t_notice) = t(&i["t_notice"]) {
            if direction == DIR_B {
                // T_nl is the first second a notice is refused.
                let t_nl = t(&out["t_nl"]).unwrap();
                let session = fx.session.insecure_clone();
                let probe = Call::PostNotice { commitment: [1; 32], ct: [0; 104] };
                w.set_time(t_nl);
                assert_err(w.would(&m, &fx, &probe, &session), "TooLate");
                w.set_time(t_nl - 1);
                ok(w.would(&m, &fx, &probe, &session));
            }
            w.set_time(t_notice);
            ok(w.notice(&m, &mut fx));
        }
        if let Some(t_freeze) = t(&i["t_freeze"]) {
            // Frozen by the watcher; T_ff = max(t_Z + W_z, T_co) is in the event and decides when
            // the claim opens and the locker's `set_ready` closes.
            assert_eq!(direction, DIR_B, "the vectors' frozen derivations are direction B");
            w.set_time(t_freeze);
            let res = ok(w.call(&m, &fx, &Call::Freeze, &watcher));
            let ev = &logged_events(&res, "Frozen")[0];
            let t_ff = t(&out["t_ff"]).unwrap();
            assert_eq!(i64::from_le_bytes(ev[137..145].try_into().unwrap()), t_ff, "{name}: frozen_until");
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.t_freeze, s.t_ff()), (FROZEN, t_freeze, t_ff), "{name}");
            let (op, taker) = (m.operator.insecure_clone(), fx.taker.insecure_clone());
            w.set_time(t_ff - 1);
            ok(w.would(&m, &fx, &Call::SetReady, &op));
            assert_err(w.would(&m, &fx, &Call::Claim(fx.s_t), &taker), "TooEarly");
            w.set_time(t_ff);
            assert_err(w.would(&m, &fx, &Call::SetReady, &op), "TooLate");
            ok(w.would(&m, &fx, &Call::Claim(fx.s_t), &taker));
        }
        if let Some(t_ready) = t(&i["t_ready"]) {
            // T_ready_min is the first second `set_ready` is accepted.
            let t_ready_min = t(&out["t_ready_min"]).unwrap();
            let locker = if direction == DIR_A { fx.session.insecure_clone() } else { m.operator.insecure_clone() };
            w.set_time(t_ready_min - 1);
            assert_err(w.would(&m, &fx, &Call::SetReady, &locker), "TooEarly");
            w.set_time(t_ready_min);
            ok(w.would(&m, &fx, &Call::SetReady, &locker));
            w.set_time(t_ready);
            ok(w.ready(&m, &fx));
        }
        if let Some(t_refund) = t(&i["t_refund"]) {
            w.set_time(t_refund);
            let locker = if direction == DIR_A { fx.taker.insecure_clone() } else { m.operator.insecure_clone() };
            let secret = w.locker_secret(&m, &fx);
            ok(w.call(&m, &fx, &Call::Refund(secret), &locker));
            // T_hold and T_split are fixed at the refund.
            assert_eq!(t(&out["t_hold"]), Some(t_refund + HOLD_SECS), "{name}");
            assert_eq!(t(&out["t_split"]), Some(t_refund + SPLIT_SECS), "{name}");
        }

        let s = w.swap(&fx.pda).unwrap();
        let stored = |v: &Value| t(v).unwrap_or(0);
        assert_eq!(s.t_pending_deadline, stored(&out["t_pend"]), "{name}: t_pend");
        assert_eq!(s.t_note_deadline, stored(&out["t_note"]), "{name}: t_note");
        assert_eq!(s.t_cut, stored(&out["t_cut"]), "{name}: t_cut");
        assert_eq!(s.t_claim_open, stored(&out["t_co"]), "{name}: t_co");
        assert_eq!(s.t_claim_deadline, stored(&out["t_cd"]), "{name}: t_cd");
        assert_eq!(s.t_final, stored(&out["t_final"]), "{name}: t_final");
        assert_eq!(s.t_refund, stored(&i["t_refund"]), "{name}: t_refund");
        assert_eq!(s.t_exp(), stored(&out["t_exp"]), "{name}: t_exp");
        assert_eq!(s.t_nl(), stored(&out["t_nl"]), "{name}: t_nl");
        // The order SPEC 3.2 derives holds on this swap.
        if s.t_claim_deadline != 0 {
            assert!(s.t_claim_deadline < s.t_final - DAY_SECS, "{name}: T_cd < T_final − 86,400");
        }
        if s.t_cut != 0 {
            assert!(s.t_notice < s.t_cut && s.t_cut <= s.t_claim_open - 600, "{name}: T_cut <= T_co − 2M");
        }
    }
}

// ------------------------------------------------------------------ invariant 1

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Enabled {
    Refund,
    Claim,
}

/// SPEC 3.2, invariant 1: the one secret-bearing call enabled in a state at an instant.
fn enabled_by_the_table(s: &SwapAcc, now: i64) -> Enabled {
    let after_final = |now: i64| if now < s.t_exp() { Enabled::Claim } else { Enabled::Refund };
    match s.state {
        ACTIVE => Enabled::Refund,
        NOTICED if now < s.t_claim_open => Enabled::Refund,
        NOTICED if now < s.t_final => Enabled::Claim,
        READY if now < s.t_claim_deadline => Enabled::Claim,
        READY if now < s.t_final => Enabled::Refund,
        ABORTED_FREE | ABORTED_HOLD if now < s.t_final => Enabled::Refund,
        NOTICED | READY | ABORTED_FREE | ABORTED_HOLD => after_final(now),
        other => panic!("state {other}"),
    }
}

/// Probe every boundary second of a swap (one before, the boundary, one after) and compare who
/// can move with the table. Nothing is committed.
fn scan(w: &mut World, m: &MakerFx, fx: &SwapFx, label: &str) -> usize {
    let s = w.swap(&fx.pda).unwrap();
    let entered = w.now();
    let mut times = BTreeSet::from([entered, entered + 1]);
    for boundary in [s.t_note_deadline, s.t_cut, s.t_claim_open, s.t_claim_deadline, s.t_final, s.t_exp(), s.t_nl()] {
        if boundary != 0 {
            times.extend([boundary - 1, boundary, boundary + 1]);
        }
    }
    let (locker, claimer) = if fx.direction == DIR_A {
        (fx.taker.insecure_clone(), m.operator.insecure_clone())
    } else {
        (m.operator.insecure_clone(), fx.taker.insecure_clone())
    };
    let refund = Call::Refund(w.locker_secret(m, fx));
    let claim = if s.maker_spend_pub == [0; 32] { None } else { Some(Call::Claim(w.claimer_secret(m, fx))) };
    let mut probes = 0;
    for &now in times.iter().filter(|&&x| x >= entered) {
        w.set_time(now);
        let refund_ok = w.would(m, fx, &refund, &locker).is_ok();
        let claim_ok = claim.as_ref().is_some_and(|c| w.would(m, fx, c, &claimer).is_ok());
        assert!(!(refund_ok && claim_ok), "{label} at {now}: both parties can reveal a secret");
        let want = enabled_by_the_table(&s, now);
        assert_eq!(
            (refund_ok, claim_ok),
            (want == Enabled::Refund, want == Enabled::Claim),
            "{label} at {now} (state {}, t_co {}, t_cd {}, t_final {}, t_exp {})",
            s.state, s.t_claim_open, s.t_claim_deadline, s.t_final, s.t_exp()
        );
        // The other party's attempt at the enabled call is never accepted either.
        assert!(w.would(m, fx, &refund, &claimer).is_err(), "{label} at {now}: the claimer refunded");
        if let Some(c) = &claim {
            assert!(w.would(m, fx, c, &locker).is_err(), "{label} at {now}: the locker claimed");
        }
        probes += 1;
    }
    w.set_time(entered);
    probes
}

#[test]
fn at_no_instant_can_both_parties_reveal_a_secret() {
    let mut probes = 0;
    for asset in [ASSET_SOL, ASSET_USDC] {
        for direction in [DIR_A, DIR_B] {
            let name = |state: &str| format!("asset {asset} direction {direction} {state}");
            for (stage, label) in [(Stage::Active, "ACTIVE"), (Stage::Noticed, "NOTICED"), (Stage::Ready, "READY")] {
                let mut w = World::new();
                let (m, fx) = w.swap_at(asset, direction, &Terms::default(), stage);
                probes += scan(&mut w, &m, &fx, &name(label));
            }
            // ABORTED_HOLD: A, the maker aborts at T_co; B, the taker aborts.
            let mut w = World::new();
            let (m, fx) = w.swap_at(asset, direction, &Terms::default(), Stage::Noticed);
            let aborter = if direction == DIR_A {
                let t_co = w.swap(&fx.pda).unwrap().t_claim_open;
                w.set_time(t_co);
                m.operator.insecure_clone()
            } else {
                fx.taker.insecure_clone()
            };
            ok(w.call(&m, &fx, &Call::Abort, &aborter));
            assert_eq!(w.swap(&fx.pda).unwrap().state, ABORTED_HOLD);
            probes += scan(&mut w, &m, &fx, &name("ABORTED_HOLD"));
            // ABORTED_FREE exists in direction A only: the maker aborts before its claim delay.
            if direction == DIR_A {
                let mut w = World::new();
                let (m, fx) = w.swap_at(asset, direction, &Terms::default(), Stage::Noticed);
                let op = m.operator.insecure_clone();
                ok(w.call(&m, &fx, &Call::Abort, &op));
                assert_eq!(w.swap(&fx.pda).unwrap().state, ABORTED_FREE);
                probes += scan(&mut w, &m, &fx, &name("ABORTED_FREE"));
            }
        }
    }
    println!("invariant 1: {probes} instants probed, never two parties enabled");
    assert!(probes > 250);
}

#[test]
fn every_gate_is_half_open_and_the_boundary_second_belongs_to_the_later_window() {
    // One swap per boundary, direction A, real transactions (the scan above only simulates).
    // T_note: post_notice until T−1; refund_unnoticed from T.
    let mut w = World::new();
    let (m, mut fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Active);
    let s = w.swap(&fx.pda).unwrap();
    let stranger = w.stranger.insecure_clone();
    w.set_time(s.t_note_deadline - 1);
    assert_err(w.call(&m, &fx, &Call::RefundUnnoticed, &stranger), "TooEarly");
    ok(w.notice(&m, &mut fx));
    let (m, mut fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Active);
    let s = w.swap(&fx.pda).unwrap();
    w.set_time(s.t_note_deadline);
    assert_err(w.notice(&m, &mut fx), "TooLate");
    let op = m.operator.insecure_clone();
    assert_err(w.call(&m, &fx, &Call::Abort, &op), "TooLate");
    ok(w.call(&m, &fx, &Call::RefundUnnoticed, &stranger));

    // T_appr: approve until T−1; expire_pending from T.
    let window = Terms { mode: 1, ..Terms::default() };
    let (mut m, fx) = w.swap_at(ASSET_SOL, DIR_A, &window, Stage::Opened);
    let s = w.swap(&fx.pda).unwrap();
    w.set_time(s.t_pending_deadline - 1);
    assert_err(w.call(&m, &fx, &Call::ExpirePending, &stranger), "TooEarly");
    ok(w.approve(&mut m, &fx));
    let (mut m, fx) = w.swap_at(ASSET_SOL, DIR_A, &window, Stage::Opened);
    let s = w.swap(&fx.pda).unwrap();
    w.set_time(s.t_pending_deadline);
    assert_err(w.approve(&mut m, &fx), "TooLate");
    ok(w.call(&m, &fx, &Call::ExpirePending, &stranger));

    // T_co: set_ready and the taker's refund until T−1; the maker's claim from T.
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Noticed);
    let s = w.swap(&fx.pda).unwrap();
    let op = m.operator.insecure_clone();
    let taker = fx.taker.insecure_clone();
    let s_m = w.maker_secret(&m, &fx);
    w.set_time(s.t_claim_open - 1);
    assert_err(w.call(&m, &fx, &Call::Claim(s_m), &op), "TooEarly");
    ok(w.would(&m, &fx, &Call::SetReady, &taker));
    ok(w.would(&m, &fx, &Call::Refund(fx.s_t), &taker));
    w.set_time(s.t_claim_open);
    assert_err(w.call(&m, &fx, &Call::SetReady, &taker), "TooLate");
    assert_err(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker), "TooLate");
    ok(w.call(&m, &fx, &Call::Claim(s_m), &op));

    // T_cd: the maker's claim until T−1; the taker's refund from T.
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Ready);
    let s = w.swap(&fx.pda).unwrap();
    let op = m.operator.insecure_clone();
    let taker = fx.taker.insecure_clone();
    let s_m = w.maker_secret(&m, &fx);
    w.set_time(s.t_claim_deadline - 1);
    assert_err(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker), "TooEarly");
    ok(w.would(&m, &fx, &Call::Claim(s_m), &op));
    w.set_time(s.t_claim_deadline);
    assert_err(w.call(&m, &fx, &Call::Claim(s_m), &op), "TooLate");
    ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));

    // set_ready is refused before depth × 60 s after the notice (a stolen session key cannot
    // set ready at once).
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Noticed);
    let s = w.swap(&fx.pda).unwrap();
    let session = fx.session.insecure_clone();
    w.set_time(s.t_notice + 10 * 60 - 1);
    assert_err(w.call(&m, &fx, &Call::SetReady, &session), "TooEarly");
    w.set_time(s.t_notice + 10 * 60);
    ok(w.call(&m, &fx, &Call::SetReady, &session));
    assert_eq!(w.swap(&fx.pda).unwrap().t_claim_deadline, s.t_notice + 600 + 1_800);
}

#[test]
fn validity_fields_are_inclusive() {
    // Offer: live while now <= updated_at + valid_secs.
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    let updated_at = w.offer(&offer).updated_at;
    w.set_time(updated_at + 60);
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
    ok(w.send_open(&fx, &raw));
    w.set_time(updated_at + 61);
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
    assert_err(w.send_open(&fx, &raw), "OfferStale");

    // Quote: valid while now <= expires_at.
    for (late, want) in [(0, None), (1, Some("QuoteExpired"))] {
        let taker = w.fund(100 * SOL);
        let (_, share, pok) = m.new_share();
        let expires = w.now() + 100;
        let id = 77 + late as u64;
        let (ix, quote) = w.post_quote_ix(&m, id, &taker.pubkey(), ASSET_SOL, DIR_A, XMR, PRICE, &Terms::default(), &share, &pok, expires);
        let op = m.operator.insecure_clone();
        ok(w.send(&[ix], &[&op]));
        w.set_time(expires + late);
        let (fx, raw) = w.prepare_open_for(&m, taker, ASSET_SOL, DIR_A, XMR, Source::Quote(quote, op.pubkey()), rand16());
        match want {
            None => {
                ok(w.send_open(&fx, &raw));
            }
            Some(e) => assert_err(w.send_open(&fx, &raw), e),
        }
    }
}
