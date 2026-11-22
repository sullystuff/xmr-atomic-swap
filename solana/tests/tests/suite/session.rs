//! The per-swap session key (SPEC 3.9, 4.5): what it may call, that it is valid for its one
//! swap only, that it can never choose a destination, and the lamport rules it lives under.
use crate::common::*;
use solana_signer::Signer;

const ASSETS: [u8; 2] = [ASSET_SOL, ASSET_USDC];

/// Every call the session key could try, with arguments that would be valid for the right signer.
fn all_calls(w: &World, m: &mut MakerFx, fx: &SwapFx) -> Vec<Call> {
    let s = w.swap(&fx.pda).unwrap();
    let open = s.open_hash(&fx.pda);
    let (_, share, pok) = m.new_share();
    let notice = fx.notice.unwrap_or((rand32(), new_view()));
    vec![
        Call::Approve { open, share, pok },
        Call::Fund { open, share, pok, view: new_view() },
        Call::Reject { open, reason: 0 },
        Call::CancelPending,
        Call::PostNotice { commitment: notice_commitment(&fx.pda, &notice.0, &notice.1), ct: [0; 104] },
        Call::SetReady,
        Call::Abort,
        Call::Refund(w.locker_secret_or_random(m, fx)),
        Call::Claim(w.claimer_secret_or_random(m, fx)),
        Call::Withhold(Some(notice)),
        Call::PublishEvidence(notice.0, notice.1),
        Call::WithdrawOwed(0),
        Call::WithdrawOwed(1),
    ]
}

trait Secrets {
    fn locker_secret_or_random(&self, m: &MakerFx, fx: &SwapFx) -> [u8; 32];
    fn claimer_secret_or_random(&self, m: &MakerFx, fx: &SwapFx) -> [u8; 32];
}
impl Secrets for World {
    fn locker_secret_or_random(&self, m: &MakerFx, fx: &SwapFx) -> [u8; 32] {
        if fx.direction == DIR_A {
            return fx.s_t;
        }
        let s = self.swap(&fx.pda).unwrap();
        m.shares.get(&s.maker_spend_pub).copied().unwrap_or_else(|| new_share().0)
    }
    fn claimer_secret_or_random(&self, m: &MakerFx, fx: &SwapFx) -> [u8; 32] {
        if fx.direction == DIR_B {
            return fx.s_t;
        }
        let s = self.swap(&fx.pda).unwrap();
        m.shares.get(&s.maker_spend_pub).copied().unwrap_or_else(|| new_share().0)
    }
}

/// In `state`, simulate every call signed by the session key; return the names that would succeed.
fn allowed(w: &mut World, m: &mut MakerFx, fx: &SwapFx) -> Vec<&'static str> {
    let session = fx.session.insecure_clone();
    if fx.asset == ASSET_USDC {
        w.make_ata(&session.pubkey()); // so `fund` is refused for the caller, not for its accounts
    }
    let mut names = vec![];
    for call in all_calls(w, m, fx) {
        let res = w.would(m, fx, &call, &session);
        if res.is_ok() {
            names.push(call.name());
        } else if !is_err(&res, "Unauthorized") {
            // A call the session key is entitled to make can still be out of state or time; a
            // call it is not entitled to must say so, or be the other direction's call.
            let own = if fx.direction == DIR_A {
                ["cancel_pending", "set_ready", "refund"].contains(&call.name())
            } else {
                ["cancel_pending", "post_notice", "abort", "claim", "publish_evidence"].contains(&call.name())
            };
            let other_direction = matches!(call, Call::Approve { .. } | Call::Fund { .. }) && is_err(&res, "WrongDirection");
            assert!(own || other_direction, "{} by the session key: {}", call.name(), err_string(&res));
        }
    }
    names
}

#[test]
fn direction_a_session_key_can_only_cancel_set_ready_and_refund() {
    for asset in ASSETS {
        let window = Terms { mode: 1, ..Terms::default() };
        let mut w = World::new();
        let (mut m, fx) = w.swap_at(asset, DIR_A, &window, Stage::Opened);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["cancel_pending"], "PENDING");

        let (mut m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Active);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["refund"], "ACTIVE");

        let (mut m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["refund"], "NOTICED before the ready minimum");
        w.warp(600);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["set_ready", "refund"], "NOTICED");

        let (mut m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Ready);
        assert_eq!(allowed(&mut w, &mut m, &fx), Vec::<&str>::new(), "READY inside the claim window");
        let t_cd = w.swap(&fx.pda).unwrap().t_claim_deadline;
        w.set_time(t_cd);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["refund"], "READY after the claim window");

        // HOLD: nothing. The deposit's fate is the operator's call or the crank's.
        let (mut m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let own_session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &own_session));
        w.svm.airdrop(&own_session.pubkey(), SOL).unwrap(); // swept to zero by the refund
        assert_eq!(allowed(&mut w, &mut m, &fx), Vec::<&str>::new(), "HOLD");
        // Before the hold ends its release is refused like anyone's; afterwards it is anyone's.
        assert_err(w.call(&m, &fx, &Call::ReleaseDeposit, &own_session), "TooEarly");
    }
}

#[test]
fn direction_b_session_key_can_cancel_notice_abort_claim_and_publish_evidence() {
    for asset in ASSETS {
        let mut w = World::new();
        let (mut m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Opened);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["cancel_pending"], "PENDING");

        let (mut m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Active);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["post_notice"], "ACTIVE");

        let (mut m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Noticed);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["abort", "publish_evidence"], "NOTICED");
        let t_co = w.swap(&fx.pda).unwrap().t_claim_open;
        w.set_time(t_co);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["abort", "claim", "publish_evidence"], "NOTICED from T_co");

        let (mut m, fx) = w.swap_at(asset, DIR_B, &Terms::default(), Stage::Ready);
        assert_eq!(allowed(&mut w, &mut m, &fx), vec!["abort", "claim", "publish_evidence"], "READY");
    }
}

#[test]
fn a_session_key_is_valid_for_its_one_swap() {
    for asset in ASSETS {
        let mut w = World::new();
        let mut m = w.register_maker();
        w.live_offer(&mut m, asset, DIR_A, &Terms::default(), PRICE);
        ok(w.refill(&mut m, asset, 2, 6));
        // Two swaps of the same taker with the same maker: the keys differ only by the nonce.
        let taker = w.fund(1_000 * SOL);
        if asset == ASSET_USDC {
            w.mint_to(&taker.pubkey(), 1_000_000_000_000);
        }
        let offer = w.offer_pda(&m.pda, asset, DIR_A);
        let mut swaps = vec![];
        for _ in 0..2 {
            let (fx, raw) = w.prepare_open_for(&m, taker.insecure_clone(), asset, DIR_A, XMR, Source::Offer(offer), rand16());
            ok(w.send_open(&fx, &raw));
            swaps.push(fx);
        }
        let (mut one, two) = (swaps.remove(0), swaps.remove(0));
        w.warp(90);
        ok(w.notice(&m, &mut one));
        let mut two = two;
        ok(w.notice(&m, &mut two));
        w.warp(600);

        // Swap one's session key on swap two: refused, whatever it tries.
        let key_one = one.session.insecure_clone();
        for call in [Call::SetReady, Call::Refund(two.s_t), Call::CancelPending, Call::Abort, Call::CloseSwap] {
            let res = w.call(&m, &two, &call, &key_one);
            // (`close_swap` of a swap that is not settled is refused before the caller matters.)
            let want = if matches!(call, Call::CloseSwap) { "NotClosable" } else { "Unauthorized" };
            assert!(is_err(&res, want), "{}: {}", call.name(), err_string(&res));
        }
        // Even with the taker's own spend share for swap two, it is not that swap's key.
        assert_err(w.call(&m, &two, &Call::Refund(two.s_t), &key_one), "Unauthorized");
        assert_eq!(w.swap(&two.pda).unwrap().state, NOTICED);
        // On its own swap it works.
        ok(w.call(&m, &one, &Call::SetReady, &key_one));
        // A key that is nobody's is refused too; the taker's wallet can do what the key can.
        let nobody = w.fund(SOL);
        assert_err(w.call(&m, &two, &Call::SetReady, &nobody), "Unauthorized");
        assert_err(w.call(&m, &two, &Call::Refund(two.s_t), &nobody), "Unauthorized");
        ok(w.call(&m, &two, &Call::SetReady, &taker));
    }
}

#[test]
fn a_session_key_can_never_choose_a_destination() {
    for asset in ASSETS {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let session = fx.session.insecure_clone();
        let thief = w.fund(SOL);
        let thief_token = w.make_ata(&thief.pubkey());

        // The taker account of a refund is pinned to the taker stored at lock.
        let mut ix = w.call_ix(&m, &fx, &Call::Refund(fx.s_t), &session.pubkey());
        ix.accounts[S_TAKER].pubkey = thief.pubkey();
        assert_err(w.send(&[ix], &[&session]), "Unauthorized");
        let mut ix = w.call_ix(&m, &fx, &Call::Refund(fx.s_t), &session.pubkey());
        ix.accounts[S_TAKER].pubkey = session.pubkey();
        assert_err(w.send(&[ix], &[&session]), "Unauthorized");
        if asset == ASSET_USDC {
            let mut ix = w.call_ix(&m, &fx, &Call::Refund(fx.s_t), &session.pubkey());
            ix.accounts[S_TAKER_TOKEN].pubkey = thief_token;
            assert_err(w.send(&[ix], &[&session]), "Unauthorized");
        }
        // The honest refund pays the taker; the key's own leftover lamports go there too.
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        assert_eq!(l.moved(&w, 1, 0, false), Moved::taker(1_485_000_000));
        assert_eq!(w.lamports(&session.pubkey()), 0);
        assert_eq!(w.lamports(&thief.pubkey()), SOL);
        assert_eq!(w.tokens(&thief_token), 0);

        // A parked payout is pulled by the wallet, to a destination the wallet names. Never by
        // the session key.
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let session = fx.session.insecure_clone();
        if asset == ASSET_USDC {
            let ata = w.ata(&fx.taker.pubkey());
            w.set_frozen(&ata, true);
        } else {
            w.set_can_receive_sol(&fx.taker.pubkey(), false);
        }
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        assert_eq!(w.swap(&fx.pda).unwrap().owed_taker, 1_485_000_000);
        w.svm.airdrop(&session.pubkey(), SOL).unwrap();
        let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(0), &session.pubkey());
        ix.accounts[S_TAKER].pubkey = thief.pubkey();
        ix.accounts[S_TAKER_TOKEN].pubkey = if asset == ASSET_USDC { thief_token } else { PROGRAM_ID };
        assert_err(w.send(&[ix], &[&session]), "Unauthorized");
        assert_eq!(w.swap(&fx.pda).unwrap().owed_taker, 1_485_000_000);
    }
}

#[test]
fn the_session_key_does_not_sign_the_lock_and_does_not_replace_the_spend_share() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
    let ix = w.open_ix(&raw);
    // One signature: the wallet's. The key's address is only named.
    assert_eq!(ix.accounts.iter().filter(|a| a.is_signer).count(), 1);
    assert!(ix.accounts.iter().any(|a| a.pubkey == fx.session.pubkey() && !a.is_signer));
    ok(w.send(&[ix], &[&fx.taker]));
    assert_eq!(w.swap(&fx.pda).unwrap().session_key, fx.session.pubkey());

    // A keyed call needs both the key and the share.
    let session = fx.session.insecure_clone();
    assert_err(w.call(&m, &fx, &Call::Refund(new_share().0), &session), "ScalarMismatch");
    assert_err(w.call(&m, &fx, &Call::Refund([0; 32]), &session), "ScalarMismatch");
    ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
}

#[test]
fn session_key_lamport_rules() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    ok(w.refill(&mut m, ASSET_SOL, 2, 4));
    let rent0 = w.rent(0);
    assert_eq!(rent0, 650_240, "mainnet's rent for an empty account at 5,080 lamports per byte");

    // Funding below the rent minimum would fail the transfer: refused with a named error.
    let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
    raw.session_lamports = rent0 - 1;
    assert_err(w.send_open(&fx, &raw), "SessionBudgetTooLow");
    raw.session_lamports = 0;
    assert_err(w.send_open(&fx, &raw), "SessionBudgetTooLow");

    // Exactly the rent minimum locks, but that key can never pay a fee: a fee payer must end
    // a transaction rent-exempt or at exactly zero, and the fee is taken first.
    raw.session_lamports = rent0;
    ok(w.send_open(&fx, &raw));
    let session = fx.session.insecure_clone();
    let res = w.call(&m, &fx, &Call::Refund(fx.s_t), &session);
    assert!(res.is_err() && !format!("{}", err_string(&res)).contains("Custom(60"), "{}", err_string(&res));
    assert_eq!(w.swap(&fx.pda).unwrap().state, ACTIVE, "the refund never ran");
    // The wallet still can.
    let taker = fx.taker.insecure_clone();
    ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
    assert_eq!(w.lamports(&session.pubkey()), rent0, "a wallet-signed call does not sweep the key");

    // Rent minimum + two fees: two transactions, and the second (the refund) sweeps the key
    // to exactly zero. The taker is out the fees only.
    let (mut fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
    raw.session_lamports = rent0 + 2 * FEE;
    let taker_start = w.lamports(&fx.taker.pubkey());
    ok(w.send_open(&fx, &raw));
    w.warp(90);
    ok(w.notice(&m, &mut fx));
    w.warp(600);
    let session = fx.session.insecure_clone();
    ok(w.call(&m, &fx, &Call::SetReady, &session));
    assert_eq!(w.lamports(&session.pubkey()), rent0 + FEE);
    let t_cd = w.swap(&fx.pda).unwrap().t_claim_deadline;
    w.set_time(t_cd);
    ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session)); // A10e: everything back
    assert_eq!(w.lamports(&session.pubkey()), 0);
    assert!(w.svm.get_account(&session.pubkey()).is_none_or(|a| a.lamports == 0));
    // lock fee + two session fees; the swap account's rent is still locked until it is closed.
    assert_eq!(taker_start - w.lamports(&fx.taker.pubkey()), 3 * FEE + w.rent(736));
    let op = m.operator.insecure_clone();
    ok(w.call(&m, &fx, &Call::CloseSwap, &op));
    assert_eq!(taker_start - w.lamports(&fx.taker.pubkey()), 3 * FEE);

    // The claim path sweeps too (direction B), so a key that only ever posted the notice does
    // not strand its rent minimum.
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_B, &Terms::default(), Stage::Ready);
    let session = fx.session.insecure_clone();
    let before = w.lamports(&fx.taker.pubkey()) + w.lamports(&session.pubkey());
    ok(w.call(&m, &fx, &Call::Claim(fx.s_t), &session));
    assert_eq!(w.lamports(&session.pubkey()), 0);
    assert_eq!(w.lamports(&fx.taker.pubkey()), before - FEE + 1_500_000_000 - 750_000 + 15_000_000);
}
