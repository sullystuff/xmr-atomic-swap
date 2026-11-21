//! Q1-Q3: the curve check itself.
#![allow(deprecated)] // curve25519_dalek::constants::BASEPOINT_ORDER
mod common;
use common::*;
use curve25519_dalek::{
    constants::{BASEPOINT_ORDER, ED25519_BASEPOINT_POINT, EIGHT_TORSION},
    edwards::CompressedEdwardsY,
    scalar::Scalar,
    traits::Identity,
    EdwardsPoint,
};
use solana_signer::Signer;

/// s + l as 32 LE bytes: same residue mod l, but not the canonical encoding.
fn plus_l(s: &[u8; 32]) -> [u8; 32] {
    let l = BASEPOINT_ORDER.to_bytes();
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in 0..32 {
        let v = s[i] as u16 + l[i] as u16 + carry;
        out[i] = v as u8;
        carry = v >> 8;
    }
    assert_eq!(carry, 0);
    out
}

#[test]
fn positive_matching_scalar_is_accepted() {
    let mut svm = setup();
    let payer = funded(&mut svm, SOL);
    let (s, point) = key_share();

    send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &point)], &[&payer]).unwrap();
    assert!(exists(&svm, &commitment_pda(&payer.pubkey())));

    let meta = send(&mut svm, &[reveal_ix(&payer.pubkey(), &s)], &[&payer]).unwrap();
    // The scalar is public afterwards: read it back from the event.
    let ev = logged_events(&meta, "Revealed");
    assert_eq!(ev.len(), 1);
    assert_eq!(&ev[0][32..64], &s);
    // `close = payer` returned the rent.
    assert!(!exists(&svm, &commitment_pda(&payer.pubkey())));
    assert_eq!(balance(&svm, &payer.pubkey()), SOL - 2 * FEE);
}

#[test]
fn negative_wrong_scalar_is_rejected() {
    let mut svm = setup();
    let payer = funded(&mut svm, SOL);
    let (s, point) = key_share();
    let (other, _) = key_share();
    send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &point)], &[&payer]).unwrap();

    assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &other)], &[&payer]), E_SCALAR_MISMATCH);
    // off by one
    let s1 = (Scalar::from_bytes_mod_order(s) + Scalar::ONE).to_bytes();
    assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &s1)], &[&payer]), E_SCALAR_MISMATCH);
    // -s gives -S: same y, flipped sign bit
    let neg = (-Scalar::from_bytes_mod_order(s)).to_bytes();
    assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &neg)], &[&payer]), E_SCALAR_MISMATCH);
    // zero
    assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &[0u8; 32])], &[&payer]), E_SCALAR_MISMATCH);
    assert!(exists(&svm, &commitment_pda(&payer.pubkey())));
    // and the right one still works afterwards
    send(&mut svm, &[reveal_ix(&payer.pubkey(), &s)], &[&payer]).unwrap();
}

#[test]
fn non_canonical_scalar_is_rejected() {
    let mut svm = setup();
    let payer = funded(&mut svm, SOL);
    // Small s so that s + l fits in 256 bits (true for any s < 2^255).
    let (s, point) = key_share();
    let s_plus_l = plus_l(&s);
    // Mathematically (s + l)·G == s·G ...
    assert_eq!(Scalar::from_bytes_mod_order(s_plus_l).to_bytes(), s);
    // ... and it is a different byte string, i.e. a second "valid" preimage
    assert_ne!(s_plus_l, s);
    send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &point)], &[&payer]).unwrap();

    // ... but the syscall refuses non-canonical scalars, so the program does.
    assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &s_plus_l)], &[&payer]), E_SCALAR_MISMATCH);
    // exactly l (== 0 mod l) and all-ones are refused too
    assert_custom_err(
        send(&mut svm, &[reveal_ix(&payer.pubkey(), &BASEPOINT_ORDER.to_bytes())], &[&payer]),
        E_SCALAR_MISMATCH,
    );
    assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &[0xff; 32])], &[&payer]), E_SCALAR_MISMATCH);
    send(&mut svm, &[reveal_ix(&payer.pubkey(), &s)], &[&payer]).unwrap();
}

fn bad_points() -> Vec<(&'static str, [u8; 32])> {
    let (_, good) = key_share();
    let good_pt = CompressedEdwardsY(good).decompress().unwrap();
    let mut v: Vec<(&'static str, [u8; 32])> = vec![];
    v.push(("identity", EdwardsPoint::identity().compress().to_bytes()));
    for t in EIGHT_TORSION.iter().skip(1) {
        v.push(("small-order point", t.compress().to_bytes()));
    }
    for t in EIGHT_TORSION.iter().skip(1) {
        v.push(("prime-order point + torsion", (good_pt + t).compress().to_bytes()));
    }
    // y = 1 encoded as p + 1 (non-canonical field element; decodes to identity)
    let mut nc = [0xffu8; 32];
    nc[0] = 0xee;
    nc[31] = 0x7f;
    v.push(("non-canonical y (identity as p+1)", nc));
    // identity with the x sign bit set ("negative zero")
    let mut nz = [0u8; 32];
    nz[0] = 1;
    nz[31] = 0x80;
    v.push(("negative-zero x", nz));
    v
}

fn off_curve() -> [u8; 32] {
    // y = 2 has no matching x on ed25519
    let mut p = [0u8; 32];
    p[0] = 2;
    assert!(CompressedEdwardsY(p).decompress().is_none());
    p
}

#[test]
fn commit_rejects_identity_torsion_noncanonical_and_off_curve() {
    let mut svm = setup();
    for (what, p) in bad_points().into_iter().chain([("off-curve", off_curve())]) {
        let payer = funded(&mut svm, SOL);
        let res = send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &p)], &[&payer]);
        assert!(res.is_err(), "{what} must be rejected");
        assert_custom_err(res, E_BAD_COMMITMENT);
    }
    // sanity: 100 honest points all pass
    for _ in 0..100 {
        let payer = funded(&mut svm, SOL);
        let (_, p) = key_share();
        send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &p)], &[&payer]).unwrap();
    }
}

#[test]
fn validate_point_syscall_alone_is_not_enough() {
    // sol_curve_validate_point == "decompresses": it accepts every bad point
    // above except the off-curve one.
    let mut svm = setup();
    let payer = funded(&mut svm, SOL);
    for (what, p) in bad_points() {
        let res = send(&mut svm, &[ix("validate_only", &[&p], vec![r(payer.pubkey(), true)])], &[&payer]);
        assert!(res.is_ok(), "validate_point unexpectedly rejected: {what}");
        svm.expire_blockhash();
    }
    let res = send(&mut svm, &[ix("validate_only", &[&off_curve()], vec![r(payer.pubkey(), true)])], &[&payer]);
    assert_custom_err(res, E_BAD_COMMITMENT);
}

#[test]
fn unchecked_torsioned_commitment_can_never_be_opened() {
    // Why the commit-time check matters: S' = S + T (T of order 8) is a valid
    // curve point, but no scalar s' has s'·G == S'. Funds behind it are stuck.
    let mut svm = setup();
    let payer = funded(&mut svm, SOL);
    let (s, good) = key_share();
    let torsioned = (CompressedEdwardsY(good).decompress().unwrap() + EIGHT_TORSION[1]).compress().to_bytes();
    send(&mut svm, &[commit_ix("commit_unchecked", &payer.pubkey(), &torsioned)], &[&payer]).unwrap();
    assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &s)], &[&payer]), E_SCALAR_MISMATCH);
    // 8·S' == 8·S: the two only differ by torsion
    let eight = Scalar::from(8u8);
    assert_eq!(
        CompressedEdwardsY(torsioned).decompress().unwrap() * eight,
        ED25519_BASEPOINT_POINT * Scalar::from_bytes_mod_order(s) * eight
    );
}

#[test]
fn compute_unit_costs() {
    let mut svm = setup();
    let payer = funded(&mut svm, SOL);
    let (s, point) = key_share();
    let meta = send(&mut svm, &[ix("bench", &[&s, &point], vec![r(payer.pubkey(), true)])], &[&payer]).unwrap();
    let m = cu_marks(&meta);
    assert_eq!(m.len(), 14);
    let d = |i: usize| m[2 * i] - m[2 * i + 1];
    let overhead = d(6); // cost of one sol_log_compute_units call
    let names = ["validate_edwards", "multiply_edwards (s·G)", "subtract_edwards", "msm n=1", "msm n=2", "is_valid_key_commitment"];
    println!("CU per call (net of {overhead} CU logging overhead):");
    let mut net = vec![];
    for (i, n) in names.iter().enumerate() {
        net.push(d(i) - overhead);
        println!("  {n:<26} {}", d(i) - overhead);
    }
    // Syscall prices from the runtime's execution budget plus a few CU of glue.
    assert!((159..159 + 60).contains(&net[0]));
    assert!((2177..2177 + 60).contains(&net[1]));
    assert!((475..475 + 60).contains(&net[2]));
    assert!((2273..2273 + 80).contains(&net[3]));
    assert!((2273 + 758..2273 + 758 + 80).contains(&net[4]));

    let m1 = send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &point)], &[&payer]).unwrap();
    let m2 = send(&mut svm, &[reveal_ix(&payer.pubkey(), &s)], &[&payer]).unwrap();
    println!("whole tx: commit (init PDA + subgroup check) = {} CU", m1.compute_units_consumed);
    println!("whole tx: reveal (s·G check + event + close)  = {} CU", m2.compute_units_consumed);
}

fn hex32(h: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

/// Monero's own vectors (tests/crypto/tests.txt, `secret_key_to_public_key`):
/// `true` rows give (sec, pub); `false` rows are secrets Monero refuses
/// because they are not reduced mod l. The on-chain check must agree on all.
#[test]
fn monero_secret_key_to_public_key_vectors() {
    const INLINE: &str = "\
secret_key_to_public_key b2f420097cd63cdbdf834d090b1e604f08acf0af5a3827d0887863aaa4cc4406 true d764c19d6c14280315d81eb8f2fc777582941047918f52f8dcef8225e9c92c52
secret_key_to_public_key f264699c939208870fecebc013b773b793dd18ea39dbe1cb712a19a692fdb000 true bcb483f075d37658b854d4b9968fafae976e5532ca99879479c85ef5da1deead
secret_key_to_public_key bd65eb76171bb9b9542a6e06b9503c09fd4a9290fe51828ed766e5aeb742dc02 true 1dec6cc63ff1984ee46a70a46687877a87fcc1e790562da73b33b1a8fd8cad37
secret_key_to_public_key 678b66376f600b267b13b3b2350258ef820b092e00601031ea5ac8240e480742 false
";
    let file = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/secret_key_to_public_key.txt");
    let text = std::fs::read_to_string(file).unwrap_or_else(|_| INLINE.to_string());
    let mut svm = setup();
    let (mut ok, mut refused) = (0, 0);
    let (_, some_point) = key_share();
    for line in text.lines().filter(|l| l.starts_with("secret_key_to_public_key")) {
        let f: Vec<&str> = line.split_whitespace().collect();
        let sec = hex32(f[1]);
        let payer = funded(&mut svm, SOL);
        if f[2] == "true" {
            let public = hex32(f[3]);
            send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &public)], &[&payer])
                .expect("Monero public key must pass the commitment check");
            send(&mut svm, &[reveal_ix(&payer.pubkey(), &sec)], &[&payer])
                .expect("Monero secret key must open its public key");
            ok += 1;
        } else {
            assert!(bool::from(Scalar::from_canonical_bytes(sec).is_none()));
            send(&mut svm, &[commit_ix("commit", &payer.pubkey(), &some_point)], &[&payer]).unwrap();
            assert_custom_err(send(&mut svm, &[reveal_ix(&payer.pubkey(), &sec)], &[&payer]), E_SCALAR_MISMATCH);
            refused += 1;
        }
    }
    println!("Monero vectors: {ok} key pairs accepted, {refused} unreduced secrets refused");
    assert!(ok >= 3 && refused >= 1);
}
