//! Vector suites for SPEC 2.2 to 2.7: keys, points, pok, joint_address, twin, dleq, merkle.

use curve25519_dalek::{
  constants::{ED25519_BASEPOINT_POINT, EIGHT_TORSION},
  scalar::Scalar,
};
use serde_json::{json, Value};

use super::{err_case, fixed, fixed_n, h, ok_case, scalar, share, suite, VectorFile};
use crate::{
  address::{joint_address as derive_joint_address, Network},
  dleq::{dleq_prove_seeded, dleq_verify, DLEQ_HEADER, DLEQ_MAX_BLOB},
  envelope::LOW_ORDER_X25519,
  keys::{contact_share_id, derive_keys},
  merkle::{key_leaf, merkle_proof, merkle_root, merkle_verify},
  point::{scalar_matches, validate_point},
  pok::{pok_check, pok_prove},
  primitives::{ed_base_mul, ed_decompress, sha256, ChainTag, L_LE},
  twin::{share_as_uint256, t2, twin_commitments, T2_TAG},
};

fn pubkey(s: &[u8; 32]) -> [u8; 32] {
  ed_base_mul(&Scalar::from_bytes_mod_order(*s))
}
/// `a + l` as 32 little-endian bytes, if it fits.
fn plus_l(a: &[u8; 32]) -> Option<[u8; 32]> {
  let mut out = [0u8; 32];
  let mut carry = 0u16;
  for i in 0..32 {
    let v = a[i] as u16 + L_LE[i] as u16 + carry;
    out[i] = v as u8;
    carry = v >> 8;
  }
  (carry == 0).then_some(out)
}

pub fn keys() -> VectorFile {
  let mut cases = Vec::new();
  for i in 0..3 {
    for (chain, tag) in [(ChainTag::Solana, "solana"), (ChainTag::Ethereum, "ethereum")] {
      let seed = fixed(&format!("keys/seed/{i}"));
      let share_id: [u8; 16] = fixed_n(&format!("keys/share-id/{i}"));
      let k = derive_keys(&seed, chain, &share_id).expect("fixed seeds derive usable shares");
      cases.push(ok_case(
        &format!("{tag}-{i}"),
        json!({ "seed": h(seed), "chain_tag": chain as u8, "share_id": h(share_id) }),
        json!({
          "spend": h(k.spend),
          "spend_pub": h(k.spend_pub),
          "view": h(k.view),
          "session_secret": h(k.session_secret),
          "session_pub": h(&k.session_pub),
          "enc_secret": h(k.enc_secret),
          "enc_pub": h(k.enc_pub),
        }),
      ));
    }
  }
  // The same seed and share id under the other chain tag give unrelated shares (cases above).
  // The contact key: share id from the maker PDA, chain tag 0x01, key = enc.
  for i in 0..2 {
    let seed = fixed(&format!("keys/seed/{i}"));
    let maker_pda = fixed(&format!("keys/maker-pda/{i}"));
    let id = contact_share_id(&maker_pda);
    let k = derive_keys(&seed, ChainTag::Solana, &id).unwrap();
    cases.push(ok_case(
      &format!("contact-{i}"),
      json!({ "seed": h(seed), "maker_pda": h(maker_pda) }),
      json!({ "share_id": h(id), "chain_tag": 1, "enc_secret": h(k.enc_secret), "enc_pub": h(k.enc_pub) }),
    ));
  }
  cases.push(err_case(
    "unknown-chain-tag",
    json!({ "seed": h(fixed("keys/seed/0")), "chain_tag": 3, "share_id": h(fixed_n::<16>("keys/share-id/0")) }),
    "UnknownChainTag",
  ));
  suite("keys", cases, vec![])
}

/// The 18 invalid commitments of the research note, in its order.
pub(crate) fn invalid_commitments() -> Vec<(String, [u8; 32])> {
  let honest = ed_decompress(&pubkey(&share("points/honest"))).unwrap();
  let mut v = vec![("identity".to_string(), EIGHT_TORSION[0].compress().to_bytes())];
  for (i, t) in EIGHT_TORSION.iter().enumerate().skip(1) {
    v.push((format!("small-order-{i}"), t.compress().to_bytes()));
  }
  for (i, t) in EIGHT_TORSION.iter().enumerate().skip(1) {
    v.push((format!("prime-order-plus-torsion-{i}"), (honest + t).compress().to_bytes()));
  }
  // y = 1 encoded as p + 1 (non-canonical field element; decodes to the identity).
  let mut nc = [0xffu8; 32];
  nc[0] = 0xee;
  nc[31] = 0x7f;
  v.push(("non-canonical-y".to_string(), nc));
  // The identity with the x sign bit set ("negative zero").
  let mut nz = [0u8; 32];
  nz[0] = 1;
  nz[31] = 0x80;
  v.push(("negative-zero-x".to_string(), nz));
  // y = 2 has no matching x.
  let mut off = [0u8; 32];
  off[0] = 2;
  v.push(("off-curve".to_string(), off));
  v
}

pub fn points() -> VectorFile {
  let mut cases = Vec::new();
  let invalid = invalid_commitments();
  assert_eq!(invalid.len(), 18);
  for (name, p) in &invalid {
    assert!(!validate_point(p), "{name} must be invalid");
    cases.push(err_case(name, json!({ "point": h(p) }), "InvalidKeyCommitment"));
  }
  for i in 0..100 {
    let s = share(&format!("points/valid/{i}"));
    let p = pubkey(&s);
    assert!(validate_point(&p) && scalar_matches(&s, &p));
    cases.push(ok_case(&format!("valid-{i}"), json!({ "point": h(p) }), json!({ "scalar": h(s) })));
  }
  // Openings that must be refused for a valid commitment.
  let s = share("points/valid/0");
  let p = pubkey(&s);
  let sc = Scalar::from_bytes_mod_order(s);
  let mut wrong: Vec<(&str, [u8; 32])> = vec![
    ("opening-plus-one", (sc + Scalar::ONE).to_bytes()),
    ("opening-negated", (-sc).to_bytes()),
    ("opening-zero", [0u8; 32]),
    ("opening-l", L_LE),
    ("opening-all-ones", [0xff; 32]),
  ];
  if let Some(v) = plus_l(&s) {
    wrong.push(("opening-plus-l", v)); // the same point mathematically; not the canonical scalar
  }
  for (name, bad) in wrong {
    assert!(!scalar_matches(&bad, &p));
    cases.push(err_case(name, json!({ "point": h(p), "scalar": h(bad) }), "ScalarMismatch"));
  }

  // Monero's own `secret_key_to_public_key` rows (tests/crypto/tests.txt): 256 reduced secrets
  // with their public keys, and 16 unreduced secrets that must be refused.
  let rows: Vec<Value> = include_str!("../../../../docs/research/prototypes/solana-curve/vectors/secret_key_to_public_key.txt")
    .lines()
    .filter(|l| !l.trim().is_empty())
    .map(|line| {
      let parts: Vec<&str> = line.split_whitespace().collect();
      assert_eq!(parts[0], "secret_key_to_public_key");
      let secret: [u8; 32] = hex::decode(parts[1]).unwrap().try_into().unwrap();
      match parts[2] {
        "true" => {
          let public: [u8; 32] = hex::decode(parts[3]).unwrap().try_into().unwrap();
          // This crate agrees with every row before publishing it.
          assert!(scalar_matches(&secret, &public), "Monero row {}", parts[1]);
          assert!(validate_point(&public));
          json!({ "secret": parts[1], "valid": true, "public": parts[3] })
        }
        "false" => {
          assert!(crate::primitives::scalar_canonical(&secret).is_err(), "Monero row {} should be unreduced", parts[1]);
          json!({ "secret": parts[1], "valid": false })
        }
        other => panic!("unexpected flag {other}"),
      }
    })
    .collect();
  assert_eq!(rows.len(), 272);

  // The low-order X25519 table: seven u-coordinates and their aliases with bit 255 set.
  let names = ["0 (order 4)", "1 (order 1)", "order 8", "order 8", "p - 1 (order 2)", "p (= 0)", "p + 1 (= 1)"];
  let mut low = Vec::new();
  for (p, name) in LOW_ORDER_X25519.iter().zip(names) {
    low.push(json!({ "key": h(p), "u": name, "bit_255": false }));
    let mut alias = *p;
    alias[31] |= 0x80;
    low.push(json!({ "key": h(alias), "u": name, "bit_255": true }));
  }
  let honest_x25519: Vec<Value> =
    (0..8).map(|i| json!(h(crate::envelope::x25519_public(&fixed(&format!("points/x25519/{i}")))))).collect();

  suite(
    "points",
    cases,
    vec![
      ("monero_secret_key_to_public_key", Value::Array(rows)),
      ("low_order_x25519", Value::Array(low)),
      ("valid_x25519", Value::Array(honest_x25519)),
      ("basepoint", json!(h(ED25519_BASEPOINT_POINT.compress().to_bytes()))),
      ("l", json!(h(L_LE))),
    ],
  )
}

pub fn pok() -> VectorFile {
  let mut cases = Vec::new();
  let input = |s_pub: &[u8; 32], ctx: &[u8; 32], pok: &[u8; 64]| json!({ "S": h(s_pub), "ctx": h(ctx), "pok": h(pok) });
  for i in 0..4 {
    let s = share(&format!("pok/share/{i}"));
    let ctx = fixed(&format!("pok/ctx/{i}"));
    let proof = pok_prove(&s, &ctx).unwrap();
    let s_pub = pubkey(&s);
    assert!(pok_check(&s_pub, &ctx, &proof).is_ok());
    cases.push(ok_case(&format!("valid-{i}"), json!({ "s": h(s), "ctx": h(ctx) }), json!({ "S": h(s_pub), "pok": h(proof) })));
  }
  let s = share("pok/share/0");
  let s_pub = pubkey(&s);
  let ctx = fixed("pok/ctx/0");
  let proof = pok_prove(&s, &ctx).unwrap();
  let mut bad = |name: &str, s_pub: [u8; 32], ctx: [u8; 32], proof: [u8; 64]| {
    let e = pok_check(&s_pub, &ctx, &proof).expect_err(name);
    cases.push(err_case(name, input(&s_pub, &ctx, &proof), &e.to_string()));
  };
  // Replay under another context: a maker's proof presented for a swap, and the reverse.
  bad("wrong-ctx", s_pub, fixed("pok/ctx/1"), proof);
  // A valid proof for another share.
  bad("wrong-key", pubkey(&share("pok/share/1")), ctx, proof);
  let mut t = proof;
  t[3] ^= 0x10;
  bad("flipped-bit-in-R", s_pub, ctx, t);
  let mut t = proof;
  t[40] ^= 0x01;
  bad("flipped-bit-in-z", s_pub, ctx, t);
  if let Some(z) = plus_l(proof[32..].try_into().unwrap()) {
    let mut t = proof;
    t[32..].copy_from_slice(&z);
    bad("non-canonical-z", s_pub, ctx, t); // z + l: same scalar mod l, refused
  }
  let mut t = proof;
  t[32..].copy_from_slice(&[0xff; 32]);
  bad("z-all-ones", s_pub, ctx, t);
  let mut t = proof;
  t[..32].copy_from_slice(&{
    let mut off = [0u8; 32];
    off[0] = 2;
    off
  });
  bad("R-off-curve", s_pub, ctx, t);
  // The trivial "proof" R = identity, z = 0 for the identity commitment.
  let mut identity = [0u8; 32];
  identity[0] = 1;
  let mut trivial = [0u8; 64];
  trivial[0] = 1;
  bad("identity-commitment", identity, ctx, trivial);
  // A torsioned commitment with the honest proof for its prime-order part.
  let torsioned = (ed_decompress(&s_pub).unwrap() + EIGHT_TORSION[1]).compress().to_bytes();
  bad("torsioned-commitment", torsioned, ctx, proof);
  // Rogue key: S' = k·G − S_other, with a proof made from k.
  let k = share("pok/rogue-k");
  let rogue = (ed_decompress(&pubkey(&k)).unwrap() - ed_decompress(&s_pub).unwrap()).compress().to_bytes();
  assert!(validate_point(&rogue));
  bad("rogue-key-proof-from-k", rogue, ctx, pok_prove(&k, &ctx).unwrap());
  bad("rogue-key-proof-from-victim", rogue, ctx, proof);
  suite("pok", cases, vec![])
}

pub fn joint_address() -> VectorFile {
  let mut cases = Vec::new();
  let hx = |s: &str| -> [u8; 32] { hex::decode(s).unwrap().try_into().unwrap() };
  // First: the vector of docs/research/monero.md section 1.
  let research = (
    hx("6f863e268cff9390a698f23843f802584c7bd2e3bc74593e60dd4138da1de31c"),
    hx("07c805e21c0057430b82a791f66fdc0d185d398e4f8fb73a955b6bada1ac88d9"),
    hx("c6367a52bf1ab84df6e44d2f4b5a12fa490bf9351654a5b610f568122e5b7002"),
    hx("2f246ff530c01376f39b9e2e95e9dcd953e6020a2b984bad02203c4e596c5906"),
  );
  let mut sets = vec![("research".to_string(), research)];
  for i in 0..3 {
    sets.push((
      format!("random-{i}"),
      (
        pubkey(&share(&format!("joint/sm/{i}"))),
        pubkey(&share(&format!("joint/st/{i}"))),
        scalar(&format!("joint/vm/{i}")),
        scalar(&format!("joint/vt/{i}")),
      ),
    ));
  }
  for (name, (sm, st, vm, vt)) in &sets {
    for network in [Network::Mainnet, Network::Stagenet, Network::Testnet, Network::Regtest] {
      let j = derive_joint_address(sm, st, vm, vt, network).unwrap();
      cases.push(ok_case(
        &format!("{name}-{}", network.name()),
        json!({ "spend_pub_a": h(sm), "spend_pub_b": h(st), "view_a": h(vm), "view_b": h(vt), "network": network.name() }),
        json!({ "address": j.address, "spend_pub": h(j.spend_pub), "view_priv": h(j.view_priv), "view_pub": h(j.view_pub) }),
      ));
    }
  }
  assert_eq!(
    cases[0]["output"]["address"],
    "43MXoVqwCynJiVT1MxchHuD7yqsPMiEv7gtCd4ZkohoAXGm7Fr6M1unUwRwuRm2n39jVCX4nyBrHfMK8tWhJrXFDMXkmBPX"
  );
  let (sm, st, vm, vt) = research;
  let mut bad = |name: &str, a: [u8; 32], b: [u8; 32], va: [u8; 32], vb: [u8; 32]| {
    let e = derive_joint_address(&a, &b, &va, &vb, Network::Mainnet).expect_err(name);
    cases.push(err_case(
      name,
      json!({ "spend_pub_a": h(a), "spend_pub_b": h(b), "view_a": h(va), "view_b": h(vb), "network": "mainnet" }),
      &e.to_string(),
    ));
  };
  let mut identity = [0u8; 32];
  identity[0] = 1;
  bad("identity-spend-half", identity, st, vm, vt);
  bad("small-order-spend-half", sm, EIGHT_TORSION[4].compress().to_bytes(), vm, vt);
  bad("torsioned-spend-half", (ed_decompress(&sm).unwrap() + EIGHT_TORSION[1]).compress().to_bytes(), st, vm, vt);
  bad("spend-halves-cancel", sm, (-ed_decompress(&sm).unwrap()).compress().to_bytes(), vm, vt);
  bad("zero-view-half", sm, st, [0u8; 32], vt);
  bad("non-canonical-view-half", sm, st, vm, L_LE);
  bad("view-halves-cancel", sm, st, vm, (-Scalar::from_bytes_mod_order(vm)).to_bytes());
  suite(
    "joint_address",
    cases,
    vec![("prefixes", json!({ "mainnet": 18, "stagenet": 24, "testnet": 53, "regtest": 18 }))],
  )
}

pub fn twin() -> VectorFile {
  let mut cases = Vec::new();
  let mut one = [0u8; 32];
  one[0] = 1;
  let mut max = [0xffu8; 32];
  max[31] = 0x0f;
  let mut shares: Vec<(String, [u8; 32])> = vec![("one".into(), one), ("max-2^252-minus-1".into(), max)];
  for i in 0..6 {
    shares.push((format!("random-{i}"), share(&format!("twin/{i}"))));
  }
  for (name, s) in &shares {
    let t = twin_commitments(s).unwrap();
    cases.push(ok_case(
      name,
      json!({ "s": h(s), "secret_uint256": h(share_as_uint256(s)) }),
      json!({ "key_addr": h(t.key_addr), "key_addr2": h(t.key_addr2), "secp_compressed": h(t.secp_compressed) }),
    ));
  }
  // Out-of-range scalars: zero, 2^252, l, n, n + 1, 2^256 − 1. The contract refuses each
  // (`0 < s < 2^252`) whatever commitments it is checked against.
  let mut two252 = [0u8; 32];
  two252[31] = 0x10;
  let mut n_le: [u8; 32] = hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141").unwrap().try_into().unwrap();
  n_le.reverse();
  let mut n_plus_1 = n_le;
  n_plus_1[0] += 1;
  for (name, s) in [("zero", [0u8; 32]), ("2^252", two252), ("l", L_LE), ("n", n_le), ("n-plus-1", n_plus_1), ("2^256-minus-1", [0xff; 32])] {
    let e = twin_commitments(&s).expect_err(name);
    cases.push(err_case(name, json!({ "s": h(s), "secret_uint256": h(share_as_uint256(&s)) }), &e.to_string()));
  }
  // An in-range scalar checked against another share's commitments: `mulVerify2` is false.
  let a = share("twin/0");
  let b = share("twin/1");
  let ta = twin_commitments(&a).unwrap();
  let tb = twin_commitments(&b).unwrap();
  cases.push(err_case(
    "mismatch-both",
    json!({ "s": h(b), "secret_uint256": h(share_as_uint256(&b)), "key_addr": h(ta.key_addr), "key_addr2": h(ta.key_addr2) }),
    "ScalarMismatch",
  ));
  // The first commitment matches and the second does not: the 320-bit check still refuses.
  cases.push(err_case(
    "mismatch-second-only",
    json!({ "s": h(a), "secret_uint256": h(share_as_uint256(&a)), "key_addr": h(ta.key_addr), "key_addr2": h(tb.key_addr2) }),
    "ScalarMismatch",
  ));
  cases.push(err_case(
    "mismatch-first-only",
    json!({ "s": h(a), "secret_uint256": h(share_as_uint256(&a)), "key_addr": h(tb.key_addr), "key_addr2": h(ta.key_addr2) }),
    "ScalarMismatch",
  ));
  // A zero commitment never matches (it is ecrecover's failure value).
  cases.push(err_case(
    "zero-commitment",
    json!({ "s": h(a), "secret_uint256": h(share_as_uint256(&a)), "key_addr": h([0u8; 20]), "key_addr2": h(ta.key_addr2) }),
    "ScalarMismatch",
  ));
  suite(
    "twin",
    cases,
    vec![("t2_tag", json!(core::str::from_utf8(T2_TAG).unwrap())), ("t2", json!(h(t2().to_bytes())))],
  )
}

pub fn dleq() -> Vec<VectorFile> {
  let mut files = Vec::new();
  let mut cases = Vec::new();
  let mut add = |name: &str, bytes: Vec<u8>, extra: Value| {
    let path = format!("dleq/{name}.bin");
    let mut input = json!({ "file": path, "length": bytes.len(), "sha256": h(sha256(&[&bytes])) });
    if let Value::Object(m) = extra {
      input.as_object_mut().unwrap().extend(m);
    }
    match dleq_verify(&bytes) {
      Ok(st) => cases.push(ok_case(
        name,
        input,
        json!({
          "spend_pub": h(st.spend_pub),
          "secp_compressed": h(st.secp_compressed),
          "key_addr": h(st.key_addr),
          "key_addr2": h(st.key_addr2),
        }),
      )),
      Err(e) => cases.push(err_case(name, input, &e.to_string())),
    }
    files.push(VectorFile { path, bytes });
  };
  let s1 = share("dleq/1");
  let s2 = share("dleq/2");
  let blob1 = dleq_prove_seeded(&s1, fixed("dleq/rng/1")).unwrap();
  let blob2 = dleq_prove_seeded(&s2, fixed("dleq/rng/2")).unwrap();
  // The revealed scalar is included so the contract test can check it against the addresses.
  add("valid-1", blob1.clone(), json!({ "s": h(s1), "secret_uint256": h(share_as_uint256(&s1)) }));
  add("valid-2", blob2.clone(), json!({ "s": h(s2), "secret_uint256": h(share_as_uint256(&s2)) }));
  let mut flipped = blob1.clone();
  flipped[DLEQ_HEADER + 20_000] ^= 0x04;
  add("flipped-bit", flipped, json!({}));
  // The proof of share 1 under the keys of share 2.
  let mut wrong_key = blob1.clone();
  wrong_key[1..DLEQ_HEADER].copy_from_slice(&blob2[1..DLEQ_HEADER]);
  add("wrong-key", wrong_key, json!({}));
  // Rogue ed25519 key with the honest secp256k1 twin (the direction-B attack of SPEC 2.6).
  let mut rogue = blob1.clone();
  rogue[1..33].copy_from_slice(&blob2[1..33]);
  add("wrong-ed25519-key", rogue, json!({}));
  let mut trailing = blob1.clone();
  trailing.push(0);
  add("trailing-byte", trailing, json!({}));
  let mut oversize = blob1.clone();
  oversize.resize(DLEQ_MAX_BLOB + 1, 0);
  add("oversize", oversize, json!({}));
  let mut version = blob1;
  version[0] = 2;
  add("wrong-version", version, json!({}));
  assert_eq!(cases.iter().filter(|c| c["valid"] == true).count(), 2);
  files.insert(
    0,
    suite(
      "dleq",
      cases,
      vec![
        ("max_blob", json!(DLEQ_MAX_BLOB)),
        ("layout", json!("0x01 || S[32] || P_compressed[33] || proof (bincode 2 standard)")),
        ("secp_h", json!(crate::dleq::SECP_H)),
        ("ed_h", json!(crate::dleq::ED_H)),
      ],
    ),
  );
  files
}

pub fn merkle() -> VectorFile {
  let mut cases = Vec::new();
  for size in [2usize, 16, 64] {
    let mut inputs = Vec::new();
    let mut leaves = Vec::new();
    for i in 0..size {
      let s = share(&format!("merkle/{size}/{i}"));
      let t = twin_commitments(&s).unwrap();
      let s_pub = pubkey(&s);
      leaves.push(key_leaf(i as u32, &t.key_addr, &t.key_addr2, &s_pub));
      inputs.push(json!({ "index": i, "key_addr": h(t.key_addr), "key_addr2": h(t.key_addr2), "spend_pub": h(s_pub) }));
    }
    let root = merkle_root(&leaves).unwrap();
    let proofs: Vec<Value> = (0..size)
      .map(|i| {
        let proof = merkle_proof(&leaves, i).unwrap();
        assert!(merkle_verify(&leaves[i], &proof, &root));
        Value::Array(proof.iter().map(|p| json!(h(p))).collect())
      })
      .collect();
    cases.push(ok_case(
      &format!("pool-{size}"),
      json!({ "leaves": inputs }),
      json!({ "leaf_hashes": leaves.iter().map(h).collect::<Vec<_>>(), "root": h(root), "proofs": proofs }),
    ));
    // Proofs that must not verify against this root.
    let p0 = merkle_proof(&leaves, 0).unwrap();
    let as_json = |p: &[[u8; 32]]| Value::Array(p.iter().map(|x| json!(h(x))).collect());
    cases.push(err_case(
      &format!("pool-{size}-proof-for-another-leaf"),
      json!({ "root": h(root), "leaf": h(leaves[1]), "proof": as_json(&p0) }),
      "MerkleProofInvalid",
    ));
    let mut tampered = p0.clone();
    tampered[0][0] ^= 1;
    cases.push(err_case(
      &format!("pool-{size}-tampered-proof"),
      json!({ "root": h(root), "leaf": h(leaves[0]), "proof": as_json(&tampered) }),
      "MerkleProofInvalid",
    ));
    // The same share at another index is another leaf.
    let s = share(&format!("merkle/{size}/0"));
    let t = twin_commitments(&s).unwrap();
    let moved = key_leaf(1, &t.key_addr, &t.key_addr2, &pubkey(&s));
    assert!(!merkle_verify(&moved, &p0, &root));
    cases.push(err_case(
      &format!("pool-{size}-same-share-other-index"),
      json!({ "root": h(root), "leaf": h(moved), "proof": as_json(&p0) }),
      "MerkleProofInvalid",
    ));
  }
  for n in [0usize, 1, 3, 100, 512] {
    assert!(merkle_root(&vec![[0u8; 32]; n]).is_err());
    cases.push(err_case(&format!("size-{n}"), json!({ "leaf_count": n }), "MerklePoolSize"));
  }
  suite("merkle", cases, vec![("leaf", json!("keccak256(keccak256(abi.encode(uint32 index, address keyAddr, address keyAddr2, bytes32 S)))")), ("node", json!("keccak256(min(a, b) || max(a, b))"))])
}
