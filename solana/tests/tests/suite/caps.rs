//! On-chain beta caps (SPEC 11.1): fail-closed start, `set_caps`, the boundaries, lowering a
//! cap under open swaps, and the exactness of the open value.
use crate::common::*;
use solana_signer::Signer;

const AMOUNT: u64 = 1_500_000_000;
const D: u64 = 15_000_000;
const ASSETS: [u8; 2] = [ASSET_SOL, ASSET_USDC];

fn attempt(w: &mut World, m: &MakerFx, asset: u8, direction: u8) -> (TxResult, SwapFx) {
    let offer = w.offer_pda(&m.pda, asset, direction);
    ok(w.refresh(m, &[(asset, direction, true, [PRICE, 0, 0], 1_000_000 * XMR)]));
    let (fx, raw) = w.prepare_open(m, asset, direction, XMR, Source::Offer(offer));
    (w.send_open(&fx, &raw), fx)
}

fn market(w: &mut World) -> MakerFx {
    let mut m = w.register_maker();
    for asset in ASSETS {
        w.live_offer(&mut m, asset, DIR_A, &Terms::default(), PRICE);
        ok(w.refill(&mut m, asset, 2, 8));
        w.live_offer(&mut m, asset, DIR_B, &Terms::default(), PRICE);
    }
    m
}

#[test]
fn a_fresh_deployment_is_fail_closed_until_the_admin_sets_caps() {
    let mut w = World::fresh();
    for asset in ASSETS {
        assert_eq!(w.caps(asset), (true, 0, 0, 0), "after initialize: the switch on, every cap zero");
    }
    assert_eq!(w.data(&w.config)[188..256], [0u8; 68], "the reserved bytes of Config");
    let m = market(&mut w);
    for asset in ASSETS {
        for direction in [DIR_A, DIR_B] {
            let (res, fx) = attempt(&mut w, &m, asset, direction);
            assert_err(res, "SwapCapExceeded");
            assert!(w.swap(&fx.pda).is_none());
        }
    }
    // Only the admin sets caps.
    let (stranger, op) = (w.stranger.insecure_clone(), m.operator.insecure_clone());
    for who in [&stranger, &op] {
        let ix = w.set_caps_ix(&who.pubkey(), false, [1; 2], [1; 2]);
        assert_err(w.send(&[ix], &[who]), "Unauthorized");
    }
    let admin = w.admin.insecure_clone();
    let ix = w.set_caps_ix(&admin.pubkey(), true, [AMOUNT, 7], [10 * AMOUNT, 9]);
    let res = ok(w.send(&[ix], &[&admin]));
    let ev = &logged_events(&res, "CapsChanged")[0];
    assert_eq!(ev[0], 1);
    assert_eq!(u64::from_le_bytes(ev[1..9].try_into().unwrap()), AMOUNT);
    assert_eq!(u64::from_le_bytes(ev[9..17].try_into().unwrap()), 7);
    assert_eq!(u64::from_le_bytes(ev[17..25].try_into().unwrap()), 10 * AMOUNT);
    assert_eq!(w.caps(ASSET_SOL), (true, AMOUNT, 10 * AMOUNT, 0));
    assert_eq!(w.caps(ASSET_USDC), (true, 7, 9, 0));
    // Per asset: SOL opens now, USDC (caps of 7 and 9 units) still does not.
    ok(attempt(&mut w, &m, ASSET_SOL, DIR_A).0);
    assert_err(attempt(&mut w, &m, ASSET_USDC, DIR_A).0, "SwapCapExceeded");
    assert_eq!((w.open_value(ASSET_SOL), w.open_value(ASSET_USDC)), (AMOUNT, 0));

    // Frozen while the caps are on: they stay as they are for good.
    let ix = w.admin_ix(&admin.pubkey(), Enc::ix("freeze_config").0);
    ok(w.send(&[ix], &[&admin]));
    assert_err(w.set_caps(false, [u64::MAX; 2], [u64::MAX; 2]), "ConfigFrozen");
    assert_eq!(w.caps(ASSET_USDC), (true, 7, 9, 0));
    assert_err(attempt(&mut w, &m, ASSET_USDC, DIR_B).0, "SwapCapExceeded");
    ok(attempt(&mut w, &m, ASSET_SOL, DIR_B).0);
}

#[test]
fn exactly_at_a_cap_is_allowed_and_one_above_is_refused() {
    for asset in ASSETS {
        let mut w = World::new();
        let m = market(&mut w);
        let caps = |w: &mut World, max_swap: u64, max_open: u64| {
            // The other asset keeps unlimited caps: the two are independent.
            let (mut s, mut o) = ([u64::MAX; 2], [u64::MAX; 2]);
            s[asset as usize] = max_swap;
            o[asset as usize] = max_open;
            ok(w.set_caps(true, s, o));
        };

        // max_swap is about the amount of one swap, in either direction.
        for direction in [DIR_A, DIR_B] {
            caps(&mut w, AMOUNT - 1, u64::MAX);
            let (res, fx) = attempt(&mut w, &m, asset, direction);
            assert_err(res, "SwapCapExceeded");
            assert!(w.swap(&fx.pda).is_none());
            caps(&mut w, AMOUNT, u64::MAX);
            ok(attempt(&mut w, &m, asset, direction).0);
        }
        // What is open now: one lock (its amount) and one take (amount + deposit).
        let open = AMOUNT + (AMOUNT + D);
        assert_eq!(w.open_value(asset), open);

        // max_open is about the sum of the counted values: A counts the amount...
        caps(&mut w, u64::MAX, open + AMOUNT - 1);
        assert_err(attempt(&mut w, &m, asset, DIR_A).0, "OpenCapExceeded");
        assert_eq!(w.open_value(asset), open, "a refused open adds nothing");
        caps(&mut w, u64::MAX, open + AMOUNT);
        ok(attempt(&mut w, &m, asset, DIR_A).0);
        let open = open + AMOUNT;
        // ...and B the amount and the take deposit, although only the deposit is escrowed yet.
        caps(&mut w, u64::MAX, open + AMOUNT + D - 1);
        assert_err(attempt(&mut w, &m, asset, DIR_B).0, "OpenCapExceeded");
        caps(&mut w, u64::MAX, open + AMOUNT + D);
        let (res, fx) = attempt(&mut w, &m, asset, DIR_B);
        ok(res);
        assert_eq!(w.open_value(asset), open + AMOUNT + D);
        assert_eq!(w.caps(asset).2, w.open_value(asset), "exactly full");
        // The other asset was never touched.
        assert_eq!(w.open_value(1 - asset), 0);
        ok(attempt(&mut w, &m, 1 - asset, DIR_A).0);

        // Full: nothing opens. The cap gates only the open: the take above is funded with
        // every cap at zero (the whole amount was reserved at take), and runs to its end.
        assert_err(attempt(&mut w, &m, asset, DIR_A).0, "OpenCapExceeded");
        ok(w.set_caps(true, [0; 2], [0; 2]));
        let mut m = m;
        ok(w.fund_swap(&mut m, &fx));
        assert_eq!(w.swap(&fx.pda).unwrap().state, ACTIVE);

        // The switch off: nothing is checked, and the accounting goes on.
        let before = w.open_value(asset);
        ok(w.set_caps(false, [0; 2], [0; 2]));
        ok(attempt(&mut w, &m, asset, DIR_A).0);
        ok(attempt(&mut w, &m, asset, DIR_B).0);
        assert_eq!(w.open_value(asset), before + AMOUNT + AMOUNT + D);
    }
}

#[test]
fn a_quote_is_capped_like_an_offer_and_the_caps_come_after_the_bounds_and_before_the_pending_count() {
    let mut w = World::new();
    let mut m = market(&mut w);
    let op = m.operator.insecure_clone();
    ok(w.set_caps(true, [AMOUNT - 1; 2], [u64::MAX; 2]));
    // A taker-bound quote: offer size limits do not apply to it; the caps do.
    let taker = w.fund(100 * SOL);
    let (_, share, pok) = m.new_share();
    let (ix, quote) = w.post_quote_ix(&m, 1, &taker.pubkey(), ASSET_SOL, DIR_A, XMR, AMOUNT, &Terms::default(), &share, &pok, w.now() + 60);
    ok(w.send(&[ix], &[&op]));
    let (fx, raw) = w.prepare_open_for(&m, taker, ASSET_SOL, DIR_A, XMR, Source::Quote(quote, op.pubkey()), rand16());
    assert_err(w.send_open(&fx, &raw), "SwapCapExceeded");
    assert!(w.exists(&quote), "a refused lock does not consume the quote");
    ok(w.set_caps(true, [AMOUNT; 2], [u64::MAX; 2]));
    ok(w.send_open(&fx, &raw));

    // Order (SPEC 11.1): a maker with 64 pending swaps and a cap too low answers with the cap.
    ok(w.set_caps(true, [AMOUNT - 1; 2], [u64::MAX; 2]));
    let maker = m.pda;
    w.patch(&maker, |d| d[MAKER_OPEN_PENDING..MAKER_OPEN_PENDING + 2].copy_from_slice(&64u16.to_le_bytes()));
    assert_err(attempt(&mut w, &m, ASSET_SOL, DIR_B).0, "SwapCapExceeded");
    ok(w.set_caps(true, [AMOUNT; 2], [u64::MAX; 2]));
    assert_err(attempt(&mut w, &m, ASSET_SOL, DIR_B).0, "TooManyPending");
    // And terms out of bounds answer with the bound, whatever the caps.
    ok(w.set_caps(true, [0; 2], [0; 2]));
    let bad = Terms { dep_bps: 501, ..Terms::default() };
    let offer = w.craft_offer(&mut m, ASSET_SOL, DIR_A, &bad, PRICE);
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
    assert_err(w.send_open(&fx, &raw), "DepositTooHigh");
}

#[test]
fn lowering_a_cap_below_the_open_value_leaves_open_swaps_alone_and_refuses_new_ones() {
    for asset in ASSETS {
        let mut w = World::new();
        let mut m = market(&mut w);
        let op = m.operator.insecure_clone();
        ok(w.set_caps(true, [AMOUNT; 2], [2 * AMOUNT; 2]));
        let (res, mut one) = attempt(&mut w, &m, asset, DIR_A);
        ok(res);
        let (res, mut two) = attempt(&mut w, &m, asset, DIR_A);
        ok(res);
        assert_eq!(w.open_value(asset), 2 * AMOUNT);
        assert_err(attempt(&mut w, &m, asset, DIR_A).0, "OpenCapExceeded");

        // The admin halves max_open: both swaps are above it now. Neither is touched.
        ok(w.set_caps(true, [AMOUNT; 2], [AMOUNT; 2]));
        assert_eq!(w.open_value(asset), 2 * AMOUNT);
        w.warp(90);
        ok(w.notice(&m, &mut one));
        ok(w.notice(&m, &mut two));
        w.warp(600);
        ok(w.ready(&m, &one));
        let secret = w.maker_secret(&m, &one);
        ok(w.call(&m, &one, &Call::Claim(secret), &op));
        // One exited: the open value is exactly at the cap, so a new open is still refused...
        assert_eq!(w.open_value(asset), AMOUNT);
        assert_err(attempt(&mut w, &m, asset, DIR_A).0, "OpenCapExceeded");
        // ...until the second leaves the open states (a held refund: HOLD is not open; its
        // deposit is a settled obligation, not counted).
        let session = two.session.insecure_clone();
        ok(w.call(&m, &two, &Call::Refund(two.s_t), &session));
        assert_eq!((w.swap(&two.pda).unwrap().state, w.open_value(asset)), (HOLD, 0));
        ok(w.refill(&mut m, asset, 0, 2));
        ok(attempt(&mut w, &m, asset, DIR_A).0);
        assert_eq!(w.open_value(asset), AMOUNT);
        // The release of the held deposit subtracts nothing a second time.
        ok(w.call(&m, &two, &Call::ReleaseDeposit, &op));
        assert_eq!(w.open_value(asset), AMOUNT);
        ok(w.call(&m, &two, &Call::CloseSwap, &op));
        assert_eq!(w.open_value(asset), AMOUNT);
    }
}

#[test]
fn open_value_arithmetic_is_exact() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let op = m.operator.insecure_clone();
    let asset = ASSET_USDC;
    // A direction-B swap whose amount + deposit does not fit the amount type is refused at take,
    // caps on or off: the counted value must be exact, and the claim would pay that sum.
    let big_take = |w: &mut World, m: &mut MakerFx, amount: u64, dep_bps: u16| {
        let taker = w.fund(10 * SOL);
        let ata = w.mint_to(&taker.pubkey(), 1);
        w.set_tokens(&ata, (amount as u128 * dep_bps as u128 / 10_000) as u64);
        let id = u64::from_le_bytes(rand32()[..8].try_into().unwrap());
        let terms = Terms { dep_bps, ..Terms::default() };
        let (ix, quote) = w.post_quote_ix(m, id, &taker.pubkey(), asset, DIR_B, XMR, amount, &terms, &[0; 32], &[0; 64], w.now() + 60);
        ok(w.send(&[ix], &[&op]));
        let (fx, raw) = w.prepare_open_for(m, taker, asset, DIR_B, XMR, Source::Quote(quote, op.pubkey()), rand16());
        (w.send_open(&fx, &raw), fx)
    };
    assert_err(big_take(&mut w, &mut m, u64::MAX, 500).0, "OpenCapExceeded");
    assert_err(big_take(&mut w, &mut m, u64::MAX, 1).0, "OpenCapExceeded");
    ok(w.set_caps(false, [0; 2], [0; 2]));
    assert_err(big_take(&mut w, &mut m, u64::MAX, 500).0, "MathOverflow");
    // The largest take that fits: amount + floor(amount × 5%) == u64::MAX exactly?  The largest
    // amount with amount + deposit <= u64::MAX.
    let amount = 17_568_327_689_247_192_014u64; // + its 5% (878,416,384,462,359,600) = u64::MAX - 1
    let deposit = (amount as u128 * 500 / 10_000) as u64;
    assert!(amount.checked_add(deposit).is_some() && (amount + 2).checked_add(((amount + 2) as u128 * 500 / 10_000) as u64).is_none());
    let (res, fx) = big_take(&mut w, &mut m, amount, 500);
    ok(res);
    assert_eq!(w.open_value(asset), amount + deposit);
    // Nothing else fits beside it, with the switch off (the add is checked, never wrapping)...
    assert_err(big_take(&mut w, &mut m, 1_000_000, 100).0, "MathOverflow");
    // ...and with it on, under caps of u64::MAX.
    ok(w.set_caps(true, [u64::MAX; 2], [u64::MAX; 2]));
    assert_err(big_take(&mut w, &mut m, 1_000_000, 100).0, "OpenCapExceeded");
    assert_eq!(w.open_value(asset), amount + deposit, "refused opens add nothing");
    // It leaves, and the value is zero again: one subtraction of exactly what was added.
    let taker = fx.taker.insecure_clone();
    ok(w.call(&m, &fx, &Call::CancelPending, &taker));
    assert_eq!(w.open_value(asset), 0);

    // The subtraction saturates and cannot fail an exit: a record whose open value is (by
    // whatever accident) below the swap's counted value still lets the swap out, at zero.
    for direction in [DIR_A, DIR_B] {
        let (m, fx) = w.swap_at(ASSET_SOL, direction, &Terms::default(), Stage::Noticed);
        let config = w.config;
        w.patch(&config, |d| d[172..180].copy_from_slice(&5u64.to_le_bytes()));
        let (signer, secret) = if direction == DIR_A {
            (fx.session.insecure_clone(), fx.s_t)
        } else {
            (m.operator.insecure_clone(), w.maker_secret(&m, &fx))
        };
        ok(w.call(&m, &fx, &Call::Refund(secret), &signer));
        assert_eq!(w.open_value(ASSET_SOL), 0);
        assert_eq!(w.swap(&fx.pda).unwrap().flags & FLAG_COUNTED, 0, "counted once, uncounted once");
    }
}

#[test]
fn the_counted_flag_follows_the_open_states() {
    for asset in ASSETS {
        let mut w = World::new();
        // PENDING, ACTIVE, NOTICED, READY, ABORTED_*: counted. HOLD, WITHHELD, DONE: not.
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms { mode: 1, ..Terms::default() }, Stage::Opened);
        let flags = |w: &World, fx: &SwapFx| w.swap(&fx.pda).unwrap().flags & FLAG_COUNTED;
        assert_eq!((w.swap(&fx.pda).unwrap().state, flags(&w, &fx), w.open_value(asset)), (PENDING, FLAG_COUNTED, AMOUNT));
        let mut m = m;
        let mut fx = fx;
        ok(w.approve(&mut m, &fx));
        ok(w.notice(&m, &mut fx));
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Abort, &op));
        assert_eq!((w.swap(&fx.pda).unwrap().state, flags(&w, &fx), w.open_value(asset)), (ABORTED_FREE, FLAG_COUNTED, AMOUNT));
        let (m2, fx2) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        assert_eq!(w.open_value(asset), 2 * AMOUNT);
        let session = fx2.session.insecure_clone();
        ok(w.call(&m2, &fx2, &Call::Refund(fx2.s_t), &session));
        assert_eq!((w.swap(&fx2.pda).unwrap().state, flags(&w, &fx2), w.open_value(asset)), (HOLD, 0, AMOUNT));
        let op2 = m2.operator.insecure_clone();
        ok(w.call(&m2, &fx2, &Call::Withhold(fx2.notice), &op2));
        assert_eq!((w.swap(&fx2.pda).unwrap().state, flags(&w, &fx2), w.open_value(asset)), (WITHHELD, 0, AMOUNT));
        w.warp(SPLIT_SECS);
        let stranger = w.stranger.insecure_clone();
        ok(w.call(&m2, &fx2, &Call::SplitDeposit, &stranger));
        assert_eq!((w.swap(&fx2.pda).unwrap().state, flags(&w, &fx2), w.open_value(asset)), (DONE, 0, AMOUNT));
        // The first swap, still ABORTED_FREE two months later, leaves through its refund at expiry.
        let t = w.swap(&fx.pda).unwrap().t_exp().max(w.now());
        w.set_time(t);
        let taker = fx.taker.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
        assert_eq!((flags(&w, &fx), w.open_value(asset)), (0, 0));
    }
}
