//! The deposit sub-machine (SPEC 3.6): hold, withhold, release, the 60-day split, burn mode,
//! and its four invariants.
use crate::common::*;
use solana_signer::Signer;

const AMOUNT: u64 = 1_500_000_000;
const D: u64 = 15_000_000;
const ASSETS: [u8; 2] = [ASSET_SOL, ASSET_USDC];

/// A direction-A swap refunded after a notice (row 4): HOLD, deposit `D` in escrow.
fn held_a(w: &mut World, asset: u8) -> (MakerFx, SwapFx) {
    let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
    let session = fx.session.insecure_clone();
    ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
    assert_eq!(w.swap(&fx.pda).unwrap().state, HOLD);
    (m, fx)
}

/// A direction-B swap the maker refunded after the taker posted no notice (B9b): HOLD.
fn held_b(w: &mut World, asset: u8) -> (MakerFx, SwapFx) {
    let (m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Active);
    let s = w.swap(&fx.pda).unwrap();
    w.set_time(s.t_note_deadline);
    let op = m.operator.insecure_clone();
    let s_m = w.maker_secret(&m, &fx);
    ok(w.call(&m, &fx, &Call::Refund(s_m), &op));
    assert_eq!(w.swap(&fx.pda).unwrap().state, HOLD);
    (m, fx)
}

#[test]
fn hold_ends_after_30_minutes_and_the_operator_may_release_earlier() {
    for asset in ASSETS {
        for held in [held_a, held_b] {
            // Anyone, from T_hold.
            let mut w = World::new();
            let (m, fx) = held(&mut w, asset);
            let s = w.swap(&fx.pda).unwrap();
            let stranger = w.stranger.insecure_clone();
            w.set_time(s.t_refund + HOLD_SECS - 1);
            assert_err(w.call(&m, &fx, &Call::ReleaseDeposit, &stranger), "TooEarly");
            w.set_time(s.t_refund + HOLD_SECS);
            let l = w.ledger(&m, &fx);
            ok(w.call(&m, &fx, &Call::ReleaseDeposit, &stranger));
            assert_eq!(l.moved(&w, 0, 0, false), Moved::taker(D));
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.deposit_state, s.outcome), (DONE, 3, 28));
            assert_eq!(w.maker(&m.pda).counters[28], 1);

            // The operator, before T_hold.
            let mut w = World::new();
            let (m, fx) = held(&mut w, asset);
            let op = m.operator.insecure_clone();
            let l = w.ledger(&m, &fx);
            ok(w.call(&m, &fx, &Call::ReleaseDeposit, &op));
            assert_eq!(l.moved(&w, 0, 1, false), Moved::taker(D));
            assert_eq!(w.swap(&fx.pda).unwrap().deposit_state, 3);
        }
    }
}

#[test]
fn withhold_is_refused_at_or_after_t_hold_even_if_nobody_cranked_the_release() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = held_a(&mut w, asset);
        let s = w.swap(&fx.pda).unwrap();
        let op = m.operator.insecure_clone();
        let evidence = Call::Withhold(fx.notice);
        // Only the operator.
        for other in [fx.taker.insecure_clone(), fx.session.insecure_clone(), m.owner.insecure_clone(), w.stranger.insecure_clone()] {
            if w.lamports(&other.pubkey()) == 0 {
                w.svm.airdrop(&other.pubkey(), SOL).unwrap();
            }
            assert_err(w.call(&m, &fx, &evidence, &other), "Unauthorized");
        }
        // The last second of the hold works (probe), the first second after does not: the
        // taker never races the maker.
        w.set_time(s.t_refund + HOLD_SECS - 1);
        ok(w.would(&m, &fx, &evidence, &op));
        w.set_time(s.t_refund + HOLD_SECS);
        assert_err(w.call(&m, &fx, &evidence, &op), "TooLate");
        w.set_time(s.t_refund + HOLD_SECS + 86_400);
        assert_err(w.call(&m, &fx, &evidence, &op), "TooLate");
        assert_eq!(w.swap(&fx.pda).unwrap().state, HOLD);
    }
}

#[test]
fn evidence_is_demanded_only_where_the_maker_posted_a_notice() {
    for asset in ASSETS {
        // Direction A after a notice: covered row by row in refund_table. Direction A with no
        // notice on record (row 3): no evidence exists to demand.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Active);
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Withhold(None), &op));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.flags & 0b10), (WITHHELD, 0));

        // Direction B: the notice (if any) is the taker's; the maker has nothing to open, and
        // anything it supplies is ignored.
        let mut w = World::new();
        let (m, fx) = held_b(&mut w, asset);
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Withhold(Some((rand32(), new_view()))), &op));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.flags & 0b10, s.evidence_txid), (WITHHELD, 2, 0, [0; 32]));
        assert_eq!(w.maker(&m.pda).counters[29], 1);
        assert_eq!(w.maker(&m.pda).withheld_volume[asset as usize], D);
    }
}

#[test]
fn a_withheld_deposit_is_released_by_the_operator_only_or_split_after_60_days() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = held_a(&mut w, asset);
        let s = w.swap(&fx.pda).unwrap();
        let op = m.operator.insecure_clone();
        let stranger = w.stranger.insecure_clone();
        let taker = fx.taker.insecure_clone();
        // Withheld in the last second of the hold: T_split is still counted from the refund.
        w.set_time(s.t_refund + HOLD_SECS - 1);
        ok(w.call(&m, &fx, &Call::Withhold(fx.notice), &op));

        // Nobody but the operator can release it, at any time.
        w.set_time(s.t_refund + HOLD_SECS + 10);
        assert_err(w.call(&m, &fx, &Call::ReleaseDeposit, &stranger), "Unauthorized");
        assert_err(w.call(&m, &fx, &Call::ReleaseDeposit, &taker), "Unauthorized");
        // The split opens exactly SPLIT_SECS after the refund.
        w.set_time(s.t_refund + SPLIT_SECS - 1);
        assert_err(w.call(&m, &fx, &Call::SplitDeposit, &stranger), "TooEarly");
        ok(w.would(&m, &fx, &Call::ReleaseDeposit, &op));
        w.set_time(s.t_refund + SPLIT_SECS);
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::SplitDeposit, &stranger));
        assert_eq!(l.moved(&w, 0, 0, false), Moved { taker: (D / 2) as i128, treasury: (D / 2) as i128, ..Moved::default() });
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.outcome), (DONE, 5, 31));

        // Released on request instead.
        let mut w = World::new();
        let (m, fx) = held_a(&mut w, asset);
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Withhold(fx.notice), &op));
        w.warp(3 * 86_400);
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::ReleaseDeposit, &op));
        assert_eq!(l.moved(&w, 0, 1, false), Moved::taker(D));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.outcome), (DONE, 4, 30));
        let mk = w.maker(&m.pda);
        assert_eq!((mk.counters[29], mk.counters[30], mk.counters[31]), (1, 1, 0));
    }
}

#[test]
fn no_call_can_pay_the_deposit_to_the_maker() {
    for asset in ASSETS {
        let usdc = asset == ASSET_USDC;
        let mut w = World::new();
        let (m, fx) = held_a(&mut w, asset);
        let s = w.swap(&fx.pda).unwrap();
        let op = m.operator.insecure_clone();
        let operator_wallet = m.operator.pubkey();
        let operator_token = w.ata(&operator_wallet);

        // release_deposit: the taker and its token account are pinned to the swap.
        let mut ix = w.call_ix(&m, &fx, &Call::ReleaseDeposit, &operator_wallet);
        ix.accounts[S_TAKER].pubkey = operator_wallet;
        assert_err(w.send(&[ix], &[&op]), "Unauthorized");
        if usdc {
            let mut ix = w.call_ix(&m, &fx, &Call::ReleaseDeposit, &operator_wallet);
            ix.accounts[S_TAKER_TOKEN].pubkey = operator_token;
            assert_err(w.send(&[ix], &[&op]), "Unauthorized");
        }
        // The operator cannot pull it as an "owed" amount either: nothing is owed to the maker.
        let owner = m.owner.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::WithdrawOwed(1), &owner), "NothingOwed");
        assert_err(w.call(&m, &fx, &Call::WithdrawOwed(0), &op), "Unauthorized");
        // A second refund or a claim of a refunded swap does not exist.
        assert_err(w.call(&m, &fx, &Call::Claim(w.maker_secret(&m, &fx)), &op), "BadState");

        // split_deposit: the treasury half goes to the treasury, never to a wallet the caller
        // names. A wrong account in a treasury slot does not fail the split (SPEC 11.1: an
        // admin flipping `split_mode` must not be able to): the half is parked for the treasury,
        // and what the operator named receives nothing. (Probed, not committed.)
        ok(w.call(&m, &fx, &Call::Withhold(fx.notice), &op));
        w.set_time(s.t_refund + SPLIT_SECS);
        let before = (w.lamports(&operator_wallet), w.tokens(&operator_token));
        let mut ix = w.call_ix(&m, &fx, &Call::SplitDeposit, &operator_wallet);
        if usdc {
            ix.accounts[S_TREASURY_VAULT].pubkey = operator_token;
        } else {
            ix.accounts[S_TREASURY].pubkey = operator_wallet;
        }
        let res = ok(w.simulate(&[ix], &[&op]));
        let parked = logged_events(&res, "PayoutParked");
        assert_eq!(parked.len(), 1);
        assert_eq!((parked[0][73], u64::from_le_bytes(parked[0][74..82].try_into().unwrap())), (2, D / 2));
        assert_eq!(before, (w.lamports(&operator_wallet), w.tokens(&operator_token)));
        if usdc {
            // The taker's own account stays pinned.
            let mut ix = w.call_ix(&m, &fx, &Call::SplitDeposit, &operator_wallet);
            ix.accounts[S_TAKER_TOKEN].pubkey = operator_token;
            assert_err(w.send(&[ix], &[&op]), "Unauthorized");
        }
        // Through the whole life of the deposit the maker's wallets received none of it.
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::SplitDeposit, &op));
        let moved = l.moved(&w, 0, 1, false);
        assert_eq!((moved.operator, moved.payout), (0, 0));
        assert_eq!(moved.taker + moved.treasury, D as i128);
    }
}

#[test]
fn fault_and_free_refunds_never_enter_hold() {
    // A10d, A10e, A10f, A10g; B9a, B9c, B9g. (A7a and A8 close the account outright.)
    type Drive = fn(&mut World, &MakerFx, &mut SwapFx);
    let cases: Vec<(&str, u8, Stage, Drive)> = vec![
        ("A10d", DIR_A, Stage::Noticed, |w, m, fx| {
            let op = m.operator.insecure_clone();
            ok(w.call(m, fx, &Call::Abort, &op));
        }),
        ("A10e", DIR_A, Stage::Ready, |w, _, fx| {
            let t = w.swap(&fx.pda).unwrap().t_claim_deadline;
            w.set_time(t);
        }),
        ("A10f", DIR_A, Stage::Ready, |w, _, fx| {
            let t = w.swap(&fx.pda).unwrap().t_exp();
            w.set_time(t);
        }),
        ("A10g", DIR_A, Stage::Active, |w, _, fx| {
            let t = w.swap(&fx.pda).unwrap().t_note_deadline;
            w.set_time(t);
        }),
        ("B9a", DIR_B, Stage::Active, |_, _, _| {}),
        ("B9c", DIR_B, Stage::Noticed, |_, _, _| {}),
        ("B9g", DIR_B, Stage::Ready, |w, _, fx| {
            let t = w.swap(&fx.pda).unwrap().t_exp();
            w.set_time(t);
        }),
    ];
    for asset in ASSETS {
        for (name, direction, stage, drive) in &cases {
            let mut w = World::new();
            let (m, mut fx) = w.swap_at(asset, *direction, &Terms::default(), *stage);
            drive(&mut w, &m, &mut fx);
            let locker = if *direction == DIR_A { fx.taker.insecure_clone() } else { m.operator.insecure_clone() };
            let secret = w.locker_secret(&m, &fx);
            let l = w.ledger(&m, &fx);
            ok(w.call(&m, &fx, &Call::Refund(secret), &locker));
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.deposit_state), (DONE, 0), "{name}: settled, the deposit was never held");
            // The taker's deposit is back with the taker in the same instruction.
            let moved = l.moved(&w, (*direction == DIR_A) as u64, (*direction == DIR_B) as u64, false);
            if *direction == DIR_A {
                assert_eq!(moved, Moved::taker(AMOUNT), "{name}");
            } else {
                assert_eq!(moved, Moved { operator: AMOUNT as i128, taker: D as i128, ..Moved::default() }, "{name}");
            }
            // So a maker that was provably late, or that backed out, cannot withhold.
            let op = m.operator.insecure_clone();
            assert_err(w.call(&m, &fx, &Call::Withhold(fx.notice), &op), "BadState");
            assert_eq!(w.maker(&m.pda).counters[29], 0, "{name}");
        }
    }
}

fn mint_supply(w: &World) -> u64 {
    u64::from_le_bytes(w.data(&w.mint)[36..44].try_into().unwrap())
}

#[test]
fn burn_mode_destroys_the_treasury_half_of_a_split_and_nothing_else() {
    // SOL: the incinerator.
    let mut w = World::with(sha256(&[b"burn"]), 1);
    let (m, fx) = held_a(&mut w, ASSET_SOL);
    let s = w.swap(&fx.pda).unwrap();
    let op = m.operator.insecure_clone();
    let stranger = w.stranger.insecure_clone();
    ok(w.call(&m, &fx, &Call::Withhold(fx.notice), &op));
    w.set_time(s.t_refund + SPLIT_SECS);
    // The Treasury PDA is not the destination of a burned half: given it, the split would park
    // that half (it does not fail, SPEC 11.1) and the Treasury PDA would receive nothing.
    let res = ok(w.would(&m, &fx, &Call::SplitDeposit, &stranger));
    assert_eq!(logged_events(&res, "PayoutParked").len(), 1);
    let treasury_before = w.lamports(&w.treasury);
    let taker_before = w.lamports(&fx.taker.pubkey());
    let mut ix = w.call_ix(&m, &fx, &Call::SplitDeposit, &stranger.pubkey());
    ix.accounts[S_TREASURY].pubkey = INCINERATOR;
    ok(w.send(&[ix], &[&stranger]));
    assert_eq!(w.lamports(&fx.taker.pubkey()) - taker_before, D - D / 2);
    assert_eq!(w.lamports(&INCINERATOR), D / 2);
    assert_eq!(w.lamports(&w.treasury), treasury_before);
    assert_eq!(w.swap(&fx.pda).unwrap().owed_treasury, 0);

    // USDC: burned by the token program, signed by the swap PDA.
    let mut w = World::with(sha256(&[b"burn"]), 1);
    let (m, fx) = held_a(&mut w, ASSET_USDC);
    let s = w.swap(&fx.pda).unwrap();
    let op = m.operator.insecure_clone();
    let stranger = w.stranger.insecure_clone();
    ok(w.call(&m, &fx, &Call::Withhold(fx.notice), &op));
    w.set_time(s.t_refund + SPLIT_SECS);
    let supply = mint_supply(&w);
    let taker_ata = w.ata(&fx.taker.pubkey());
    let taker_before = w.tokens(&taker_ata);
    ok(w.call(&m, &fx, &Call::SplitDeposit, &stranger));
    assert_eq!(supply - mint_supply(&w), D / 2, "the treasury half no longer exists");
    assert_eq!(w.tokens(&taker_ata) - taker_before, D - D / 2);
    assert_eq!(w.tokens(&w.treasury_vault), 0);
    assert_eq!(w.tokens(&fx.vault), 0);

    // Fees are not a split: in burn mode a claim still pays the treasury.
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Ready);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    ok(w.call(&m, &fx, &Call::Claim(secret), &op));
    assert_eq!(w.tokens(&w.treasury_vault), 750_000);
}

#[test]
fn publish_evidence_is_the_claimers_and_must_open_the_commitment() {
    for asset in ASSETS {
        // Direction A: the operator, in any state once a notice is on record, including DONE.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Active);
        let op = m.operator.insecure_clone();
        let (txid, view) = (rand32(), new_view());
        assert_err(w.call(&m, &fx, &Call::PublishEvidence(txid, view), &op), "BadState");
        let mut fx = fx;
        w.warp(90);
        ok(w.notice(&m, &mut fx));
        let (txid, view) = fx.notice.unwrap();
        let session = fx.session.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::PublishEvidence(txid, view), &session), "Unauthorized");
        assert_err(w.call(&m, &fx, &Call::PublishEvidence(view, txid), &op), "EvidenceMismatch");
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        ok(w.call(&m, &fx, &Call::ReleaseDeposit, &op));
        assert_eq!(w.swap(&fx.pda).unwrap().state, DONE);
        let res = ok(w.call(&m, &fx, &Call::PublishEvidence(txid, view), &op));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.evidence_txid, s.evidence_view, s.flags & 0b10, s.state), (txid, view, 0b10, DONE));
        assert_eq!(logged_events(&res, "EvidencePublished").len(), 1);
        assert_eq!(w.maker(&m.pda).counters.iter().sum::<u32>(), 4, "lock, notice, refund, release: evidence moves no counter");

        // Direction B: the taker (wallet or session key).
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Noticed);
        let (txid, view) = fx.notice.unwrap();
        let op = m.operator.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::PublishEvidence(txid, view), &op), "Unauthorized");
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::PublishEvidence(txid, view), &session));
        assert_eq!(w.swap(&fx.pda).unwrap().flags & 0b10, 0b10);
    }
}

#[test]
fn notice_json_commitments_and_the_binding_to_the_swap() {
    let v = vectors("notice");
    assert_eq!(v["ciphertext_len"], 104);
    let mut checked = 0;
    for case in v["cases"].as_array().unwrap() {
        let (i, out) = (&case["input"], &case["output"]);
        let (Some(txid), Some(commitment)) = (i.get("txid"), out.get("commitment")) else { continue };
        let (txid, view, swap_ref) = (h32(txid), h32(&i["view"]), h32(&i["swap_ref"]));
        // The harness's formula is the vectors'.
        assert_eq!(
            notice_commitment(&solana_pubkey::Pubkey::new_from_array(swap_ref), &txid, &view),
            h32(commitment),
            "{}",
            case["name"]
        );
        let Some(ct) = out.get("ciphertext") else {
            checked += 1;
            continue;
        };
        let ct: [u8; 104] = h(ct).try_into().unwrap();

        // On-chain the commitment is over this swap's PDA. Post the vector's opening and
        // ciphertext for a real swap, refund, and withhold with it.
        let mut w = World::new();
        let (m, mut fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Active);
        let op = m.operator.insecure_clone();
        let real = notice_commitment(&fx.pda, &txid, &view);
        ok(w.call(&m, &fx, &Call::PostNotice { commitment: real, ct }, &op));
        fx.notice = Some((txid, view));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.notice_commitment, s.notice_ct.as_slice()), (real, &ct[..]), "the notice is account state");
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        ok(w.would(&m, &fx, &Call::Withhold(Some((txid, view))), &op));

        // The same opening does not open a commitment made for another swap (the vectors'
        // placeholder swap_ref), a wrong txid or a wrong view share.
        let (m2, fx2) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Active);
        let op2 = m2.operator.insecure_clone();
        ok(w.call(&m2, &fx2, &Call::PostNotice { commitment: h32(commitment), ct }, &op2));
        let session2 = fx2.session.insecure_clone();
        ok(w.call(&m2, &fx2, &Call::Refund(fx2.s_t), &session2));
        assert_err(w.call(&m2, &fx2, &Call::Withhold(Some((txid, view))), &op2), "EvidenceMismatch");
        let mut other = txid;
        other[0] ^= 1;
        assert_err(w.call(&m, &fx, &Call::Withhold(Some((other, view))), &op), "EvidenceMismatch");
        let mut other = view;
        other[31] ^= 1;
        assert_err(w.call(&m, &fx, &Call::Withhold(Some((txid, other))), &op), "EvidenceMismatch");
        ok(w.call(&m, &fx, &Call::Withhold(Some((txid, view))), &op));
        checked += 1;
    }
    assert_eq!(checked, 4);
}
