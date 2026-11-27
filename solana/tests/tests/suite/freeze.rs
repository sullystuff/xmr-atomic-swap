//! Keyless freeze by a watcher (SPEC 11.6, rows Z1 to Z6): who may freeze and when, that it
//! moves and reveals nothing, what it does to the locker (nothing) and to the claimer (its
//! claim-without-ready opens at `T_ff = max(t_Z + W_z, T_co)`, never past `T_final`), the
//! deposit rules after a freeze in each direction, the counters, and the `Swap` layout.
use crate::common::*;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

const AMOUNT: u64 = 1_500_000_000;
const D: u64 = 15_000_000;
const W_Z: u32 = 86_400;
const ASSETS: [u8; 2] = [ASSET_SOL, ASSET_USDC];
const DIRECTIONS: [u8; 2] = [DIR_A, DIR_B];
const FREEZES: usize = 33;
const REFUNDS_AFTER_FREEZE: usize = 34;
const BACKOUTS_AFTER_FREEZE: usize = 35;
const CLAIMS_AFTER_FREEZE: usize = 36;

fn watched() -> Terms {
    Terms { w_z: W_Z, ..Terms::default() }
}

struct Keys {
    /// Every key the locker may sign with (A: taker wallet and session key; B: the operator).
    lockers: Vec<Keypair>,
    /// Every key of the claimer's side (A: operator and owner; B: taker wallet and session key).
    claimers: Vec<Keypair>,
    locker: Keypair,
    claimer: Keypair,
}

fn keys(m: &MakerFx, fx: &SwapFx) -> Keys {
    let taker = vec![fx.taker.insecure_clone(), fx.session.insecure_clone()];
    let maker = vec![m.operator.insecure_clone(), m.owner.insecure_clone()];
    if fx.direction == DIR_A {
        Keys { lockers: taker, claimers: maker, locker: fx.taker.insecure_clone(), claimer: m.operator.insecure_clone() }
    } else {
        Keys { lockers: vec![m.operator.insecure_clone()], claimers: taker, locker: m.operator.insecure_clone(), claimer: fx.taker.insecure_clone() }
    }
}

/// A NOTICED swap with a watcher, frozen by it now.
fn frozen(w: &mut World, asset: u8, direction: u8, terms: &Terms) -> (MakerFx, SwapFx, Keypair) {
    let (m, fx, watcher) = w.swap_watched(asset, direction, terms, Stage::Noticed);
    ok(w.call(&m, &fx, &Call::Freeze, &watcher));
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.t_freeze, s.watcher, s.w_z), (FROZEN, w.now(), watcher.pubkey(), terms.w_z));
    (m, fx, watcher)
}

#[test]
fn only_the_named_watcher_or_the_locker_freezes_and_only_in_its_window() {
    for asset in ASSETS {
        for direction in DIRECTIONS {
            let label = format!("asset {asset} direction {direction}");
            let mut w = World::new();

            // Before a notice there is nothing to freeze (the keyless refund protects the locker).
            let (m, fx, watcher) = w.swap_watched(asset, direction, &watched(), Stage::Active);
            let k = keys(&m, &fx);
            assert_err(w.call(&m, &fx, &Call::Freeze, &watcher), "BadState");
            assert_err(w.call(&m, &fx, &Call::Freeze, &k.locker), "BadState");

            let (m, fx, watcher) = w.swap_watched(asset, direction, &watched(), Stage::Noticed);
            let k = keys(&m, &fx);
            let before = w.swap(&fx.pda).unwrap();
            assert_eq!((before.watcher, before.w_z, before.t_freeze), (watcher.pubkey(), W_Z, 0));
            // Not a stranger, not the claimer's side, not another watcher, not the payout address.
            let other_watcher = w.fund(SOL);
            let stranger = w.stranger.insecure_clone();
            for who in k.claimers.iter().chain([&stranger, &other_watcher]) {
                assert_err(w.call(&m, &fx, &Call::Freeze, who), "Unauthorized");
            }
            // The window is the locker's refund window: `now < T_co`.
            let entered = w.now();
            w.set_time(before.t_claim_open);
            for who in k.lockers.iter().chain([&watcher]) {
                assert_err(w.would(&m, &fx, &Call::Freeze, who), "TooLate");
            }
            w.set_time(before.t_claim_open - 1);
            for who in k.lockers.iter().chain([&watcher]) {
                ok(w.would(&m, &fx, &Call::Freeze, who));
            }
            w.set_time(entered + 7);

            // Z1. It moves nothing and reveals nothing: the escrow, every party's balance and
            // the record, but for the state and the freeze time, are as they were.
            let l = w.ledger(&m, &fx);
            let vault = (w.lamports(&fx.pda), if asset == ASSET_USDC { w.tokens(&fx.vault) } else { 0 });
            let watcher_before = w.lamports(&watcher.pubkey());
            let maker_before = w.maker(&m.pda);
            let res = ok(w.call(&m, &fx, &Call::Freeze, &watcher));
            assert_eq!(l.moved(&w, 0, 0, false), Moved::default(), "{label}");
            assert_eq!(vault, (w.lamports(&fx.pda), if asset == ASSET_USDC { w.tokens(&fx.vault) } else { 0 }));
            assert_eq!(watcher_before - w.lamports(&watcher.pubkey()), FEE, "the watcher pays its fee and nothing else");
            let after = w.swap(&fx.pda).unwrap();
            assert_eq!(after, SwapAcc { state: FROZEN, t_freeze: entered + 7, ..before.clone() }, "{label}");
            assert_eq!(after.revealed, [0; 32]);
            // The public record: one counter, and an event naming the taker and the watcher.
            let mut want = maker_before.clone();
            want.counters[FREEZES] += 1;
            assert_eq!(w.maker(&m.pda), want, "{label}: `freezes` and nothing else");
            let ev = &logged_events(&res, "Frozen")[0];
            assert_eq!(ev[0..32], fx.pda.to_bytes());
            assert_eq!(ev[32..64], m.pda.to_bytes());
            assert_eq!(ev[64], FREEZES as u8);
            assert_eq!(i64::from_le_bytes(ev[65..73].try_into().unwrap()), entered + 7);
            assert_eq!(ev[73..105], fx.taker.pubkey().to_bytes());
            assert_eq!(ev[105..137], watcher.pubkey().to_bytes());
            assert_eq!(i64::from_le_bytes(ev[137..145].try_into().unwrap()), entered + 7 + W_Z as i64);
            assert_eq!(ev.len(), 145);

            // Once.
            for who in k.lockers.iter().chain([&watcher]) {
                assert_err(w.call(&m, &fx, &Call::Freeze, who), "BadState");
            }
            assert_eq!(w.maker(&m.pda).counters[FREEZES], 1);

            // The locker itself may freeze, with any of its keys.
            for i in 0..k.lockers.len() {
                let (m, fx, _) = w.swap_watched(asset, direction, &watched(), Stage::Noticed);
                let k = keys(&m, &fx);
                ok(w.call(&m, &fx, &Call::Freeze, &k.lockers[i]));
                assert_eq!(w.swap(&fx.pda).unwrap().state, FROZEN, "{label}");
            }

            // READY: the locker has confirmed the lock; nothing to freeze.
            let (m, fx, watcher) = w.swap_watched(asset, direction, &watched(), Stage::Ready);
            let k = keys(&m, &fx);
            assert_err(w.call(&m, &fx, &Call::Freeze, &watcher), "BadState");
            assert_err(w.call(&m, &fx, &Call::Freeze, &k.locker), "BadState");

            // No watcher named: no freeze, by anyone, although the offer has a freeze window.
            let (m, fx) = w.swap_at(asset, direction, &watched(), Stage::Noticed);
            let k = keys(&m, &fx);
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.watcher, s.w_z), (Pubkey::default(), W_Z));
            for who in &k.lockers {
                assert_err(w.call(&m, &fx, &Call::Freeze, who), "BadState");
            }
            assert_err(w.call(&m, &fx, &Call::Freeze, &watcher), "Unauthorized");
            assert_err(w.call(&m, &fx, &Call::Freeze, &stranger), "Unauthorized");
        }
    }
}

#[test]
fn a_watcher_needs_an_offer_with_a_freeze_window() {
    for asset in ASSETS {
        let mut w = World::new();
        let mut m = w.register_maker();
        let watcher = Keypair::new().pubkey();
        // Direction A, `w_z == 0`: a lock naming a watcher is refused; without one it opens.
        let offer = w.live_offer(&mut m, asset, DIR_A, &Terms::default(), PRICE);
        for (named, want) in [(Some(watcher), Some("WatcherNotAllowed")), (Some(Pubkey::default()), Some("WatcherNotAllowed")), (None, None)] {
            let (fx, mut raw) = w.prepare_open(&m, asset, DIR_A, XMR, Source::Offer(offer));
            raw.watcher = named;
            let res = w.send_open(&fx, &raw);
            match want {
                Some(e) => {
                    assert!(is_err(&res, e), "{}", err_string(&res));
                    assert!(w.swap(&fx.pda).is_none());
                }
                None => {
                    ok(res);
                }
            }
        }
        // Direction B, `w_z == 0`: a fund naming a watcher is refused; without one it funds.
        let fx = w.swap_with(&mut m, asset, DIR_B, &Terms::default(), Stage::Opened);
        assert_err(w.fund_swap_with(&mut m, &fx, Some(watcher)), "WatcherNotAllowed");
        assert_err(w.fund_swap_with(&mut m, &fx, Some(Pubkey::default())), "WatcherNotAllowed");
        assert_eq!(w.swap(&fx.pda).unwrap().state, PENDING);
        ok(w.fund_swap(&mut m, &fx));
        assert_eq!(w.swap(&fx.pda).unwrap().watcher, Pubkey::default());

        // With a window: the zero key is still not a watcher, in either direction.
        let mut m = w.register_maker();
        let offer = w.live_offer(&mut m, asset, DIR_A, &watched(), PRICE);
        let (fx, mut raw) = w.prepare_open(&m, asset, DIR_A, XMR, Source::Offer(offer));
        raw.watcher = Some(Pubkey::default());
        assert_err(w.send_open(&fx, &raw), "WatcherNotAllowed");
        let fx = w.swap_with(&mut m, asset, DIR_B, &watched(), Stage::Opened);
        assert_err(w.fund_swap_with(&mut m, &fx, Some(Pubkey::default())), "WatcherNotAllowed");
        // The watcher is in the taker's open hash (direction A): the event carries it.
        let (fx, mut raw) = w.prepare_open(&m, asset, DIR_A, XMR, Source::Offer(offer));
        raw.watcher = Some(watcher);
        let res = ok(w.send_open(&fx, &raw));
        assert_eq!(logged_events(&res, "SwapOpened")[0][166..198], watcher.to_bytes());
        assert_eq!(w.swap(&fx.pda).unwrap().watcher, watcher);

        // The window itself: 0, or 3,600 to 259,200 seconds.
        for (w_z, want) in [(1, false), (MIN_FREEZE_SECS - 1, false), (MIN_FREEZE_SECS, true), (MAX_FREEZE_SECS, true), (MAX_FREEZE_SECS + 1, false), (0, true)] {
            let res = w.set_offer(&m, asset, DIR_A, &Terms { w_z, ..Terms::default() });
            assert_eq!(res.is_ok(), want, "w_z {w_z}: {}", err_string(&res));
            if !want {
                assert_err(res, "FreezeWindowOutOfRange");
            }
        }
    }
}

#[test]
fn a_freeze_never_blocks_the_locker_and_delays_the_claim_to_the_frozen_final_time() {
    for asset in ASSETS {
        for direction in DIRECTIONS {
            let label = format!("asset {asset} direction {direction}");
            let mut w = World::new();
            let (m, fx, watcher) = frozen(&mut w, asset, direction, &watched());
            let k = keys(&m, &fx);
            let s = w.swap(&fx.pda).unwrap();
            let t_ff = s.t_ff();
            assert_eq!(t_ff, s.t_freeze + W_Z as i64, "{label}: t_Z + W_z is the later one here");
            assert!(s.t_claim_open < t_ff && t_ff < s.t_final - s.w_c as i64 - DAY_SECS, "{label}");
            let refund = Call::Refund(w.locker_secret(&m, &fx));
            let claim = Call::Claim(w.claimer_secret(&m, &fx));

            // The watcher has no other power: it holds no share and is no party.
            for call in [&refund, &claim, &Call::SetReady, &Call::Abort, &Call::WithdrawOwed(0), &Call::WithdrawOwed(1)] {
                let res = w.call(&m, &fx, call, &watcher);
                assert!(is_err(&res, "Unauthorized"), "{label} {}: {}", call.name(), err_string(&res));
            }

            // From the freeze to T_ff − 1, at every boundary on the way (T_cut, the old T_co):
            // the locker can refund, and can set ready (from the confirmation floor on); the
            // claimer cannot claim. With every key the locker has.
            let ready_min = s.t_notice + s.depth as i64 * 60;
            for now in [w.now(), s.t_cut - 1, s.t_cut, s.t_claim_open - 1, s.t_claim_open, s.t_claim_open + 1, t_ff - 1] {
                w.set_time(now);
                for locker in &k.lockers {
                    let res = w.would(&m, &fx, &refund, locker);
                    assert!(res.is_ok(), "{label} at {now}: the refund is blocked: {}", err_string(&res));
                    let res = w.would(&m, &fx, &Call::SetReady, locker);
                    assert_eq!(res.is_ok(), now >= ready_min, "{label} at {now}: set_ready: {}", err_string(&res));
                }
                for claimer in &k.claimers {
                    assert_err(w.would(&m, &fx, &claim, claimer), if claimer.pubkey() == k.claimer.pubkey() || direction == DIR_B { "TooEarly" } else { "Unauthorized" });
                }
                // The claimer can still walk away (Z5).
                ok(w.would(&m, &fx, &Call::Abort, &k.claimer));
            }
            // At T_ff the sides swap, at the same second: never both (invariant 1).
            w.set_time(t_ff);
            for locker in &k.lockers {
                assert_err(w.would(&m, &fx, &refund, locker), "TooLate");
                assert_err(w.would(&m, &fx, &Call::SetReady, locker), "TooLate");
            }
            ok(w.would(&m, &fx, &claim, &k.claimer));
            // Z6: the final deadline and expiry are where they always were.
            for now in [s.t_final - 1, s.t_final, s.t_exp() - 1] {
                w.set_time(now);
                ok(w.would(&m, &fx, &claim, &k.claimer));
                assert!(w.would(&m, &fx, &refund, &k.locker).is_err());
            }
            w.set_time(s.t_exp());
            ok(w.would(&m, &fx, &refund, &k.locker));
            assert_err(w.would(&m, &fx, &claim, &k.claimer), "TooLate");

            // Z4, committed at T_ff: it pays exactly what the same claim pays on a swap nobody
            // froze, and is counted.
            w.set_time(t_ff);
            let l = w.ledger(&m, &fx);
            ok(w.call(&m, &fx, &claim, &k.claimer));
            let frozen_claim = l.moved(&w, (direction == DIR_B) as u64, (direction == DIR_A) as u64, false);
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.t_freeze != 0), (DONE, true), "{label}");
            let c = w.maker(&m.pda).counters;
            assert_eq!((c[FREEZES], c[CLAIMS_AFTER_FREEZE], c[REFUNDS_AFTER_FREEZE], c[BACKOUTS_AFTER_FREEZE]), (1, 1, 0, 0), "{label}");

            let (m2, fx2) = w.swap_at(asset, direction, &watched(), Stage::Noticed);
            let k2 = keys(&m2, &fx2);
            let t_co = w.swap(&fx2.pda).unwrap().t_claim_open;
            w.set_time(t_co);
            let l = w.ledger(&m2, &fx2);
            ok(w.call(&m2, &fx2, &Call::Claim(w.claimer_secret(&m2, &fx2)), &k2.claimer));
            assert_eq!(frozen_claim, l.moved(&w, (direction == DIR_B) as u64, (direction == DIR_A) as u64, false), "{label}: a claim after a freeze is any claim");
            assert_eq!(w.maker(&m2.pda).counters[CLAIMS_AFTER_FREEZE], 0);
            assert_eq!(asset_units(&w, asset, &watcher.pubkey()), if asset == ASSET_SOL { SOL - FEE * 7 } else { 0 }, "{label}: a watcher is never paid");
        }
    }
}

fn asset_units(w: &World, asset: u8, wallet: &Pubkey) -> u64 {
    if asset == ASSET_USDC {
        let ata = w.ata(wallet);
        if w.exists(&ata) { w.tokens(&ata) } else { 0 }
    } else {
        w.lamports(wallet)
    }
}

#[test]
fn the_frozen_final_time_is_never_before_the_claim_delay_and_never_reaches_the_final_deadline() {
    for direction in DIRECTIONS {
        // The shortest window, frozen right at the notice: t_Z + W_z falls before T_co, and the
        // claim opens at T_co as if nobody had frozen (a freeze shortens no wait of the locker's
        // refund window and opens no claim early).
        let mut w = World::new();
        let terms = Terms { w_z: MIN_FREEZE_SECS, ..Terms::default() };
        let (m, fx, _) = frozen(&mut w, ASSET_SOL, direction, &terms);
        let k = keys(&m, &fx);
        let s = w.swap(&fx.pda).unwrap();
        assert!(s.t_freeze + (MIN_FREEZE_SECS as i64) < s.t_claim_open);
        assert_eq!(s.t_ff(), s.t_claim_open);
        let (refund, claim) = (Call::Refund(w.locker_secret(&m, &fx)), Call::Claim(w.claimer_secret(&m, &fx)));
        w.set_time(s.t_freeze + MIN_FREEZE_SECS as i64);
        assert_err(w.would(&m, &fx, &claim, &k.claimer), "TooEarly");
        ok(w.would(&m, &fx, &refund, &k.locker));
        w.set_time(s.t_claim_open - 1);
        assert_err(w.would(&m, &fx, &claim, &k.claimer), "TooEarly");
        ok(w.would(&m, &fx, &refund, &k.locker));
        ok(w.would(&m, &fx, &Call::SetReady, &k.locker));
        w.set_time(s.t_claim_open);
        ok(w.would(&m, &fx, &claim, &k.claimer));
        assert_err(w.would(&m, &fx, &refund, &k.locker), "TooLate");
        assert_err(w.would(&m, &fx, &Call::SetReady, &k.locker), "TooLate");

        // The longest window, frozen in the last second it can be: the latest T_ff there is. It
        // is still a day and a claim window short of T_final, and a ready set in its last second
        // leaves the whole claim window before the final day.
        let mut w = World::new();
        let terms = Terms { w_z: MAX_FREEZE_SECS, ..Terms::default() };
        let (m, fx, watcher) = w.swap_watched(ASSET_SOL, direction, &terms, Stage::Noticed);
        let k = keys(&m, &fx);
        let t_co = w.swap(&fx.pda).unwrap().t_claim_open;
        w.set_time(t_co - 1);
        ok(w.call(&m, &fx, &Call::Freeze, &watcher));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!(s.t_ff(), t_co - 1 + MAX_FREEZE_SECS as i64);
        assert!(s.t_ff() < s.t_final - s.w_c as i64 - DAY_SECS);
        let claim = Call::Claim(w.claimer_secret(&m, &fx));
        w.set_time(s.t_ff() - 1);
        assert_err(w.would(&m, &fx, &claim, &k.claimer), "TooEarly");
        ok(w.call(&m, &fx, &Call::SetReady, &k.locker));
        let r = w.swap(&fx.pda).unwrap();
        assert_eq!((r.state, r.t_claim_deadline), (READY, s.t_ff() - 1 + s.w_c as i64));
        assert!(r.t_claim_deadline < r.t_final - DAY_SECS);
        assert_eq!((r.t_final, r.t_exp()), (s.t_final, s.t_exp()), "a freeze moves neither");
        // Z2 unfroze it: the claim is the ordinary claim of a READY swap, open at once.
        ok(w.would(&m, &fx, &claim, &k.claimer));
    }
}

#[test]
fn after_a_freeze_the_buy_side_deposit_is_always_withholdable() {
    for asset in ASSETS {
        let mut w = World::new();
        // Z3: the taker's refund of a frozen swap. Whenever it comes (before the lock could have
        // confirmed, or after), the deposit is held.
        for late in [false, true] {
            let (m, fx, _) = frozen(&mut w, asset, DIR_A, &watched());
            let s = w.swap(&fx.pda).unwrap();
            if late {
                w.set_time(s.t_ff() - 1);
            }
            let session = fx.session.insecure_clone();
            let l = w.ledger(&m, &fx);
            ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
            assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT - D), "asset {asset} late {late}");
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.deposit_state, w.open_value(asset)), (HOLD, 1, 0));
            let c = w.maker(&m.pda).counters;
            assert_eq!((c[FREEZES], c[REFUNDS_AFTER_FREEZE], c[BACKOUTS_AFTER_FREEZE], c[CLAIMS_AFTER_FREEZE]), (1, 1, 0, 0));
            // The maker can withhold it (its notice was real: it shows the evidence).
            let op = m.operator.insecure_clone();
            ok(w.call(&m, &fx, &Call::Withhold(fx.notice), &op));
            assert_eq!(w.swap(&fx.pda).unwrap().state, WITHHELD);
        }

        // Z5: the maker's abort of a frozen swap is ABORTED_HOLD at any time, so the refund that
        // follows holds the deposit. Without the freeze the same early abort frees it.
        let (m, fx, _) = frozen(&mut w, asset, DIR_A, &watched());
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Abort, &op));
        assert_eq!(w.swap(&fx.pda).unwrap().state, ABORTED_HOLD);
        let taker = fx.taker.insecure_clone();
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT - D));
        assert_eq!(w.swap(&fx.pda).unwrap().state, HOLD);
        ok(w.call(&m, &fx, &Call::Withhold(fx.notice), &op));

        let (m, fx) = w.swap_at(asset, DIR_A, &watched(), Stage::Noticed);
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Abort, &op));
        assert_eq!(w.swap(&fx.pda).unwrap().state, ABORTED_FREE);
        let taker = fx.taker.insecure_clone();
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(AMOUNT), "no freeze: the early abort frees the deposit");
    }
}

#[test]
fn a_maker_side_freeze_never_holds_the_take_deposit() {
    for asset in ASSETS {
        let mut w = World::new();
        // Without a freeze, a maker refund after T_cut holds the take deposit (B9d): the control.
        let (m, fx) = w.swap_at(asset, DIR_B, &watched(), Stage::Noticed);
        let t_cut = w.swap(&fx.pda).unwrap().t_cut;
        w.set_time(t_cut);
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(w.maker_secret(&m, &fx)), &op));
        assert_eq!((w.swap(&fx.pda).unwrap().state, w.swap(&fx.pda).unwrap().deposit_state), (HOLD, 1));

        // Z3 in B, frozen by the maker's watcher or by the operator, refunded at any time up to
        // T_ff: the amount back to the maker, the deposit to the taker in the same transaction.
        for by_watcher in [true, false] {
            for at in ["at once", "at T_cut", "at T_ff - 1"] {
                let (m, fx, watcher) = w.swap_watched(asset, DIR_B, &watched(), Stage::Noticed);
                let op = m.operator.insecure_clone();
                ok(w.call(&m, &fx, &Call::Freeze, if by_watcher { &watcher } else { &op }));
                let s = w.swap(&fx.pda).unwrap();
                match at {
                    "at T_cut" => w.set_time(s.t_cut),
                    "at T_ff - 1" => w.set_time(s.t_ff() - 1),
                    _ => {}
                }
                let l = w.ledger(&m, &fx);
                ok(w.call(&m, &fx, &Call::Refund(w.maker_secret(&m, &fx)), &op));
                let label = format!("asset {asset} by_watcher {by_watcher} {at}");
                assert_eq!(l.moved(&w, 0, 1, false), Moved { operator: AMOUNT as i128, taker: D as i128, ..Moved::default() }, "{label}");
                let s = w.swap(&fx.pda).unwrap();
                assert_eq!((s.state, s.deposit_state, s.owed_taker), (DONE, 0, 0), "{label}");
                let c = w.maker(&m.pda).counters;
                assert_eq!((c[FREEZES], c[BACKOUTS_AFTER_FREEZE], c[REFUNDS_AFTER_FREEZE], c[CLAIMS_AFTER_FREEZE]), (1, 1, 0, 0), "{label}");
                // Nothing is left to withhold, hold or split.
                for call in [Call::Withhold(fx.notice), Call::ReleaseDeposit, Call::SplitDeposit] {
                    assert_err(w.call(&m, &fx, &call, &op), "BadState");
                }
            }
        }
    }
}

#[test]
fn the_swap_account_is_800_bytes_and_its_reserved_space_stays_zero() {
    // There is no deployment and so no migration; what is asserted is the Amendment 1 layout
    // (SPEC 11.8) at every stage a swap goes through, in both directions and assets.
    let mut seen = 0;
    for asset in ASSETS {
        for direction in DIRECTIONS {
            let mut w = World::new();
            let payout = Keypair::new().pubkey();
            let mut check = |w: &World, fx: &SwapFx, watcher: Pubkey, payout: Pubkey, frozen_at: i64| {
                let d = w.data(&fx.pda);
                assert_eq!(d.len(), 800);
                assert_eq!(d[770..800], [0u8; 30], "reserved");
                assert_eq!(d[694..726], payout.to_bytes(), "payout");
                assert_eq!(d[726..758], watcher.to_bytes(), "watcher");
                assert_eq!(u32::from_le_bytes(d[758..762].try_into().unwrap()), W_Z, "w_z");
                assert_eq!(i64::from_le_bytes(d[762..770].try_into().unwrap()), frozen_at, "t_freeze");
                assert_eq!(w.lamports(&fx.pda) >= w.rent(800), true);
                seen += 1;
            };
            for stage in [Stage::Opened, Stage::Active, Stage::Noticed, Stage::Ready] {
                let (m, fx, watcher) = w.swap_watched(asset, direction, &watched(), stage);
                let s = w.swap(&fx.pda).unwrap();
                // A: the payout field is zeros. B: the taker's own wallet by default; the maker's
                // watcher is written at fund, not before.
                let p = if direction == DIR_A { Pubkey::default() } else { fx.taker.pubkey() };
                let named = if direction == DIR_B && s.state == PENDING { Pubkey::default() } else { watcher.pubkey() };
                check(&w, &fx, named, p, 0);
                if stage == Stage::Noticed {
                    ok(w.call(&m, &fx, &Call::Freeze, &watcher));
                    check(&w, &fx, named, p, w.now());
                    let k = keys(&m, &fx);
                    ok(w.call(&m, &fx, &Call::Refund(w.locker_secret(&m, &fx)), &k.locker));
                    check(&w, &fx, named, p, w.now());
                }
            }
            if direction == DIR_B {
                let mut m = w.register_maker();
                let offer = w.live_offer(&mut m, asset, DIR_B, &watched(), PRICE);
                let (mut fx, mut raw) = w.prepare_open(&m, asset, DIR_B, XMR, Source::Offer(offer));
                raw.payout = payout;
                fx.payout = payout;
                ok(w.send_open(&fx, &raw));
                check(&w, &fx, Pubkey::default(), payout, 0);
            }
        }
    }
    assert_eq!(seen, 2 * (2 * 6 + 1));
}
