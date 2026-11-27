//! SPEC 3.12: `approve`, `fund` and `reject` are bound to the lock they act on. A taker can
//! replace a pending lock with another at the same PDA (cancel, then lock again with the same
//! nonce); the maker's transaction, built for the first lock, must then fail with `BadState`.
use crate::common::*;
use solana_signer::Signer;

const ASSETS: [u8; 2] = [ASSET_SOL, ASSET_USDC];

fn window() -> Terms {
    Terms { mode: 1, ..Terms::default() }
}

/// Open, remember the open hash, cancel, and open again at the same PDA after `change`.
fn relock(
    w: &mut World,
    m: &MakerFx,
    asset: u8,
    direction: u8,
    change: &dyn Fn(&mut World, &mut OpenRaw, &mut SwapFx),
) -> (SwapFx, [u8; 32]) {
    let offer = w.offer_pda(&m.pda, asset, direction);
    let (fx, raw) = w.prepare_open(m, asset, direction, XMR, Source::Offer(offer));
    ok(w.send_open(&fx, &raw));
    let first = w.swap(&fx.pda).unwrap();
    let stale = first.open_hash(&fx.pda);
    let taker = fx.taker.insecure_clone();
    ok(w.call(m, &fx, &Call::CancelPending, &taker));
    assert!(w.swap(&fx.pda).is_none(), "the cancel closed the account");

    let mut fx = fx;
    let mut raw = raw;
    change(w, &mut raw, &mut fx);
    ok(w.send_open(&fx, &raw));
    let second = w.swap(&fx.pda).unwrap();
    assert_eq!(second.state, PENDING);
    assert_ne!(second.open_hash(&fx.pda), stale, "the open hash changed with the lock");
    (fx, stale)
}

type Change = (&'static str, fn(&mut World, &mut OpenRaw, &mut SwapFx));

fn changes() -> Vec<Change> {
    vec![
        ("a different size", |_, raw, fx| {
            raw.xmr = 2 * XMR;
            fx.xmr = 2 * XMR;
        }),
        ("a different spend commitment", |_, raw, fx| {
            let (s, s_pub) = new_share();
            raw.spend_pub = s_pub;
            raw.pok = pok_prove(&s, &fx.pda.to_bytes());
            fx.s_t = s;
            fx.s_pub_t = s_pub;
        }),
        ("a different encryption key", |_, raw, _| raw.enc_key = rand32()),
        ("the same lock, one second later", |w, _, _| w.warp(1)),
    ]
}

#[test]
fn approve_and_reject_carrying_the_hash_of_a_replaced_lock_fail_with_bad_state() {
    for asset in ASSETS {
        for (name, change) in changes() {
            let mut w = World::new();
            let mut m = w.register_maker();
            w.live_offer(&mut m, asset, DIR_A, &window(), PRICE);
            let (fx, stale) = relock(&mut w, &m, asset, DIR_A, &change);
            let op = m.operator.insecure_clone();
            let (_, share, pok) = m.new_share();
            assert_err(w.call(&m, &fx, &Call::Approve { open: stale, share, pok }, &op), "BadState");
            assert_err(w.call(&m, &fx, &Call::Reject { open: stale, reason: 0 }, &op), "BadState");
            assert_eq!(w.swap(&fx.pda).unwrap().state, PENDING, "{name}");
            // With the hash of the lock that is actually there, the same calls work.
            ok(w.approve(&mut m, &fx));
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.xmr), (ACTIVE, fx.xmr), "{name}");
        }
        // A different view share (direction A only: it is the locker's view share).
        let mut w = World::new();
        let mut m = w.register_maker();
        w.live_offer(&mut m, asset, DIR_A, &window(), PRICE);
        let (fx, stale) = relock(&mut w, &m, asset, DIR_A, &|_, raw, _| raw.view = new_view());
        let op = m.operator.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::Reject { open: stale, reason: 1 }, &op), "BadState");
        let open = w.swap(&fx.pda).unwrap().open_hash(&fx.pda);
        ok(w.call(&m, &fx, &Call::Reject { open, reason: 1 }, &op));
        assert_eq!(w.maker(&m.pda).counters[32], 1, "rejections_no_fault");
        assert_eq!(w.maker(&m.pda).counters[3], 0);
    }
}

#[test]
fn fund_carrying_the_hash_of_a_replaced_take_fails_with_bad_state() {
    for asset in ASSETS {
        for (name, change) in changes() {
            let mut w = World::new();
            let mut m = w.register_maker();
            w.live_offer(&mut m, asset, DIR_B, &Terms::default(), PRICE);
            let (fx, stale) = relock(&mut w, &m, asset, DIR_B, &change);
            let op = m.operator.insecure_clone();
            let operator_before = if asset == ASSET_USDC { w.tokens(&w.ata(&op.pubkey())) } else { w.lamports(&op.pubkey()) };
            let (_, share, pok) = m.new_share();
            assert_err(w.call(&m, &fx, &Call::Fund { open: stale, share, pok, view: new_view(), watcher: None }, &op), "BadState");
            // The maker's money did not move into an escrow whose terms it never saw.
            let operator_after = if asset == ASSET_USDC { w.tokens(&w.ata(&op.pubkey())) } else { w.lamports(&op.pubkey()) + FEE };
            assert_eq!(operator_before, operator_after, "{name}");
            ok(w.fund_swap(&mut m, &fx));
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.xmr), (ACTIVE, fx.xmr), "{name}");
        }
    }
}

#[test]
fn the_open_hash_covers_what_the_maker_checked() {
    let mut w = World::new();
    let mut m = w.register_maker();
    w.live_offer(&mut m, ASSET_SOL, DIR_A, &window(), PRICE);
    let fx = w.open(&m, ASSET_SOL, DIR_A, XMR);
    let s = w.swap(&fx.pda).unwrap();
    let op = m.operator.insecure_clone();
    let base = s.open_hash(&fx.pda);
    // Every single-field variation of the hash input is refused.
    // A direction-A lock with no watcher: payout and watcher are zeros in the hash.
    let z = [0u8; 32];
    let variants: Vec<[u8; 32]> = vec![
        open_hash_of(&[1; 32], s.t_lock, 0, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock + 1, 0, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 1, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 1, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr + 1, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount + 1, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount, s.deposit + 1, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount, s.deposit, &[2; 32], &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &[3; 32], &s.taker_enc_key, &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &[4; 32], &s.maker_enc_key, &z, &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &[5; 32], &z, &z),
        // The payout address and the watcher are covered too (SPEC 11.2, 11.6).
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &[6; 32], &z),
        open_hash_of(&fx.pda.to_bytes(), s.t_lock, 0, 0, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, &z, &[7; 32]),
        [0; 32],
    ];
    for (i, open) in variants.iter().enumerate() {
        assert_ne!(*open, base);
        let (_, share, pok) = m.new_share();
        let res = w.call(&m, &fx, &Call::Approve { open: *open, share, pok }, &op);
        assert!(is_err(&res, "BadState"), "variant {i}: {}", err_string(&res));
    }
    // The stored maker key is the one of the version the taker named: it is in the hash too.
    assert_eq!(s.maker_enc_key, m.enc_key);
    let (_, share, pok) = m.new_share();
    ok(w.call(&m, &fx, &Call::Approve { open: base, share, pok }, &op));
    // Once ACTIVE the hash no longer opens anything: approve and reject are pending-only.
    let (_, share, pok) = m.new_share();
    assert_err(w.call(&m, &fx, &Call::Approve { open: base, share, pok }, &op), "BadState");
    assert_err(w.call(&m, &fx, &Call::Reject { open: base, reason: 0 }, &op), "BadState");
    let _ = fx.taker.pubkey();
}
