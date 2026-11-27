//! Transaction sizes against the 1,232-byte limit (SPEC 4.10) and compute units of the main
//! instructions (SPEC 4.9). Every transaction in the table is built with one signature and the
//! two compute-budget instructions the SDK always adds, measured, and (where it fits) executed.
use crate::common::*;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;

const LIMIT: usize = 1_232;

struct Row {
    name: &'static str,
    keys: usize,
    bytes: usize,
    /// The figure this test pins: `(account keys, bytes)`.
    want: (usize, usize),
    /// What SPEC 4.10 / 11.6 says, where it gives a figure that differs.
    spec: Option<usize>,
    cu: Option<u64>,
}

fn measure(w: &mut World, name: &'static str, want: (usize, usize), ixs: Vec<Instruction>, signer: &Keypair, run: bool) -> Row {
    let mut all = compute_budget_ixs().to_vec();
    all.extend(ixs);
    let msg = Message::new(&all, Some(&signer.pubkey()));
    let bytes = tx_size(&all, &signer.pubkey(), 1);
    let keys = msg.account_keys.len();
    let cu = if run {
        assert!(bytes <= LIMIT, "{name}: {bytes} bytes");
        Some(ok(w.send(&all, &[signer])).compute_units_consumed)
    } else {
        None
    };
    Row { name, keys, bytes, want, spec: None, cu }
}

/// Every transaction of SPEC 4.10, as Amendment 1 left it, and every instruction the amendment
/// grew or added (SPEC 11.6 "Transaction size"), measured and executed.
#[test]
fn every_transaction_fits_one_legacy_transaction() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let mut m2 = w.register_maker();
    // Offers with a freeze window, so a watcher can be named.
    let watched = Terms { w_z: 86_400, ..Terms::default() };
    let advance = Terms { mode: 2, ..watched.clone() };
    for asset in [ASSET_SOL, ASSET_USDC] {
        for maker in [&mut m, &mut m2] {
            w.live_offer(maker, asset, DIR_A, &watched, PRICE);
            ok(w.refill(maker, asset, 2, 8));
            w.live_offer(maker, asset, DIR_B, &watched, PRICE);
        }
    }
    let watcher = w.fund(SOL);
    let op = m.operator.insecure_clone();
    let mut rows = vec![];
    let offer = |w: &World, m: &MakerFx, asset: u8, direction: u8| Source::Offer(w.offer_pda(&m.pda, asset, direction));

    // lock against an offer, without and with a watcher.
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, offer(&w, &m, ASSET_SOL, DIR_A));
    let ix = w.open_ix(&raw);
    rows.push(measure(&mut w, "lock, SOL, offer", (9, 684), vec![ix], &fx.taker, true));
    let (fx, raw) = w.prepare_open(&m, ASSET_USDC, DIR_A, XMR, offer(&w, &m, ASSET_USDC, DIR_A));
    let ix = w.open_ix(&raw);
    rows.push(measure(&mut w, "lock, USDC, offer", (13, 812), vec![ix], &fx.taker, true));
    let usdc_swap = fx;
    let (fx, mut raw) = w.prepare_open(&m, ASSET_USDC, DIR_A, XMR, offer(&w, &m, ASSET_USDC, DIR_A));
    raw.watcher = Some(watcher.pubkey());
    let ix = w.open_ix(&raw);
    rows.push(measure(&mut w, "lock, USDC, offer, watcher", (13, 844), vec![ix], &fx.taker, true));
    let watched_swap = fx;

    // lock, USDC, against a Quote account.
    let taker = w.fund(100 * SOL);
    w.mint_to(&taker.pubkey(), 10_000_000_000);
    let (_, share, pok) = m.new_share();
    let (ix, quote) = w.post_quote_ix(&m, 5, &taker.pubkey(), ASSET_USDC, DIR_A, XMR, PRICE, &watched, &share, &pok, w.now() + 60);
    rows.push(measure(&mut w, "post_quote", (6, 515), vec![ix], &op, true));
    let (fx, raw) = w.prepare_open_for(&m, taker, ASSET_USDC, DIR_A, XMR, Source::Quote(quote, op.pubkey()), rand16());
    let ix = w.open_ix(&raw);
    let mut row = measure(&mut w, "lock, USDC, quote", (14, 844), vec![ix], &fx.taker, true);
    row.spec = Some(875 + 1); // SPEC 4.10 counts 15 keys; it is 14 (13 - offer + quote + receiver)
    rows.push(row);

    // take: the payout address is 32 bytes of data and no account.
    let (fx, mut raw) = w.prepare_open(&m, ASSET_USDC, DIR_B, XMR, offer(&w, &m, ASSET_USDC, DIR_B));
    raw.payout = Keypair::new().pubkey();
    let ix = w.open_ix(&raw);
    rows.push(measure(&mut w, "take, USDC, offer, payout address", (13, 810), vec![ix], &fx.taker, true));
    // fund, naming the maker's watcher; the taker's notice follows at once.
    let mut fx = fx;
    let open = w.swap(&fx.pda).unwrap().open_hash(&fx.pda);
    let (_, share, pok) = m.new_share();
    let op = m.operator.insecure_clone();
    let fund = w.call_ix(&m, &fx, &Call::Fund { open, share, pok, view: new_view(), watcher: Some(watcher.pubkey()) }, &op.pubkey());
    rows.push(measure(&mut w, "fund, USDC, watcher", (11, 688), vec![fund], &op, true));
    fx.payout = w.swap(&fx.pda).unwrap().payout;
    ok(w.notice(&m, &mut fx));
    let take_swap = fx;

    // With an advance approval: the Ed25519 instruction is index 2, after the two compute-budget
    // instructions. The largest single-swap transaction is the USDC lock with a watcher.
    for (asset, direction) in [(ASSET_SOL, DIR_A), (ASSET_USDC, DIR_A), (ASSET_USDC, DIR_B)] {
        ok(w.set_offer(&m, asset, direction, &advance));
        ok(w.refresh(&m, &[(asset, direction, true, [PRICE, 0, 0], 1_000 * XMR)]));
    }
    for (asset, direction, named, name, want, spec) in [
        (ASSET_SOL, DIR_A, false, "lock, SOL, advance approval", (11, 1_055), None),
        (ASSET_USDC, DIR_A, false, "lock, USDC, advance approval", (15, 1_183), None),
        (ASSET_USDC, DIR_A, true, "lock, USDC, advance approval, watcher", (15, 1_215), Some(1_215)),
        (ASSET_USDC, DIR_B, false, "take, USDC, advance approval, payout", (15, 1_181), None),
    ] {
        let (fx, mut raw) = w.prepare_open(&m, asset, direction, XMR, offer(&w, &m, asset, direction));
        raw.approval_ix = Some(2);
        raw.sysvar = Some(IX_SYSVAR);
        if named {
            raw.watcher = Some(watcher.pubkey());
        }
        if direction == DIR_B {
            raw.payout = Keypair::new().pubkey();
        }
        let ed = w.approval_ix(&m, &fx.taker.pubkey(), asset, direction, XMR);
        assert_eq!(ed.data.len(), 302, "the Ed25519 instruction data (306 with its framing)");
        let ix = w.open_ix(&raw);
        let mut row = measure(&mut w, name, want, vec![ed, ix], &fx.taker, true);
        row.spec = spec;
        rows.push(row);
        assert_eq!(w.swap(&fx.pda).unwrap().mode, 2);
    }

    // Two locks, two makers, one taker (the large-swap tool), each naming the watcher.
    for (asset, name, want, fits) in [
        (ASSET_SOL, "two locks, SOL, two makers, watchers", (13, 1_150), true),
        (ASSET_USDC, "two locks, USDC, two makers, watchers", (18, 1_310), false),
    ] {
        let taker = w.fund(100 * SOL);
        if asset == ASSET_USDC {
            w.mint_to(&taker.pubkey(), 10_000_000_000);
        }
        let mut m3 = w.register_maker();
        w.live_offer(&mut m3, asset, DIR_A, &watched, PRICE);
        let (fx_a, mut raw_a) = w.prepare_open_for(&m2, taker.insecure_clone(), asset, DIR_A, XMR, offer(&w, &m2, asset, DIR_A), rand16());
        let (_, mut raw_b) = w.prepare_open_for(&m3, taker.insecure_clone(), asset, DIR_A, XMR, offer(&w, &m3, asset, DIR_A), rand16());
        raw_a.watcher = Some(watcher.pubkey());
        raw_b.watcher = Some(watcher.pubkey());
        let ixs = vec![w.open_ix(&raw_a), w.open_ix(&raw_b)];
        let mut row = measure(&mut w, name, want, ixs, &fx_a.taker, fits);
        if asset == ASSET_SOL {
            row.spec = Some(1_150);
        }
        assert_eq!(row.bytes <= LIMIT, fits, "{name}: {} bytes", row.bytes);
        rows.push(row);
    }

    // freeze (the Short list), by the watcher.
    let mut fx = watched_swap;
    w.warp(90);
    ok(w.notice(&m, &mut fx));
    let ix = w.call_ix(&m, &fx, &Call::Freeze, &watcher.pubkey());
    rows.push(measure(&mut w, "freeze", (6, 329), vec![ix], &watcher, true));
    assert_eq!(w.swap(&fx.pda).unwrap().state, FROZEN);

    // claim, USDC, direction A (the Settle list plus the three payout slots).
    let mut fx = usdc_swap;
    ok(w.notice(&m, &mut fx));
    w.warp(600);
    ok(w.ready(&m, &fx));
    let secret = w.maker_secret(&m, &fx);
    let claim = w.call_ix(&m, &fx, &Call::Claim(secret), &op.pubkey());
    rows.push(measure(&mut w, "claim, USDC, direction A", (16, 694), vec![claim], &op, true));

    // The taker's claim to a payout address that has no token account yet: the session key
    // pays for it (the associated-token program is passed).
    let fx = take_swap;
    ok(w.ready(&m, &fx));
    let session = fx.session.insecure_clone();
    w.svm.airdrop(&session.pubkey(), 3_000_000).unwrap(); // the rent of the token account it will create
    let mut claim = w.call_ix(&m, &fx, &Call::Claim(fx.s_t), &session.pubkey());
    claim.accounts[S_ATA_PROGRAM] = meta(ATA_PROGRAM, false, false);
    rows.push(measure(&mut w, "claim, USDC, direction B, creating the payout account", (19, 790), vec![claim], &session, true));
    assert_eq!(w.tokens(&w.ata(&fx.payout)), 1_500_000_000 - 750_000 + 15_000_000);

    // set_caps.
    let admin = w.admin.insecure_clone();
    let ix = w.set_caps_ix(&admin.pubkey(), true, [u64::MAX; 2], [u64::MAX; 2]);
    rows.push(measure(&mut w, "set_caps", (4, 296), vec![ix], &admin, true));

    // refresh_offers: four offers and four Ethereum quotes in one transaction.
    for slot in 0..4u8 {
        let ix = w.set_eth_quote_ix(&m, slot, &[slot; 255], &[slot; 65]);
        if slot == 0 {
            rows.push(measure(&mut w, "set_eth_quote", (6, 651), vec![ix], &op, true));
        } else {
            ok(w.send(&[ix], &[&op]));
        }
    }
    let offers: Vec<_> = [(ASSET_SOL, DIR_A), (ASSET_SOL, DIR_B), (ASSET_USDC, DIR_A), (ASSET_USDC, DIR_B)]
        .iter()
        .map(|(a, d)| (*a, *d, true, [PRICE, 0, 0], 100 * XMR))
        .collect();
    let eth: Vec<_> = (0..4u8).map(|s| (s, [1u128 << 100, 2, 3], 1_900_000_000u64, 42 + s as u64, [0xee; 65])).collect();
    let refresh = w.refresh_full_ix(&m, &offers, &eth);
    rows.push(measure(&mut w, "refresh_offers, 4 offers + 4 ETH quotes", (9, 1_097), vec![refresh], &op, true));

    // set_offer (4 bytes longer: w_z) and refill_keys, eight slots.
    let mut m4 = w.register_maker();
    let op4 = m4.operator.insecure_clone();
    let ix = w.set_offer_ix(&m4, ASSET_SOL, DIR_A, &watched);
    rows.push(measure(&mut w, "set_offer", (6, 429), vec![ix], &op4, true));
    let slots: Vec<_> = (0..8u8)
        .map(|i| {
            let (_, s_pub, pok) = m4.new_share();
            (i, s_pub, pok)
        })
        .collect();
    let refill = w.refill_ix(&m4, ASSET_SOL, &slots);
    rows.push(measure(&mut w, "refill_keys, 8 slots", (5, 1_078), vec![refill], &op4, true));

    // post_message: a 900-byte payload naming a swap.
    let mut payload = vec![0x58, 0x53];
    payload.resize(900, 7);
    let sender = w.fund(SOL);
    let msg = w.post_message_ix(&sender.pubkey(), &m.pda, Some(fx.pda), &payload);
    rows.push(measure(&mut w, "post_message, 900 bytes, with a swap", (5, 1_201), vec![msg], &sender, true));

    println!("{:<56} {:>5} {:>6} {:>8} {:>8}", "transaction", "keys", "bytes", "SPEC", "CU");
    for r in &rows {
        println!(
            "{:<56} {:>5} {:>6} {:>8} {:>8}",
            r.name,
            r.keys,
            r.bytes,
            r.spec.map(|b| b.to_string()).unwrap_or_default(),
            r.cu.map(|c| c.to_string()).unwrap_or_else(|| "does not fit".into())
        );
    }
    for r in &rows {
        assert_eq!((r.keys, r.bytes), r.want, "{}", r.name);
    }
    // Everything that is sent alone fits; the largest is the USDC lock with an approval and a
    // watcher.
    let largest = rows.iter().filter(|r| r.cu.is_some()).max_by_key(|r| r.bytes).unwrap();
    assert_eq!(largest.name, "lock, USDC, advance approval, watcher");
    assert!(largest.bytes <= LIMIT);
}

#[test]
fn instruction_data_has_the_documented_length() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let watched = Terms { w_z: 3_600, ..Terms::default() };
    w.live_offer(&mut m, ASSET_SOL, DIR_A, &watched, PRICE);
    w.live_offer(&mut m, ASSET_SOL, DIR_B, &watched, PRICE);
    let (fx_a, raw_a) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(w.offer_pda(&m.pda, ASSET_SOL, DIR_A)));
    let (fx_b, raw_b) = w.prepare_open(&m, ASSET_SOL, DIR_B, XMR, Source::Offer(w.offer_pda(&m.pda, ASSET_SOL, DIR_B)));
    let (lock, take) = (w.open_ix(&raw_a), w.open_ix(&raw_b));
    // LockArgs: 248 bytes, +1 with an approval, +32 with a watcher. TakeArgs: 246 (the payout
    // address is always there), +1 with an approval. Plus the 8-byte discriminator.
    assert_eq!(lock.data.len(), 8 + 248);
    assert_eq!(take.data.len(), 8 + 246);
    let mut r = raw_a.clone();
    r.approval_ix = Some(0);
    assert_eq!(w.open_ix(&r).data.len(), 8 + 249);
    r.watcher = Some(Keypair::new().pubkey());
    assert_eq!(w.open_ix(&r).data.len(), 8 + 249 + 32);
    let mut r = raw_b.clone();
    r.approval_ix = Some(0);
    assert_eq!(w.open_ix(&r).data.len(), 8 + 247);
    let size = |ix: &Instruction, payer: &Keypair| {
        let mut all = compute_budget_ixs().to_vec();
        all.push(ix.clone());
        tx_size(&all, &payer.pubkey(), 1)
    };
    assert_eq!(size(&lock, &fx_a.taker) - size(&take, &fx_b.taker), 2);
    assert_eq!(lock.accounts.len(), 14);
    assert_eq!(take.accounts.len(), 14);
    // claim and withdraw_owed carry the three payout slots.
    let fx = w.open(&m, ASSET_SOL, DIR_A, XMR);
    let op = m.operator.pubkey();
    assert_eq!(w.call_ix(&m, &fx, &Call::Claim([0; 32]), &op).accounts.len(), 17);
    assert_eq!(w.call_ix(&m, &fx, &Call::WithdrawOwed(0), &op).accounts.len(), 17);
    assert_eq!(w.call_ix(&m, &fx, &Call::Refund([0; 32]), &op).accounts.len(), 14);
    assert_eq!(w.call_ix(&m, &fx, &Call::Freeze, &op).accounts.len(), 4);
}

/// Compute units of each instruction on its common path. PDA bump searches make the totals
/// vary by address, so these are ceilings, with the measurements printed.
#[test]
fn compute_units_of_the_main_instructions() {
    let mut table: Vec<(String, u64)> = vec![];
    for asset in [ASSET_SOL, ASSET_USDC] {
        let tag = if asset == ASSET_SOL { "SOL" } else { "USDC" };
        let mut w = World::new();
        let mut m = w.register_maker();
        let op = m.operator.insecure_clone();
        let mut note = |name: &str, res: TxResult| {
            let cu = ok(res).compute_units_consumed;
            table.push((format!("{name} ({tag})"), cu));
            cu
        };

        note("set_offer (create)", w.set_offer(&m, asset, DIR_A, &Terms::default()));
        note("refresh_offers (1)", w.refresh(&m, &[(asset, DIR_A, true, [PRICE, 0, 0], 100 * XMR)]));
        note("refill_keys (8)", w.refill(&mut m, asset, 0, 8));
        w.live_offer(&mut m, asset, DIR_B, &Terms::default(), PRICE);

        // Direction A, the happy path.
        let offer = w.offer_pda(&m.pda, asset, DIR_A);
        let (mut fx, raw) = w.prepare_open(&m, asset, DIR_A, XMR, Source::Offer(offer));
        note("lock, offer, ACTIVE", w.send_open(&fx, &raw));
        w.warp(90);
        note("post_notice", w.notice(&m, &mut fx));
        w.warp(600);
        note("set_ready", w.ready(&m, &fx));
        let secret = w.maker_secret(&m, &fx);
        note("claim (A)", w.call(&m, &fx, &Call::Claim(secret), &op));
        let session = fx.session.insecure_clone();
        note("close_swap", w.call(&m, &fx, &Call::CloseSwap, &session));

        // Direction A with an approval, then a refund, a withhold and a split.
        ok(w.refresh(&m, &[(asset, DIR_A, true, [PRICE, 0, 0], 100 * XMR)]));
        let (mut fx, mut raw) = w.prepare_open(&m, asset, DIR_A, XMR, Source::Offer(offer));
        raw.approval_ix = Some(0);
        raw.sysvar = Some(IX_SYSVAR);
        let ed = w.approval_ix(&m, &fx.taker.pubkey(), asset, DIR_A, XMR);
        let res = w.send(&[ed, w.open_ix(&raw)], &[&fx.taker]);
        note("lock + advance approval", res);
        w.warp(90);
        ok(w.notice(&m, &mut fx));
        let session = fx.session.insecure_clone();
        note("refund (A, session key, held)", w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        note("withhold (evidence)", w.call(&m, &fx, &Call::Withhold(fx.notice), &op));
        w.warp(SPLIT_SECS);
        let stranger = w.stranger.insecure_clone();
        note("split_deposit", w.call(&m, &fx, &Call::SplitDeposit, &stranger));

        // Window mode: approve, reject.
        ok(w.set_offer(&m, asset, DIR_A, &Terms { mode: 1, ..Terms::default() }));
        ok(w.refresh(&m, &[(asset, DIR_A, true, [PRICE, 0, 0], 100 * XMR)]));
        let fx = w.open(&m, asset, DIR_A, XMR);
        note("approve", w.approve(&mut m, &fx));
        let fx = w.open(&m, asset, DIR_A, XMR);
        let open = w.swap(&fx.pda).unwrap().open_hash(&fx.pda);
        note("reject (closes)", w.call(&m, &fx, &Call::Reject { open, reason: 0 }, &op));

        // Direction B.
        ok(w.refresh(&m, &[(asset, DIR_B, true, [PRICE, 0, 0], 100 * XMR)]));
        let offer_b = w.offer_pda(&m.pda, asset, DIR_B);
        let (mut fx, raw) = w.prepare_open(&m, asset, DIR_B, XMR, Source::Offer(offer_b));
        note("take", w.send_open(&fx, &raw));
        note("fund", w.fund_swap(&mut m, &fx));
        w.warp(90);
        ok(w.notice(&m, &mut fx));
        w.warp(600);
        ok(w.ready(&m, &fx));
        let session = fx.session.insecure_clone();
        note("claim (B, session key)", w.call(&m, &fx, &Call::Claim(fx.s_t), &session));
        let fx = w.swap_with(&mut m, asset, DIR_B, &Terms::default(), Stage::Active);
        let secret = w.maker_secret(&m, &fx);
        note("refund (B, free)", w.call(&m, &fx, &Call::Refund(secret), &op));
    }
    println!("{:<44} {:>8}", "instruction", "CU");
    for (name, cu) in &table {
        println!("{name:<44} {cu:>8}");
    }
    let cu = |name: &str| table.iter().find(|(n, _)| n == name).unwrap().1;
    // Everything runs inside the default 200,000 CU of one instruction, with room.
    for (name, c) in &table {
        assert!(*c < 200_000, "{name}: {c} CU");
    }
    // The secret checks themselves are cheap; a claim or refund is dominated by the transfers.
    assert!(cu("claim (A) (SOL)") < 30_000);
    assert!(cu("claim (A) (USDC)") < 60_000);
    assert!(cu("refund (A, session key, held) (SOL)") < 30_000);
    assert!(cu("lock, offer, ACTIVE (SOL)") < 90_000);
    assert!(cu("lock + advance approval (USDC)") < 120_000);
}
