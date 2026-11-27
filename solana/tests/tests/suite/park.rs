//! Pay or park (SPEC 4.5): a claim or a refund publishes a secret in its arguments, so it must
//! never fail on a payout. Frozen, missing and mismatched token accounts, a frozen escrow, a
//! payout address changed under a transaction in flight, lamport destinations that could not
//! stay rent-exempt; then `withdraw_owed` and `close_swap`.
use crate::common::*;
use solana_signer::Signer;

const AMOUNT: u64 = 1_500_000_000;
const D: u64 = 15_000_000;
const FEE_OF_AMOUNT: u64 = 750_000;

fn parked_events(res: &litesvm::types::TransactionMetadata) -> Vec<(u8, u64)> {
    logged_events(res, "PayoutParked").iter().map(|e| (e[73], u64::from_le_bytes(e[74..82].try_into().unwrap()))).collect()
}

#[test]
fn claim_with_a_frozen_payout_token_account_succeeds_and_parks() {
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Ready);
    let payout_ata = w.ata(&m.payout.pubkey());
    w.set_frozen(&payout_ata, true);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    let res = ok(w.call(&m, &fx, &Call::Claim(secret), &op));

    // The claim happened: the secret is in state, the fee reached the treasury, the maker's
    // share is still in escrow and recorded.
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.outcome, s.revealed), (DONE, 8, secret));
    assert_eq!((s.owed_maker, s.owed_taker, s.owed_treasury), (AMOUNT - FEE_OF_AMOUNT, 0, 0));
    assert_eq!(w.tokens(&fx.vault), AMOUNT - FEE_OF_AMOUNT);
    assert_eq!(w.tokens(&w.treasury_vault), FEE_OF_AMOUNT);
    assert_eq!(w.tokens(&payout_ata), 0);
    assert_eq!(parked_events(&res), vec![(1, AMOUNT - FEE_OF_AMOUNT)]);
    assert_eq!(w.maker(&m.pda).counters[8], 1);

    // Only the maker's owner can pull it, to an account it names.
    let owner = m.owner.insecure_clone();
    assert_err(w.call(&m, &fx, &Call::WithdrawOwed(1), &op), "Unauthorized");
    let stranger = w.stranger.insecure_clone();
    assert_err(w.call(&m, &fx, &Call::WithdrawOwed(1), &stranger), "Unauthorized");
    // While the destination is frozen the withdrawal fails (it carries no secret; it may).
    assert!(w.call(&m, &fx, &Call::WithdrawOwed(1), &owner).is_err());
    assert_eq!(w.swap(&fx.pda).unwrap().owed_maker, AMOUNT - FEE_OF_AMOUNT);
    let cold = w.make_ata(&owner.pubkey());
    let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(1), &owner.pubkey());
    ix.accounts[S_MAKER_TOKEN].pubkey = cold;
    let res = ok(w.send(&[ix], &[&owner]));
    assert_eq!(w.tokens(&cold), AMOUNT - FEE_OF_AMOUNT);
    assert_eq!(w.swap(&fx.pda).unwrap().owed_maker, 0);
    assert_eq!(logged_events(&res, "OwedWithdrawn").len(), 1);
    assert_err(w.call(&m, &fx, &Call::WithdrawOwed(1), &owner), "NothingOwed");
}

#[test]
fn claim_parks_when_the_payout_token_account_is_missing_or_is_not_the_payout_wallets() {
    // Missing: the owner set a payout wallet that has no token account. Payout paths never
    // create one.
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Ready);
    let new_payout = w.fund(SOL);
    let owner = m.owner.insecure_clone();
    let ix = w.maker_ix(&owner.pubkey(), &m.pda, Enc::ix("set_payout").key(&new_payout.pubkey()).0);
    ok(w.send(&[ix], &[&owner]));
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    let mut ix = w.call_ix(&m, &fx, &Call::Claim(secret), &op.pubkey());
    ix.accounts[S_MAKER_WALLET].pubkey = new_payout.pubkey();
    ix.accounts[S_MAKER_TOKEN].pubkey = w.ata(&new_payout.pubkey());
    ok(w.send(&[ix], &[&op]));
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.revealed, s.owed_maker), (DONE, secret, AMOUNT - FEE_OF_AMOUNT));
    assert!(!w.exists(&w.ata(&new_payout.pubkey())), "no token account was created");

    // Not the payout wallet's: the operator names its own token account. Parked, not paid: a
    // claim pays the payout address the cold owner key set, never the operator.
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Ready);
    let op = m.operator.insecure_clone();
    let operator_ata = w.ata(&op.pubkey());
    let before = w.tokens(&operator_ata);
    let secret = w.maker_secret(&m, &fx);
    let mut ix = w.call_ix(&m, &fx, &Call::Claim(secret), &op.pubkey());
    ix.accounts[S_MAKER_TOKEN].pubkey = operator_ata;
    ok(w.send(&[ix], &[&op]));
    assert_eq!(w.tokens(&operator_ata), before);
    assert_eq!(w.swap(&fx.pda).unwrap().owed_maker, AMOUNT - FEE_OF_AMOUNT);
    // The same for SOL: the operator's wallet in the payout slot.
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Ready);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    let before = w.lamports(&op.pubkey());
    let mut ix = w.call_ix(&m, &fx, &Call::Claim(secret), &op.pubkey());
    ix.accounts[S_MAKER_WALLET].pubkey = op.pubkey();
    ok(w.send(&[ix], &[&op]));
    assert_eq!(w.lamports(&op.pubkey()), before - FEE);
    assert_eq!(w.swap(&fx.pda).unwrap().owed_maker, AMOUNT - FEE_OF_AMOUNT);
}

#[test]
fn a_payout_address_changed_under_a_claim_in_flight_parks_instead_of_failing() {
    for asset in [ASSET_SOL, ASSET_USDC] {
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Ready);
        let op = m.operator.insecure_clone();
        let secret = w.maker_secret(&m, &fx);
        // The operator builds (and simulates) its claim for the current payout address...
        let ix = w.call_ix(&m, &fx, &Call::Claim(secret), &op.pubkey());
        ok(w.simulate(&[ix.clone()], &[&op]));
        // ...and the owner's set_payout lands first.
        let new_payout = w.fund(SOL);
        let owner = m.owner.insecure_clone();
        let set = w.maker_ix(&owner.pubkey(), &m.pda, Enc::ix("set_payout").key(&new_payout.pubkey()).0);
        ok(w.send(&[set], &[&owner]));
        // The claim still succeeds: its secret would be public either way.
        let l = w.ledger(&m, &fx);
        ok(w.send(&[ix], &[&op]));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.revealed, s.owed_maker), (DONE, secret, AMOUNT - FEE_OF_AMOUNT), "asset {asset}");
        assert_eq!(l.moved(&w, 0, 1, false), Moved { treasury: FEE_OF_AMOUNT as i128, ..Moved::default() });
    }
}

#[test]
fn refund_with_a_frozen_taker_account_or_a_frozen_escrow_succeeds_and_parks() {
    for what in ["taker account", "escrow"] {
        let mut w = World::new();
        let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Noticed);
        let taker_ata = w.ata(&fx.taker.pubkey());
        let frozen = if what == "escrow" { fx.vault } else { taker_ata };
        w.set_frozen(&frozen, true);
        let before = w.tokens(&taker_ata);
        let session = fx.session.insecure_clone();
        let res = ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &session));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.revealed, s.owed_taker), (HOLD, fx.s_t, AMOUNT - D), "{what}");
        assert_eq!(w.tokens(&taker_ata), before);
        assert_eq!(w.tokens(&fx.vault), AMOUNT);
        assert_eq!(parked_events(&res), vec![(0, AMOUNT - D)]);
        assert_eq!(w.lamports(&session.pubkey()), 0, "the key is still swept: lamports are not tokens");

        // The hold ends; the release parks too and the swap is DONE with the deposit owed.
        w.warp(HOLD_SECS);
        let stranger = w.stranger.insecure_clone();
        ok(w.call(&m, &fx, &Call::ReleaseDeposit, &stranger));
        let s = w.swap(&fx.pda).unwrap();
        assert_eq!((s.state, s.deposit_state, s.owed_taker), (DONE, 3, AMOUNT));
        // It cannot be closed while something is owed.
        let op = m.operator.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &op), "NotClosable");

        // The taker pulls it to an account it names (a second wallet's), once the escrow thaws.
        let taker = fx.taker.insecure_clone();
        let cold = w.fund(SOL);
        let cold_ata = w.make_ata(&cold.pubkey());
        if what == "escrow" {
            w.set_frozen(&frozen, false);
        }
        let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(0), &taker.pubkey());
        ix.accounts[S_TAKER].pubkey = cold.pubkey();
        ix.accounts[S_TAKER_TOKEN].pubkey = cold_ata;
        ok(w.send(&[ix], &[&taker]));
        assert_eq!(w.tokens(&cold_ata), AMOUNT);
        assert_eq!(w.swap(&fx.pda).unwrap().owed_taker, 0);
        ok(w.call(&m, &fx, &Call::CloseSwap, &op));
        assert!(w.swap(&fx.pda).is_none() && !w.exists(&fx.vault));
    }
}

#[test]
fn direction_b_claim_with_a_missing_taker_token_account_parks_everything_for_the_taker() {
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_B, &Terms::default(), Stage::Ready);
    // The taker emptied and closed its token account after posting the take deposit.
    let taker_ata = w.ata(&fx.taker.pubkey());
    w.svm
        .set_account(taker_ata, solana_account::Account { lamports: 0, data: vec![], owner: SYSTEM, executable: false, rent_epoch: 0 })
        .unwrap();
    assert!(!w.exists(&taker_ata));
    let session = fx.session.insecure_clone();
    ok(w.call(&m, &fx, &Call::Claim(fx.s_t), &session));
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.revealed), (DONE, fx.s_t));
    assert_eq!(s.owed_taker, AMOUNT - FEE_OF_AMOUNT + D);
    assert_eq!(w.tokens(&w.treasury_vault), FEE_OF_AMOUNT);
    // The maker reads s_T from the account and takes the XMR; the taker comes back for its money.
    let taker = fx.taker.insecure_clone();
    let again = w.make_ata(&taker.pubkey());
    ok(w.call(&m, &fx, &Call::WithdrawOwed(0), &taker));
    assert_eq!(w.tokens(&again), AMOUNT - FEE_OF_AMOUNT + D);
}

#[test]
fn a_frozen_treasury_vault_parks_the_fee_and_anyone_can_deliver_it_later_to_the_treasury_only() {
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Ready);
    let tv = w.treasury_vault;
    w.set_frozen(&tv, true);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    ok(w.call(&m, &fx, &Call::Claim(secret), &op));
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.owed_treasury, s.owed_maker), (DONE, FEE_OF_AMOUNT, 0), "a fee can never block a claim");
    assert_eq!(w.tokens(&w.ata(&m.payout.pubkey())), AMOUNT - FEE_OF_AMOUNT);

    w.set_frozen(&tv, false);
    let stranger = w.stranger.insecure_clone();
    let own = w.make_ata(&stranger.pubkey());
    let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(2), &stranger.pubkey());
    ix.accounts[S_TREASURY_VAULT].pubkey = own;
    assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");
    ok(w.call(&m, &fx, &Call::WithdrawOwed(2), &stranger));
    assert_eq!(w.tokens(&tv), FEE_OF_AMOUNT);
    assert_eq!(w.tokens(&own), 0);

    // SOL: the treasury destination is pinned the same way.
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Ready);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    let mut ix = w.call_ix(&m, &fx, &Call::Claim(secret), &op.pubkey());
    ix.accounts[S_TREASURY].pubkey = op.pubkey();
    assert_err(w.send(&[ix], &[&op]), "Unauthorized");
}

/// Move every lamport out of a wallet (the fee comes off the top), leaving an account that
/// does not exist.
fn drain(w: &mut World, wallet: &solana_keypair::Keypair) {
    let sink = w.fund(SOL);
    let all = w.lamports(&wallet.pubkey()) - FEE;
    let ix = solana_system_interface::instruction::transfer(&wallet.pubkey(), &sink.pubkey(), all);
    ok(w.send(&[ix], &[wallet]));
    assert_eq!(w.lamports(&wallet.pubkey()), 0);
}

#[test]
fn lamport_payouts_that_would_leave_the_destination_below_rent_are_parked() {
    let rent0 = 650_240;
    // Direction B, a small swap: the take deposit is 1,000 lamports. The taker's wallet is
    // empty when the maker backs out, so the deposit cannot land there (an account must hold
    // its rent minimum). The maker's refund must still succeed.
    let mut w = World::new();
    let mut m = w.register_maker();
    w.live_offer(&mut m, ASSET_SOL, DIR_B, &Terms::default(), 100_000);
    let fx = w.open(&m, ASSET_SOL, DIR_B, XMR);
    assert_eq!(w.swap(&fx.pda).unwrap().deposit, 1_000);
    ok(w.fund_swap(&mut m, &fx));
    drain(&mut w, &fx.taker);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    let operator_before = w.lamports(&op.pubkey());
    let res = ok(w.call(&m, &fx, &Call::Refund(secret), &op));
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.outcome, s.revealed, s.owed_taker), (DONE, 17, secret, 1_000));
    assert_eq!(w.lamports(&op.pubkey()), operator_before - FEE + 100_000);
    assert_eq!(w.lamports(&fx.taker.pubkey()), 0);
    assert_eq!(parked_events(&res), vec![(0, 1_000)]);
    assert_eq!(w.lamports(&fx.pda), w.rent(SWAP_LEN) + 1_000);
    // Once the wallet is funded again the taker collects.
    w.svm.airdrop(&fx.taker.pubkey(), SOL).unwrap();
    let taker = fx.taker.insecure_clone();
    ok(w.call(&m, &fx, &Call::WithdrawOwed(0), &taker));
    assert_eq!(w.lamports(&fx.taker.pubkey()), SOL - FEE + 1_000);

    // Direction A: the payout wallet does not exist and amount − fee is below the rent minimum.
    let mut w = World::new();
    let mut m = w.register_maker();
    w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), 500_000);
    let empty = solana_keypair::Keypair::new();
    let owner = m.owner.insecure_clone();
    let set = w.maker_ix(&owner.pubkey(), &m.pda, Enc::ix("set_payout").key(&empty.pubkey()).0);
    ok(w.send(&[set], &[&owner]));
    m.payout = empty;
    let mut fx = w.open(&m, ASSET_SOL, DIR_A, XMR);
    w.warp(90);
    ok(w.notice(&m, &mut fx));
    w.warp(600);
    ok(w.ready(&m, &fx));
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    let treasury_before = w.lamports(&w.treasury);
    ok(w.call(&m, &fx, &Call::Claim(secret), &op));
    let s = w.swap(&fx.pda).unwrap();
    assert!(500_000 - 250 < rent0);
    assert_eq!((s.state, s.revealed, s.owed_maker, s.owed_treasury), (DONE, secret, 500_000 - 250, 0));
    assert_eq!(w.lamports(&m.payout.pubkey()), 0);
    assert_eq!(w.lamports(&w.treasury) - treasury_before, 250, "the Treasury PDA already holds its rent");
    // The owner pulls it to its own (funded) wallet.
    let before = w.lamports(&owner.pubkey());
    let mut ix = w.call_ix(&m, &fx, &Call::WithdrawOwed(1), &owner.pubkey());
    ix.accounts[S_MAKER_WALLET].pubkey = owner.pubkey();
    ok(w.send(&[ix], &[&owner]));
    assert_eq!(w.lamports(&owner.pubkey()), before - FEE + 500_000 - 250);
    assert_eq!(w.lamports(&fx.pda), w.rent(SWAP_LEN), "the account stays rent-exempt throughout");
}

#[test]
fn a_parked_row_marked_closed_stays_open_until_withdrawn_and_closed() {
    // A4 with a taker that cannot receive: DONE, not closed; then withdraw and close.
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms { mode: 1, ..Terms::default() }, Stage::Opened);
    let ata = w.ata(&fx.taker.pubkey());
    w.set_frozen(&ata, true);
    let stranger = w.stranger.insecure_clone();
    w.warp(60);
    ok(w.call(&m, &fx, &Call::ExpirePending, &stranger));
    let s = w.swap(&fx.pda).unwrap();
    assert_eq!((s.state, s.outcome, s.owed_taker), (DONE, 4, AMOUNT));
    assert_eq!(w.maker(&m.pda).open_pending, 0);
    w.set_frozen(&ata, false);
    let taker = fx.taker.insecure_clone();
    ok(w.call(&m, &fx, &Call::WithdrawOwed(0), &taker));
    // No secret was revealed: anyone may close it; the rent goes to the taker.
    let before = w.lamports(&taker.pubkey());
    ok(w.call(&m, &fx, &Call::CloseSwap, &stranger));
    assert_eq!(w.lamports(&taker.pubkey()) - before, w.rent(SWAP_LEN) + w.rent(165));
    assert!(w.swap(&fx.pda).is_none());
}

#[test]
fn close_swap_rules() {
    for asset in [ASSET_SOL, ASSET_USDC] {
        // After a claim in A the taker still has to read s_M: only the taker (or its key) closes.
        let mut w = World::new();
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Ready);
        let op = m.operator.insecure_clone();
        let stranger = w.stranger.insecure_clone();
        let taker = fx.taker.insecure_clone();
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &taker), "NotClosable"); // not settled
        let secret = w.maker_secret(&m, &fx);
        ok(w.call(&m, &fx, &Call::Claim(secret), &op));
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &stranger), "Unauthorized");
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &op), "Unauthorized");
        w.warp(CLOSE_GRACE_SECS + 1);
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &stranger), "Unauthorized");
        assert_eq!(w.swap(&fx.pda).unwrap().revealed, secret, "still readable a month later");
        let before = w.lamports(&taker.pubkey());
        ok(w.call(&m, &fx, &Call::CloseSwap, &taker));
        let vault_rent = if asset == ASSET_USDC { w.rent(165) } else { 0 };
        assert_eq!(w.lamports(&taker.pubkey()) - before, w.rent(SWAP_LEN) + vault_rent - FEE);
        assert!(w.swap(&fx.pda).is_none() && !w.exists(&fx.vault));

        // After a refund in A the maker has to read s_T: the operator closes at any time; the
        // taker only after the grace period; a stranger never.
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Ready);
        let t_cd = w.swap(&fx.pda).unwrap().t_claim_deadline;
        w.set_time(t_cd);
        let taker = fx.taker.insecure_clone();
        let session = fx.session.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
        let settled = w.swap(&fx.pda).unwrap().t_settled;
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &taker), "Unauthorized");
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &session), "Unauthorized");
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &stranger), "Unauthorized");
        w.set_time(settled + CLOSE_GRACE_SECS - 1);
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &taker), "Unauthorized");
        w.set_time(settled + CLOSE_GRACE_SECS);
        assert_err(w.call(&m, &fx, &Call::CloseSwap, &stranger), "Unauthorized");
        // The session key closes, and is swept: rent and its leftover lamports reach the taker.
        let before = w.lamports(&taker.pubkey()) + w.lamports(&session.pubkey());
        ok(w.call(&m, &fx, &Call::CloseSwap, &session));
        assert_eq!(w.lamports(&session.pubkey()), 0);
        assert_eq!(w.lamports(&taker.pubkey()), before - FEE + w.rent(SWAP_LEN) + vault_rent);

        // The non-revealing party closes at once (the operator, after the taker's refund).
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Noticed);
        let op = m.operator.insecure_clone();
        ok(w.call(&m, &fx, &Call::Abort, &op));
        let taker = fx.taker.insecure_clone();
        ok(w.call(&m, &fx, &Call::Refund(fx.s_t), &taker));
        let before = w.lamports(&taker.pubkey());
        ok(w.call(&m, &fx, &Call::CloseSwap, &op));
        assert_eq!(w.lamports(&taker.pubkey()) - before, w.rent(SWAP_LEN) + vault_rent, "all rent to the taker");

        // The address is free again: the same taker and nonce open a new swap there.
        let offer = w.offer_pda(&m.pda, asset, DIR_A);
        let (fx2, raw) = w.prepare_open_for(&m, taker, asset, DIR_A, XMR, Source::Offer(offer), fx.nonce);
        assert_eq!(fx2.pda, fx.pda);
        ok(w.refresh(&m, &[(asset, DIR_A, true, [PRICE, 0, 0], 100 * XMR)]));
        ok(w.send_open(&fx2, &raw));
        assert_eq!(w.swap(&fx2.pda).unwrap().state, ACTIVE);
        // And a live swap cannot be overwritten by locking again at its address.
        assert_err(w.send_open(&fx2, &raw), "BadState");
    }
}

#[test]
fn dust_sent_to_a_settled_vault_cannot_block_the_close() {
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Ready);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    ok(w.call(&m, &fx, &Call::Claim(secret), &op));
    assert_eq!(w.tokens(&fx.vault), 0);
    // Someone sends 7 units to the vault after settlement.
    let vault = fx.vault;
    w.set_tokens(&vault, 7);
    let taker = fx.taker.insecure_clone();
    // Frozen with tokens in it, the vault cannot be emptied: the close says so.
    w.set_frozen(&vault, true);
    assert_err(w.call(&m, &fx, &Call::CloseSwap, &taker), "VaultNotEmpty");
    w.set_frozen(&vault, false);
    let treasury_before = w.tokens(&w.treasury_vault);
    ok(w.call(&m, &fx, &Call::CloseSwap, &taker));
    assert_eq!(w.tokens(&w.treasury_vault) - treasury_before, 7, "the dust went to the treasury vault");
    assert!(w.swap(&fx.pda).is_none() && !w.exists(&fx.vault));

    // With the treasury vault unusable the dust is burned instead; the close still happens.
    let (m, fx) = w.swap_at(ASSET_USDC, DIR_A, &Terms::default(), Stage::Ready);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    ok(w.call(&m, &fx, &Call::Claim(secret), &op));
    let vault = fx.vault;
    w.set_tokens(&vault, 9);
    let tv = w.treasury_vault;
    w.set_frozen(&tv, true);
    let taker = fx.taker.insecure_clone();
    let treasury_before = w.tokens(&tv);
    ok(w.call(&m, &fx, &Call::CloseSwap, &taker));
    assert_eq!(w.tokens(&tv), treasury_before);
    assert!(!w.exists(&fx.vault));
}
