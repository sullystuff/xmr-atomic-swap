//! DESIGN's "Refunds and deposits" table, row by row (SPEC 3.10), written out by hand from
//! sections 3.4 to 3.6 and run on both assets, plus the rows the design does not list (early
//! aborts, expiry, and the whole of direction B). The vector replay covers the same transitions
//! against the reference model; these state the expectations independently of it.
use crate::common::*;

const AMOUNT: u64 = 1_500_000_000;
const D: u64 = 15_000_000; // 1%
const FEE_OF_AMOUNT: u64 = 750_000; // 0.05%
const ASSETS: [u8; 2] = [ASSET_SOL, ASSET_USDC];

fn counters(w: &World, m: &MakerFx) -> [u32; 40] {
    w.maker(&m.pda).counters
}

/// The counters that moved since `before`, as `(id, by)`.
fn bumped(w: &World, m: &MakerFx, before: &[u32; 40]) -> Vec<(usize, u32)> {
    counters(w, m).iter().zip(before.iter()).enumerate().filter(|(_, (a, b))| a != b).map(|(i, (a, b))| (i, a - b)).collect()
}

fn window() -> Terms {
    Terms { mode: 1, ..Terms::default() }
}

// ---- row 1

#[test]
fn row_1_pending_rejected_expired_or_cancelled_returns_everything_with_no_fault() {
    for asset in ASSETS {
        for exit in ["reject", "expire", "cancel"] {
            for direction in [DIR_A, DIR_B] {
                let mut w = World::new();
                let (m, fx) = w.swap_at(asset, direction, &window(), Stage::Opened);
                let stake = if direction == DIR_A { AMOUNT } else { D };
                assert_eq!(w.swap(&fx.pda).unwrap().state, PENDING);
                assert_eq!(w.maker(&m.pda).open_pending, 1);
                let l = w.ledger(&m, &fx);
                let c = counters(&w, &m);
                let (taker_fees, operator_fees, counter) = match exit {
                    "reject" => {
                        let open = w.swap(&fx.pda).unwrap().open_hash(&fx.pda);
                        let op = m.operator.insecure_clone();
                        ok(w.call(&m, &fx, &Call::Reject { open, reason: 0 }, &op));
                        (0, 1, 3)
                    }
                    "expire" => {
                        w.warp(59);
                        let stranger = w.stranger.insecure_clone();
                        assert_err(w.call(&m, &fx, &Call::ExpirePending, &stranger), "TooEarly");
                        w.warp(1);
                        ok(w.call(&m, &fx, &Call::ExpirePending, &stranger)); // anyone can send it
                        (0, 0, 4)
                    }
                    _ => {
                        let taker = fx.taker.insecure_clone();
                        ok(w.call(&m, &fx, &Call::CancelPending, &taker));
                        (1, 0, 5)
                    }
                };
                // Everything back, at once; the account is closed; the deposit was never held.
                assert_eq!(l.moved(&w, taker_fees, operator_fees, true), Moved::taker(stake), "{exit} {direction} {asset}");
                assert!(w.swap(&fx.pda).is_none());
                assert_eq!(bumped(&w, &m, &c), vec![(counter, 1)]);
                // No fault: none of missed_notices (11), missed_claims (12), missed_funds (13).
                assert_eq!(w.maker(&m.pda).open_pending, 0);
            }
        }
    }
}

// ---- row 2

#[test]
fn row_2_approved_but_no_notice_by_the_deadline_is_a_keyless_full_refund_anyone_can_send() {
    for asset in ASSETS {
        // A8: a stranger, once the notice deadline has passed.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Active);
        let s = w.swap(&fx.pda).unwrap();
        let stranger = w.stranger.insecure_clone();
        w.set_time(s.t_note_deadline - 1);
        assert_err(w.call(&m, &fx, &Call::RefundUnnoticed, &stranger), "TooEarly");
        w.set_time(s.t_note_deadline);
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        ok(w.call(&m, &fx, &Call::RefundUnnoticed, &stranger));
        assert_eq!(l.moved(&w, 0, 0, true), Moved::taker(AMOUNT));
        assert!(w.swap(&fx.pda).is_none(), "closed in the same instruction");
        assert_eq!(bumped(&w, &m, &c), vec![(11, 1)], "the maker's fault: missed_notices");

        // A7a: the maker gives up before the deadline; also keyless, full and immediate.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Active);
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Abort, &op));
        assert_eq!(l.moved(&w, 0, 1, true), Moved::taker(AMOUNT));
        assert_eq!(bumped(&w, &m, &c), vec![(14, 1)], "aborts_pre_notice");
    }
}

// ---- row 3

#[test]
fn row_3_taker_cancels_after_approval_before_the_notice_deadline() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Active);
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        // amount − D now; D held.
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT - D));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.revealed), (HOLD, 1, fx.s_t));
        assert_eq!(bumped(&w, &m, &c), vec![(20, 1)], "taker_cancels_approved: no fault");

        // Held 30 minutes: a stranger's crank returns it at T_hold and not a second earlier.
        let stranger = w.stranger.insecure_clone();
        w.set_time(s.t_refund + HOLD_SECS - 1);
        assert_err(w.call(&m, &fx, &Call::ReleaseDeposit, &stranger), "TooEarly");
        w.set_time(s.t_refund + HOLD_SECS);
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::ReleaseDeposit, &stranger));
        assert_eq!(l.moved(&w, 0, 0, false), Moved::taker(D));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.outcome), (DONE, 3, 28));
    }
}

// ---- row 4

#[test]
fn row_4_taker_refunds_after_a_lock_notice() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT - D));
        assert_eq!(bumped(&w, &m, &c), vec![(21, 1)], "taker_refunds_noticed");
        // The maker recovers its XMR with s_T: it is account state, not just an event.
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.revealed, s.flags & 0b1100), (HOLD, fx.s_t, 0b1100));

        // Withholdable, but only with the opening of the maker's own notice.
        let op = m.operator.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::Withhold(None), &op), "EvidenceRequired");
        assert_err(w.call(&m, &fx, &Call::Withhold(Some((rand32(), new_view()))), &op), "EvidenceMismatch");
        let (txid, view) = fx.notice.unwrap();
        ok(w.call(&m, &fx, &Call::Withhold(Some((txid, view))), &op));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.evidence_txid, s.evidence_view), (WITHHELD, 2, txid, view));
        assert_eq!(w.maker(&m.pda).withheld_volume[asset as usize], D);
    }
}

// ---- row 5

#[test]
fn row_5_maker_aborts_after_its_claim_delay_then_the_taker_refunds() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let s = w.swap(&fx.pda).unwrap();
        let op = m.operator.insecure_clone();
        w.set_time(s.t_claim_open);
        let c = counters(&w, &m);
        ok(w.call(&m, &fx, &Call::Abort, &op));
        assert_eq!(w.swap(&fx.pda).unwrap().state, ABORTED_HOLD);
        assert_eq!(bumped(&w, &m, &c), vec![(16, 1)], "aborts_late");
        // The abort is a waiver until the final deadline: the maker cannot claim now.
        let s_m = w.maker_secret(&m, &fx);
        assert_err(w.call(&m, &fx, &Call::Claim(s_m), &op), "TooEarly");

        // The taker returns before T_final.
        w.set_time(s.t_final - 1);
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        let taker = fx.taker.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT - D));
        assert_eq!(w.swap(&fx.pda).unwrap().state, HOLD);
        assert_eq!(bumped(&w, &m, &c), vec![(22, 1)], "refunds_after_abort");
    }
}

// ---- row 6

#[test]
fn row_6_taker_never_sets_ready_or_refunds_and_the_maker_claims_after_its_claim_delay() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let s = w.swap(&fx.pda).unwrap();
        let op = m.operator.insecure_clone();
        let s_m = w.maker_secret(&m, &fx);
        w.set_time(s.t_claim_open - 1);
        assert_err(w.call(&m, &fx, &Call::Claim(s_m), &op), "TooEarly");
        w.set_time(s.t_claim_open);
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        ok(w.call(&m, &fx, &Call::Claim(s_m), &op));
        assert_eq!(
            l.moved(&w, 0, 1, false),
            Moved { payout: (AMOUNT - FEE_OF_AMOUNT) as i128, treasury: FEE_OF_AMOUNT as i128, ..Moved::default() }
        );
        assert_eq!(bumped(&w, &m, &c), vec![(9, 1)], "claims_without_ready");
        // s_M is public in account state: the taker collects the XMR with it.
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.revealed, s.flags & 0b1100), (DONE, s_m, 0b0100));
        // The taker's refund is over for good.
        let taker = fx.taker.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker), "BadState");
    }
}

// ---- row 7

#[test]
fn row_7_ready_set_and_the_maker_misses_its_claim_deadline() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Ready);
        let s = w.swap(&fx.pda).unwrap();
        let session = fx.session.insecure_clone();
        w.set_time(s.t_claim_deadline - 1);
        assert_err(w.call(&m, &fx, &Call::Refund(fx.s_t), &session), "TooEarly");
        w.set_time(s.t_claim_deadline);
        // The maker is now too late.
        let op = m.operator.insecure_clone();
        let s_m = w.maker_secret(&m, &fx);
        assert_err(w.call(&m, &fx, &Call::Claim(s_m), &op), "TooLate");
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        // Everything; the deposit is never held, so a maker that was late cannot withhold.
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.revealed), (DONE, 0, fx.s_t));
        assert_eq!(bumped(&w, &m, &c), vec![(12, 1)], "the maker's fault: missed_claims");
        assert_err(w.call(&m, &fx, &Call::Withhold(fx.notice), &op), "BadState");
    }
}

// ---- row 8

#[test]
fn row_8_taker_never_returns_and_the_maker_claims_after_the_final_deadline() {
    for asset in ASSETS {
        // From READY with the claim window missed, and from ABORTED after an abort.
        for abort in [false, true] {
            let mut w = World::new();
            let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Ready);
            let s = w.swap(&fx.pda).unwrap();
            let op = m.operator.insecure_clone();
            let s_m = w.maker_secret(&m, &fx);
            if abort {
                w.set_time(s.t_claim_deadline + 10);
                ok(w.call(&m, &fx, &Call::Abort, &op));
            }
            w.set_time(s.t_final - 1);
            assert_err(w.call(&m, &fx, &Call::Claim(s_m), &op), if abort { "TooEarly" } else { "TooLate" });
            w.set_time(s.t_final);
            let l = w.ledger(&m, &fx);
            let c = counters(&w, &m);
            ok(w.call(&m, &fx, &Call::Claim(s_m), &op));
            assert_eq!(
                l.moved(&w, 0, 1, false),
                Moved { payout: (AMOUNT - FEE_OF_AMOUNT) as i128, treasury: FEE_OF_AMOUNT as i128, ..Moved::default() }
            );
            assert_eq!(bumped(&w, &m, &c), vec![(10, 1)], "claims_after_final");
            assert_eq!(w.swap(&fx.pda).unwrap().revealed, s_m);
        }
    }
}

// ---- rows the design does not list

#[test]
fn early_maker_aborts_lead_to_a_full_refund_with_no_hold() {
    for asset in ASSETS {
        // A7b: NOTICED, before the claim delay. A7d: READY.
        for (stage, counter) in [(Stage::Noticed, 15), (Stage::Ready, 12)] {
            let mut w = World::new();
            let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), stage);
            let op = m.operator.insecure_clone();
            let c = counters(&w, &m);
            ok(w.call(&m, &fx, &Call::Abort, &op));
            assert_eq!(w.swap(&fx.pda).unwrap().state, ABORTED_FREE);
            assert_eq!(bumped(&w, &m, &c), vec![(counter, 1)]);
            let l = w.ledger(&m, &fx);
            let session = fx.session.insecure_clone();
            ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
            assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT), "A10d: everything, no hold");
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.outcome, s.deposit_state), (DONE, 22, 0));
        }
    }
}

#[test]
fn expiry_and_the_keyed_refund_in_active_after_the_notice_deadline() {
    for asset in ASSETS {
        // A10f: nobody acted between T_final and T_exp; afterwards only the locker can move.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let s = w.swap(&fx.pda).unwrap();
        let taker = fx.taker.insecure_clone();
        let op = m.operator.insecure_clone();
        let s_m = w.maker_secret(&m, &fx);
        w.set_time(s.t_exp() - 1);
        assert_err(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker), "TooLate");
        w.set_time(s.t_exp());
        assert_err(w.call(&m, &fx, &Call::Claim(s_m), &op), "TooLate");
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT));
        assert_eq!(w.swap(&fx.pda).unwrap().outcome, 27, "expired_refunds");

        // A10g: a keyed refund that lands after T_note with no notice has the result of A8.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Active);
        let s = w.swap(&fx.pda).unwrap();
        w.set_time(s.t_note_deadline);
        let l = w.ledger(&m, &fx);
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.outcome, s.deposit_state), (DONE, 11, 0), "missed_notices, never held");
    }
}

// ---- direction B

/// `(amount to the maker's operator, take deposit to the taker now, counter, end state)`.
fn b_refund(asset: u8, drive: &dyn Fn(&mut World, &MakerFx, &mut SwapFx)) -> (Moved, usize, u8, [u8; 32]) {
    let mut w = World::new();
    let (m, mut fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Active);
    drive(&mut w, &m, &mut fx);
    let l = w.ledger(&m, &fx);
    let c = counters(&w, &m);
    let op = m.operator.insecure_clone();
    let s_m = w.maker_secret(&m, &fx);
    ok(w.call(&m, &fx, &Call::Refund(s_m), &op));
    let moved = l.moved(&w, 0, 1, false);
    let b = bumped(&w, &m, &c);
    assert_eq!(b.len(), 1);
    let s = w.swap(&fx.pda).unwrap();
    // Every maker refund reveals s_M, so a taker who really locked XMR recovers it.
    assert_eq!((s.revealed, s.flags & 0b1100), (s_m, 0b1100));
    (moved, b[0].0, s.state, s.revealed)
}

#[test]
fn direction_b_every_maker_refund_row() {
    let free = Moved { operator: AMOUNT as i128, taker: D as i128, ..Moved::default() };
    let held = Moved { operator: AMOUNT as i128, ..Moved::default() };
    for asset in ASSETS {
        // B9a: backs out before the notice deadline. The take deposit returns at once.
        let (moved, counter, state, _) = b_refund(asset, &|_, _, _| {});
        assert_eq!((moved, counter, state), (free, 17, DONE), "B9a backouts_pre_notice");

        // B9b: the taker posted no notice by the deadline. The deposit is held.
        let (moved, counter, state, _) = b_refund(asset, &|w, _, fx| {
            let s = w.swap(&fx.pda).unwrap();
            w.set_time(s.t_note_deadline);
        });
        assert_eq!((moved, counter, state), (held, 23, HOLD), "B9b taker_no_notice");

        // B9c: notice on time, the maker backs out before T_cut. Free.
        let (moved, counter, state, _) = b_refund(asset, &|w, m, fx| {
            w.warp(90);
            ok(w.notice(m, fx));
            let s = w.swap(&fx.pda).unwrap();
            w.set_time(s.t_cut - 1);
        });
        assert_eq!((moved, counter, state), (free, 18, DONE), "B9c backouts_post_notice");

        // B9h: the notice was late; any refund before T_cut holds the deposit.
        let (moved, counter, state, _) = b_refund(asset, &|w, m, fx| {
            let s = w.swap(&fx.pda).unwrap();
            w.set_time(s.t_note_deadline);
            ok(w.notice(m, fx));
            assert_eq!(w.swap(&fx.pda).unwrap().flags & 0b10000, 0b10000, "late-notice flag");
            w.warp(60);
        });
        assert_eq!((moved, counter, state), (held, 23, HOLD), "B9h taker_no_notice");

        // B9d: the XMR never confirmed; the maker refunds in [T_cut, T_co).
        let (moved, counter, state, _) = b_refund(asset, &|w, m, fx| {
            w.warp(90);
            ok(w.notice(m, fx));
            let s = w.swap(&fx.pda).unwrap();
            w.set_time(s.t_cut);
        });
        assert_eq!((moved, counter, state), (held, 24, HOLD), "B9d refunds_unconfirmed");

        // B9e: ready was set and the taker missed its claim window.
        let (moved, counter, state, _) = b_refund(asset, &|w, m, fx| {
            w.warp(90);
            ok(w.notice(m, fx));
            w.warp(600);
            ok(w.ready(m, fx));
            let s = w.swap(&fx.pda).unwrap();
            w.set_time(s.t_claim_deadline);
        });
        assert_eq!((moved, counter, state), (held, 25, HOLD), "B9e taker_missed_claims");

        // B8 then B9f: the taker aborts; the maker's refund holds the deposit.
        let (moved, counter, state, _) = b_refund(asset, &|w, m, fx| {
            w.warp(90);
            ok(w.notice(m, fx));
            let session = fx.session.insecure_clone();
            ok(w.call(m, fx, &Call::Abort, &session));
            assert_eq!(w.swap(&fx.pda).unwrap().state, ABORTED_HOLD);
        });
        assert_eq!((moved, counter, state), (held, 22, HOLD), "B9f refunds_after_abort");

        // B9g: expiry. The deposit returns.
        let (moved, counter, state, _) = b_refund(asset, &|w, m, fx| {
            w.warp(90);
            ok(w.notice(m, fx));
            let s = w.swap(&fx.pda).unwrap();
            w.set_time(s.t_exp());
        });
        assert_eq!((moved, counter, state), (free, 27, DONE), "B9g expired_refunds");
    }
}

#[test]
fn direction_b_claims_pay_amount_minus_fee_plus_the_take_deposit() {
    let paid = Moved { taker: (AMOUNT - FEE_OF_AMOUNT + D) as i128, treasury: FEE_OF_AMOUNT as i128, ..Moved::default() };
    for asset in ASSETS {
        // B10a ready and in time; B10b without ready from T_co; B10c after the final deadline.
        for (case, counter) in [("ready", 8usize), ("without-ready", 19), ("after-final", 10)] {
            let mut w = World::new();
            let stage = if case == "ready" { Stage::Ready } else { Stage::Noticed };
            let (m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), stage);
            let s = w.swap(&fx.pda).unwrap();
            let session = fx.session.insecure_clone();
            match case {
                "without-ready" => {
                    w.set_time(s.t_claim_open - 1);
                    assert_err(w.call(&m, &fx, &Call::Claim(fx.s_t), &session), "TooEarly");
                    w.set_time(s.t_claim_open);
                }
                "after-final" => w.set_time(s.t_final),
                _ => {}
            }
            let l = w.ledger(&m, &fx);
            let c = counters(&w, &m);
            ok(w.call(&m, &fx, &Call::Claim(fx.s_t), &session));
            assert_eq!(l.moved(&w, 1, 0, false), paid, "{case}");
            assert_eq!(bumped(&w, &m, &c), vec![(counter, 1)], "{case}");
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.revealed), (DONE, fx.s_t));
            assert_eq!(w.maker(&m.pda).volume[asset as usize], AMOUNT);
        }
    }
}

#[test]
fn direction_b_lapses_and_the_stranded_take_deposit() {
    for asset in ASSETS {
        // B4 outside window mode: the maker never funded. Its fault (missed_funds).
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Opened);
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!(s.t_pending_deadline, s.t_lock + 600, "T_fund = t_take + W_n outside window mode");
        let stranger = w.stranger.insecure_clone();
        // B3 is window mode only.
        let op = m.operator.insecure_clone();
        let open = s.open_hash(&fx.pda);
        assert_err(w.call(&m, &fx, &Call::Reject { open, reason: 0 }, &op), "BadState");
        w.set_time(s.t_pending_deadline);
        let l = w.ledger(&m, &fx);
        let c = counters(&w, &m);
        ok(w.call(&m, &fx, &Call::ExpirePending, &stranger));
        assert_eq!(l.moved(&w, 0, 0, true), Moved::taker(D));
        assert_eq!(bumped(&w, &m, &c), vec![(13, 1)]);

        // B11: funded, then nobody acts. At T_exp anyone returns the take deposit; the maker's
        // escrow is parked for its owner, never pushed.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Active);
        let s = w.swap(&fx.pda).unwrap();
        let stranger = w.stranger.insecure_clone();
        let op = m.operator.insecure_clone();
        w.set_time(s.t_exp() - 1);
        assert_err(w.call(&m, &fx, &Call::ExpireUnnoticed, &stranger), "TooEarly");
        w.set_time(s.t_exp());
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::ExpireUnnoticed, &stranger));
        assert_eq!(l.moved(&w, 0, 0, false), Moved::taker(D));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.outcome, s.owed_maker), (DONE, 27, AMOUNT));
        // Only the maker's owner can pull it; the operator cannot.
        assert_err(w.call(&m, &fx, &Call::WithdrawOwed(1), &op), "Unauthorized");
        let owner = m.owner.insecure_clone();
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::WithdrawOwed(1), &owner));
        assert_eq!(l.moved(&w, 0, 0, false), Moved { payout: AMOUNT as i128, ..Moved::default() });
        assert_err(w.call(&m, &fx, &Call::WithdrawOwed(1), &owner), "NothingOwed");
    }
}

#[test]
fn a_refund_that_would_hold_a_zero_deposit_goes_straight_to_done() {
    let no_deposit = Terms { dep_bps: 0, ..Terms::default() };
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &no_deposit, Stage::Noticed);
        let c = counters(&w, &m);
        let l = w.ledger(&m, &fx);
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.outcome), (DONE, 0, 21));
        assert_eq!(bumped(&w, &m, &c), vec![(21, 1)], "no deposit counter moves");
        let op = m.operator.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::Withhold(fx.notice), &op), "BadState");
    }
}
