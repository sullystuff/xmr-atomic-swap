//! Amount arithmetic as the program performs it (SPEC 3.1, 3.7): `amounts.json` replayed
//! through real instructions, and the 0.05% fee with its rounding on real claims.
//!
//! * `pay` (direction A, round up) is a `lock`; `receive` (direction B, round down) is a `take`.
//! * `bps` is the deposit a quote's `dep_bps` produces, and for 5 bps also the fee of a claim.
//! * `split` is a real withheld deposit split after 60 days.
//! * `tier` is the depth (and, with the same thresholds, the price) a lock picks.
//!
//! Vector cases whose inputs do not fit the program's `u64` fields (a price or an amount above
//! 2^64, used for the Ethereum column and for intermediate-width checks) cannot be encoded in an
//! instruction at all; they are counted, not skipped silently.
use crate::common::*;
use serde_json::Value;
use solana_signer::Signer;

fn wide() -> Terms {
    Terms { min_xmr: 0, max_xmr: u64::MAX, dep_bps: 0, ..Terms::default() }
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

struct Market {
    w: World,
    m: MakerFx,
    next_slot: u8,
}

fn market(terms_a: &Terms, terms_b: &Terms) -> Market {
    let mut w = World::new();
    let m = w.register_maker();
    ok(w.set_offer(&m, ASSET_USDC, DIR_A, terms_a));
    ok(w.set_offer(&m, ASSET_USDC, DIR_B, terms_b));
    Market { w, m, next_slot: 0 }
}

/// Lock (A) or take (B) `xmr` at `price` on USDC; the taker can afford anything.
fn open_at(k: &mut Market, direction: u8, xmr: u64, prices: [u64; 3]) -> (SwapFx, TxResult) {
    ok(k.w.refresh(&k.m, &[(ASSET_USDC, direction, true, prices, u64::MAX)]));
    if direction == DIR_A {
        // One fresh pool key per lock.
        ok(k.w.refill(&mut k.m, ASSET_USDC, k.next_slot % 16, 1));
        k.next_slot += 1;
    }
    let offer = k.w.offer_pda(&k.m.pda, ASSET_USDC, direction);
    let (fx, mut raw) = k.w.prepare_open(&k.m, ASSET_USDC, direction, xmr, Source::Offer(offer));
    let ata = k.w.ata(&fx.taker.pubkey());
    k.w.set_tokens(&ata, u64::MAX);
    raw.key_hint = (k.next_slot.wrapping_sub(1)) % 16;
    let res = k.w.send_open(&fx, &raw);
    (fx, res)
}

#[test]
fn amounts_json_pay_and_receive() {
    let v = vectors("amounts");
    let mut k = market(&wide(), &wide());
    let (mut replayed, mut overflow, mut unrepresentable) = (0, 0, 0);
    for case in v["cases"].as_array().unwrap() {
        let i = &case["input"];
        let op = i["op"].as_str().unwrap();
        if (op != "pay" && op != "receive") || i["chain"] != "solana" {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let price = u128_of(&i["price"]);
        if price > u64::MAX as u128 {
            // Not encodable: the offer's price field is a u64. The vector agrees it overflows.
            assert_eq!(case["error"], "MathOverflow", "{name}");
            unrepresentable += 1;
            continue;
        }
        let direction = if op == "pay" { DIR_A } else { DIR_B };
        let (fx, res) = open_at(&mut k, direction, num(&i["xmr"]), [price as u64, 0, 0]);
        if case["valid"].as_bool().unwrap() {
            ok(res);
            let s = k.w.swap(&fx.pda).unwrap();
            assert_eq!(s.amount, num(&case["output"]["amount"]), "{name}");
            assert_eq!(s.price, price as u64, "{name}");
            if direction == DIR_A {
                assert_eq!(k.w.tokens(&fx.vault), s.amount, "{name}: exactly the amount is escrowed");
            }
            replayed += 1;
        } else {
            assert!(is_err(&res, case["error"].as_str().unwrap()), "{name}: {}", err_string(&res));
            assert!(k.w.swap(&fx.pda).is_none());
            overflow += 1;
        }
    }
    println!("amounts.json pay/receive (solana): {replayed} amounts, {overflow} overflows, {unrepresentable} not encodable in u64");
    assert_eq!((replayed, overflow, unrepresentable), (18, 4, 4));
}

#[test]
fn pay_is_bounded_by_max_pay_and_receive_by_min_receive() {
    let mut k = market(&wide(), &wide());
    // 1/3 XMR at 3 units per XMR: A pays ceil(0.99…) = 1, B receives floor = 0.
    let third = 333_333_333_333;
    ok(k.w.refresh(&k.m, &[(ASSET_USDC, DIR_A, true, [3, 0, 0], u64::MAX), (ASSET_USDC, DIR_B, true, [3, 0, 0], u64::MAX)]));
    ok(k.w.refill(&mut k.m, ASSET_USDC, 0, 2));
    let offer_a = k.w.offer_pda(&k.m.pda, ASSET_USDC, DIR_A);
    let offer_b = k.w.offer_pda(&k.m.pda, ASSET_USDC, DIR_B);
    let (fx, mut raw) = k.w.prepare_open(&k.m, ASSET_USDC, DIR_A, third, Source::Offer(offer_a));
    raw.limit = 0;
    assert_err(k.w.send_open(&fx, &raw), "PriceMoved");
    raw.limit = 1;
    ok(k.w.send_open(&fx, &raw));
    assert_eq!(k.w.swap(&fx.pda).unwrap().amount, 1);

    let (fx, mut raw) = k.w.prepare_open(&k.m, ASSET_USDC, DIR_B, third, Source::Offer(offer_b));
    raw.limit = 1;
    assert_err(k.w.send_open(&fx, &raw), "PriceMoved");
    raw.limit = 0;
    ok(k.w.send_open(&fx, &raw));
    assert_eq!(k.w.swap(&fx.pda).unwrap().amount, 0);
}

/// A quote for exactly `amount` with `dep_bps`, taken (direction B) or locked (direction A).
fn open_quote(w: &mut World, m: &mut MakerFx, asset: u8, direction: u8, amount: u64, dep_bps: u16) -> SwapFx {
    let taker = w.fund(if asset == ASSET_SOL { amount.saturating_add(10 * SOL) } else { 10 * SOL });
    if asset == ASSET_USDC {
        // Exactly what the taker has to put in: the amount (A) or the take deposit (B).
        let ata = w.mint_to(&taker.pubkey(), 1);
        let needs = if direction == DIR_A { amount } else { (amount as u128 * dep_bps as u128 / 10_000) as u64 };
        w.set_tokens(&ata, needs);
    }
    let (share, pok) = if direction == DIR_A {
        let (_, s_pub, pok) = m.new_share();
        (s_pub, pok)
    } else {
        ([0; 32], [0; 64])
    };
    let terms = Terms { dep_bps, ..Terms::default() };
    let id = u64::from_le_bytes(rand32()[..8].try_into().unwrap());
    let (ix, quote) = w.post_quote_ix(m, id, &taker.pubkey(), asset, direction, XMR, amount, &terms, &share, &pok, w.now() + 60);
    let op = m.operator.insecure_clone();
    ok(w.send(&[ix], &[&op]));
    let (fx, raw) = w.prepare_open_for(m, taker, asset, direction, XMR, Source::Quote(quote, op.pubkey()), rand16());
    ok(w.send_open(&fx, &raw));
    fx
}

#[test]
fn amounts_json_bps_as_the_deposit() {
    let v = vectors("amounts");
    let mut w = World::new();
    let mut m = w.register_maker();
    let (mut replayed, mut unrepresentable) = (0, 0);
    for case in v["cases"].as_array().unwrap().iter().filter(|c| c["input"]["op"] == "bps") {
        let i = &case["input"];
        let amount = u128_of(&i["amount"]);
        if amount > u64::MAX as u128 {
            unrepresentable += 1;
            continue;
        }
        let bps = i["bps"].as_u64().unwrap() as u16;
        let fx = open_quote(&mut w, &mut m, ASSET_USDC, DIR_B, amount as u64, bps);
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!(s.deposit, num(&case["output"]["result"]), "{}", case["name"]);
        assert_eq!(w.tokens(&fx.vault), s.deposit, "{}: the take deposit is what was escrowed", case["name"]);
        replayed += 1;
    }
    assert_eq!((replayed, unrepresentable), (8, 2));
}

/// Open for exactly `amount`, post the notice, wait out the claim delay, claim. Returns what the
/// treasury and the claimer received.
fn claim_for(asset: u8, direction: u8, amount: u64) -> (i128, i128, u64) {
    let mut w = World::new();
    let mut m = w.register_maker();
    if asset == ASSET_USDC {
        let ata = w.ata(&m.operator.pubkey());
        w.set_tokens(&ata, amount);
    } else {
        w.svm.airdrop(&m.operator.pubkey(), amount).unwrap();
    }
    let mut fx = open_quote(&mut w, &mut m, asset, direction, amount, 100);
    if direction == DIR_B {
        ok(w.fund_swap(&mut m, &fx));
    }
    ok(w.notice(&m, &mut fx));
    let s = w.swap(&fx.pda).unwrap();
    w.set_time(s.t_claim_open);
    let l = w.ledger(&m, &fx);
    let (signer, secret) = if direction == DIR_A {
        (m.operator.insecure_clone(), w.maker_secret(&m, &fx))
    } else {
        (fx.taker.insecure_clone(), fx.s_t)
    };
    let res = ok(w.call(&m, &fx, &Call::Claim(secret), &signer));
    let moved = l.moved(&w, (direction == DIR_B) as u64, (direction == DIR_A) as u64, false);
    // The event states the same split.
    let ev = &logged_events(&res, "Claimed")[0];
    let paid = u64::from_le_bytes(ev[105..113].try_into().unwrap());
    let fee = u64::from_le_bytes(ev[113..121].try_into().unwrap());
    assert_eq!(fee as i128, moved.treasury);
    let claimer = if direction == DIR_A { moved.payout } else { moved.taker };
    assert_eq!(paid as i128, claimer);
    assert_eq!(w.swap(&fx.pda).unwrap().fee_bps, 5);
    (moved.treasury, claimer, s.deposit)
}

#[test]
fn the_fee_is_floor_of_5_bps_of_the_amount_paid_by_whoever_receives_the_asset() {
    // amounts.json: floor(1999 × 5 / 10^4) = 0, floor(2000 × 5 / 10^4) = 1.
    let v = vectors("amounts");
    let fee_cases: Vec<(u64, u64)> = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["input"]["op"] == "bps" && c["input"]["bps"] == 5 && u128_of(&c["input"]["amount"]) <= u64::MAX as u128)
        .map(|c| (num(&c["input"]["amount"]), num(&c["output"]["result"])))
        .collect();
    assert_eq!(fee_cases, vec![(1_999, 0), (2_000, 1)]);

    let mut amounts: Vec<(u64, u64)> = fee_cases;
    for a in [1u64, 3_999, 4_000, 19_999, 20_000, 1_500_000_000, 1_500_000_077, 999_999_999_999] {
        amounts.push((a, (a as u128 * 5 / 10_000) as u64));
    }
    for (amount, fee) in amounts {
        for asset in [ASSET_SOL, ASSET_USDC] {
            // Direction A: the maker pays the fee out of its payout.
            let (treasury, maker, _) = claim_for(asset, DIR_A, amount);
            assert_eq!((treasury, maker), (fee as i128, (amount - fee) as i128), "A {asset} {amount}");
            // Direction B: the taker pays it, and gets its take deposit back on top.
            let (treasury, taker, deposit) = claim_for(asset, DIR_B, amount);
            assert_eq!((treasury, taker), (fee as i128, (amount - fee + deposit) as i128), "B {asset} {amount}");
        }
    }
    // The largest amounts only exist as tokens.
    let big = 123_456_789_012_345_678u64;
    let (treasury, maker, _) = claim_for(ASSET_USDC, DIR_A, big);
    assert_eq!((treasury, maker), (61_728_394_506_172, (big - 61_728_394_506_172) as i128));
    let (treasury, taker, deposit) = claim_for(ASSET_USDC, DIR_B, u64::MAX / 2);
    let fee = (u64::MAX as u128 / 2 * 5 / 10_000) as i128;
    assert_eq!((treasury, taker), (fee, (u64::MAX / 2) as i128 - fee + deposit as i128));
}

#[test]
fn no_fee_on_refunds_held_deposits_or_pending_exits() {
    for asset in [ASSET_SOL, ASSET_USDC] {
        let treasury_of = |w: &World| if asset == ASSET_USDC { w.tokens(&w.treasury_vault) } else { w.lamports(&w.treasury) };
        let mut w = World::new();
        let before = treasury_of(&w);
        // A pending cancel, a held refund with its release, a free refund, a direction-B backout.
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms { mode: 1, ..Terms::default() }, Stage::Opened);
        let taker = fx.taker.insecure_clone();
        ok(w.call(&m, &fx, &Call::CancelPending, &taker));
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::ReleaseDeposit, &op));
        let (m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Noticed);
        let op = m.operator.insecure_clone();
        let secret = w.maker_secret(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(secret), &op));
        assert_eq!(treasury_of(&w), before, "asset {asset}");
        assert_eq!(w.maker(&m.pda).volume, [0, 0], "refunds add no volume");
    }
}

#[test]
fn amounts_json_split() {
    let v = vectors("amounts");
    let (mut replayed, mut unrepresentable) = (0, 0);
    for case in v["cases"].as_array().unwrap().iter().filter(|c| c["input"]["op"] == "split") {
        let name = case["name"].as_str().unwrap();
        let deposit = u128_of(&case["input"]["deposit"]);
        if deposit > u64::MAX as u128 {
            unrepresentable += 1;
            continue;
        }
        let deposit = deposit as u64;
        let (to_taker, to_treasury) = (num(&case["output"]["to_taker"]), num(&case["output"]["to_treasury"]));
        let mut w = World::new();
        let mut m = w.register_maker();
        // A 1% take deposit of exactly `deposit` where that fits; the u64 maximum is written
        // into a real held swap (no amount has a 1% deposit that large).
        let patched = deposit > u64::MAX / 100;
        let amount = if patched { 1_000 } else { deposit * 100 };
        let fx = open_quote(&mut w, &mut m, ASSET_USDC, DIR_B, amount, 100);
        ok(w.fund_swap(&mut m, &fx));
        let s = w.swap(&fx.pda).unwrap();
        w.set_time(s.t_note_deadline);
        let op = m.operator.insecure_clone();
        let secret = w.maker_secret(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(secret), &op)); // B9b: the deposit is held
        if deposit == 0 {
            // Nothing to hold: the refund settles the swap and there is nothing to split.
            assert_eq!(w.swap(&fx.pda).unwrap().state, DONE, "{name}");
            let stranger = w.stranger.insecure_clone();
            assert_err(w.call(&m, &fx, &Call::SplitDeposit, &stranger), "BadState");
            replayed += 1;
            continue;
        }
        if patched {
            w.patch(&fx.pda, |d| d[206..214].copy_from_slice(&deposit.to_le_bytes()));
            let vault = fx.vault;
            w.set_tokens(&vault, deposit);
            let ata = w.ata(&fx.taker.pubkey());
            w.set_tokens(&ata, 0);
        }
        assert_eq!(w.swap(&fx.pda).unwrap().deposit, deposit, "{name}");
        ok(w.call(&m, &fx, &Call::Withhold(None), &op));
        w.set_time(s.t_note_deadline + SPLIT_SECS);
        let taker_ata = w.ata(&fx.taker.pubkey());
        let taker_before = w.tokens(&taker_ata);
        let stranger = w.stranger.insecure_clone();
        let res = ok(w.call(&m, &fx, &Call::SplitDeposit, &stranger));
        assert_eq!(w.tokens(&taker_ata) - taker_before, to_taker, "{name}: ceil(D/2) to the taker");
        assert_eq!(w.tokens(&w.treasury_vault), to_treasury, "{name}: floor(D/2) to the treasury");
        assert_eq!(w.tokens(&fx.vault), 0, "{name}");
        let ev = &logged_events(&res, "DepositSplit")[0];
        assert_eq!(u64::from_le_bytes(ev[73..81].try_into().unwrap()), to_taker);
        assert_eq!(u64::from_le_bytes(ev[81..89].try_into().unwrap()), to_treasury);
        replayed += 1;
    }
    assert_eq!((replayed, unrepresentable), (7, 1));
}

#[test]
fn amounts_json_tiers_pick_the_depth_and_the_price() {
    let v = vectors("amounts");
    let cases: Vec<&Value> = v["cases"].as_array().unwrap().iter().filter(|c| c["input"]["op"] == "tier").collect();
    assert_eq!(cases.len(), 14);
    let three = |v: &Value| -> [u64; 3] {
        let a = v.as_array().unwrap();
        [num(&a[0]), num(&a[1]), num(&a[2])]
    };
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let (above, values, xmr) = (three(&i["above"]), three(&i["values"]), num(&i["xmr"]));

        // As depth tiers. The claim delay must cover the deepest tier (25 needs 6,015 s).
        let depth_terms = Terms {
            depth_above: above,
            depths: [values[0] as u8, values[1] as u8, values[2] as u8],
            d_c: 6_100,
            ..wide()
        };
        let mut w = World::new();
        let m = w.register_maker();
        let res = w.set_offer(&m, ASSET_USDC, DIR_B, &depth_terms);
        if case["valid"].as_bool().unwrap() {
            ok(res);
            let mut k = Market { w, m, next_slot: 0 };
            let (fx, res) = open_at(&mut k, DIR_B, xmr, [1, 0, 0]);
            ok(res);
            assert_eq!(k.w.swap(&fx.pda).unwrap().depth as u64, num(&case["output"]["value"]), "{name}: depth");
        } else {
            assert!(is_err(&res, "TiersInvalid"), "{name}: depth tiers: {}", err_string(&res));
        }

        // As price tiers: thresholds at set_offer, prices at refresh.
        let price_terms = Terms { price_above: above, ..wide() };
        let mut w = World::new();
        let m = w.register_maker();
        let set = w.set_offer(&m, ASSET_USDC, DIR_B, &price_terms);
        if case["valid"].as_bool().unwrap() {
            ok(set);
            let mut k = Market { w, m, next_slot: 0 };
            let (fx, res) = open_at(&mut k, DIR_B, xmr, values);
            ok(res);
            let s = k.w.swap(&fx.pda).unwrap();
            let value = num(&case["output"]["value"]);
            assert_eq!(s.price, value, "{name}: price");
            assert_eq!(s.amount as u128, xmr as u128 * value as u128 / 1_000_000_000_000, "{name}");
        } else if set.is_ok() {
            let res = w.refresh(&m, &[(ASSET_USDC, DIR_B, true, values, u64::MAX)]);
            assert!(is_err(&res, "TiersInvalid"), "{name}: price tiers: {}", err_string(&res));
        } else {
            assert!(is_err(&set, "TiersInvalid"), "{name}: price thresholds: {}", err_string(&set));
        }
    }
}
