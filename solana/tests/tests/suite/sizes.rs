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
    /// SPEC 4.10's hand-computed figure.
    spec: (usize, usize),
    /// What this transaction really is, where the hand count is off.
    measured: Option<(usize, usize)>,
    cu: Option<u64>,
}

fn measure(w: &mut World, name: &'static str, spec: (usize, usize), ixs: Vec<Instruction>, signer: &Keypair, run: bool) -> Row {
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
    Row { name, keys, bytes, spec, measured: None, cu }
}

#[test]
fn every_transaction_of_spec_4_10_fits_one_legacy_transaction() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let mut m2 = w.register_maker();
    let advance = Terms { mode: 2, ..Terms::default() };
    for asset in [ASSET_SOL, ASSET_USDC] {
        for maker in [&mut m, &mut m2] {
            w.live_offer(maker, asset, DIR_A, &Terms::default(), PRICE);
            ok(w.refill(maker, asset, 2, 8));
            w.live_offer(maker, asset, DIR_B, &Terms::default(), PRICE);
        }
    }
    let mut rows = vec![];
    let offer = |w: &World, m: &MakerFx, asset: u8| Source::Offer(w.offer_pda(&m.pda, asset, DIR_A));

    // lock, SOL, against an offer.
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, offer(&w, &m, ASSET_SOL));
    let ix = w.open_ix(&raw);
    rows.push(measure(&mut w, "lock, SOL, offer", (9, 683), vec![ix], &fx.taker, true));
    // lock, USDC, against an offer.
    let (fx, raw) = w.prepare_open(&m, ASSET_USDC, DIR_A, XMR, offer(&w, &m, ASSET_USDC));
    let ix = w.open_ix(&raw);
    rows.push(measure(&mut w, "lock, USDC, offer", (13, 811), vec![ix], &fx.taker, true));
    let usdc_swap = fx;

    // lock, USDC, against a Quote account.
    let taker = w.fund(100 * SOL);
    w.mint_to(&taker.pubkey(), 10_000_000_000);
    let (_, share, pok) = m.new_share();
    let (ix, quote) = w.post_quote_ix(&m, 5, &taker.pubkey(), ASSET_USDC, DIR_A, XMR, PRICE, &Terms::default(), &share, &pok, w.now() + 60);
    let op = m.operator.insecure_clone();
    ok(w.send(&[ix], &[&op]));
    let (fx, raw) = w.prepare_open_for(&m, taker, ASSET_USDC, DIR_A, XMR, Source::Quote(quote, op.pubkey()), rand16());
    let ix = w.open_ix(&raw);
    let mut row = measure(&mut w, "lock, USDC, quote", (15, 875), vec![ix], &fx.taker, true);
    // SPEC 4.10 counts 15 keys. A lock against a quote drops the offer and adds the quote and
    // its rent receiver: 13 − 1 + 2 = 14 keys, 843 bytes (solana/DEVIATIONS.md).
    row.measured = Some((14, 843));
    rows.push(row);

    // lock with an advance approval: the Ed25519 instruction is index 2, after the two
    // compute-budget instructions.
    ok(w.set_offer(&m, ASSET_SOL, DIR_A, &advance));
    ok(w.set_offer(&m, ASSET_USDC, DIR_A, &advance));
    ok(w.refresh(&m, &[(ASSET_SOL, DIR_A, true, [PRICE, 0, 0], 1_000 * XMR), (ASSET_USDC, DIR_A, true, [PRICE, 0, 0], 1_000 * XMR)]));
    for (asset, name, spec) in [(ASSET_SOL, "lock, SOL, advance approval", (11, 1_054)), (ASSET_USDC, "lock, USDC, advance approval", (15, 1_182))] {
        let (fx, mut raw) = w.prepare_open(&m, asset, DIR_A, XMR, offer(&w, &m, asset));
        raw.approval_ix = Some(2);
        raw.sysvar = Some(IX_SYSVAR);
        let ed = w.approval_ix(&m, &fx.taker.pubkey(), asset, DIR_A, XMR);
        assert_eq!(ed.data.len(), 302, "the Ed25519 instruction data (306 with its framing)");
        let ix = w.open_ix(&raw);
        rows.push(measure(&mut w, name, spec, vec![ed, ix], &fx.taker, true));
        assert_eq!(w.swap(&fx.pda).unwrap().mode, 2);
    }

    // Two locks, two makers, one taker (the large-swap tool).
    for (asset, name, spec, fits) in [
        (ASSET_SOL, "two locks, SOL, two makers", (13, 1_084), true),
        (ASSET_USDC, "two locks, USDC, two makers", (18, 1_244), false),
    ] {
        let taker = w.fund(100 * SOL);
        if asset == ASSET_USDC {
            w.mint_to(&taker.pubkey(), 10_000_000_000);
        }
        // Maker one's offers are ADVANCE now; use B-side makers' auto offers: maker two and a third.
        let mut m3 = w.register_maker();
        w.live_offer(&mut m3, asset, DIR_A, &Terms::default(), PRICE);
        let (fx_a, raw_a) = w.prepare_open_for(&m2, taker.insecure_clone(), asset, DIR_A, XMR, offer(&w, &m2, asset), rand16());
        let (_, raw_b) = w.prepare_open_for(&m3, taker.insecure_clone(), asset, DIR_A, XMR, offer(&w, &m3, asset), rand16());
        let ixs = vec![w.open_ix(&raw_a), w.open_ix(&raw_b)];
        let row = measure(&mut w, name, spec, ixs, &fx_a.taker, fits);
        assert_eq!(row.bytes <= LIMIT, fits, "{name}: {} bytes", row.bytes);
        rows.push(row);
    }

    // claim, USDC (the Settle list).
    let mut fx = usdc_swap;
    w.warp(90);
    ok(w.notice(&m, &mut fx));
    w.warp(600);
    ok(w.ready(&m, &fx));
    let secret = w.maker_secret(&m, &fx);
    let claim = w.call_ix(&m, &fx, &Call::Claim(secret), &op.pubkey());
    rows.push(measure(&mut w, "claim, USDC", (16, 691), vec![claim], &op, true));

    // refresh_offers: four offers and four Ethereum quotes in one transaction.
    for slot in 0..4u8 {
        let ix = w.set_eth_quote_ix(&m, slot, &[slot; 251], &[slot; 65]);
        ok(w.send(&[ix], &[&op]));
    }
    let offers: Vec<_> = [(ASSET_SOL, DIR_A), (ASSET_SOL, DIR_B), (ASSET_USDC, DIR_A), (ASSET_USDC, DIR_B)]
        .iter()
        .map(|(a, d)| (*a, *d, true, [PRICE, 0, 0], 100 * XMR))
        .collect();
    let eth: Vec<_> = (0..4u8).map(|s| (s, [1u128 << 100, 2, 3], 1_900_000_000u64, 42 + s as u64, [0xee; 65])).collect();
    let refresh = w.refresh_full_ix(&m, &offers, &eth);
    rows.push(measure(&mut w, "refresh_offers, 4 offers + 4 ETH quotes", (9, 1_097), vec![refresh], &op, true));

    // refill_keys, eight slots. (Slots 2..10 of maker two's SOL offer hold unused keys: use the
    // free ones above them is not possible with 8, so refill a fresh offer.)
    let mut m4 = w.register_maker();
    ok(w.set_offer(&m4, ASSET_SOL, DIR_A, &Terms::default()));
    let slots: Vec<_> = (0..8u8)
        .map(|i| {
            let (_, s_pub, pok) = m4.new_share();
            (i, s_pub, pok)
        })
        .collect();
    let refill = w.refill_ix(&m4, ASSET_SOL, &slots);
    let op4 = m4.operator.insecure_clone();
    rows.push(measure(&mut w, "refill_keys, 8 slots", (5, 1_078), vec![refill], &op4, true));

    // post_message: a 900-byte payload naming a swap.
    let mut payload = vec![0x58, 0x53];
    payload.resize(900, 7);
    let sender = w.fund(SOL);
    let msg = w.post_message_ix(&sender.pubkey(), &m.pda, Some(fx.pda), &payload);
    rows.push(measure(&mut w, "post_message, 900 bytes, with a swap", (5, 1_201), vec![msg], &sender, true));

    println!("{:<44} {:>5} {:>6} {:>10} {:>8}", "transaction", "keys", "bytes", "SPEC 4.10", "CU");
    for r in &rows {
        println!(
            "{:<44} {:>5} {:>6} {:>10} {:>8}",
            r.name,
            r.keys,
            r.bytes,
            format!("{}/{}", r.spec.0, r.spec.1),
            r.cu.map(|c| c.to_string()).unwrap_or_else(|| "does not fit".into())
        );
    }
    // The limit holds for every transaction SPEC 4.10 says fits, and the measured figures are
    // the hand-computed ones.
    for r in &rows {
        assert_eq!((r.keys, r.bytes), r.measured.unwrap_or(r.spec), "{}", r.name);
    }
    let largest = rows.iter().filter(|r| r.cu.is_some()).map(|r| r.bytes).max().unwrap();
    assert_eq!(largest, 1_201);
}

#[test]
fn take_is_33_bytes_smaller_than_lock_and_instruction_data_has_the_documented_length() {
    let mut w = World::new();
    let mut m = w.register_maker();
    w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    w.live_offer(&mut m, ASSET_SOL, DIR_B, &Terms::default(), PRICE);
    let (fx_a, raw_a) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(w.offer_pda(&m.pda, ASSET_SOL, DIR_A)));
    let (fx_b, raw_b) = w.prepare_open(&m, ASSET_SOL, DIR_B, XMR, Source::Offer(w.offer_pda(&m.pda, ASSET_SOL, DIR_B)));
    let (lock, take) = (w.open_ix(&raw_a), w.open_ix(&raw_b));
    // LockArgs: 247 bytes (248 with an approval). TakeArgs: 214 (215). Plus the discriminator.
    assert_eq!(lock.data.len(), 8 + 247);
    assert_eq!(take.data.len(), 8 + 214);
    let mut with_approval = raw_a.clone();
    with_approval.approval_ix = Some(0);
    assert_eq!(w.open_ix(&with_approval).data.len(), 8 + 248);
    let size = |ix: &Instruction, payer: &Keypair| {
        let mut all = compute_budget_ixs().to_vec();
        all.push(ix.clone());
        tx_size(&all, &payer.pubkey(), 1)
    };
    assert_eq!(size(&lock, &fx_a.taker) - size(&take, &fx_b.taker), 33);
    assert_eq!(lock.accounts.len(), 14);
    assert_eq!(take.accounts.len(), 14);
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
        assert!(*c < 150_000, "{name}: {c} CU");
    }
    // The secret checks themselves are cheap; a claim or refund is dominated by the transfers.
    assert!(cu("claim (A) (SOL)") < 30_000);
    assert!(cu("claim (A) (USDC)") < 60_000);
    assert!(cu("refund (A, session key, held) (SOL)") < 30_000);
    assert!(cu("lock, offer, ACTIVE (SOL)") < 60_000);
    assert!(cu("lock + advance approval (USDC)") < 120_000);
}
