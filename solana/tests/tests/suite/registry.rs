//! Admin and registry instructions (SPEC 4.3) and the checks of `lock` / `take` that the
//! state-machine vectors do not reach (SPEC 4.4): the offer, the key pool, quotes, pausing,
//! encryption-key versions, the asset and its accounts, messages.
use crate::common::*;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

// ------------------------------------------------------------------ initialize and admin

#[test]
fn initialize_requires_the_programs_upgrade_authority() {
    let mut svm = base_svm();
    let authority = funded(&mut svm, 10 * SOL);
    let impostor = funded(&mut svm, 10 * SOL);
    let issuer = funded(&mut svm, 10 * SOL);
    let mint = litesvm_token::CreateMint::new(&mut svm, &issuer).decimals(6).send().unwrap();
    let tag = [7u8; 32];
    let send = |svm: &mut litesvm::LiteSVM, ix: Instruction, signer: &Keypair| {
        let msg = solana_message::Message::new(&[ix], Some(&signer.pubkey()));
        let tx = solana_transaction::Transaction::new(&[signer], msg, svm.latest_blockhash());
        let res = svm.send_transaction(tx);
        svm.expire_blockhash();
        res
    };

    // LiteSVM loads the program with no upgrade authority: nobody can initialize.
    let ix = initialize_ix(&authority.pubkey(), &mint, &tag, &authority.pubkey(), 0);
    assert_err(send(&mut svm, ix.clone(), &authority), "Unauthorized");
    // With an authority set, only that key.
    set_upgrade_authority(&mut svm, Some(&authority.pubkey()));
    let bad = initialize_ix(&impostor.pubkey(), &mint, &tag, &impostor.pubkey(), 0);
    assert_err(send(&mut svm, bad, &impostor), "Unauthorized");
    // Another account in the ProgramData slot (one the impostor controls the contents of).
    let mut bad = initialize_ix(&impostor.pubkey(), &mint, &tag, &impostor.pubkey(), 0);
    bad.accounts[6].pubkey = impostor.pubkey();
    assert_err(send(&mut svm, bad, &impostor), "Unauthorized");
    // A split mode that does not exist.
    let bad = initialize_ix(&authority.pubkey(), &mint, &tag, &authority.pubkey(), 2);
    assert!(send(&mut svm, bad, &authority).is_err());

    ok(send(&mut svm, ix.clone(), &authority));
    let config = svm.get_account(&pda(&[b"config"])).unwrap();
    assert_eq!(config.data.len(), 256);
    assert_eq!(config.data[8..40], authority.pubkey().to_bytes(), "admin = the signer");
    assert_eq!(config.data[40..72], authority.pubkey().to_bytes(), "treasury authority");
    assert_eq!(config.data[72..104], tag, "cluster tag");
    assert_eq!(config.data[104..136], mint.to_bytes(), "usdc mint");
    assert_eq!(config.data[136], 0, "split mode");
    assert_eq!(svm.get_account(&pda(&[b"treasury"])).unwrap().data.len(), 16);
    let vault = svm.get_account(&pda(&[b"treasury_vault", mint.as_ref()])).unwrap();
    assert_eq!(vault.owner, TOKEN);
    assert_eq!(vault.data[..32], mint.to_bytes());
    assert_eq!(vault.data[32..64], pda(&[b"treasury"]).to_bytes(), "the Treasury PDA is its authority");
    // Once.
    assert!(send(&mut svm, ix, &authority).is_err());
}

#[test]
fn admin_setters_and_freeze() {
    let mut w = World::new();
    let admin = w.admin.insecure_clone();
    let stranger = w.stranger.insecure_clone();
    let new_authority = Pubkey::new_unique();
    let set_ta = |w: &World, who: &Keypair, to: &Pubkey| w.admin_ix(&who.pubkey(), Enc::ix("set_treasury_authority").key(to).0);

    assert_err(w.send(&[set_ta(&w, &stranger, &new_authority)], &[&stranger]), "Unauthorized");
    ok(w.send(&[set_ta(&w, &admin, &new_authority)], &[&admin]));
    assert_eq!(w.data(&w.config)[40..72], new_authority.to_bytes());

    let split = |w: &World, who: &Keypair, mode: u8| w.admin_ix(&who.pubkey(), Enc::ix("set_split_mode").u8(mode).0);
    ok(w.send(&[split(&w, &admin, 1)], &[&admin]));
    assert_eq!(w.data(&w.config)[136], 1);
    assert!(w.send(&[split(&w, &admin, 2)], &[&admin]).is_err());
    assert_err(w.send(&[split(&w, &stranger, 0)], &[&stranger]), "Unauthorized");

    // transfer_admin: the old admin loses the role.
    let next = w.fund(SOL);
    let ix = w.admin_ix(&admin.pubkey(), Enc::ix("transfer_admin").key(&next.pubkey()).0);
    ok(w.send(&[ix], &[&admin]));
    assert_err(w.send(&[split(&w, &admin, 0)], &[&admin]), "Unauthorized");
    ok(w.send(&[split(&w, &next, 0)], &[&next]));
    // Not to the default key: that is what freeze_config is for.
    let ix = w.admin_ix(&next.pubkey(), Enc::ix("transfer_admin").key(&Pubkey::default()).0);
    assert!(w.send(&[ix], &[&next]).is_err());

    // freeze_config: afterwards the four fail forever, for everyone.
    let freeze = |w: &World, who: &Keypair| w.admin_ix(&who.pubkey(), Enc::ix("freeze_config").0);
    assert_err(w.send(&[freeze(&w, &admin)], &[&admin]), "Unauthorized");
    ok(w.send(&[freeze(&w, &next)], &[&next]));
    assert_eq!(w.data(&w.config)[8..40], [0u8; 32]);
    for who in [&next, &admin, &stranger] {
        assert_err(w.send(&[split(&w, who, 1)], &[who]), "ConfigFrozen");
        assert_err(w.send(&[set_ta(&w, who, &new_authority)], &[who]), "ConfigFrozen");
        assert_err(w.send(&[freeze(&w, who)], &[who]), "ConfigFrozen");
        let ix = w.admin_ix(&who.pubkey(), Enc::ix("transfer_admin").key(&who.pubkey()).0);
        assert_err(w.send(&[ix], &[who]), "ConfigFrozen");
    }
    // The program keeps working when frozen.
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Ready);
    let op = m.operator.insecure_clone();
    let secret = w.maker_secret(&m, &fx);
    ok(w.call(&m, &fx, &Call::Claim(secret), &op));
}

#[test]
fn sweep_treasury_moves_fees_and_never_touches_the_rent_minimum() {
    let mut w = World::new();
    let authority = w.treasury_authority.insecure_clone();
    let stranger = w.stranger.insecure_clone();
    let rent = w.rent(16);
    assert_eq!(w.lamports(&w.treasury), rent);
    // Collect a SOL fee and a USDC fee.
    for asset in [ASSET_SOL, ASSET_USDC] {
        let (m, fx) = w.swap_at(asset, DIR_A, &Terms::default(), Stage::Ready);
        let op = m.operator.insecure_clone();
        let secret = w.maker_secret(&m, &fx);
        ok(w.call(&m, &fx, &Call::Claim(secret), &op));
    }
    assert_eq!(w.lamports(&w.treasury), rent + 750_000);
    assert_eq!(w.tokens(&w.treasury_vault), 750_000);

    let dest = w.fund(SOL);
    let dest_token = w.make_ata(&dest.pubkey());
    let ix = w.sweep_treasury_ix(&stranger.pubkey(), ASSET_SOL, 1, &dest.pubkey());
    assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");
    let ix = w.sweep_treasury_ix(&w.admin.pubkey(), ASSET_SOL, 1, &dest.pubkey());
    let admin = w.admin.insecure_clone();
    assert_err(w.send(&[ix], &[&admin]), "Unauthorized");
    // One lamport more than the fees: refused. Exactly the fees: the account keeps its rent.
    let ix = w.sweep_treasury_ix(&authority.pubkey(), ASSET_SOL, 750_001, &dest.pubkey());
    assert_err(w.send(&[ix], &[&authority]), "AmountOutOfRange");
    let ix = w.sweep_treasury_ix(&authority.pubkey(), ASSET_SOL, 750_000, &dest.pubkey());
    let res = ok(w.send(&[ix], &[&authority]));
    assert_eq!(w.lamports(&w.treasury), rent);
    assert_eq!(w.lamports(&dest.pubkey()), SOL + 750_000);
    assert_eq!(logged_events(&res, "TreasurySwept").len(), 1);

    let ix = w.sweep_treasury_ix(&authority.pubkey(), ASSET_USDC, 750_001, &dest_token);
    assert!(w.send(&[ix], &[&authority]).is_err());
    let ix = w.sweep_treasury_ix(&authority.pubkey(), ASSET_USDC, 500_000, &dest_token);
    ok(w.send(&[ix], &[&authority]));
    assert_eq!((w.tokens(&dest_token), w.tokens(&w.treasury_vault)), (500_000, 250_000));
    let ix = w.sweep_treasury_ix(&authority.pubkey(), 2, 1, &dest_token);
    assert_err(w.send(&[ix], &[&authority]), "WrongAsset");
}

// ------------------------------------------------------------------ the maker record

#[test]
fn maker_record_setters_and_their_signers() {
    let mut w = World::new();
    let m = w.register_maker();
    let (owner, op, stranger) = (m.owner.insecure_clone(), m.operator.insecure_clone(), w.stranger.insecure_clone());
    let mk = w.maker(&m.pda);
    assert_eq!((mk.owner, mk.operator, mk.payout), (owner.pubkey(), op.pubkey(), m.payout.pubkey()));
    assert_eq!((mk.enc_key, mk.enc_key_version, mk.registered_at, mk.registered_slot > 0), (m.enc_key, 1, w.now(), true));
    assert_eq!((mk.approval_epoch, mk.quote_epoch, mk.paused, mk.open_pending), (0, 0, 0, 0));
    assert_eq!(w.data(&m.pda)[..8], account_disc("Maker"), "the Maker discriminator clients filter on");
    assert_eq!(account_disc("Maker"), [31, 255, 232, 61, 38, 28, 189, 147]);
    assert_eq!(account_disc("Swap"), [53, 206, 146, 152, 44, 97, 120, 177]);

    let ix = |w: &World, who: &Keypair, data: Vec<u8>| w.maker_ix(&who.pubkey(), &m.pda, data);
    let new_key = Pubkey::new_unique();
    // Owner-only: operator, payout, link.
    for data in [
        Enc::ix("set_operator").key(&new_key).0,
        Enc::ix("set_payout").key(&new_key).0,
        Enc::ix("set_eth_link").bytes(&[1; 20]).0,
    ] {
        assert_err(w.send(&[ix(&w, &op, data.clone())], &[&op]), "Unauthorized");
        assert_err(w.send(&[ix(&w, &stranger, data)], &[&stranger]), "Unauthorized");
    }
    // Operator-only: encryption key, onion, contacts, inbox policy.
    for data in [
        Enc::ix("rotate_enc_key").bytes(&rand32()).i64(w.now() + 10).0,
        Enc::ix("set_onion").vec(b"").0,
        Enc::ix("set_contacts").u32(0).0,
        Enc::ix("set_inbox_policy").u8(1).0,
    ] {
        assert_err(w.send(&[ix(&w, &owner, data.clone())], &[&owner]), "Unauthorized");
        assert_err(w.send(&[ix(&w, &stranger, data)], &[&stranger]), "Unauthorized");
    }
    // Owner or operator: pause, epochs.
    for data in [Enc::ix("set_paused").bool(true).0, Enc::ix("bump_epochs").bool(true).bool(true).0] {
        assert_err(w.send(&[ix(&w, &stranger, data)], &[&stranger]), "Unauthorized");
    }

    ok(w.send(&[ix(&w, &owner, Enc::ix("set_payout").key(&new_key).0)], &[&owner]));
    assert_eq!(w.maker(&m.pda).payout, new_key);

    // bump_epochs: each flag moves its own epoch.
    ok(w.send(&[ix(&w, &op, Enc::ix("bump_epochs").bool(true).bool(false).0)], &[&op]));
    ok(w.send(&[ix(&w, &owner, Enc::ix("bump_epochs").bool(false).bool(true).0)], &[&owner]));
    ok(w.send(&[ix(&w, &owner, Enc::ix("bump_epochs").bool(false).bool(true).0)], &[&owner]));
    let mk = w.maker(&m.pda);
    assert_eq!((mk.approval_epoch, mk.quote_epoch), (1, 2));

    // set_operator: the old key loses the role at once and both epochs move.
    let next = w.fund(SOL);
    ok(w.send(&[ix(&w, &owner, Enc::ix("set_operator").key(&next.pubkey()).0)], &[&owner]));
    let mk = w.maker(&m.pda);
    assert_eq!((mk.operator, mk.approval_epoch, mk.quote_epoch), (next.pubkey(), 2, 3));
    assert_err(w.send(&[ix(&w, &op, Enc::ix("set_inbox_policy").u8(1).0)], &[&op]), "Unauthorized");
    ok(w.send(&[ix(&w, &next, Enc::ix("set_inbox_policy").u8(1).0)], &[&next]));
    assert_eq!(w.maker(&m.pda).inbox_policy, 1);

    // Onion: 56 base32 characters + ".onion", or empty.
    let good = format!("{}.onion", "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx");
    assert_eq!(good.len(), 62);
    ok(w.send(&[ix(&w, &next, Enc::ix("set_onion").vec(good.as_bytes()).0)], &[&next]));
    assert_eq!(w.maker(&m.pda).onion, good);
    for bad in [
        "short.onion".to_string(),
        good.replace(".onion", ".onio1"),
        good.replace('a', "A"),
        good.replace('2', "1"),
        format!("{good}x"),
    ] {
        assert_err(w.send(&[ix(&w, &next, Enc::ix("set_onion").vec(bad.as_bytes()).0)], &[&next]), "OnionInvalid");
    }
    ok(w.send(&[ix(&w, &next, Enc::ix("set_onion").vec(b"").0)], &[&next]));
    assert_eq!(w.maker(&m.pda).onion, "");

    // Contacts: at most 6, each at most 96 bytes; the list is replaced.
    let contacts = |list: &[(u8, String)]| {
        let mut e = Enc::ix("set_contacts").u32(list.len() as u32);
        for (kind, value) in list {
            e = e.u8(*kind).vec(value.as_bytes());
        }
        e.0
    };
    let six: Vec<(u8, String)> = (0..6).map(|i| (i as u8, format!("https://example.invalid/{i}"))).collect();
    ok(w.send(&[ix(&w, &next, contacts(&six))], &[&next]));
    assert_eq!(w.maker(&m.pda).contacts, six);
    let mut seven = six.clone();
    seven.push((255, "x".into()));
    assert_err(w.send(&[ix(&w, &next, contacts(&seven))], &[&next]), "ContactsTooLong");
    assert_err(w.send(&[ix(&w, &next, contacts(&[(1, "y".repeat(97))]))], &[&next]), "ContactsTooLong");
    ok(w.send(&[ix(&w, &next, contacts(&[(1, "y".repeat(96))]))], &[&next]));
    assert_eq!(w.maker(&m.pda).contacts.len(), 1);
    // The fixed fields did not move: clients filter on these offsets.
    let mk = w.maker(&m.pda);
    assert_eq!((mk.owner, mk.operator), (owner.pubkey(), next.pubkey()));
    assert_eq!(w.data(&m.pda).len(), 1280);
}

#[test]
fn identity_link_first_is_immediate_and_changes_wait_seven_days() {
    let mut w = World::new();
    let m = w.register_maker();
    let owner = m.owner.insecure_clone();
    let link = |w: &mut World, address: [u8; 20]| {
        let ix = w.maker_ix(&owner.pubkey(), &m.pda, Enc::ix("set_eth_link").bytes(&address).0);
        ok(w.send(&[ix], &[&owner]))
    };
    let res = link(&mut w, [1; 20]);
    let mk = w.maker(&m.pda);
    assert_eq!((mk.eth_link, mk.eth_link_next, mk.eth_link_next_at), ([1; 20], [0; 20], 0));
    assert_eq!(logged_events(&res, "LinkChanged").len(), 1);

    // A change is pending for LINK_DELAY_SECS; readers treat it as current from then on.
    let t = w.now();
    link(&mut w, [2; 20]);
    let mk = w.maker(&m.pda);
    assert_eq!((mk.eth_link, mk.eth_link_next, mk.eth_link_next_at), ([1; 20], [2; 20], t + 604_800));
    // A second change before it matures replaces the pending one and restarts the delay.
    w.warp(100);
    link(&mut w, [3; 20]);
    let mk = w.maker(&m.pda);
    assert_eq!((mk.eth_link, mk.eth_link_next, mk.eth_link_next_at), ([1; 20], [3; 20], t + 100 + 604_800));
    // After it matures the next call promotes it first; an unlink (zeros) is delayed too.
    w.set_time(t + 100 + 604_800);
    let t2 = w.now();
    link(&mut w, [0; 20]);
    let mk = w.maker(&m.pda);
    assert_eq!((mk.eth_link, mk.eth_link_next, mk.eth_link_next_at), ([3; 20], [0; 20], t2 + 604_800));
    w.set_time(t2 + 604_800);
    // Matured unlink, then a new first link: immediate again.
    link(&mut w, [4; 20]);
    let mk = w.maker(&m.pda);
    assert_eq!((mk.eth_link, mk.eth_link_next_at), ([4; 20], 0));
}

#[test]
fn pausing_stops_new_swaps_and_each_key_clears_only_its_own_bit() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    let (owner, op) = (m.owner.insecure_clone(), m.operator.insecure_clone());
    let pause = |w: &mut World, who: &Keypair, on: bool| {
        let ix = w.maker_ix(&who.pubkey(), &m.pda, Enc::ix("set_paused").bool(on).0);
        ok(w.send(&[ix], &[who]));
        w.maker(&m.pda).paused
    };
    let try_lock = |w: &mut World| {
        let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
        w.send_open(&fx, &raw)
    };
    // A swap opened before the pause is unaffected by it.
    let mut open_before = w.open(&m, ASSET_SOL, DIR_A, XMR);

    assert_eq!(pause(&mut w, &op, true), 0b10);
    assert_err(try_lock(&mut w), "Paused");
    assert_eq!(pause(&mut w, &owner, true), 0b11);
    assert_eq!(pause(&mut w, &op, false), 0b01, "the operator cannot lift the owner's pause");
    assert_err(try_lock(&mut w), "Paused");
    assert_eq!(pause(&mut w, &owner, false), 0);
    ok(try_lock(&mut w));

    assert_eq!(pause(&mut w, &owner, true), 0b01);
    ok(w.notice(&m, &mut open_before));
    assert_eq!(w.swap(&open_before.pda).unwrap().state, NOTICED);
}

#[test]
fn encryption_key_versions_at_lock() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    ok(w.refill(&mut m, ASSET_SOL, 2, 6));
    let op = m.operator.insecure_clone();
    let key1 = m.enc_key;
    let (key2, key3) = (rand32(), rand32());
    let rotate = |w: &mut World, key: [u8; 32], prev_expires_at: i64| {
        let ix = w.maker_ix(&op.pubkey(), &m.pda, Enc::ix("rotate_enc_key").bytes(&key).i64(prev_expires_at).0);
        w.send(&[ix], &[&op])
    };
    let lock_with = |w: &mut World, version: u32| {
        ok(w.refresh(&m, &[(ASSET_SOL, DIR_A, true, [PRICE, 0, 0], 100 * XMR)]));
        let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
        raw.maker_enc_version = version;
        (w.send_open(&fx, &raw), fx.pda)
    };

    // The previous key's expiry cannot be in the past.
    let past = w.now() - 1;
    assert_err(rotate(&mut w, key2, past), "TooLate");
    let expiry = w.now() + 600;
    let res = ok(rotate(&mut w, key2, expiry));
    let ev = &logged_events(&res, "EncKeyRotated")[0];
    assert_eq!(ev[36..68], key2, "the event carries the new key");

    // Version 2 (current) and version 1 (previous, not yet expired) are accepted, and the swap
    // stores the key of the version the taker used.
    let (res, swap) = lock_with(&mut w, 2);
    ok(res);
    let s = w.swap(&swap).unwrap();
    assert_eq!((s.maker_enc_version, s.maker_enc_key), (2, key2));
    let (res, swap) = lock_with(&mut w, 1);
    ok(res);
    let s = w.swap(&swap).unwrap();
    assert_eq!((s.maker_enc_version, s.maker_enc_key), (1, key1));
    // Versions that do not exist.
    assert_err(lock_with(&mut w, 0).0, "StaleKeyVersion");
    assert_err(lock_with(&mut w, 3).0, "StaleKeyVersion");
    // The previous version dies at its expiry: valid while now < prev_enc_key_expires_at.
    w.set_time(expiry - 1);
    ok(lock_with(&mut w, 1).0);
    w.set_time(expiry);
    assert_err(lock_with(&mut w, 1).0, "StaleKeyVersion");
    ok(lock_with(&mut w, 2).0);
    // After a second rotation version 1 is gone whatever the clock says; an in-flight swap
    // keeps the key it stored.
    let later = w.now() + 10_000;
    ok(rotate(&mut w, key3, later));
    assert_err(lock_with(&mut w, 1).0, "StaleKeyVersion");
    ok(lock_with(&mut w, 2).0);
    assert_eq!(w.swap(&swap).unwrap().maker_enc_key, key1);
    assert_eq!(w.maker(&m.pda).enc_key_version, 3);
}

// ------------------------------------------------------------------ offers and the key pool

#[test]
fn terms_json_and_the_offer_account() {
    let v = vectors("terms");
    let three = |a: &serde_json::Value| -> [u64; 3] {
        let a = a.as_array().unwrap();
        [num(&a[0]), num(&a[1]), num(&a[2])]
    };
    let mut on_chain = 0;
    for case in v["cases"].as_array().unwrap() {
        let i = &case["input"];
        let u = |k: &str| i[k].as_u64().unwrap();
        let depths: Vec<u8> = i["depths"].as_array().unwrap().iter().map(|d| d.as_u64().unwrap() as u8).collect();
        let terms = Terms {
            mode: u("mode") as u8,
            depth_above: three(&i["depth_above"]),
            depths: [depths[0], depths[1], depths[2]],
            dep_bps: u("dep_bps") as u16,
            w_a: u("w_a") as u32,
            w_n: u("w_n") as u32,
            d_c: u("d_c") as u32,
            w_c: u("w_c") as u32,
            w_f: u("w_f") as u32,
            ..Terms::default()
        };
        let (asset, direction) = (u("asset") as u8, u("direction") as u8);
        if u("fee_bps") == 5 {
            assert_eq!(terms.hash(asset, direction), h32(&case["output"]["terms_hash"]), "{}", case["name"]);
        }
        // Terms the program can publish: the hash it stores is the vector's.
        let mut w = World::new();
        let m = w.register_maker();
        match w.set_offer(&m, asset, direction, &terms) {
            Ok(res) => {
                let offer = w.offer(&w.offer_pda(&m.pda, asset, direction));
                assert_eq!(offer.terms_hash, h32(&case["output"]["terms_hash"]), "{}", case["name"]);
                assert_eq!(logged_events(&res, "OfferSet")[0][42..74], offer.terms_hash);
                on_chain += 1;
            }
            // "extremes" uses values no offer may carry (a 655% deposit, a fee field of 65,535).
            Err(_) => assert_eq!(case["name"], "extremes"),
        }
    }
    assert_eq!(on_chain, 6);
}

#[test]
fn set_offer_and_refresh_offers() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let other = w.register_maker();
    let (op, stranger) = (m.operator.insecure_clone(), w.stranger.insecure_clone());
    let terms = Terms::default();

    // Only the operator; the offer PDA is derived from the maker, the asset and the direction.
    let mut ix = w.set_offer_ix(&m, ASSET_SOL, DIR_A, &terms);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");
    let mut ix = w.set_offer_ix(&m, ASSET_SOL, DIR_A, &terms);
    ix.accounts[2].pubkey = w.offer_pda(&m.pda, ASSET_USDC, DIR_A);
    assert!(w.send(&[ix], &[&op]).is_err());
    assert_err(w.set_offer(&m, 2, DIR_A, &terms), "WrongAsset");
    assert_err(w.set_offer(&m, ASSET_SOL, 2, &terms), "WrongDirection");
    assert!(w.set_offer(&m, ASSET_SOL, DIR_A, &Terms { mode: 3, ..terms.clone() }).is_err());
    assert_err(w.set_offer(&m, ASSET_SOL, DIR_A, &Terms { min_xmr: 10, max_xmr: 9, ..terms.clone() }), "AmountOutOfRange");

    ok(w.set_offer(&m, ASSET_SOL, DIR_A, &terms));
    let key = w.offer_pda(&m.pda, ASSET_SOL, DIR_A);
    let o = w.offer(&key);
    assert_eq!((o.maker, o.asset, o.direction, o.seq, o.enabled, o.prices), (m.pda, ASSET_SOL, DIR_A, 1, 0, [0; 3]));
    assert_eq!(o.terms_hash, terms.hash(ASSET_SOL, DIR_A));
    assert_eq!(w.data(&key).len(), 768);

    // Not live until refreshed.
    ok(w.refill(&mut m, ASSET_SOL, 0, 2));
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(key));
    assert_err(w.send_open(&fx, &raw), "OfferDisabled");
    ok(w.refresh(&m, &[(ASSET_SOL, DIR_A, true, [PRICE, 0, 0], 3 * XMR)]));
    let o = w.offer(&key);
    assert_eq!((o.seq, o.enabled, o.prices, o.capacity_xmr, o.updated_at), (2, 1, [PRICE, 0, 0], 3 * XMR, w.now()));
    ok(w.send_open(&fx, &raw));
    assert_eq!(w.offer(&key).capacity_xmr, 2 * XMR, "an ACTIVE lock consumes capacity");

    // A change of terms: seq moves, prices are zeroed, the offer is off until the next refresh,
    // and a taker pinned to the old terms is refused.
    let changed = Terms { d_c: 5_401, ..terms.clone() };
    ok(w.set_offer(&m, ASSET_SOL, DIR_A, &changed));
    let o = w.offer(&key);
    assert_eq!((o.seq, o.enabled, o.prices, o.pool_filled), (3, 0, [0; 3], 0b11), "the pool survives a terms change");
    ok(w.refresh(&m, &[(ASSET_SOL, DIR_A, true, [PRICE, 0, 0], 3 * XMR)]));
    let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(key));
    raw.terms_hash = terms.hash(ASSET_SOL, DIR_A);
    assert_err(w.send_open(&fx, &raw), "TermsChanged");
    raw.terms_hash = changed.hash(ASSET_SOL, DIR_A);
    raw.min_seq = 5;
    assert_err(w.send_open(&fx, &raw), "SeqTooOld");
    raw.min_seq = 4;
    ok(w.send_open(&fx, &raw));

    // refresh_offers: several offers in one transaction, in the order of the arguments.
    ok(w.set_offer(&m, ASSET_USDC, DIR_B, &terms));
    ok(w.refresh(&m, &[(ASSET_USDC, DIR_B, true, [7, 0, 0], 9), (ASSET_SOL, DIR_A, false, [8, 0, 0], 10)]));
    let (b, a) = (w.offer(&w.offer_pda(&m.pda, ASSET_USDC, DIR_B)), w.offer(&key));
    assert_eq!((b.prices[0], b.capacity_xmr, b.enabled, b.seq), (7, 9, 1, 2));
    assert_eq!((a.prices[0], a.capacity_xmr, a.enabled, a.seq), (8, 10, 0, 5));
    // The accounts must be the offers the arguments name, and this maker's.
    let mut ix = w.refresh_ix(&m, &[(ASSET_USDC, DIR_B, true, [7, 0, 0], 9)]);
    ix.accounts[3].pubkey = key;
    assert_err(w.send(&[ix], &[&op]), "WrongAsset");
    ok(w.set_offer(&other, ASSET_USDC, DIR_B, &terms));
    let mut ix = w.refresh_ix(&m, &[(ASSET_USDC, DIR_B, true, [7, 0, 0], 9)]);
    ix.accounts[3].pubkey = w.offer_pda(&other.pda, ASSET_USDC, DIR_B);
    assert_err(w.send(&[ix], &[&op]), "Unauthorized");
    let mut ix = w.refresh_ix(&m, &[(ASSET_USDC, DIR_B, true, [7, 0, 0], 9)]);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");
    // Fewer accounts than offers.
    let mut ix = w.refresh_ix(&m, &[(ASSET_USDC, DIR_B, true, [7, 0, 0], 9)]);
    ix.accounts.pop();
    assert!(w.send(&[ix], &[&op]).is_err());
}

#[test]
fn lock_checks_against_the_offer() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let other = w.register_maker();
    let terms = Terms { min_xmr: XMR / 2, max_xmr: 2 * XMR, ..Terms::default() };
    let a = w.live_offer(&mut m, ASSET_SOL, DIR_A, &terms, PRICE);
    let b = w.live_offer(&mut m, ASSET_SOL, DIR_B, &terms, PRICE);
    let usdc = w.live_offer(&mut m, ASSET_USDC, DIR_A, &terms, PRICE);
    let attempt = |w: &mut World, asset: u8, direction: u8, offer: Pubkey, change: &dyn Fn(&mut World, &mut OpenRaw)| {
        let (fx, mut raw) = w.prepare_open(&m, asset, direction, XMR, Source::Offer(offer));
        change(w, &mut raw);
        w.send_open(&fx, &raw)
    };

    // Size limits of the offer.
    assert_err(attempt(&mut w, ASSET_SOL, DIR_A, a, &|_, r| r.xmr = XMR / 2 - 1), "AmountOutOfRange");
    assert_err(attempt(&mut w, ASSET_SOL, DIR_A, a, &|_, r| r.xmr = 2 * XMR + 1), "AmountOutOfRange");
    // The offer must be the maker's, for this direction and this asset.
    assert_err(attempt(&mut w, ASSET_SOL, DIR_A, b, &|_, _| {}), "WrongDirection");
    assert_err(attempt(&mut w, ASSET_SOL, DIR_B, a, &|_, _| {}), "WrongDirection");
    assert_err(attempt(&mut w, ASSET_SOL, DIR_A, usdc, &|_, _| {}), "WrongAsset");
    assert_err(attempt(&mut w, ASSET_SOL, DIR_A, a, &|_, r| r.maker = other.pda), "Unauthorized");
    // Token accounts are present iff the asset is USDC.
    assert_err(attempt(&mut w, ASSET_USDC, DIR_A, usdc, &|_, r| r.token = None), "WrongAsset");
    assert_err(
        attempt(&mut w, ASSET_SOL, DIR_A, a, &|w, r| {
            let taker_token = w.mint_to(&r.taker, 10_000_000_000);
            r.token = Some((w.mint, taker_token, pda(&[b"vault", r.swap.as_ref()]), TOKEN));
        }),
        "WrongAsset"
    );
    assert_err(attempt(&mut w, 2, DIR_A, a, &|_, r| r.asset = 2), "WrongAsset");
    // Only Config.usdc_mint: another mint is refused even with matching token accounts.
    let issuer = w.issuer.insecure_clone();
    let fake = litesvm_token::CreateMint::new(&mut w.svm, &issuer).decimals(6).send().unwrap();
    let res = attempt(&mut w, ASSET_USDC, DIR_A, usdc, &|w, r| {
        let taker_token = litesvm_token::CreateAssociatedTokenAccount::new(&mut w.svm, &issuer, &fake).owner(&r.taker).send().unwrap();
        litesvm_token::MintTo::new(&mut w.svm, &issuer, &fake, &taker_token, 10_000_000_000).send().unwrap();
        r.token = Some((fake, taker_token, r.token.unwrap().2, TOKEN));
    });
    assert_err(res, "MintNotAllowed");
    // Exactly one of offer and quote.
    let (fx, raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(a));
    let mut ix = w.open_ix(&raw);
    ix.accounts[6] = opt(None, true);
    assert_err(w.send(&[ix], &[&fx.taker]), "BadState");
    // A swap PDA that is not the taker's for this nonce.
    let mut ix = w.open_ix(&raw);
    ix.accounts[1].pubkey = pda(&[b"swap", fx.taker.pubkey().as_ref(), &[9u8; 16]]);
    assert!(w.send(&[ix], &[&fx.taker]).is_err());
    ok(w.send_open(&fx, &raw));
}

#[test]
fn the_key_pool() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let op = m.operator.insecure_clone();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE); // slots 0 and 1
    w.live_offer(&mut m, ASSET_SOL, DIR_B, &Terms::default(), PRICE);
    let ctx = m.pda.to_bytes();
    let slot = |index: u8| {
        let (s, s_pub) = new_share();
        (index, s_pub, pok_prove(&s, &ctx))
    };

    // A published, untaken share cannot be replaced under a taker's feet.
    let ix = w.refill_ix(&m, ASSET_SOL, &[slot(1)]);
    assert_err(w.send(&[ix], &[&op]), "KeySlotBusy");
    // At most eight per call, at least one, indexes below 16, direction-A offers only.
    let nine: Vec<_> = (2..11).map(slot).collect();
    let ix = w.refill_ix(&m, ASSET_SOL, &nine);
    assert!(w.send(&[ix], &[&op]).is_err());
    let ix = w.refill_ix(&m, ASSET_SOL, &[]);
    assert!(w.send(&[ix], &[&op]).is_err());
    let ix = w.refill_ix(&m, ASSET_SOL, &[slot(16)]);
    assert!(w.send(&[ix], &[&op]).is_err());
    let mut ix = w.refill_ix(&m, ASSET_SOL, &[slot(5)]);
    ix.accounts[2].pubkey = w.offer_pda(&m.pda, ASSET_SOL, DIR_B);
    assert_err(w.send(&[ix], &[&op]), "WrongDirection");
    let ix = w.refill_ix(&m, ASSET_USDC, &[slot(5)]);
    let mut ix = ix;
    ix.accounts[2].pubkey = offer;
    assert_err(w.send(&[ix], &[&op]), "WrongAsset");
    let stranger = w.stranger.insecure_clone();
    let mut ix = w.refill_ix(&m, ASSET_SOL, &[slot(5)]);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");

    // key_hint is only a hint: the first filled, unused slot at or after it, wrapping.
    let pool = w.offer(&offer).pool;
    let lock = |w: &mut World, hint: u8| {
        let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
        raw.key_hint = hint;
        (w.send_open(&fx, &raw), fx.pda)
    };
    let (res, swap) = lock(&mut w, 1);
    ok(res);
    assert_eq!(w.swap(&swap).unwrap().maker_spend_pub, pool[1]);
    let (res, swap) = lock(&mut w, 1); // slot 1 is used: wraps to slot 0
    ok(res);
    assert_eq!(w.swap(&swap).unwrap().maker_spend_pub, pool[0]);
    let o = w.offer(&offer);
    assert_eq!((o.pool_filled, o.pool_used), (0b11, 0b11));
    // No share left: the lock is refused; nothing is reserved.
    assert_err(lock(&mut w, 0).0, "NoKeyAvailable");
    assert_err(lock(&mut w, 200).0, "NoKeyAvailable");
    // A used slot can be refilled; the new share is handed out once.
    let fresh = slot(1);
    let ix = w.refill_ix(&m, ASSET_SOL, &[fresh]);
    let res = ok(w.send(&[ix], &[&op]));
    assert_eq!(logged_events(&res, "KeysRefilled").len(), 1);
    let o = w.offer(&offer);
    assert_eq!((o.pool_filled, o.pool_used, o.pool[1]), (0b11, 0b01, fresh.1));
    let (res, swap) = lock(&mut w, 9);
    ok(res);
    assert_eq!(w.swap(&swap).unwrap().maker_spend_pub, fresh.1);
    assert_err(lock(&mut w, 0).0, "NoKeyAvailable");

    // A pending lock reserves no key (window mode).
    ok(w.set_offer(&m, ASSET_SOL, DIR_A, &Terms { mode: 1, ..Terms::default() }));
    ok(w.refresh(&m, &[(ASSET_SOL, DIR_A, true, [PRICE, 0, 0], XMR)]));
    let (res, swap) = lock(&mut w, 0);
    ok(res);
    let s = w.swap(&swap).unwrap();
    assert_eq!((s.state, s.maker_spend_pub), (PENDING, [0; 32]));
    assert_eq!(w.offer(&offer).capacity_xmr, XMR, "nor capacity");
}

#[test]
fn pending_swaps_are_capped_at_64_per_maker() {
    let mut w = World::new();
    let mut m = w.register_maker();
    let window = Terms { mode: 1, ..Terms::default() };
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &window, 1_000_000);
    let offer_b = w.live_offer(&mut m, ASSET_SOL, DIR_B, &Terms::default(), 1_000_000);
    let taker = w.fund(10_000 * SOL);
    let mut open = vec![];
    for i in 0..64 {
        // Locks and takes both count.
        let (direction, source) = if i % 2 == 0 { (DIR_A, offer) } else { (DIR_B, offer_b) };
        let (fx, raw) = w.prepare_open_for(&m, taker.insecure_clone(), ASSET_SOL, direction, XMR, Source::Offer(source), rand16());
        ok(w.send_open(&fx, &raw));
        open.push(fx);
    }
    assert_eq!(w.maker(&m.pda).open_pending, 64);
    let (fx, raw) = w.prepare_open_for(&m, taker.insecure_clone(), ASSET_SOL, DIR_A, XMR, Source::Offer(offer), rand16());
    assert_err(w.send_open(&fx, &raw), "TooManyPending");
    let (fx_b, raw_b) = w.prepare_open_for(&m, taker.insecure_clone(), ASSET_SOL, DIR_B, XMR, Source::Offer(offer_b), rand16());
    assert_err(w.send_open(&fx_b, &raw_b), "TooManyPending");
    // Every exit from PENDING frees a slot: a cancel, a rejection, an approval, a funding, an expiry.
    let op = m.operator.insecure_clone();
    ok(w.call(&m, &open[0], &Call::CancelPending, &taker));
    assert_eq!(w.maker(&m.pda).open_pending, 63);
    ok(w.send_open(&fx, &raw));
    assert_err(w.send_open(&fx_b, &raw_b), "TooManyPending");
    let open_hash = w.swap(&open[2].pda).unwrap().open_hash(&open[2].pda);
    ok(w.call(&m, &open[2], &Call::Reject { open: open_hash, reason: 2 }, &op));
    ok(w.approve(&mut m, &open[4]));
    ok(w.fund_swap(&mut m, &open[1]));
    assert_eq!(w.maker(&m.pda).open_pending, 61);
    w.warp(60);
    let stranger = w.stranger.insecure_clone();
    ok(w.call(&m, &open[6], &Call::ExpirePending, &stranger));
    assert_eq!(w.maker(&m.pda).open_pending, 60);
    let mk = w.maker(&m.pda);
    assert_eq!((mk.counters[0], mk.counters[1], mk.counters[2], mk.counters[4], mk.counters[5], mk.counters[32]), (33, 32, 2, 1, 1, 1));
}

// ------------------------------------------------------------------ quotes

#[test]
fn taker_bound_quotes_are_single_use_expire_and_die_with_the_epoch() {
    for asset in [ASSET_SOL, ASSET_USDC] {
        for direction in [DIR_A, DIR_B] {
            let mut w = World::new();
            let mut m = w.register_maker();
            let (op, stranger) = (m.operator.insecure_clone(), w.stranger.insecure_clone());
            let taker = w.fund(1_000 * SOL);
            if asset == ASSET_USDC {
                w.mint_to(&taker.pubkey(), 100_000_000_000);
            }
            let terms = Terms::default();
            let mut next_id = 100u64;
            let mut post = |w: &mut World, m: &mut MakerFx, to: &Pubkey, expires_in: i64| {
                next_id += 1;
                let (share, pok) = if direction == DIR_A {
                    let (_, s_pub, pok) = m.new_share();
                    (s_pub, pok)
                } else {
                    ([0; 32], [0; 64])
                };
                let (ix, quote) = w.post_quote_ix(m, next_id, to, asset, direction, 5_000 * XMR, 4_242, &terms, &share, &pok, w.now() + expires_in);
                (w.send(&[ix], &[&op]), quote, share)
            };
            let open = |w: &mut World, m: &MakerFx, who: &Keypair, quote: Pubkey, change: &dyn Fn(&mut OpenRaw)| {
                let (fx, mut raw) =
                    w.prepare_open_for(m, who.insecure_clone(), asset, direction, 5_000 * XMR, Source::Quote(quote, op.pubkey()), rand16());
                change(&mut raw);
                (w.send_open(&fx, &raw), fx)
            };

            // Posting: only the operator, at most 120 s ahead, not already expired.
            assert_err(post(&mut w, &mut m, &taker.pubkey(), 121).0, "QuoteMismatch");
            assert_err(post(&mut w, &mut m, &taker.pubkey(), -1).0, "QuoteExpired");
            let (res, quote, share) = post(&mut w, &mut m, &taker.pubkey(), 120);
            let res = ok(res);
            assert_eq!(logged_events(&res, "QuotePosted").len(), 1);
            assert_eq!(w.data(&quote).len(), 192);
            let rent = w.lamports(&quote);

            // Bound to its taker, its size, its direction and asset.
            let thief = w.fund(1_000 * SOL);
            if asset == ASSET_USDC {
                w.mint_to(&thief.pubkey(), 100_000_000_000);
            }
            assert_err(open(&mut w, &m, &thief, quote, &|_| {}).0, "QuoteMismatch");
            assert_err(open(&mut w, &m, &taker, quote, &|r| r.xmr += 1).0, "QuoteMismatch");
            assert_err(open(&mut w, &m, &taker, quote, &|r| r.limit = if direction == DIR_A { 4_241 } else { 4_243 }).0, "PriceMoved");
            // The rent goes to the operator, nobody else.
            assert_err(
                open(&mut w, &m, &taker, quote, &|r| r.source = Source::Quote(quote, r.taker)).0,
                "Unauthorized"
            );

            // Consumed: offer size limits do not apply (5,000 XMR), the share is the quote's,
            // the account is closed and its rent is back with the operator.
            let operator_before = w.lamports(&op.pubkey());
            let (res, fx) = open(&mut w, &m, &taker, quote, &|_| {});
            ok(res);
            let s = w.swap(&fx.pda).unwrap();
            assert_eq!((s.mode, s.amount, s.xmr, s.price, s.depth), (3, 4_242, 5_000 * XMR, 0, 10));
            assert_eq!(s.maker_spend_pub, share);
            assert_eq!(s.state, if direction == DIR_A { ACTIVE } else { PENDING });
            assert!(!w.exists(&quote));
            assert_eq!(w.lamports(&op.pubkey()) - operator_before, rent);
            // Second use: there is no quote any more.
            assert!(open(&mut w, &m, &taker, quote, &|_| {}).0.is_err());

            // Expiry is inclusive; after it anyone can cancel (the rent still goes to the operator).
            let (res, quote, _) = post(&mut w, &mut m, &taker.pubkey(), 100);
            ok(res);
            let ix = w.cancel_quote_ix(&m, &stranger.pubkey(), &quote);
            assert_err(w.send(&[ix.clone()], &[&stranger]), "Unauthorized");
            w.warp(101);
            assert_err(open(&mut w, &m, &taker, quote, &|_| {}).0, "QuoteExpired");
            let operator_before = w.lamports(&op.pubkey());
            let res = ok(w.send(&[ix], &[&stranger]));
            assert_eq!(logged_events(&res, "QuoteCancelled").len(), 1);
            assert_eq!(w.lamports(&op.pubkey()) - operator_before, rent);
            assert!(!w.exists(&quote));

            // The operator cancels at any time; a cancelled quote cannot be used.
            let (res, quote, _) = post(&mut w, &mut m, &taker.pubkey(), 100);
            ok(res);
            let mut bad = w.cancel_quote_ix(&m, &op.pubkey(), &quote);
            bad.accounts[3].pubkey = stranger.pubkey();
            assert_err(w.send(&[bad], &[&op]), "Unauthorized");
            let ix = w.cancel_quote_ix(&m, &op.pubkey(), &quote);
            ok(w.send(&[ix], &[&op]));
            assert!(open(&mut w, &m, &taker, quote, &|_| {}).0.is_err());

            // Bumping the quote epoch kills an outstanding quote.
            let (res, quote, _) = post(&mut w, &mut m, &taker.pubkey(), 100);
            ok(res);
            ok(w.bump_epochs(&m, false, true));
            assert_err(open(&mut w, &m, &taker, quote, &|_| {}).0, "StaleEpoch");
        }
    }
}

// ------------------------------------------------------------------ the Ethereum board and messages

#[test]
fn eth_board_is_opaque_and_refresh_rewrites_only_the_dynamic_fields() {
    let mut w = World::new();
    let m = w.register_maker();
    let other = w.register_maker();
    let op = m.operator.insecure_clone();
    let board = w.eth_board(&m.pda);
    let quote: [u8; 251] = std::array::from_fn(|i| i as u8);
    let sig = [0xab; 65];

    let ix = w.set_eth_quote_ix(&m, 4, &quote, &sig);
    assert!(w.send(&[ix], &[&op]).is_err(), "four slots");
    let mut ix = w.set_eth_quote_ix(&m, 0, &quote, &sig);
    ix.accounts[0].pubkey = w.stranger.pubkey();
    let stranger = w.stranger.insecure_clone();
    assert_err(w.send(&[ix], &[&stranger]), "Unauthorized");

    let ix = w.set_eth_quote_ix(&m, 2, &quote, &sig);
    let res = ok(w.send(&[ix], &[&op]));
    assert_eq!(logged_events(&res, "EthQuoteSet").len(), 1);
    let data = w.data(&board);
    assert_eq!(data.len(), 1_408);
    assert_eq!(data[..8], account_disc("EthBoard"));
    assert_eq!(data[8..40], m.pda.to_bytes());
    let slot = |data: &[u8], i: usize| data[41 + i * 325..41 + (i + 1) * 325].to_vec();
    let s2 = slot(&data, 2);
    assert_eq!(s2[0], 1);
    assert_eq!(i64::from_le_bytes(s2[1..9].try_into().unwrap()), w.now());
    assert_eq!(s2[9..260], quote);
    assert_eq!(s2[260..325], sig);
    assert_eq!(slot(&data, 0), vec![0u8; 325]);

    // refresh: tierPrice at 102..150, validUntil at 199..207, quoteId at 243..251, and the signature.
    w.warp(30);
    let new_sig = [0xcd; 65];
    let prices = [1u128 << 90, 77, u128::MAX];
    let ix = w.refresh_full_ix(&m, &[], &[(2, prices, 1_900_000_000, 0xdead_beef, new_sig)]);
    let res = ok(w.send(&[ix], &[&op]));
    assert_eq!(logged_events(&res, "OffersRefreshed")[0][32], 1, "count");
    let s2 = slot(&w.data(&board), 2);
    let q = &s2[9..260];
    let mut want = quote;
    for (i, p) in prices.iter().enumerate() {
        want[102 + 16 * i..118 + 16 * i].copy_from_slice(&p.to_le_bytes());
    }
    want[199..207].copy_from_slice(&1_900_000_000u64.to_le_bytes());
    want[243..251].copy_from_slice(&0xdead_beefu64.to_le_bytes());
    assert_eq!(q, want, "every other byte of the compact quote is untouched");
    assert_eq!(s2[260..325], new_sig);
    assert_eq!(i64::from_le_bytes(s2[1..9].try_into().unwrap()), w.now());

    // An empty slot cannot be refreshed; another maker's board is refused; so is a missing one.
    let ix = w.refresh_full_ix(&m, &[], &[(1, prices, 1, 1, new_sig)]);
    assert!(w.send(&[ix], &[&op]).is_err());
    let mut ix = w.refresh_full_ix(&other, &[], &[(2, prices, 1, 1, new_sig)]);
    ix.accounts[2].pubkey = board;
    let other_op = other.operator.insecure_clone();
    assert_err(w.send(&[ix], &[&other_op]), "Unauthorized");
    let mut ix = w.refresh_full_ix(&m, &[], &[(2, prices, 1, 1, new_sig)]);
    ix.accounts[2] = opt(None, true);
    assert!(w.send(&[ix], &[&op]).is_err());
}

#[test]
fn post_message_checks_the_cap_and_the_magic_and_writes_nothing() {
    let v = vectors("envelope");
    let mut w = World::new();
    let m = w.register_maker();
    let sender = w.fund(SOL);
    let maker_before = w.data(&m.pda);
    let post = |w: &mut World, payload: &[u8]| {
        let ix = w.post_message_ix(&sender.pubkey(), &m.pda, None, payload);
        w.send(&[ix], &[&sender])
    };

    // The vectors' envelopes: everything at or under the 900-byte cap with the right magic is
    // carried (the program does not open them); the largest Solana responses fit.
    assert_eq!(v["max_onchain"], 900);
    let mut carried = 0;
    for case in v["cases"].as_array().unwrap() {
        let Some(env) = case["output"].get("envelope").or_else(|| case["input"].get("envelope")) else { continue };
        let bytes = h(env);
        let res = post(&mut w, &bytes);
        if bytes.len() > 900 {
            assert!(is_err(&res, "MessageTooLarge"), "{}: {}", case["name"], err_string(&res));
        } else if bytes.len() < 2 || bytes[..2] != [0x58, 0x53] {
            assert!(is_err(&res, "MessageMalformed"), "{}: {}", case["name"], err_string(&res));
        } else {
            let res = ok(res);
            assert!(!res.logs.iter().any(|l| l.starts_with("Program data: ")), "{}: nothing is emitted", case["name"]);
            carried += 1;
        }
        if let Some(fits) = case["output"].get("fits_onchain_cap") {
            assert_eq!(fits.as_bool().unwrap(), bytes.len() <= 900, "{}", case["name"]);
        }
    }
    assert!(carried >= 20, "{carried}");

    let mut exact = vec![0x58, 0x53];
    exact.resize(900, 1);
    ok(post(&mut w, &exact));
    exact.push(1);
    assert_err(post(&mut w, &exact), "MessageTooLarge");
    assert_err(post(&mut w, b"X"), "MessageMalformed");
    assert_err(post(&mut w, b""), "MessageMalformed");
    assert_err(post(&mut w, b"SX rest"), "MessageMalformed");
    assert_eq!(w.data(&m.pda), maker_before, "the recipient is only named");
}
