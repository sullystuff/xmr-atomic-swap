//! Happy paths end to end, both directions and both assets, with the fee, the session-key sweep
//! and the events checked by hand (the vector replay covers the same paths against the model).
use crate::common::*;
use solana_signer::Signer;

#[test]
fn direction_a_sol_lock_notice_ready_claim() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let price = 150 * SOL / 100; // 1.5 SOL per XMR
    w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), price);

    let payout_before = w.lamports(&m.payout.pubkey());
    let treasury_before = w.lamports(&w.treasury);
    let fx = w.open(&m, ASSET_SOL, DIR_A, XMR);
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.amount, s.deposit, s.mode), (ACTIVE, 1_500_000_000, 15_000_000, 0));
    assert_eq!(w.lamports(&fx.pda), w.rent(SWAP_LEN) + 1_500_000_000);
    assert_eq!(w.lamports(&fx.session.pubkey()), w.rent(0) + 2_000_000);

    let mut fx = fx;
    w.warp(90);
    ok(w.notice(&m, &mut fx));
    w.warp(600);
    ok(w.ready(&m, &fx));
    w.warp(60);
    let secret = w.maker_secret(&m, &fx);
    let op = m.operator.insecure_clone();
    let res = ok(w.call(&m, &fx, &Call::Claim(secret), &op));
    println!("claim (SOL, A): {} CU", res.compute_units_consumed);

    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.outcome, s.revealed), (DONE, 8, secret));
    assert_eq!(w.lamports(&m.payout.pubkey()) - payout_before, 1_500_000_000 - 750_000);
    assert_eq!(w.lamports(&w.treasury) - treasury_before, 750_000);
    assert_eq!(w.lamports(&fx.pda), w.rent(SWAP_LEN));
    let claimed = logged_events(&res, "Claimed");
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0][..32], fx.pda.to_bytes());
    assert_eq!(claimed[0][64], 8); // counter: completed

    // The taker reads the revealed share, then closes the account with its session key: rent
    // and the session key's leftover lamports return to the taker.
    let taker_before = w.lamports(&fx.taker.pubkey());
    let session_before = w.lamports(&fx.session.pubkey());
    let session = fx.session.insecure_clone();
    ok(w.call(&m, &fx, &Call::CloseSwap, &session));
    assert!(w.swap(&fx.pda).is_none());
    assert_eq!(w.lamports(&fx.session.pubkey()), 0);
    assert_eq!(w.lamports(&fx.taker.pubkey()) - taker_before, w.rent(SWAP_LEN) + session_before - FEE);
}

#[test]
fn direction_b_usdc_take_fund_notice_ready_claim() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let price = 150_000_000; // 150 USDC per XMR
    w.live_offer(&mut m, ASSET_USDC, DIR_B, &Terms::default(), price);

    let mut fx = w.open(&m, ASSET_USDC, DIR_B, 2 * XMR);
    let taker_ata = w.ata(&fx.taker.pubkey());
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.amount, s.deposit), (PENDING, 300_000_000, 3_000_000));
    assert_eq!(w.tokens(&fx.vault), 3_000_000);
    let taker_tokens = w.tokens(&taker_ata);

    w.warp(12);
    ok(w.fund_swap(&mut m, &fx));
    assert_eq!(w.tokens(&fx.vault), 303_000_000);
    w.warp(90);
    ok(w.notice(&m, &mut fx));
    w.warp(600);
    ok(w.ready(&m, &fx));
    w.warp(60);
    let session = fx.session.insecure_clone();
    let res = ok(w.call(&m, &fx, &Call::Claim(fx.s_t), &session));
    println!("claim (USDC, B): {} CU", res.compute_units_consumed);

    // amount − fee + Dp to the taker; fee = floor(300 USDC × 5 / 10,000) = 0.15 USDC.
    assert_eq!(w.tokens(&taker_ata) - taker_tokens, 300_000_000 - 150_000 + 3_000_000);
    assert_eq!(w.tokens(&w.treasury_vault), 150_000);
    assert_eq!(w.tokens(&fx.vault), 0);
    assert_eq!(w.lamports(&fx.session.pubkey()), 0, "the claim swept the session key");
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.outcome, s.revealed, s.flags), (DONE, 8, fx.s_t, 0b101));
    let mk = w.maker(&m.pda);
    assert_eq!(mk.counters[8], 1);
    assert_eq!(mk.volume, [0, 300_000_000]);
    assert_eq!(mk.response_secs_sum, 12);
}
