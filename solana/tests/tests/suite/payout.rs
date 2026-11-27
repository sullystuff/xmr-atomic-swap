//! Fresh payout address when selling XMR (SPEC 11.2): a direction-B claim pays the address
//! named at take and no other, whoever submits it; everything else returns to the taker's own
//! wallet; a missing token account is created at the caller's cost or the proceeds are parked;
//! parked proceeds can be delivered by anyone, to the payout address only.
use crate::common::*;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

const AMOUNT: u64 = 1_500_000_000;
const D: u64 = 15_000_000;
const FEE_OF_AMOUNT: u64 = 750_000;
const PROCEEDS: u64 = AMOUNT - FEE_OF_AMOUNT + D;
const ASSETS: [u8; 2] = [ASSET_SOL, ASSET_USDC];

/// A direction-B swap paying `payout`, driven to `stage`. The payout address has no balance
/// and no token account unless the test gives it one.
fn sell_to(w: &mut World, asset: u8, payout: &Pubkey, stage: Stage) -> (MakerFx, SwapFx) {
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, asset, DIR_B, &Terms::default(), PRICE);
    let (mut fx, mut raw) = w.prepare_open(&m, asset, DIR_B, XMR, Source::Offer(offer));
    raw.payout = *payout;
    fx.payout = *payout;
    let res = ok(w.send_open(&fx, &raw));
    // The address is public in the swap and in the event (SPEC 11.2 says so plainly).
    assert_eq!(logged_events(&res, "SwapOpened")[0][134..166], payout.to_bytes());
    assert_eq!(w.swap(&fx.pda).unwrap().payout, *payout);
    if stage == Stage::Opened {
        return (m, fx);
    }
    w.warp(12);
    ok(w.fund_swap(&mut m, &fx));
    if stage == Stage::Active {
        return (m, fx);
    }
    w.warp(90);
    ok(w.notice(&m, &mut fx));
    if stage == Stage::Noticed {
        return (m, fx);
    }
    w.warp(600);
    ok(w.ready(&m, &fx));
    (m, fx)
}

fn asset_of(w: &World, asset: u8, wallet: &Pubkey) -> u64 {
    if asset == ASSET_USDC {
        w.tokens(&w.ata(wallet))
    } else {
        w.lamports(wallet)
    }
}

#[test]
fn a_claim_pays_the_bound_payout_address_whoever_submits_it() {
    for asset in ASSETS {
        for submitter in ["session", "wallet"] {
            let mut w = World::new();
            let payout = Keypair::new().pubkey();
            if asset == ASSET_USDC {
                w.make_ata(&payout);
            }
            let (m, fx) = sell_to(&mut w, asset, &payout, Stage::Ready);
            let taker = fx.taker.pubkey();
            let signer = if submitter == "session" { fx.session.insecure_clone() } else { fx.taker.insecure_clone() };
            let thief = w.fund(SOL);
            let thief_token = w.make_ata(&thief.pubkey());

            // The payout slot is the swap's payout address and nothing else: not the taker, not
            // the submitter, not a third party.
            for other in [taker, signer.pubkey(), thief.pubkey()] {
                let mut ix = w.call_ix(&m, &fx, &Call::Claim(fx.s_t), &signer.pubkey());
                ix.accounts[S_PAYOUT].pubkey = other;
                if asset == ASSET_USDC {
                    ix.accounts[S_PAYOUT_TOKEN].pubkey = w.make_ata(&other);
                }
                assert_err(w.send(&[ix], &[&signer]), "Unauthorized");
            }
            if asset == ASSET_USDC {
                let mut ix = w.call_ix(&m, &fx, &Call::Claim(fx.s_t), &signer.pubkey());
                ix.accounts[S_PAYOUT_TOKEN].pubkey = thief_token;
                assert_err(w.send(&[ix], &[&signer]), "Unauthorized");
            }
            assert_eq!(w.swap(&fx.pda).unwrap().state, READY);

            // (The refused attempts above cost their signer fees.)
            let taker_before = asset_of(&w, asset, &taker);
            let res = ok(w.call(&m, &fx, &Call::Claim(fx.s_t), &signer));
            // amount − fee + Dp to the payout address; it needed no balance to receive it.
            assert_eq!(asset_of(&w, asset, &payout), PROCEEDS, "{submitter} {asset}");
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.state, s.outcome, s.revealed, s.owed_taker), (DONE, 8, fx.s_t, 0));
            let ev = &logged_events(&res, "Claimed")[0];
            assert_eq!(u64::from_le_bytes(ev[105..113].try_into().unwrap()), PROCEEDS);
            // The taking wallet received none of the proceeds (in SOL: only its own session
            // key's leftover lamports, or minus its fee).
            if asset == ASSET_USDC {
                assert_eq!(asset_of(&w, asset, &taker), taker_before);
                assert_eq!(w.tokens(&thief_token), 0);
            } else if submitter == "session" {
                assert!(asset_of(&w, asset, &taker) - taker_before < 3_000_000, "the sweep only");
                assert_eq!(w.lamports(&fx.session.pubkey()), 0);
            } else {
                assert_eq!(taker_before - asset_of(&w, asset, &taker), FEE);
            }
            assert_eq!(w.lamports(&thief.pubkey()), SOL);
        }
    }
}

#[test]
fn nobody_but_the_taker_can_claim_and_the_payout_address_signs_nothing() {
    for asset in ASSETS {
        let mut w = World::new();
        let payout = w.fund(SOL);
        w.make_ata(&payout.pubkey());
        let (m, fx) = sell_to(&mut w, asset, &payout.pubkey(), Stage::Ready);
        // The payout address is not a party: with the taker's secret in hand it still cannot
        // claim, refund, abort, cancel or post anything.
        let (stranger, op) = (w.stranger.insecure_clone(), m.operator.insecure_clone());
        for who in [&payout, &stranger, &op] {
            assert_err(w.call(&m, &fx, &Call::Claim(fx.s_t), who), "Unauthorized");
        }
        for call in [Call::Abort, Call::CancelPending, Call::SetReady, Call::WithdrawOwed(0)] {
            let res = w.call(&m, &fx, &call, &payout);
            assert!(is_err(&res, "Unauthorized"), "{}: {}", call.name(), err_string(&res));
        }
        assert_eq!(w.swap(&fx.pda).unwrap().state, READY);
    }
}

#[test]
fn everything_that_is_not_a_claim_returns_to_the_takers_own_wallet() {
    for asset in ASSETS {
        // A cancel, a maker backout, a held deposit released: the take deposit goes to the
        // wallet that posted it; the payout address sees nothing.
        let mut w = World::new();
        let payout = Keypair::new().pubkey();
        w.make_ata(&payout);
        let (m, fx) = sell_to(&mut w, asset, &payout, Stage::Opened);
        let l = w.ledger(&m, &fx);
        let taker = fx.taker.insecure_clone();
        ok(w.call(&m, &fx, &Call::CancelPending, &taker));
        assert_eq!(l.moved(&w, 1, 0, true), Moved::taker(D));

        let (m, fx) = sell_to(&mut w, asset, &payout, Stage::Noticed);
        let op = m.operator.insecure_clone();
        let secret = w.maker_secret(&m, &fx);
        let l = w.ledger(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(secret), &op));
        assert_eq!(l.moved(&w, 0, 1, false), Moved { operator: AMOUNT as i128, taker: D as i128, ..Moved::default() });

        let (m, fx) = sell_to(&mut w, asset, &payout, Stage::Active);
        let t = w.swap(&fx.pda).unwrap().t_note_deadline;
        w.set_time(t);
        let op = m.operator.insecure_clone();
        let secret = w.maker_secret(&m, &fx);
        ok(w.call(&m, &fx, &Call::Refund(secret), &op));
        w.warp(HOLD_SECS);
        let l = w.ledger(&m, &fx);
        let stranger = w.stranger.insecure_clone();
        ok(w.call(&m, &fx, &Call::ReleaseDeposit, &stranger));
        assert_eq!(l.moved(&w, 0, 0, false), Moved::taker(D));
        assert_eq!(asset_of(&w, asset, &payout), 0);
    }
}

#[test]
fn a_missing_token_account_is_created_at_the_callers_cost_or_the_proceeds_are_parked() {
    let asset = ASSET_USDC;
    let with_ata_program = |w: &World, m: &MakerFx, fx: &SwapFx, signer: &Pubkey, call: &Call| {
        let mut ix = w.call_ix(m, fx, call, signer);
        ix.accounts[S_ATA_PROGRAM] = meta(ATA_PROGRAM, false, false);
        ix
    };

    // Created: the session key holds the token account's rent on top of its own.
    let mut w = World::new();
    let payout = Keypair::new().pubkey();
    let (m, fx) = sell_to(&mut w, asset, &payout, Stage::Ready);
    let session = fx.session.insecure_clone();
    // Exactly enough: the fee, the token account's rent, and its own.
    let mut acc = w.svm.get_account(&session.pubkey()).unwrap();
    acc.lamports = w.rent(165) + w.rent(0) + FEE;
    w.svm.set_account(session.pubkey(), acc).unwrap();
    let before = w.lamports(&session.pubkey()) + w.lamports(&fx.taker.pubkey());
    assert!(!w.exists(&w.ata(&payout)));
    let ix = with_ata_program(&w, &m, &fx, &session.pubkey(), &Call::Claim(fx.s_t));
    ok(w.send(&[ix], &[&session]));
    assert_eq!(w.tokens(&w.ata(&payout)), PROCEEDS);
    assert_eq!(w.swap(&fx.pda).unwrap().owed_taker, 0);
    // The caller paid: the fee and the account's rent; the rest of the key was swept to the taker.
    assert_eq!(before - (w.lamports(&session.pubkey()) + w.lamports(&fx.taker.pubkey())), FEE + w.rent(165));
    assert_eq!(w.lamports(&session.pubkey()), 0);

    // Not created, parked, and the claim still succeeds, when: the associated-token program is
    // not passed; something else is passed in its slot; the caller cannot afford the rent.
    for case in ["no program", "another program", "poor caller"] {
        let mut w = World::new();
        let payout = Keypair::new().pubkey();
        let (m, fx) = sell_to(&mut w, asset, &payout, Stage::Ready);
        let session = fx.session.insecure_clone();
        let mut ix = w.call_ix(&m, &fx, &Call::Claim(fx.s_t), &session.pubkey());
        match case {
            "no program" => w.svm.airdrop(&session.pubkey(), w.rent(165)).unwrap().fee.min(0),
            "another program" => {
                w.svm.airdrop(&session.pubkey(), w.rent(165)).unwrap();
                ix.accounts[S_ATA_PROGRAM] = meta(TOKEN, false, false);
                0
            }
            _ => {
                // One lamport short, after the fee, of the token account's rent on top of its own.
                let mut acc = w.svm.get_account(&session.pubkey()).unwrap();
                acc.lamports = w.rent(165) + w.rent(0) + FEE - 1;
                w.svm.set_account(session.pubkey(), acc).unwrap();
                ix.accounts[S_ATA_PROGRAM] = meta(ATA_PROGRAM, false, false);
                0
            }
        };
        ok(w.send(&[ix], &[&session]));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.revealed, s.owed_taker), (DONE, fx.s_t, PROCEEDS), "{case}");
        assert!(!w.exists(&w.ata(&payout)), "{case}");
        assert_eq!(w.tokens(&w.treasury_vault), FEE_OF_AMOUNT, "{case}: the fee was not held up");

        // Parked proceeds are not stranded, and cannot be redirected.
        let stranger = w.stranger.insecure_clone();
        let taker = fx.taker.insecure_clone();
        let stranger_token = w.make_ata(&stranger.pubkey());
        let taker_token = w.ata(&taker.pubkey());
        // The taking wallet, naming itself: refused. (It may deliver to the payout address, like
        // anyone.)
        let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(0), &taker.pubkey());
        ix.accounts[S_PAYOUT].pubkey = taker.pubkey();
        ix.accounts[S_PAYOUT_TOKEN].pubkey = taker_token;
        assert_err(w.send(&[ix], &[&taker]), "Unauthorized");
        // A stranger, naming itself, or the right wallet with its own token account.
        let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(0), &stranger.pubkey());
        ix.accounts[S_PAYOUT].pubkey = stranger.pubkey();
        ix.accounts[S_PAYOUT_TOKEN].pubkey = stranger_token;
        assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");
        let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(0), &stranger.pubkey());
        ix.accounts[S_PAYOUT_TOKEN].pubkey = stranger_token;
        assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");
        // Without a token account to deliver to it fails (it carries no secret; it may)...
        assert!(w.call(&m, &fx, &Call::WithdrawOwed(0), &stranger).is_err());
        // ...and with the associated-token program the stranger creates it and delivers.
        let ix = with_ata_program(&w, &m, &fx, &stranger.pubkey(), &Call::WithdrawOwed(0));
        ok(w.send(&[ix], &[&stranger]));
        assert_eq!(w.tokens(&w.ata(&payout)), PROCEEDS, "{case}");
        assert_eq!((w.tokens(&stranger_token), w.tokens(&taker_token) > 0, w.swap(&fx.pda).unwrap().owed_taker), (0, true, 0));
        assert_err(w.call(&m, &fx, &Call::WithdrawOwed(0), &stranger), "NothingOwed");
    }
}

#[test]
fn the_payout_address_pulls_its_parked_proceeds_to_any_destination_it_names() {
    for asset in ASSETS {
        let mut w = World::new();
        let payout = w.fund(SOL);
        let payout_token = w.make_ata(&payout.pubkey());
        let (m, fx) = sell_to(&mut w, asset, &payout.pubkey(), Stage::Ready);
        // It cannot receive right now.
        if asset == ASSET_USDC {
            w.set_frozen(&payout_token, true);
        } else {
            w.set_can_receive_sol(&payout.pubkey(), false);
        }
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Claim(fx.s_t), &session));
        assert_eq!(w.swap(&fx.pda).unwrap().owed_taker, PROCEEDS);
        if asset == ASSET_SOL {
            w.set_can_receive_sol(&payout.pubkey(), true);
        }
        // Signed by the payout address: any destination (here a cold wallet's).
        let cold = w.fund(SOL);
        let cold_token = w.make_ata(&cold.pubkey());
        let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(0), &payout.pubkey());
        ix.accounts[S_PAYOUT].pubkey = cold.pubkey();
        if asset == ASSET_USDC {
            ix.accounts[S_PAYOUT_TOKEN].pubkey = cold_token;
        }
        ok(w.send(&[ix], &[&payout]));
        assert_eq!(asset_of(&w, asset, &cold.pubkey()) - if asset == ASSET_SOL { SOL } else { 0 }, PROCEEDS);
        assert_eq!(w.swap(&fx.pda).unwrap().owed_taker, 0);
    }
}

#[test]
fn an_invalid_payout_address_is_refused_at_take() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_USDC, DIR_B, &Terms::default(), PRICE);
    let some_wallet = Keypair::new().pubkey();
    let invalid: Vec<(&str, Pubkey)> = vec![
        ("the default key (also the system program)", Pubkey::default()),
        ("the program", PROGRAM_ID),
        ("a PDA of the program (the config)", w.config),
        ("a PDA of the program (the treasury)", w.treasury),
        ("the maker PDA", m.pda),
        ("an associated token account", w.ata(&some_wallet)),
        ("the treasury token vault", w.treasury_vault),
    ];
    for (name, payout) in invalid {
        let (fx, mut raw) = w.prepare_open(&m, ASSET_USDC, DIR_B, XMR, Source::Offer(offer));
        raw.payout = payout;
        let res = w.send_open(&fx, &raw);
        assert!(is_err(&res, "PayoutInvalid"), "{name}: {}", err_string(&res));
        assert!(w.swap(&fx.pda).is_none());
    }
    assert_eq!(w.open_value(ASSET_USDC), 0);
    // The taker's own wallet is the default; any other ordinary address is fine, funded or not.
    for payout in [None, Some(some_wallet), Some(w.stranger.pubkey())] {
        let (fx, mut raw) = w.prepare_open(&m, ASSET_USDC, DIR_B, XMR, Source::Offer(offer));
        if let Some(p) = payout {
            raw.payout = p;
        }
        ok(w.send_open(&fx, &raw));
        assert_eq!(w.swap(&fx.pda).unwrap().payout, payout.unwrap_or(fx.taker.pubkey()));
    }
    // Direction A has no payout address: the field is zeros.
    let (_, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Opened);
    assert_eq!(w.swap(&fx.pda).unwrap().payout, Pubkey::default());
}

#[test]
fn the_maker_funds_knowing_the_payout_address() {
    // SPEC 11.2: the payout address is covered by the open hash. A maker's `fund` built for a
    // take that paid the taker itself fails against a take, at the same address, that names
    // another payout.
    for asset in ASSETS {
        let mut w = World::new();
        let payout = Keypair::new().pubkey();
        let (mut m, fx) = sell_to(&mut w, asset, &payout, Stage::Opened);
        let s = w.swap(&fx.pda).unwrap();
        let z = [0u8; 32];
        let with = |p: &[u8; 32]| {
            open_hash_of(&fx.pda.to_bytes(), s.t_lock, s.direction, s.asset, s.xmr, s.amount, s.deposit, &s.taker_spend_pub, &s.locker_view, &s.taker_enc_key, &s.maker_enc_key, p, &z)
        };
        let op = m.operator.insecure_clone();
        for wrong in [fx.taker.pubkey().to_bytes(), z] {
            let (_, share, pok) = m.new_share();
            let call = Call::Fund { open: with(&wrong), share, pok, view: new_view(), watcher: None };
            assert_err(w.call(&m, &fx, &call, &op), "BadState");
        }
        let (_, share, pok) = m.new_share();
        let call = Call::Fund { open: with(&payout.to_bytes()), share, pok, view: new_view(), watcher: None };
        ok(w.call(&m, &fx, &call, &op));
        assert_eq!(with(&payout.to_bytes()), s.open_hash(&fx.pda));
    }
}
