//! Key shares and proofs of knowledge (SPEC 2.2 to 2.4, 2.8) as the program verifies them:
//! `points.json` (the 18 invalid commitments, the 100 valid ones, the bad openings, Monero's
//! 272 `secret_key_to_public_key` rows, the low-order X25519 table) and `pok.json`.
//!
//! A proof is bound to a context the vectors cannot choose (the maker PDA or the swap PDA), so
//! `pok.json` is replayed in two halves: byte for byte against this harness's prover and an
//! off-chain verifier, and kind by kind (wrong context, wrong key, flipped bits, non-canonical
//! `z`, off-curve `R`, identity, torsion, the two rogue-key constructions) at every instruction
//! that stores a share: `refill_keys`, `post_quote`, `approve`, `fund`, `lock`, `take`.
use crate::common::*;
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, edwards::CompressedEdwardsY, scalar::Scalar, traits::IsIdentity};
use serde_json::Value;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Off-chain mirror of the program's two checks, in the vectors' error vocabulary.
fn verify_offchain(s_pub: &[u8; 32], ctx: &[u8; 32], pok: &[u8; 64]) -> Result<(), &'static str> {
    let point = CompressedEdwardsY(*s_pub).decompress().ok_or("InvalidKeyCommitment")?;
    if point.is_identity() || !point.is_torsion_free() || point.compress().to_bytes() != *s_pub {
        return Err("InvalidKeyCommitment");
    }
    let r: [u8; 32] = pok[..32].try_into().unwrap();
    let z: [u8; 32] = pok[32..].try_into().unwrap();
    let r_point = CompressedEdwardsY(r).decompress().ok_or("PokInvalid")?;
    let z = Option::<Scalar>::from(Scalar::from_canonical_bytes(z)).ok_or("PokInvalid")?;
    let c = Scalar::from_bytes_mod_order(clamp252(sha256(&[&ds("pok"), &r, s_pub, ctx])));
    if (z * ED25519_BASEPOINT_POINT).compress() == (r_point + c * point).compress() {
        Ok(())
    } else {
        Err("PokInvalid")
    }
}

#[test]
fn pok_vectors_against_the_prover_and_an_offchain_verifier() {
    let v = vectors("pok");
    let (mut valid, mut invalid) = (0, 0);
    for case in v["cases"].as_array().unwrap() {
        let i = &case["input"];
        let ctx = h32(&i["ctx"]);
        if case["valid"].as_bool().unwrap() {
            let s = h32(&i["s"]);
            let pok = pok_prove(&s, &ctx);
            assert_eq!(base_mul(&s), h32(&case["output"]["S"]), "{}", case["name"]);
            assert_eq!(pok.to_vec(), h(&case["output"]["pok"]), "{}: the prover is deterministic", case["name"]);
            assert_eq!(verify_offchain(&base_mul(&s), &ctx, &pok), Ok(()));
            valid += 1;
        } else {
            let pok: [u8; 64] = h(&i["pok"]).try_into().unwrap();
            assert_eq!(verify_offchain(&h32(&i["S"]), &ctx, &pok), Err(case["error"].as_str().unwrap()), "{}", case["name"]);
            invalid += 1;
        }
    }
    assert_eq!((valid, invalid), (4, 11));
}

// ------------------------------------------------------------------ the six sites

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Site {
    RefillKeys,
    PostQuote,
    Approve,
    Fund,
    Lock,
    Take,
}
const SITES: [Site; 6] = [Site::RefillKeys, Site::PostQuote, Site::Approve, Site::Fund, Site::Lock, Site::Take];

struct Sites {
    w: World,
    m: MakerFx,
    /// A pending direction-A lock (window mode) and a pending take, waiting for the maker's share.
    pending_a: SwapFx,
    pending_b: SwapFx,
    taker: Keypair,
}

fn sites() -> Sites {
    let mut w = World::new();
    let mut m = w.register_maker();
    let window = Terms { mode: 1, w_a: 3_600, w_f: 700_000, ..Terms::default() };
    // USDC: window mode, so a lock waits for `approve`. SOL: auto.
    let pending_a = w.swap_with(&mut m, ASSET_USDC, DIR_A, &window, Stage::Opened);
    let pending_b = w.swap_with(&mut m, ASSET_USDC, DIR_B, &Terms { w_n: 3_600, w_f: 700_000, ..Terms::default() }, Stage::Opened);
    w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), 1_000_000);
    w.live_offer(&mut m, ASSET_SOL, DIR_B, &Terms::default(), 1_000_000);
    let taker = w.fund(1_000 * SOL);
    Sites { w, m, pending_a, pending_b, taker }
}

/// Present a share and proof at `site`. `make` receives the context the proof must be bound to.
fn attempt(f: &mut Sites, site: Site, make: &dyn Fn(&[u8; 32]) -> ([u8; 32], [u8; 64])) -> TxResult {
    let maker_ctx = f.m.pda.to_bytes();
    let op = f.m.operator.insecure_clone();
    match site {
        Site::RefillKeys => {
            let (share, pok) = make(&maker_ctx);
            let ix = f.w.refill_ix(&f.m, ASSET_SOL, &[(15, share, pok)]);
            f.w.send(&[ix], &[&op])
        }
        Site::PostQuote => {
            let (share, pok) = make(&maker_ctx);
            let id = u64::from_le_bytes(rand32()[..8].try_into().unwrap());
            let (ix, _) = f.w.post_quote_ix(
                &f.m, id, &f.taker.pubkey(), ASSET_SOL, DIR_A, XMR, PRICE, &Terms::default(), &share, &pok, f.w.now() + 60,
            );
            f.w.send(&[ix], &[&op])
        }
        Site::Approve => {
            let (share, pok) = make(&maker_ctx);
            let open = f.w.swap(&f.pending_a.pda).unwrap().open_hash(&f.pending_a.pda);
            let ix = f.w.call_ix(&f.m, &f.pending_a, &Call::Approve { open, share, pok }, &op.pubkey());
            f.w.send(&[ix], &[&op])
        }
        Site::Fund => {
            let (share, pok) = make(&maker_ctx);
            let open = f.w.swap(&f.pending_b.pda).unwrap().open_hash(&f.pending_b.pda);
            let ix = f.w.call_ix(&f.m, &f.pending_b, &Call::Fund { open, share, pok, view: new_view() }, &op.pubkey());
            f.w.send(&[ix], &[&op])
        }
        Site::Lock | Site::Take => {
            let direction = if site == Site::Lock { DIR_A } else { DIR_B };
            let offer = f.w.offer_pda(&f.m.pda, ASSET_SOL, direction);
            let (fx, mut raw) =
                f.w.prepare_open_for(&f.m, f.taker.insecure_clone(), ASSET_SOL, direction, XMR, Source::Offer(offer), rand16());
            let (share, pok) = make(&fx.pda.to_bytes());
            raw.spend_pub = share;
            raw.pok = pok;
            f.w.send_open(&fx, &raw)
        }
    }
}

#[test]
fn invalid_commitments_are_refused_wherever_a_share_is_stored() {
    let v = vectors("points");
    let bad: Vec<(String, [u8; 32])> = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["error"] == "InvalidKeyCommitment")
        .map(|c| (c["name"].as_str().unwrap().to_string(), h32(&c["input"]["point"])))
        .collect();
    // Identity, the 7 other small-order points, 7 torsioned points, non-canonical y, negative
    // zero, off-curve.
    assert_eq!(bad.len(), 18);
    let mut f = sites();
    for site in SITES {
        for (name, point) in &bad {
            // The proof is irrelevant: the commitment is checked first. Give it a well-formed one.
            let res = attempt(&mut f, site, &|ctx| (*point, pok_prove(&new_share().0, ctx)));
            assert!(is_err(&res, "InvalidKeyCommitment"), "{site:?} {name}: {}", err_string(&res));
        }
    }
    // Nothing was stored anywhere.
    assert_eq!(f.w.swap(&f.pending_a.pda).unwrap().state, PENDING);
    assert_eq!(f.w.swap(&f.pending_b.pda).unwrap().state, PENDING);
    assert_eq!(f.w.offer(&f.w.offer_pda(&f.m.pda, ASSET_SOL, DIR_A)).pool_filled & (1 << 15), 0);
}

#[test]
fn proof_of_knowledge_kinds_at_every_site() {
    let v = vectors("pok");
    let off_curve_r: [u8; 32] = h(&v["cases"].as_array().unwrap().iter().find(|c| c["name"] == "R-off-curve").unwrap()["input"]["pok"])
        [..32]
        .try_into()
        .unwrap();
    assert!(CompressedEdwardsY(off_curve_r).decompress().is_none());

    let (s, s_pub) = new_share();
    let (_, s2_pub) = new_share();
    let (k, _) = new_share();
    // The rogue key S' = k·G − S: whoever publishes it controls the joint Monero key alone, and
    // cannot open it.
    let rogue = (CompressedEdwardsY(base_mul(&k)).decompress().unwrap() - CompressedEdwardsY(s_pub).decompress().unwrap())
        .compress()
        .to_bytes();
    let other_ctx = rand32();

    type Make = Box<dyn Fn(&[u8; 32]) -> ([u8; 32], [u8; 64])>;
    let edit = move |f: fn(&mut [u8; 64])| -> Make {
        Box::new(move |ctx: &[u8; 32]| {
            let mut p = pok_prove(&s, ctx);
            f(&mut p);
            (s_pub, p)
        })
    };
    let kinds: Vec<(&str, &str, Make)> = vec![
        ("wrong-ctx", "InvalidProofOfKnowledge", Box::new(move |_| (s_pub, pok_prove(&s, &other_ctx)))),
        ("wrong-key", "InvalidProofOfKnowledge", Box::new(move |ctx| (s2_pub, pok_prove(&s, ctx)))),
        ("flipped-bit-in-R", "InvalidProofOfKnowledge", edit(|p| p[3] ^= 0x10)),
        ("flipped-bit-in-z", "InvalidProofOfKnowledge", edit(|p| p[40] ^= 0x01)),
        // z + l: the same scalar mod l, so the equation would hold if the program reduced it.
        ("non-canonical-z", "InvalidProofOfKnowledge", edit(|p| {
            let z: [u8; 32] = p[32..].try_into().unwrap();
            p[32..].copy_from_slice(&plus_l(&z));
        })),
        ("z-all-ones", "InvalidProofOfKnowledge", edit(|p| p[32..].fill(0xff))),
        ("R-off-curve", "InvalidProofOfKnowledge", Box::new(move |ctx| {
            let mut p = pok_prove(&s, ctx);
            p[..32].copy_from_slice(&off_curve_r);
            (s_pub, p)
        })),
        ("rogue-key-proof-from-k", "InvalidProofOfKnowledge", Box::new(move |ctx| (rogue, pok_prove(&k, ctx)))),
        ("rogue-key-proof-from-victim", "InvalidProofOfKnowledge", Box::new(move |ctx| (rogue, pok_prove(&s, ctx)))),
        ("identity-commitment", "InvalidKeyCommitment", Box::new(move |ctx| {
            let mut id = [0u8; 32];
            id[0] = 1;
            (id, pok_prove(&s, ctx))
        })),
        ("torsioned-commitment", "InvalidKeyCommitment", Box::new(move |ctx| (torsioned(&s_pub), pok_prove(&s, ctx)))),
    ];
    // The same eleven kinds as the vectors' invalid cases.
    let mut vector_kinds: Vec<&str> =
        v["cases"].as_array().unwrap().iter().filter(|c| !c["valid"].as_bool().unwrap()).map(|c| c["name"].as_str().unwrap()).collect();
    let mut mine: Vec<&str> = kinds.iter().map(|k| k.0).collect();
    vector_kinds.sort();
    mine.sort();
    assert_eq!(mine, vector_kinds);

    let mut f = sites();
    for site in SITES {
        for (name, error, make) in &kinds {
            let res = attempt(&mut f, site, make.as_ref());
            assert!(is_err(&res, error), "{site:?} {name}: expected {error}, got {}", err_string(&res));
        }
        // The honest proof, bound to the right context, is accepted at the same site.
        let (hs, hs_pub) = new_share();
        ok(attempt(&mut f, site, &move |ctx| (hs_pub, pok_prove(&hs, ctx))));
    }
    assert_eq!(f.w.swap(&f.pending_a.pda).unwrap().state, ACTIVE);
    assert_eq!(f.w.swap(&f.pending_b.pda).unwrap().state, ACTIVE);
}

// ------------------------------------------------------------------ openings (scalar_matches)

struct Openings {
    w: World,
    m: MakerFx,
    taker: Keypair,
    offer: solana_pubkey::Pubkey,
}

fn openings() -> Openings {
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), 1_000_000);
    let taker = w.fund(1_000 * SOL);
    Openings { w, m, taker, offer }
}

/// Lock with `(s, S)` as the taker's share: the commitment is accepted and the swap is ACTIVE.
fn lock_with(o: &mut Openings, s: &[u8; 32], s_pub: &[u8; 32]) -> SwapFx {
    let pool = o.w.offer(&o.offer);
    if pool.pool_filled & !pool.pool_used == 0 {
        ok(o.w.refill(&mut o.m, ASSET_SOL, 0, 8));
    }
    let (mut fx, mut raw) =
        o.w.prepare_open_for(&o.m, o.taker.insecure_clone(), ASSET_SOL, DIR_A, XMR, Source::Offer(o.offer), rand16());
    raw.spend_pub = *s_pub;
    raw.pok = pok_prove(s, &fx.pda.to_bytes());
    fx.s_t = *s;
    fx.s_pub_t = *s_pub;
    ok(o.w.send_open(&fx, &raw));
    fx
}

fn refund(o: &mut Openings, fx: &SwapFx, secret: &[u8; 32]) -> TxResult {
    let taker = o.taker.insecure_clone();
    o.w.call(&o.m, fx, &Call::Refund(*secret), &taker)
}

#[test]
fn the_100_valid_points_are_accepted_and_opened_by_their_scalars() {
    let v = vectors("points");
    let valid: Vec<([u8; 32], [u8; 32])> = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["valid"].as_bool().unwrap())
        .map(|c| (h32(&c["output"]["scalar"]), h32(&c["input"]["point"])))
        .collect();
    assert_eq!(valid.len(), 100);
    let mut o = openings();
    for (s, s_pub) in &valid {
        assert_eq!(base_mul(s), *s_pub);
        let fx = lock_with(&mut o, s, s_pub);
        ok(refund(&mut o, &fx, s));
        let acc = o.w.swap(&fx.pda).unwrap();
        assert_eq!((acc.state, acc.revealed), (HOLD, *s));
    }
    // As maker shares too: eight per `refill_keys`, proofs bound to the maker PDA.
    let ctx = o.m.pda.to_bytes();
    for chunk in valid.chunks(8) {
        let pool = o.w.offer(&o.offer);
        if pool.pool_filled & !pool.pool_used != 0 {
            // Use up what is published so every slot can be refilled.
            for _ in 0..(pool.pool_filled & !pool.pool_used).count_ones() {
                let (s, s_pub) = new_share();
                lock_with(&mut o, &s, &s_pub);
            }
        }
        let slots: Vec<_> = chunk.iter().enumerate().map(|(i, (s, s_pub))| (i as u8, *s_pub, pok_prove(s, &ctx))).collect();
        let ix = o.w.refill_ix(&o.m, ASSET_SOL, &slots);
        let op = o.m.operator.insecure_clone();
        ok(o.w.send(&[ix], &[&op]));
        for (s, s_pub) in chunk {
            o.m.shares.insert(*s_pub, *s);
        }
    }
}

#[test]
fn wrong_and_non_canonical_openings_are_refused() {
    let v = vectors("points");
    let cases = v["cases"].as_array().unwrap();
    let scalar_of = |point: &[u8; 32]| -> [u8; 32] {
        h32(&cases.iter().find(|c| c["valid"].as_bool().unwrap() && h32(&c["input"]["point"]) == *point).unwrap()["output"]["scalar"])
    };
    let bad: Vec<&Value> = cases.iter().filter(|c| c["error"] == "ScalarMismatch").collect();
    // s+1, −s, 0, l, ff…ff, s+l.
    assert_eq!(bad.len(), 6);
    let mut o = openings();
    for case in bad {
        let point = h32(&case["input"]["point"]);
        let s = scalar_of(&point);
        let fx = lock_with(&mut o, &s, &point);
        let before = o.w.swap(&fx.pda).unwrap();
        let res = refund(&mut o, &fx, &h32(&case["input"]["scalar"]));
        assert!(is_err(&res, "ScalarMismatch"), "{}: {}", case["name"], err_string(&res));
        assert_eq!(o.w.swap(&fx.pda).unwrap(), before, "{}: nothing changed", case["name"]);
        ok(refund(&mut o, &fx, &s));
    }

    // The same on a claim, with the maker's share: s + l opens the same point mathematically
    // and is the one encoding the program must not accept.
    let mut w = World::new();
    let (m, fx) = w.swap_at(ASSET_SOL, DIR_A, &Terms::default(), Stage::Ready);
    let s_m = w.maker_secret(&m, &fx);
    let op = m.operator.insecure_clone();
    for (name, secret) in [
        ("s + l", plus_l(&s_m)),
        ("the taker's share", fx.s_t),
        ("zero", [0; 32]),
        ("l", L_LE),
        ("random", new_share().0),
    ] {
        let res = w.call(&m, &fx, &Call::Claim(secret), &op);
        assert!(is_err(&res, "ScalarMismatch"), "{name}: {}", err_string(&res));
    }
    ok(w.call(&m, &fx, &Call::Claim(s_m), &op));
}

#[test]
fn monero_secret_key_to_public_key_rows() {
    let v = vectors("points");
    let rows = v["monero_secret_key_to_public_key"].as_array().unwrap();
    assert_eq!(rows.len(), 272);
    let mut o = openings();
    let (mut accepted, mut refused) = (0, 0);
    for row in rows {
        let secret = h32(&row["secret"]);
        if row["valid"].as_bool().unwrap() {
            // Monero's own key pair: the public key is accepted as a commitment and the secret
            // opens it, byte for byte.
            let public = h32(&row["public"]);
            let fx = lock_with(&mut o, &secret, &public);
            ok(refund(&mut o, &fx, &secret));
            assert_eq!(o.w.swap(&fx.pda).unwrap().revealed, secret);
            accepted += 1;
        } else {
            // A secret Monero refuses (not reduced mod l): the program refuses it as an opening
            // even of the point it denotes, and accepts the reduced encoding.
            let reduced = Scalar::from_bytes_mod_order(secret).to_bytes();
            assert_ne!(reduced, secret);
            let public = base_mul(&reduced);
            let fx = lock_with(&mut o, &reduced, &public);
            let res = refund(&mut o, &fx, &secret);
            assert!(is_err(&res, "ScalarMismatch"), "{}", err_string(&res));
            ok(refund(&mut o, &fx, &reduced));
            refused += 1;
        }
    }
    assert_eq!((accepted, refused), (256, 16));
}

// ------------------------------------------------------------------ view shares and X25519 keys

#[test]
fn view_shares_must_be_canonical_and_nonzero() {
    let mut l_minus_1 = L_LE;
    l_minus_1[0] -= 1;
    let mut l_plus_1 = L_LE;
    l_plus_1[0] += 1;
    let mut one = [0u8; 32];
    one[0] = 1;
    let bad = [("zero", [0u8; 32]), ("l", L_LE), ("l + 1", l_plus_1), ("ff..ff", [0xff; 32]), ("2^255", { let mut b = [0u8; 32]; b[31] = 0x80; b })];
    let good = [("one", one), ("l - 1", l_minus_1)];

    // lock: the taker's view share, in clear.
    let mut w = World::new();
    let mut m = w.register_maker();
    let offer = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    for (name, view) in bad {
        let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
        raw.view = view;
        let res = w.send_open(&fx, &raw);
        assert!(is_err(&res, "InvalidScalar"), "lock {name}: {}", err_string(&res));
    }
    for (name, view) in good {
        let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_A, XMR, Source::Offer(offer));
        raw.view = view;
        ok(w.send_open(&fx, &raw));
        assert_eq!(w.swap(&fx.pda).unwrap().locker_view, view, "{name}");
    }

    // fund: the maker's view share, in clear.
    let fx = w.swap_with(&mut m, ASSET_SOL, DIR_B, &Terms::default(), Stage::Opened);
    assert_eq!(w.swap(&fx.pda).unwrap().locker_view, [0; 32], "zeros until the maker funds");
    let op = m.operator.insecure_clone();
    let open = w.swap(&fx.pda).unwrap().open_hash(&fx.pda);
    for (name, view) in bad {
        let (_, share, pok) = m.new_share();
        let res = w.call(&m, &fx, &Call::Fund { open, share, pok, view }, &op);
        assert!(is_err(&res, "InvalidScalar"), "fund {name}: {}", err_string(&res));
    }
    let (_, share, pok) = m.new_share();
    ok(w.call(&m, &fx, &Call::Fund { open, share, pok, view: l_minus_1 }, &op));
    assert_eq!(w.swap(&fx.pda).unwrap().locker_view, l_minus_1);
}

#[test]
fn low_order_encryption_keys_are_refused() {
    let v = vectors("points");
    let low: Vec<[u8; 32]> = v["low_order_x25519"].as_array().unwrap().iter().map(|e| h32(&e["key"])).collect();
    let fine: Vec<[u8; 32]> = v["valid_x25519"].as_array().unwrap().iter().map(h32).collect();
    // The seven u-coordinates and each with bit 255 set.
    assert_eq!(low.len(), 14);

    let mut w = World::new();
    let mut m = w.register_maker();
    let offer_a = w.live_offer(&mut m, ASSET_SOL, DIR_A, &Terms::default(), PRICE);
    let offer_b = w.live_offer(&mut m, ASSET_SOL, DIR_B, &Terms::default(), PRICE);
    let op = m.operator.insecure_clone();

    let register = |w: &mut World, key: &[u8; 32]| {
        let owner = w.fund(10 * SOL);
        let ix = solana_instruction::Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                meta(owner.pubkey(), true, true),
                meta(pda(&[b"maker", owner.pubkey().as_ref()]), false, true),
                meta(SYSTEM, false, false),
            ],
            data: Enc::ix("register_maker").key(&owner.pubkey()).key(&owner.pubkey()).bytes(key).0,
        };
        w.send(&[ix], &[&owner])
    };
    let rotate = |w: &mut World, key: &[u8; 32]| {
        let ix = w.maker_ix(&op.pubkey(), &m.pda, Enc::ix("rotate_enc_key").bytes(key).i64(w.now() + 600).0);
        w.send(&[ix], &[&op])
    };

    for key in &low {
        let name = hex::encode(key);
        assert!(is_err(&register(&mut w, key), "InvalidEncryptionKey"), "register_maker {name}");
        assert!(is_err(&rotate(&mut w, key), "InvalidEncryptionKey"), "rotate_enc_key {name}");
        for (direction, offer) in [(DIR_A, offer_a), (DIR_B, offer_b)] {
            let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, direction, XMR, Source::Offer(offer));
            raw.enc_key = *key;
            let res = w.send_open(&fx, &raw);
            assert!(is_err(&res, "InvalidEncryptionKey"), "open {direction} {name}: {}", err_string(&res));
        }
    }
    for key in &fine {
        ok(register(&mut w, key));
        let (fx, mut raw) = w.prepare_open(&m, ASSET_SOL, DIR_B, XMR, Source::Offer(offer_b));
        raw.enc_key = *key;
        ok(w.send_open(&fx, &raw));
        assert_eq!(w.swap(&fx.pda).unwrap().taker_enc_key, *key);
    }
    // Rotation with an honest key: version 2, the previous key kept until its expiry.
    let old = w.maker(&m.pda).enc_key;
    ok(rotate(&mut w, &fine[0]));
    let mk = w.maker(&m.pda);
    assert_eq!((mk.enc_key, mk.enc_key_version, mk.prev_enc_key, mk.prev_enc_key_expires_at), (fine[0], 2, old, w.now() + 600));
}
