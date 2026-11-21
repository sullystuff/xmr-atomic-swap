//! Q2/Q4: escrow harness — SOL and SPL vaults, session key, deadlines, closes.
mod common;
use common::*;
use litesvm::LiteSVM;
use litesvm_token::{CreateAssociatedTokenAccount, CreateMint, MintTo};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

struct World {
    svm: LiteSVM,
    taker: Keypair,
    maker: Keypair,
    session: Keypair,
    s_maker: [u8; 32],
    s_taker: [u8; 32],
    lock: Lock,
    swap: Pubkey,
    session_lamports: u64,
}

fn world() -> World {
    let mut svm = setup();
    let taker = funded(&mut svm, 10 * SOL);
    let maker = funded(&mut svm, SOL);
    let session = Keypair::new(); // never airdropped: funded by the lock itself
    let (s_maker, maker_point) = key_share();
    let (s_taker, taker_point) = key_share();
    // A fee payer must stay rent-exempt (or hit exactly 0) after each tx.
    let session_lamports = svm.minimum_balance_for_rent_exemption(0) + 2 * FEE;
    let lock = Lock {
        swap_id: *b"swap0001",
        maker: maker.pubkey(),
        session_key: session.pubkey(),
        amount: SOL,
        maker_point,
        taker_point,
        refund_after: now(&svm) + 3600,
        session_lamports,
    };
    let swap = swap_pda(&taker.pubkey(), &lock.swap_id);
    World { svm, taker, maker, session, s_maker, s_taker, lock, swap, session_lamports }
}

#[test]
fn sol_lock_ready_claim() {
    let mut w = world();
    let (t, m) = (w.taker.pubkey(), w.maker.pubkey());
    let t0 = balance(&w.svm, &t);
    let m0 = balance(&w.svm, &m);

    send(&mut w.svm, &[lock_sol_ix(&t, &w.lock)], &[&w.taker]).unwrap();
    let swap_len = w.svm.get_account(&w.swap).unwrap().data.len();
    assert_eq!(swap_len, 8 + 218);
    let rent = w.svm.minimum_balance_for_rent_exemption(swap_len);
    assert_eq!(rent, 1_798_320, "matches `solana rent 226` on mainnet");
    assert_eq!(w.svm.minimum_balance_for_rent_exemption(0), 650_240);
    assert_eq!(balance(&w.svm, &w.swap), rent + SOL, "escrow sits in the swap PDA on top of rent");
    assert_eq!(balance(&w.svm, &t), t0 - SOL - rent - w.session_lamports - FEE);

    // maker cannot claim before ready, even with the right scalar
    assert_custom_err(send(&mut w.svm, &[claim_sol_ix(&m, &t, &w.swap, &w.s_maker)], &[&w.maker]), E_NOT_READY);

    // a stranger cannot set ready
    let stranger = funded(&mut w.svm, SOL);
    assert_custom_err(send(&mut w.svm, &[set_ready_ix(&stranger.pubkey(), &w.swap)], &[&stranger]), E_UNAUTHORIZED);

    // session key signs AND pays the fee: no wallet involved
    send(&mut w.svm, &[set_ready_ix(&w.session.pubkey(), &w.swap)], &[&w.session]).unwrap();

    // maker with the taker's scalar, or a stranger with the maker's scalar: no
    assert_custom_err(send(&mut w.svm, &[claim_sol_ix(&m, &t, &w.swap, &w.s_taker)], &[&w.maker]), E_SCALAR_MISMATCH);
    assert_custom_err(
        send(&mut w.svm, &[claim_sol_ix(&stranger.pubkey(), &t, &w.swap, &w.s_maker)], &[&stranger]),
        E_UNAUTHORIZED,
    );

    let t1 = balance(&w.svm, &t);
    let meta = send(&mut w.svm, &[claim_sol_ix(&m, &t, &w.swap, &w.s_maker)], &[&w.maker]).unwrap();
    println!("claim_sol: {} CU", meta.compute_units_consumed);
    assert_eq!(&logged_events(&meta, "Claimed")[0][32..64], &w.s_maker, "maker key half is now public");
    assert_eq!(balance(&w.svm, &m), m0 + SOL - 3 * FEE); // 2 failed attempts above also paid fees
    assert_eq!(balance(&w.svm, &t), t1 + rent, "swap rent returned to the taker");
    assert!(!exists(&w.svm, &w.swap));
}

#[test]
fn sol_refund_by_session_key_after_deadline() {
    let mut w = world();
    let (t, sk) = (w.taker.pubkey(), w.session.pubkey());
    let t0 = balance(&w.svm, &t);
    send(&mut w.svm, &[lock_sol_ix(&t, &w.lock)], &[&w.taker]).unwrap();

    // The session key holds rent-min + 2 fees. Failed txs still pay fees, so
    // top it up the way a taker UI would before letting it retry.
    send(
        &mut w.svm,
        &[solana_system_interface::instruction::transfer(&t, &sk, 10 * FEE)],
        &[&w.taker],
    )
    .unwrap();

    // too early
    assert_custom_err(send(&mut w.svm, &[refund_sol_ix(&sk, &t, &w.swap, &w.s_taker)], &[&w.session]), E_TOO_EARLY);

    // one second short, then exactly on the deadline
    warp_secs(&mut w.svm, 3599);
    assert_custom_err(send(&mut w.svm, &[refund_sol_ix(&sk, &t, &w.swap, &w.s_taker)], &[&w.session]), E_TOO_EARLY);
    warp_secs(&mut w.svm, 1);

    // wrong scalar; refund destination other than the taker
    assert_custom_err(send(&mut w.svm, &[refund_sol_ix(&sk, &t, &w.swap, &w.s_maker)], &[&w.session]), E_SCALAR_MISMATCH);
    let thief = funded(&mut w.svm, SOL);
    assert!(send(&mut w.svm, &[refund_sol_ix(&sk, &thief.pubkey(), &w.swap, &w.s_taker)], &[&w.session]).is_err());
    assert!(send(&mut w.svm, &[refund_sol_ix(&thief.pubkey(), &t, &w.swap, &w.s_taker)], &[&thief]).is_err());
    assert_eq!(balance(&w.svm, &thief.pubkey()), SOL - FEE);

    let meta = send(&mut w.svm, &[refund_sol_ix(&sk, &t, &w.swap, &w.s_taker)], &[&w.session]).unwrap();
    println!("refund_sol (session key, with sweep): {} CU", meta.compute_units_consumed);
    assert_eq!(&logged_events(&meta, "Refunded")[0][32..64], &w.s_taker);
    assert!(!exists(&w.svm, &w.swap));
    assert_eq!(balance(&w.svm, &sk), 0, "session key swept to zero");
    // Taker is out only the fees: lock + top-up (its own) and 5 session-key txs.
    assert_eq!(balance(&w.svm, &t), t0 - 2 * FEE - 5 * FEE);
}

#[test]
fn sol_refund_by_taker_wallet_also_works() {
    let mut w = world();
    let t = w.taker.pubkey();
    send(&mut w.svm, &[lock_sol_ix(&t, &w.lock)], &[&w.taker]).unwrap();
    warp_secs(&mut w.svm, 3600);
    send(&mut w.svm, &[refund_sol_ix(&t, &t, &w.swap, &w.s_taker)], &[&w.taker]).unwrap();
    assert!(!exists(&w.svm, &w.swap));
}

#[test]
fn session_key_funded_below_rent_minimum_fails_the_lock() {
    let mut w = world();
    w.lock.session_lamports = 2 * FEE; // looks like "enough for two fees"
    let res = send(&mut w.svm, &[lock_sol_ix(&w.taker.pubkey(), &w.lock)], &[&w.taker]);
    let err = res.expect_err("a system account cannot hold less than the rent minimum");
    println!("under-funded session key -> {:?}", err.err);

    // rent-min + exactly one fee: the first tx works, the second cannot pay,
    // because paying would leave the fee payer below the rent minimum.
    w.lock.session_lamports = w.svm.minimum_balance_for_rent_exemption(0) + FEE;
    w.svm.expire_blockhash();
    send(&mut w.svm, &[lock_sol_ix(&w.taker.pubkey(), &w.lock)], &[&w.taker]).unwrap();
    send(&mut w.svm, &[set_ready_ix(&w.session.pubkey(), &w.swap)], &[&w.session]).unwrap();
    warp_secs(&mut w.svm, 3600);
    let ix = refund_sol_ix(&w.session.pubkey(), &w.taker.pubkey(), &w.swap, &w.s_taker);
    let err = send(&mut w.svm, &[ix], &[&w.session]).expect_err("fee payer would drop below rent minimum");
    println!("session key with no fee headroom -> {:?}", err.err);
    assert!(exists(&w.svm, &w.swap));
}

#[test]
fn lock_rejects_bad_key_commitments_and_duplicate_ids() {
    let mut w = world();
    let t = w.taker.pubkey();
    let good = w.lock.maker_point;
    w.lock.maker_point = [0u8; 32]; // y = 0: a point of order 4
    assert_custom_err(send(&mut w.svm, &[lock_sol_ix(&t, &w.lock)], &[&w.taker]), E_BAD_COMMITMENT);
    w.lock.maker_point = good;
    send(&mut w.svm, &[lock_sol_ix(&t, &w.lock)], &[&w.taker]).unwrap();
    w.svm.expire_blockhash();
    assert!(send(&mut w.svm, &[lock_sol_ix(&t, &w.lock)], &[&w.taker]).is_err(), "same swap id = same PDA");
}

fn token_world() -> (World, Pubkey, Pubkey, Pubkey) {
    let mut w = world();
    let issuer = funded(&mut w.svm, SOL);
    let mint = CreateMint::new(&mut w.svm, &issuer).decimals(6).send().unwrap(); // USDC-like
    let taker_ata = CreateAssociatedTokenAccount::new(&mut w.svm, &issuer, &mint)
        .owner(&w.taker.pubkey())
        .send()
        .unwrap();
    let maker_ata = CreateAssociatedTokenAccount::new(&mut w.svm, &issuer, &mint)
        .owner(&w.maker.pubkey())
        .send()
        .unwrap();
    MintTo::new(&mut w.svm, &issuer, &mint, &taker_ata, 1_000_000_000).send().unwrap();
    w.lock.amount = 250_000_000; // 250 USDC
    (w, mint, taker_ata, maker_ata)
}

#[test]
fn token_lock_ready_claim() {
    let (mut w, mint, taker_ata, maker_ata) = token_world();
    let (t, m) = (w.taker.pubkey(), w.maker.pubkey());
    let vault = vault_pda(&w.swap);
    let t0 = balance(&w.svm, &t);

    let meta = send(&mut w.svm, &[lock_token_ix(&t, &mint, &taker_ata, &w.lock)], &[&w.taker]).unwrap();
    println!("lock_token: {} CU", meta.compute_units_consumed);
    assert_eq!(token_balance(&w.svm, &vault), 250_000_000);
    assert_eq!(token_balance(&w.svm, &taker_ata), 750_000_000);

    send(&mut w.svm, &[set_ready_ix(&w.session.pubkey(), &w.swap)], &[&w.session]).unwrap();

    // maker cannot redirect the payout to an account it does not own... it
    // can only name a token account whose owner is the maker
    assert!(send(&mut w.svm, &[claim_token_ix(&m, &t, &w.swap, &mint, &taker_ata, &w.s_taker)], &[&w.maker]).is_err());

    let meta = send(&mut w.svm, &[claim_token_ix(&m, &t, &w.swap, &mint, &maker_ata, &w.s_maker)], &[&w.maker]).unwrap();
    println!("claim_token: {} CU", meta.compute_units_consumed);
    assert_eq!(token_balance(&w.svm, &maker_ata), 250_000_000);
    assert!(!exists(&w.svm, &vault), "vault token account closed");
    assert!(!exists(&w.svm, &w.swap), "swap account closed");
    // both rents came back: the taker is out the lock fee and the session top-up only
    assert_eq!(balance(&w.svm, &t), t0 - FEE - w.session_lamports);
}

#[test]
fn token_refund_by_session_key() {
    let (mut w, mint, taker_ata, _maker_ata) = token_world();
    let (t, sk) = (w.taker.pubkey(), w.session.pubkey());
    let vault = vault_pda(&w.swap);
    let t0 = balance(&w.svm, &t);
    send(&mut w.svm, &[lock_token_ix(&t, &mint, &taker_ata, &w.lock)], &[&w.taker]).unwrap();

    assert_custom_err(
        send(&mut w.svm, &[refund_token_ix(&sk, &t, &w.swap, &mint, &taker_ata, &w.s_taker)], &[&w.session]),
        E_TOO_EARLY,
    );
    warp_secs(&mut w.svm, 3600);
    let meta = send(&mut w.svm, &[refund_token_ix(&sk, &t, &w.swap, &mint, &taker_ata, &w.s_taker)], &[&w.session]).unwrap();
    println!("refund_token (session key, with sweep): {} CU", meta.compute_units_consumed);
    assert_eq!(token_balance(&w.svm, &taker_ata), 1_000_000_000);
    assert!(!exists(&w.svm, &vault) && !exists(&w.svm, &w.swap));
    assert_eq!(balance(&w.svm, &sk), 0);
    assert_eq!(balance(&w.svm, &t), t0 - FEE - 2 * FEE, "only fees were spent");
}

#[test]
fn slot_and_timestamp_are_independent_sysvar_fields() {
    let mut svm = setup();
    let c0: solana_clock::Clock = svm.get_sysvar();
    svm.warp_to_slot(c0.slot + 1_000_000);
    let c1: solana_clock::Clock = svm.get_sysvar();
    assert_eq!(c1.slot, c0.slot + 1_000_000);
    assert_eq!(c1.unix_timestamp, c0.unix_timestamp, "warp_to_slot does not move unix_timestamp");
}
