//! Vector suites for SPEC 2.8 to 2.10 and 3.12: notice, envelope, sol_signed, eip712.

use serde_json::{json, Value};

use super::{d, err_case, fixed, fixed_n, h, h0x, ok_case, scalar, share, suite, VectorFile};
use crate::{
  envelope::{
    envelope_open, envelope_seal, envelope_sign, envelope_verify_sig, notice_commitment, notice_open, notice_seal,
    x25519_public, NoticeKeys, OpenArgs, SealArgs, Side, ENVELOPE_MAX_ONCHAIN, ENVELOPE_MAX_TOR,
  },
  ethereum::{
    approval_digest, approval_struct_hash, approval_type_hash, domain_separator, encode_eth_quote_compact,
    encode_eth_quote_compact_signed, eth_approval_admits, open_hash_ethereum, quote_digest, quote_live, quote_struct_hash,
    quote_type_hash, swap_id, Eip712Domain, EthApproval, EthQuote, OpenHashEthereumInput, ANY_DIRECTION, ANY_TOKEN,
    APPROVAL_TYPE, DOMAIN_TYPE, EIP712_NAME, EIP712_VERSION, QUOTE_TYPE,
  },
  primitives::ed_base_mul,
  sign::{ecdsa_recover_address, ecdsa_sign_digest, ed25519_public, ed25519_sign, ed25519_verify, eth_address_of_secret},
  solana::{
    encode_sol_approval, open_hash_solana, sol_approval_admits, OpenHashSolanaInput, SolApproval, ANY,
  },
  twin::twin_commitments,
};

struct Parties {
  taker_secret: [u8; 32],
  taker_pub: [u8; 32],
  maker_secret: [u8; 32],
  maker_pub: [u8; 32],
  operator_seed: [u8; 32],
  operator_pub: [u8; 32],
}
fn parties() -> Parties {
  let taker_secret = fixed("msg/taker-enc");
  let maker_secret = fixed("msg/maker-enc");
  let operator_seed = fixed("msg/operator");
  Parties {
    taker_secret,
    taker_pub: x25519_public(&taker_secret),
    maker_secret,
    maker_pub: x25519_public(&maker_secret),
    operator_seed,
    operator_pub: ed25519_public(&operator_seed),
  }
}
fn keys_json(p: &Parties) -> Value {
  json!({
    "taker_secret": h(p.taker_secret),
    "taker_pub": h(p.taker_pub),
    "maker_secret": h(p.maker_secret),
    "maker_pub": h(p.maker_pub),
    "operator_seed": h(p.operator_seed),
    "operator_pub": h(p.operator_pub),
  })
}

pub fn notice() -> VectorFile {
  let p = parties();
  let mut cases = Vec::new();
  let swap_ref = fixed("notice/swap-ref");
  let txid = fixed("notice/txid");
  let view = scalar("notice/view");
  let nonce: [u8; 24] = fixed_n("notice/nonce");
  let commitment = notice_commitment(&swap_ref, &txid, &view);
  let maker = NoticeKeys { own_secret: &p.maker_secret, peer_pub: &p.taker_pub, side: Side::Maker, swap_ref: &swap_ref };
  let taker = NoticeKeys { own_secret: &p.taker_secret, peer_pub: &p.maker_pub, side: Side::Taker, swap_ref: &swap_ref };
  let ct = notice_seal(&maker, &txid, &view, nonce).unwrap();
  assert_eq!(notice_open(&taker, &ct, &commitment).unwrap(), (txid, view));
  // Both sides derive the same key, so the bytes do not depend on who seals.
  assert_eq!(notice_seal(&taker, &txid, &view, nonce).unwrap(), ct);

  cases.push(ok_case(
    "commitment",
    json!({ "swap_ref": h(swap_ref), "txid": h(txid), "view": h(view) }),
    json!({ "commitment": h(commitment) }),
  ));
  cases.push(ok_case(
    "seal-direction-a",
    json!({ "sealed_by": "maker", "swap_ref": h(swap_ref), "txid": h(txid), "view": h(view), "nonce": h(nonce) }),
    json!({ "ciphertext": h(ct), "commitment": h(commitment) }),
  ));
  cases.push(ok_case(
    "seal-direction-b",
    json!({ "sealed_by": "taker", "swap_ref": h(swap_ref), "txid": h(txid), "view": h(view), "nonce": h(nonce) }),
    json!({ "ciphertext": h(ct), "commitment": h(commitment) }),
  ));
  // A second notice: another swap, another nonce.
  let swap_ref2 = fixed("notice/swap-ref-2");
  let txid2 = fixed("notice/txid-2");
  let view2 = scalar("notice/view-2");
  let nonce2: [u8; 24] = fixed_n("notice/nonce-2");
  let taker2 = NoticeKeys { swap_ref: &swap_ref2, ..NoticeKeys { own_secret: &p.taker_secret, peer_pub: &p.maker_pub, side: Side::Taker, swap_ref: &swap_ref } };
  let ct2 = notice_seal(&taker2, &txid2, &view2, nonce2).unwrap();
  cases.push(ok_case(
    "seal-second-swap",
    json!({ "sealed_by": "taker", "swap_ref": h(swap_ref2), "txid": h(txid2), "view": h(view2), "nonce": h(nonce2) }),
    json!({ "ciphertext": h(ct2), "commitment": h(notice_commitment(&swap_ref2, &txid2, &view2)) }),
  ));

  // Failures, as seen by the taker opening a direction-A notice.
  let mut bad = |name: &str, keys: &NoticeKeys, ct: &[u8], commitment: [u8; 32]| {
    let e = notice_open(keys, ct, &commitment).expect_err(name);
    cases.push(err_case(
      name,
      json!({ "opened_by": "taker", "swap_ref": h(keys.swap_ref), "ciphertext": h(ct), "commitment": h(commitment) }),
      &e.to_string(),
    ));
  };
  let mut tampered = ct;
  tampered[60] ^= 0x01;
  bad("tampered-ciphertext", &taker, &tampered, commitment);
  let mut tampered = ct;
  tampered[103] ^= 0x80;
  bad("tampered-tag", &taker, &tampered, commitment);
  let mut tampered = ct;
  tampered[0] ^= 0x01;
  bad("tampered-nonce", &taker, &tampered, commitment);
  // The right ciphertext presented for another swap (the swap_ref is the associated data).
  bad("wrong-swap-ref", &taker2, &ct, commitment);
  // A ciphertext that decrypts but does not open the on-chain commitment: "no lock".
  let lying = notice_seal(&maker, &fixed("notice/other-txid"), &view, nonce).unwrap();
  bad("does-not-open-commitment", &taker, &lying, commitment);
  let lying_view = notice_seal(&maker, &txid, &scalar("notice/other-view"), nonce).unwrap();
  bad("does-not-open-commitment-view", &taker, &lying_view, commitment);
  bad("truncated", &taker, &ct[..103], commitment);

  suite("notice", cases, vec![("keys", keys_json(&p)), ("ciphertext_len", json!(104))])
}

/// The largest messages a maker sends in reply, as JSON plaintext (SPEC 6.1).
fn largest_responses(op_seed: &[u8; 32]) -> Vec<(&'static str, String)> {
  let b64 = |b: &[u8]| base64(b);
  // Solana approval_response: every field at its widest.
  let sol_approval = json!({
    "t": "approval_response", "ok": true, "chain": "solana",
    "asset": 255, "direction": 255,
    "max_xmr": d(u64::MAX), "not_before": d(i64::MAX), "expires_at": d(i64::MAX),
    "epoch": u32::MAX, "approval_id": d(u64::MAX),
    "sig": b64(&ed25519_sign(op_seed, b"largest")),
  });
  // Ethereum approval_response.
  let eth_approval = json!({
    "t": "approval_response", "ok": true, "chain": "ethereum",
    "maker": h0x([0xff; 20]), "taker": h0x([0xee; 20]), "token": h0x(ANY_TOKEN),
    "direction": 255,
    "max_xmr": d(u64::MAX), "not_before": d(u64::MAX), "valid_until": d(u64::MAX),
    "epoch": u32::MAX, "approval_id": h0x([0xdd; 32]),
    "sig": b64(&[0xaa; 65]),
  });
  // Solana quote_response.
  let sol_quote = json!({ "t": "quote_response", "ok": true, "chain": "solana", "quote_id": d(u64::MAX), "expires_at": d(i64::MAX) });
  // Ethereum quote_response: the compact form with its signature (320 bytes).
  let eth_quote = json!({ "t": "quote_response", "ok": true, "chain": "ethereum", "quote": b64(&[0xff; 320]) });
  vec![
    ("largest-approval-response-solana", sol_approval.to_string()),
    ("largest-approval-response-ethereum", eth_approval.to_string()),
    ("largest-quote-response-solana", sol_quote.to_string()),
    ("largest-quote-response-ethereum", eth_quote.to_string()),
  ]
}

/// Standard base64 with padding (the only place this crate needs it: vector plaintexts).
pub(crate) fn base64(b: &[u8]) -> String {
  const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::new();
  for chunk in b.chunks(3) {
    let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
    out.push(T[(n >> 18) as usize & 63] as char);
    out.push(T[(n >> 12) as usize & 63] as char);
    out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
    out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
  }
  out
}

pub fn envelope() -> VectorFile {
  let p = parties();
  let mut cases = Vec::new();
  let swap_ref = fixed("envelope/swap-ref");
  let nonce: [u8; 24] = fixed_n("envelope/nonce");

  // Taker to maker, bound to a swap.
  let t2m_plain = br#"{"t":"inbox","text":"Please release my deposit.","action":"release_deposit"}"#;
  let t2m = envelope_seal(&SealArgs {
    from_maker: false,
    maker_key_version: 3,
    own_secret: &p.taker_secret,
    peer_pub: &p.maker_pub,
    swap_ref: &swap_ref,
    plaintext: t2m_plain,
    nonce,
    max_len: ENVELOPE_MAX_ONCHAIN,
  })
  .unwrap();
  cases.push(ok_case(
    "taker-to-maker",
    json!({ "from_maker": false, "maker_key_version": 3, "swap_ref": h(swap_ref), "nonce": h(nonce), "plaintext": h(t2m_plain), "plaintext_utf8": core::str::from_utf8(t2m_plain).unwrap() }),
    json!({ "envelope": h(&t2m), "length": t2m.len() }),
  ));
  // Taker to maker, no swap (a quote request under the contact key).
  let req_plain = br#"{"t":"quote_request","chain":"solana","market":"usdc_sol","direction":"A","xmr":"250000000000000","taker":"4Nd1mYw1rWcWxCmWbHVNr4YjYLgFQLA9mCF5Mqqu9Bq8"}"#;
  let nonce2: [u8; 24] = fixed_n("envelope/nonce-2");
  let req = envelope_seal(&SealArgs {
    from_maker: false,
    maker_key_version: 3,
    own_secret: &p.taker_secret,
    peer_pub: &p.maker_pub,
    swap_ref: &[0u8; 32],
    plaintext: req_plain,
    nonce: nonce2,
    max_len: ENVELOPE_MAX_ONCHAIN,
  })
  .unwrap();
  cases.push(ok_case(
    "taker-to-maker-no-swap",
    json!({ "from_maker": false, "maker_key_version": 3, "swap_ref": h([0u8; 32]), "nonce": h(nonce2), "plaintext": h(req_plain), "plaintext_utf8": core::str::from_utf8(req_plain).unwrap() }),
    json!({ "envelope": h(&req), "length": req.len() }),
  ));
  // Maker to taker, signed by the operator.
  let m2t_plain = br#"{"t":"inbox_reply","text":"Released.","in_reply_to":"7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069"}"#;
  let nonce3: [u8; 24] = fixed_n("envelope/nonce-3");
  let seal_maker = |plaintext: &[u8], nonce: [u8; 24], max_len: usize| {
    envelope_seal(&SealArgs {
      from_maker: true,
      maker_key_version: 3,
      own_secret: &p.maker_secret,
      peer_pub: &p.taker_pub,
      swap_ref: &swap_ref,
      plaintext,
      nonce,
      max_len,
    })
    .and_then(|e| envelope_sign(&e, &p.operator_seed))
  };
  let m2t = seal_maker(m2t_plain, nonce3, ENVELOPE_MAX_ONCHAIN).unwrap();
  assert!(envelope_verify_sig(&m2t, &p.operator_pub));
  cases.push(ok_case(
    "maker-to-taker",
    json!({ "from_maker": true, "maker_key_version": 3, "swap_ref": h(swap_ref), "nonce": h(nonce3), "plaintext": h(m2t_plain), "plaintext_utf8": core::str::from_utf8(m2t_plain).unwrap() }),
    json!({ "envelope": h(&m2t), "length": m2t.len(), "signature": h(&m2t[m2t.len() - 64..]) }),
  ));

  // The largest responses against the 900-byte on-chain cap.
  for (i, (name, plaintext)) in largest_responses(&p.operator_seed).into_iter().enumerate() {
    let nonce: [u8; 24] = fixed_n(&format!("envelope/largest/{i}"));
    let env = seal_maker(plaintext.as_bytes(), nonce, ENVELOPE_MAX_TOR).unwrap();
    assert!(env.len() <= ENVELOPE_MAX_ONCHAIN, "{name} is {} bytes: it does not fit the on-chain cap", env.len());
    cases.push(ok_case(
      name,
      json!({ "from_maker": true, "maker_key_version": 3, "swap_ref": h(swap_ref), "nonce": h(nonce), "plaintext": h(plaintext.as_bytes()), "plaintext_utf8": plaintext }),
      json!({ "envelope": h(&env), "length": env.len(), "fits_onchain_cap": true, "onchain_cap": ENVELOPE_MAX_ONCHAIN }),
    ));
  }

  // Failures. `opened_by` says whose keys the reader uses.
  let open_taker = |env: &[u8], operator: Option<&[u8; 32]>| {
    envelope_open(&OpenArgs { envelope: env, own_secret: &p.taker_secret, maker_pub: Some(&p.maker_pub), operator_pub: operator })
  };
  let open_maker = |env: &[u8]| envelope_open(&OpenArgs { envelope: env, own_secret: &p.maker_secret, maker_pub: None, operator_pub: None });
  let mut bad_maker = |name: &str, env: Vec<u8>| {
    let e = open_maker(&env).expect_err(name);
    cases.push(err_case(name, json!({ "opened_by": "maker", "envelope": h(&env) }), &e.to_string()));
  };
  let flip = |env: &[u8], at: usize| {
    let mut v = env.to_vec();
    v[at] ^= 0x01;
    v
  };
  bad_maker("bad-magic", flip(&t2m, 0));
  bad_maker("bad-version", flip(&t2m, 2));
  bad_maker("unknown-flag-bit", {
    let mut v = t2m.clone();
    v[3] = 0x02;
    v
  });
  bad_maker("tampered-key-version", flip(&t2m, 4));
  bad_maker("tampered-taker-pub", flip(&t2m, 20));
  bad_maker("tampered-swap-ref", flip(&t2m, 50));
  bad_maker("tampered-nonce", flip(&t2m, 80));
  bad_maker("tampered-ciphertext", flip(&t2m, 100));
  bad_maker("tampered-tag", flip(&t2m, t2m.len() - 1));
  bad_maker("truncated", t2m[..100].to_vec());
  bad_maker("oversize", vec![0u8; ENVELOPE_MAX_TOR + 1]);
  // A taker envelope whose taker_pub is a low-order point.
  bad_maker("low-order-taker-pub", {
    let mut v = t2m.clone();
    v[8..40].copy_from_slice(&crate::envelope::LOW_ORDER_X25519[2]);
    v
  });

  let mut bad_taker = |name: &str, env: Vec<u8>, operator: Option<[u8; 32]>| {
    let e = open_taker(&env, operator.as_ref()).expect_err(name);
    cases.push(err_case(
      name,
      json!({ "opened_by": "taker", "envelope": h(&env), "operator_pub": operator.map(h) }),
      &e.to_string(),
    ));
  };
  bad_taker("maker-envelope-without-operator-key", m2t.clone(), None);
  bad_taker("maker-envelope-wrong-operator", m2t.clone(), Some(ed25519_public(&fixed("envelope/other-operator"))));
  bad_taker("maker-envelope-tampered-signature", flip(&m2t, m2t.len() - 10), Some(p.operator_pub));
  bad_taker("maker-envelope-tampered-body", flip(&m2t, 100), Some(p.operator_pub));
  bad_taker("maker-envelope-signature-stripped", m2t[..m2t.len() - 64].to_vec(), Some(p.operator_pub));
  // Correctly signed, but encrypted to another taker's key.
  let other_taker = x25519_public(&fixed("envelope/other-taker"));
  let to_other = envelope_seal(&SealArgs {
    from_maker: true,
    maker_key_version: 3,
    own_secret: &p.maker_secret,
    peer_pub: &other_taker,
    swap_ref: &swap_ref,
    plaintext: m2t_plain,
    nonce: nonce3,
    max_len: ENVELOPE_MAX_ONCHAIN,
  })
  .and_then(|e| envelope_sign(&e, &p.operator_seed))
  .unwrap();
  bad_taker("maker-envelope-for-another-taker", to_other, Some(p.operator_pub));

  // Sealing failures.
  let over = envelope_seal(&SealArgs {
    from_maker: false,
    maker_key_version: 3,
    own_secret: &p.taker_secret,
    peer_pub: &p.maker_pub,
    swap_ref: &swap_ref,
    plaintext: &[b'a'; 789],
    nonce,
    max_len: ENVELOPE_MAX_ONCHAIN,
  })
  .expect_err("789 bytes of plaintext make 901");
  cases.push(err_case("seal-over-onchain-cap", json!({ "from_maker": false, "plaintext_len": 789, "max_len": ENVELOPE_MAX_ONCHAIN }), &over.to_string()));
  let over = seal_maker(&[b'a'; 725], nonce, ENVELOPE_MAX_ONCHAIN).expect_err("725 bytes plus the signature make 901");
  cases.push(err_case("seal-maker-over-onchain-cap", json!({ "from_maker": true, "plaintext_len": 725, "max_len": ENVELOPE_MAX_ONCHAIN }), &over.to_string()));

  suite(
    "envelope",
    cases,
    vec![
      ("keys", keys_json(&p)),
      ("max_onchain", json!(ENVELOPE_MAX_ONCHAIN)),
      ("max_tor", json!(ENVELOPE_MAX_TOR)),
      ("overhead", json!({ "taker": 112, "maker": 176 })),
      ("signature_message", json!("DS(\"envelope-sig\") || envelope[0 .. len - 64]")),
    ],
  )
}

/// The data of an Ed25519 precompile instruction carrying one signature whose public key,
/// signature and message all live in that same instruction (all three instruction-index fields
/// are `0xFFFF`), as SPEC 4.6 requires: 2 + 14 + 32 + 64 + message bytes.
pub(crate) fn ed25519_instruction_data(public: &[u8; 32], sig: &[u8; 64], msg: &[u8]) -> Vec<u8> {
  const HEADER: u16 = 2 + 14;
  let pk_offset = HEADER;
  let sig_offset = pk_offset + 32;
  let msg_offset = sig_offset + 64;
  let mut v = vec![1u8, 0u8]; // one signature, padding
  for x in [sig_offset, 0xffff, pk_offset, 0xffff, msg_offset, msg.len() as u16, 0xffff] {
    v.extend_from_slice(&x.to_le_bytes());
  }
  v.extend_from_slice(public);
  v.extend_from_slice(sig);
  v.extend_from_slice(msg);
  v
}

pub fn sol_signed() -> VectorFile {
  let operator_seed = fixed("sol-signed/operator");
  let operator_pub = ed25519_public(&operator_seed);
  let base = SolApproval {
    cluster_tag: fixed("sol-signed/cluster"),
    program_id: fixed("sol-signed/program"),
    maker: fixed("sol-signed/maker"),
    taker: fixed("sol-signed/taker"),
    asset: 1,
    direction: 0,
    max_xmr: 5_000_000_000_000,
    not_before: 1_800_000_000,
    expires_at: 1_800_086_400,
    epoch: 7,
    approval_id: 0x0123_4567_89ab_cdef,
  };
  let fields = |a: &SolApproval| {
    json!({
      "cluster_tag": h(a.cluster_tag), "program_id": h(a.program_id), "maker": h(a.maker), "taker": h(a.taker),
      "asset": a.asset, "direction": a.direction, "max_xmr": d(a.max_xmr), "not_before": a.not_before,
      "expires_at": a.expires_at, "epoch": a.epoch, "approval_id": d(a.approval_id),
    })
  };
  let mut cases = Vec::new();
  // What the lock presents: (now, asset, direction, xmr, maker.approval_epoch).
  let mut use_case = |name: &str, a: &SolApproval, now: i64, asset: u8, direction: u8, xmr: u64, epoch: u32| {
    let msg = encode_sol_approval(a);
    let sig = ed25519_sign(&operator_seed, &msg);
    assert!(ed25519_verify(&operator_pub, &msg, &sig));
    let admits = sol_approval_admits(a, now, asset, direction, xmr, epoch);
    let input = json!({
      "approval": fields(a),
      "lock": { "now": now, "asset": asset, "direction": direction, "xmr": d(xmr), "approval_epoch": epoch },
    });
    let output = json!({
      "message": h(msg), "signature": h(sig), "operator_pub": h(operator_pub),
      "ed25519_instruction_data": h(ed25519_instruction_data(&operator_pub, &sig, &msg)),
    });
    if admits {
      cases.push(ok_case(name, input, output));
    } else {
      // The signature is genuine; the lock must still be refused.
      let mut c = err_case(name, input, "ApprovalInvalid");
      c.as_object_mut().unwrap().insert("output".into(), output);
      cases.push(c);
    }
  };
  // Validity is inclusive on both ends.
  use_case("at-not-before-minus-1", &base, base.not_before - 1, 1, 0, 1_000_000_000_000, 7);
  use_case("at-not-before", &base, base.not_before, 1, 0, 1_000_000_000_000, 7);
  use_case("at-expires-at", &base, base.expires_at, 1, 0, 1_000_000_000_000, 7);
  use_case("at-expires-at-plus-1", &base, base.expires_at + 1, 1, 0, 1_000_000_000_000, 7);
  use_case("at-max-xmr", &base, base.not_before + 10, 1, 0, base.max_xmr, 7);
  use_case("over-max-xmr", &base, base.not_before + 10, 1, 0, base.max_xmr + 1, 7);
  use_case("wrong-asset", &base, base.not_before + 10, 0, 0, 1, 7);
  use_case("wrong-direction", &base, base.not_before + 10, 1, 1, 1, 7);
  use_case("stale-epoch", &base, base.not_before + 10, 1, 0, 1, 8);
  let any = SolApproval { asset: ANY, direction: ANY, approval_id: 2, ..base.clone() };
  use_case("wildcards-sol-a", &any, base.not_before + 10, 0, 0, 1, 7);
  use_case("wildcards-usdc-b", &any, base.not_before + 10, 1, 1, 1, 7);
  let any_asset = SolApproval { asset: ANY, approval_id: 3, ..base.clone() };
  use_case("any-asset-wrong-direction", &any_asset, base.not_before + 10, 0, 1, 1, 7);

  // Signature and binding failures: the precompile or the program's field checks refuse these.
  let msg = encode_sol_approval(&base);
  let sig = ed25519_sign(&operator_seed, &msg);
  let lock = json!({ "now": base.not_before + 10, "asset": 1, "direction": 0, "xmr": "1", "approval_epoch": 7 });
  let mut bad = |name: &str, msg: &[u8], sig: [u8; 64], signer: [u8; 32], error: &str, note: &str| {
    cases.push(err_case(
      name,
      json!({ "message": h(msg), "signature": h(sig), "operator_pub": h(operator_pub), "signer_pub": h(signer), "lock": lock, "note": note }),
      error,
    ));
  };
  let mut tampered = sig;
  tampered[5] ^= 1;
  assert!(!ed25519_verify(&operator_pub, &msg, &tampered));
  bad("tampered-signature", &msg, tampered, operator_pub, "SignatureInvalid", "the Ed25519 precompile fails the transaction");
  let other_seed = fixed("sol-signed/other-operator");
  let other_sig = ed25519_sign(&other_seed, &msg);
  bad(
    "signed-by-another-key",
    &msg,
    other_sig,
    ed25519_public(&other_seed),
    "ApprovalInvalid",
    "a valid signature, but the public key in the instruction is not maker.operator",
  );
  // Replay across domains: each changes one binding field; the signature is valid for the
  // changed message, and the program must refuse it because the field does not match.
  let bindings: [(&str, fn(&mut SolApproval), &str); 4] = [
    ("for-another-cluster", |a| a.cluster_tag = fixed("sol-signed/other-cluster"), "cluster_tag differs from Config.cluster_tag"),
    ("for-another-program", |a| a.program_id = fixed("sol-signed/other-program"), "program_id differs from the program id"),
    ("for-another-maker", |a| a.maker = fixed("sol-signed/other-maker"), "maker differs from the maker PDA"),
    ("for-another-taker", |a| a.taker = fixed("sol-signed/other-taker"), "taker differs from the signing taker"),
  ];
  for (name, mutate, note) in bindings {
    let mut a = base.clone();
    mutate(&mut a);
    let m = encode_sol_approval(&a);
    assert_ne!(m, msg);
    bad(name, &m, ed25519_sign(&operator_seed, &m), operator_pub, "ApprovalInvalid", note);
    // The original signature does not verify over the changed message.
    assert!(!ed25519_verify(&operator_pub, &m, &sig));
  }
  let mut short = msg.to_vec();
  short.pop();
  bad("message-189-bytes", &short, ed25519_sign(&operator_seed, &short), operator_pub, "ApprovalInvalid", "the message is not exactly 190 bytes");
  let mut wrong_tag = msg;
  wrong_tag[0] ^= 1;
  bad("wrong-domain-tag", &wrong_tag, ed25519_sign(&operator_seed, &wrong_tag), operator_pub, "ApprovalInvalid", "the message does not begin with DS(\"sol-approval\")");

  // The open hash of SPEC 3.12 (Solana).
  let open = |name: &str, o: &OpenHashSolanaInput| {
    ok_case(
      name,
      json!({
        "swap": h(o.swap), "t_lock": o.t_lock, "direction": o.direction, "asset": o.asset, "xmr": d(o.xmr), "amount": d(o.amount),
        "deposit": d(o.deposit), "taker_spend_pub": h(o.taker_spend_pub), "locker_view": h(o.locker_view),
        "taker_enc_key": h(o.taker_enc_key), "maker_enc_key": h(o.maker_enc_key),
        "payout": h(o.payout), "watcher": h(o.watcher),
      }),
      json!({ "open_hash": h(open_hash_solana(o)) }),
    )
  };
  let oa = OpenHashSolanaInput {
    swap: fixed("open/swap"),
    t_lock: 1_800_000_000,
    direction: 0,
    asset: 1,
    xmr: 2_000_000_000_000,
    amount: 300_000_000,
    deposit: 3_000_000,
    taker_spend_pub: ed_base_mul(&curve25519_dalek::scalar::Scalar::from_bytes_mod_order(share("open/taker"))),
    locker_view: scalar("open/view"),
    taker_enc_key: x25519_public(&fixed("open/taker-enc")),
    maker_enc_key: x25519_public(&fixed("open/maker-enc")),
    payout: [0u8; 32],
    watcher: [0u8; 32],
  };
  cases.push(open("open-hash-direction-a", &oa));
  // SPEC 11.6: the watcher the taker names at lock is part of the hash.
  let watched = OpenHashSolanaInput { watcher: ed25519_public(&fixed("open/watcher")), ..oa.clone() };
  assert_ne!(open_hash_solana(&watched), open_hash_solana(&oa));
  cases.push(open("open-hash-direction-a-watcher", &watched));
  // Direction B: the locker's view share is zeros at take time; the payout address is the
  // taker's own by default, and the maker's watcher (named at fund) is not part of the hash.
  let taker_wallet = ed25519_public(&fixed("open/taker-wallet"));
  let ob = OpenHashSolanaInput { direction: 1, asset: 0, locker_view: [0u8; 32], amount: 1_500_000_000, deposit: 15_000_000, payout: taker_wallet, ..oa.clone() };
  cases.push(open("open-hash-direction-b", &ob));
  // SPEC 11.2: another payout address, another hash: the maker funds knowing where a claim pays.
  let ob_payout = OpenHashSolanaInput { payout: ed25519_public(&fixed("open/payout")), ..ob.clone() };
  assert_ne!(open_hash_solana(&ob_payout), open_hash_solana(&ob));
  cases.push(open("open-hash-direction-b-payout", &ob_payout));
  // A re-lock at the same PDA with another size: another hash.
  let relock = OpenHashSolanaInput { t_lock: oa.t_lock + 30, xmr: oa.xmr * 2, amount: oa.amount * 2, deposit: oa.deposit * 2, ..oa.clone() };
  assert_ne!(open_hash_solana(&relock), open_hash_solana(&oa));
  cases.push(open("open-hash-relock-same-pda", &relock));

  suite(
    "sol_signed",
    cases,
    vec![
      ("operator_seed", json!(h(operator_seed))),
      ("operator_pub", json!(h(operator_pub))),
      ("message_len", json!(190)),
      ("any", json!(ANY)),
      (
        "offsets",
        json!({ "tag": 0, "cluster_tag": 24, "program_id": 56, "maker": 88, "taker": 120, "asset": 152, "direction": 153,
                "max_xmr": 154, "not_before": 162, "expires_at": 170, "epoch": 178, "approval_id": 182 }),
      ),
    ],
  )
}

fn quote_message(q: &EthQuote) -> Value {
  json!({
    "maker": h0x(q.maker), "taker": h0x(q.taker), "token": h0x(q.token),
    "direction": q.direction, "approvalMode": q.approval_mode,
    "minXmr": d(q.min_xmr), "maxXmr": d(q.max_xmr),
    "tierXmr": q.tier_xmr.map(d), "tierPrice": q.tier_price.map(d),
    "depthXmr": q.depth_xmr.map(d), "depth": q.depth,
    "depositBps": q.deposit_bps, "approvalWindow": q.approval_window, "noticeWindow": q.notice_window,
    "claimDelay": q.claim_delay, "claimWindow": q.claim_window, "finalWindow": q.final_window,
    "validUntil": d(q.valid_until), "epoch": q.epoch, "keyRoot": h0x(q.key_root), "quoteId": d(q.quote_id),
    "freezeWindow": q.freeze_window,
  })
}
fn approval_message(a: &EthApproval) -> Value {
  json!({
    "maker": h0x(a.maker), "taker": h0x(a.taker), "token": h0x(a.token), "direction": a.direction,
    "maxXmr": d(a.max_xmr), "notBefore": d(a.not_before), "validUntil": d(a.valid_until),
    "epoch": a.epoch, "approvalId": h0x(a.approval_id),
  })
}
fn type_fields(type_string: &str) -> Value {
  let inner = &type_string[type_string.find('(').unwrap() + 1..type_string.len() - 1];
  Value::Array(
    inner
      .split(',')
      .map(|f| {
        let (ty, name) = f.split_once(' ').unwrap();
        json!({ "name": name, "type": ty })
      })
      .collect(),
  )
}
/// The typed-data JSON that `cast wallet sign --data` and viem's `signTypedData` take.
fn typed_data(domain: &Eip712Domain, primary: &str, type_string: &str, message: Value) -> Value {
  json!({
    "types": { "EIP712Domain": type_fields(DOMAIN_TYPE), primary: type_fields(type_string) },
    "primaryType": primary,
    "domain": { "name": EIP712_NAME, "version": EIP712_VERSION, "chainId": domain.chain_id, "verifyingContract": h0x(domain.verifying_contract) },
    "message": message,
  })
}

pub fn eip712() -> VectorFile {
  // A fixed test key; it controls nothing.
  let operator_key = fixed("eip712/operator-key");
  let operator = eth_address_of_secret(&operator_key).unwrap();
  let domain = Eip712Domain { chain_id: 31_337, verifying_contract: fixed_n("eip712/contract") };
  let maker: [u8; 20] = fixed_n("eip712/maker");
  let taker: [u8; 20] = fixed_n("eip712/taker");
  let usdc: [u8; 20] = fixed_n("eip712/usdc");
  let mut cases = Vec::new();

  let base = EthQuote {
    maker,
    taker: [0; 20],
    token: [0; 20],
    direction: 0,
    approval_mode: 0,
    min_xmr: 100_000_000_000,
    max_xmr: 100_000_000_000_000,
    tier_xmr: [0, 1_000_000_000_000, 50_000_000_000_000],
    tier_price: [61_000_000_000_000_000, 60_500_000_000_000_000, 60_000_000_000_000_000],
    depth_xmr: [0, 1_000_000_000_000, 50_000_000_000_000],
    depth: [2, 10, 25],
    deposit_bps: 100,
    approval_window: 120,
    notice_window: 1_800,
    claim_delay: 10_800,
    claim_window: 5_400,
    final_window: 604_800,
    valid_until: 1_800_000_150,
    epoch: 3,
    key_root: fixed("eip712/key-root"),
    quote_id: 42,
    freeze_window: 0,
  };
  let quotes: Vec<(&str, EthQuote)> = vec![
    ("quote-public-eth-a", base.clone()),
    // Taker-bound (single use), USDC, one price tier, window mode.
    (
      "quote-bound-usdc-a",
      EthQuote {
        taker,
        token: usdc,
        approval_mode: 1,
        tier_xmr: [0, 0, 0],
        tier_price: [165_250_000, 0, 0],
        depth_xmr: [0, 0, 0],
        depth: [25, 0, 0],
        quote_id: 43,
        ..base.clone()
      },
    ),
    // Direction B: no key pool, so keyRoot is zero.
    ("quote-public-eth-b", EthQuote { direction: 1, key_root: [0; 32], approval_mode: 2, quote_id: 44, ..base.clone() }),
    // SPEC 11.6: quotes that accept a watcher, at the floor and the cap of the freeze window.
    ("quote-freeze-window-one-hour", EthQuote { freeze_window: 3_600, quote_id: 45, ..base.clone() }),
    ("quote-freeze-window-three-days-b", EthQuote { direction: 1, key_root: [0; 32], freeze_window: 259_200, quote_id: 46, ..base.clone() }),
    // Field extremes: every integer at its maximum (prices at the u128 the compact form holds).
    (
      "quote-extremes",
      EthQuote {
        maker: [0xff; 20],
        taker: [0xff; 20],
        token: [0xff; 20],
        direction: 1,
        approval_mode: 2,
        min_xmr: u64::MAX,
        max_xmr: u64::MAX,
        tier_xmr: [0, u64::MAX - 1, u64::MAX],
        tier_price: [u128::MAX, u128::MAX - 1, 1],
        depth_xmr: [0, u64::MAX - 1, u64::MAX],
        depth: [255, 254, 1],
        deposit_bps: u16::MAX,
        approval_window: u32::MAX,
        notice_window: u32::MAX,
        claim_delay: u32::MAX,
        claim_window: u32::MAX,
        final_window: u32::MAX,
        valid_until: u64::MAX,
        epoch: u32::MAX,
        key_root: [0xff; 32],
        quote_id: u64::MAX,
        freeze_window: u32::MAX,
      },
    ),
  ];
  for (name, q) in &quotes {
    let digest = quote_digest(&domain, q);
    let sig = ecdsa_sign_digest(&operator_key, &digest).unwrap();
    assert_eq!(ecdsa_recover_address(&digest, &sig).unwrap(), operator);
    cases.push(ok_case(
      name,
      json!({ "typed_data": typed_data(&domain, "Quote", QUOTE_TYPE, quote_message(q)) }),
      json!({
        "struct_hash": h0x(quote_struct_hash(q)),
        "digest": h0x(digest),
        "signature": h0x(sig),
        "signer": h0x(operator),
        "compact": h(encode_eth_quote_compact(q)),
        "compact_signed": h(encode_eth_quote_compact_signed(q, &sig)),
      }),
    ));
  }
  // Validity is inclusive: live at validUntil, dead one second later.
  let digest = quote_digest(&domain, &base);
  let sig = ecdsa_sign_digest(&operator_key, &digest).unwrap();
  for (name, now) in [("quote-at-valid-until", base.valid_until), ("quote-at-valid-until-plus-1", base.valid_until + 1)] {
    let input = json!({ "typed_data": typed_data(&domain, "Quote", QUOTE_TYPE, quote_message(&base)), "signature": h0x(sig), "now": d(now) });
    if quote_live(&base, now) {
      cases.push(ok_case(name, input, json!({ "digest": h0x(digest), "signer": h0x(operator) })));
    } else {
      cases.push(err_case(name, input, "Expired"));
    }
  }
  // Replay across domains and tampering: the signature recovers another signer, so `BadSigner`.
  let other_chain = Eip712Domain { chain_id: 1, ..domain.clone() };
  let other_contract = Eip712Domain { verifying_contract: fixed_n("eip712/other-contract"), ..domain.clone() };
  let tampered = EthQuote { tier_price: [base.tier_price[0] - 1, base.tier_price[1], base.tier_price[2]], ..base.clone() };
  for (name, dom, q) in [
    ("quote-replayed-on-another-chain", &other_chain, &base),
    ("quote-replayed-on-another-contract", &other_contract, &base),
    ("quote-tampered-price", &domain, &tampered),
  ] {
    let dg = quote_digest(dom, q);
    assert_ne!(ecdsa_recover_address(&dg, &sig).ok(), Some(operator));
    cases.push(err_case(
      name,
      json!({ "typed_data": typed_data(dom, "Quote", QUOTE_TYPE, quote_message(q)), "signature": h0x(sig), "expected_signer": h0x(operator), "digest": h0x(dg) }),
      "BadSigner",
    ));
  }
  // A high-s signature for the right digest: OpenZeppelin's ECDSA refuses it.
  let mut high = sig;
  {
    use sigma_fun::secp256k1::fun::{marker::*, Scalar};
    let s_low = Scalar::<Public, NonZero>::from_bytes(sig[32..64].try_into().unwrap()).unwrap();
    high[32..64].copy_from_slice(&(-s_low).to_bytes());
    high[64] = if sig[64] == 27 { 28 } else { 27 };
  }
  assert!(ecdsa_recover_address(&digest, &high).is_err());
  cases.push(err_case(
    "quote-high-s-signature",
    json!({ "typed_data": typed_data(&domain, "Quote", QUOTE_TYPE, quote_message(&base)), "signature": h0x(high), "expected_signer": h0x(operator), "digest": h0x(digest) }),
    "BadSigner",
  ));

  // Approvals.
  let approval = EthApproval {
    maker,
    taker,
    token: ANY_TOKEN,
    direction: ANY_DIRECTION,
    max_xmr: 5_000_000_000_000,
    not_before: 1_800_000_000,
    valid_until: 1_800_086_400,
    epoch: 2,
    approval_id: fixed("eip712/approval-id"),
  };
  let narrow = EthApproval { token: usdc, direction: 0, approval_id: fixed("eip712/approval-id-2"), ..approval.clone() };
  for (name, a) in [("approval-any", &approval), ("approval-usdc-a", &narrow)] {
    let dg = approval_digest(&domain, a);
    let s = ecdsa_sign_digest(&operator_key, &dg).unwrap();
    assert_eq!(ecdsa_recover_address(&dg, &s).unwrap(), operator);
    cases.push(ok_case(
      name,
      json!({ "typed_data": typed_data(&domain, "Approval", APPROVAL_TYPE, approval_message(a)) }),
      json!({ "struct_hash": h0x(approval_struct_hash(a)), "digest": h0x(dg), "signature": h0x(s), "signer": h0x(operator) }),
    ));
  }
  let adg = approval_digest(&domain, &approval);
  let asig = ecdsa_sign_digest(&operator_key, &adg).unwrap();
  // (now, msg.sender, token, direction, xmr, approvalEpoch) at the lock.
  let uses: [(&str, u64, [u8; 20], [u8; 20], u8, u64, u32); 9] = [
    ("approval-at-not-before-minus-1", approval.not_before - 1, taker, usdc, 0, 1, 2),
    ("approval-at-not-before", approval.not_before, taker, usdc, 0, 1, 2),
    ("approval-at-valid-until", approval.valid_until, taker, [0; 20], 1, 1, 2),
    ("approval-at-valid-until-plus-1", approval.valid_until + 1, taker, usdc, 0, 1, 2),
    ("approval-at-max-xmr", approval.not_before + 5, taker, usdc, 0, approval.max_xmr, 2),
    ("approval-over-max-xmr", approval.not_before + 5, taker, usdc, 0, approval.max_xmr + 1, 2),
    ("approval-wrong-taker", approval.not_before + 5, fixed_n("eip712/other-taker"), usdc, 0, 1, 2),
    ("approval-stale-epoch", approval.not_before + 5, taker, usdc, 0, 1, 3),
    ("approval-wildcards-eth-b", approval.not_before + 5, taker, [0; 20], 1, 1, 2),
  ];
  for (name, now, sender, token, direction, xmr, epoch) in uses {
    let input = json!({
      "typed_data": typed_data(&domain, "Approval", APPROVAL_TYPE, approval_message(&approval)),
      "signature": h0x(asig),
      "lock": { "now": d(now), "sender": h0x(sender), "token": h0x(token), "direction": direction, "xmr": d(xmr), "approval_epoch": epoch },
    });
    if eth_approval_admits(&approval, now, &sender, &token, direction, xmr, epoch) {
      cases.push(ok_case(name, input, json!({ "digest": h0x(adg), "signer": h0x(operator) })));
    } else {
      let error = if now > approval.valid_until || now < approval.not_before {
        "Expired"
      } else if sender != approval.taker {
        "WrongParty"
      } else if epoch != approval.epoch {
        "StaleEpoch"
      } else {
        "AmountOutOfRange"
      };
      cases.push(err_case(name, input, error));
    }
  }
  // A narrow approval used for another token or direction.
  let ndg = approval_digest(&domain, &narrow);
  let nsig = ecdsa_sign_digest(&operator_key, &ndg).unwrap();
  for (name, token, direction, error) in [("approval-narrow-wrong-token", [0u8; 20], 0u8, "TokenNotAllowed"), ("approval-narrow-wrong-direction", usdc, 1u8, "WrongDirection")] {
    assert!(!eth_approval_admits(&narrow, narrow.not_before + 5, &taker, &token, direction, 1, 2));
    cases.push(err_case(
      name,
      json!({
        "typed_data": typed_data(&domain, "Approval", APPROVAL_TYPE, approval_message(&narrow)),
        "signature": h0x(nsig),
        "lock": { "now": d(narrow.not_before + 5), "sender": h0x(taker), "token": h0x(token), "direction": direction, "xmr": "1", "approval_epoch": 2 },
      }),
      error,
    ));
  }
  // A Quote signature is not an Approval signature (type hashes differ).
  assert_ne!(ecdsa_recover_address(&adg, &sig).ok(), Some(operator));

  // swapId and the open hash of SPEC 3.12 (Ethereum).
  let nonce: [u8; 16] = fixed_n("eip712/swap-nonce");
  let id = swap_id(&taker, &nonce);
  cases.push(ok_case("swap-id", json!({ "taker": h0x(taker), "swap_nonce": h0x(nonce) }), json!({ "swap_id": h0x(id) })));
  let ts = share("eip712/taker-share");
  let tw = twin_commitments(&ts).unwrap();
  let open_a = OpenHashEthereumInput {
    swap_id: id,
    t_lock: 1_800_000_000,
    direction: 0,
    token: [0; 20],
    xmr: 2_000_000_000_000,
    amount: 122_000_000_000_000_000,
    deposit: 1_220_000_000_000_000,
    taker_spend_pub: ed_base_mul(&curve25519_dalek::scalar::Scalar::from_bytes_mod_order(ts)),
    taker_key: tw.key_addr,
    taker_key2: tw.key_addr2,
    taker_view: scalar("eip712/taker-view"),
    taker_enc_key: x25519_public(&fixed("eip712/taker-enc")),
    maker_enc_key: x25519_public(&fixed("eip712/maker-enc")),
    key_leaf: fixed("eip712/key-leaf"),
    payout: [0; 20],
    watcher: [0; 20],
  };
  let open_case = |name: &str, o: &OpenHashEthereumInput| {
    ok_case(
      name,
      json!({
        "swap_id": h0x(o.swap_id), "t_lock": d(o.t_lock), "direction": o.direction, "token": h0x(o.token), "xmr": d(o.xmr),
        "amount": d(o.amount), "deposit": d(o.deposit), "taker_spend_pub": h0x(o.taker_spend_pub), "taker_key": h0x(o.taker_key),
        "taker_key2": h0x(o.taker_key2), "taker_view": h0x(o.taker_view), "taker_enc_key": h0x(o.taker_enc_key),
        "maker_enc_key": h0x(o.maker_enc_key), "key_leaf": h0x(o.key_leaf),
        "payout": h0x(o.payout), "watcher": h0x(o.watcher),
      }),
      json!({ "open_hash": h0x(open_hash_ethereum(o)) }),
    )
  };
  cases.push(open_case("open-hash-direction-a", &open_a));
  // SPEC 11.6: the watcher named at lock.
  let open_watched = OpenHashEthereumInput { watcher: fixed_n("eip712/watcher"), ..open_a.clone() };
  assert_ne!(open_hash_ethereum(&open_watched), open_hash_ethereum(&open_a));
  cases.push(open_case("open-hash-direction-a-watcher", &open_watched));
  // Direction B: the payout argument of take (the taker's own address by default).
  let open_b = OpenHashEthereumInput { direction: 1, token: usdc, amount: 330_500_000, deposit: 3_305_000, taker_view: [0; 32], key_leaf: [0; 32], payout: taker, ..open_a.clone() };
  cases.push(open_case("open-hash-direction-b", &open_b));
  let open_b_payout = OpenHashEthereumInput { payout: fixed_n("eip712/payout"), ..open_b.clone() };
  assert_ne!(open_hash_ethereum(&open_b_payout), open_hash_ethereum(&open_b));
  cases.push(open_case("open-hash-direction-b-payout", &open_b_payout));
  // A reorg replaces the lock with another at the same id: other commitments, another hash.
  let ts2 = share("eip712/taker-share-2");
  let tw2 = twin_commitments(&ts2).unwrap();
  let replaced = OpenHashEthereumInput {
    taker_spend_pub: ed_base_mul(&curve25519_dalek::scalar::Scalar::from_bytes_mod_order(ts2)),
    taker_key: tw2.key_addr,
    taker_key2: tw2.key_addr2,
    ..open_a.clone()
  };
  assert_ne!(open_hash_ethereum(&replaced), open_hash_ethereum(&open_a));
  cases.push(open_case("open-hash-replaced-lock-same-id", &replaced));

  suite(
    "eip712",
    cases,
    vec![
      ("operator_private_key", json!(h0x(operator_key))),
      ("operator", json!(h0x(operator))),
      ("domain", json!({ "name": EIP712_NAME, "version": EIP712_VERSION, "chainId": domain.chain_id, "verifyingContract": h0x(domain.verifying_contract) })),
      ("domain_separator", json!(h0x(domain_separator(&domain)))),
      ("quote_type", json!(QUOTE_TYPE)),
      ("quote_type_hash", json!(h0x(quote_type_hash()))),
      ("approval_type", json!(APPROVAL_TYPE)),
      ("approval_type_hash", json!(h0x(approval_type_hash()))),
      ("any_token", json!(h0x(ANY_TOKEN))),
      ("any_direction", json!(ANY_DIRECTION)),
      ("compact_len", json!(255)),
      ("signature_format", json!("r || s || v, 65 bytes, low-s, v in {27, 28}; RFC 6979 nonce")),
    ],
  )
}

/// SPEC 11.3: `wallet_seed.json`. Real signatures from fixed test keys over the two fixed
/// messages, and the seed each gives.
pub fn wallet_seed() -> VectorFile {
  use crate::{
    keys::derive_keys,
    primitives::ChainTag,
    wallet_key::{
      base58, normalize_eth_signature, wallet_key_digest, wallet_key_message_solana, wallet_key_struct_hash,
      wallet_key_type_hash, wallet_seed as seed_of, WALLET_KEY_NOTICE, WALLET_KEY_TYPE, WALLET_KEY_VERSION,
    },
  };
  // A stand-in for `WALLET_KEY_SITE`: the vectors must not depend on the name the owner picks.
  let site = "swap.example";
  let nonce: [u8; 16] = fixed_n("wallet-seed/swap-nonce");
  let mut cases = Vec::new();

  // Solana.
  let sol_key = fixed("wallet-seed/solana-wallet");
  let sol_wallet = ed25519_public(&sol_key);
  let genesis = fixed("wallet-seed/genesis-hash");
  let program = fixed("wallet-seed/program-id");
  let msg = wallet_key_message_solana(site, &genesis, &program, &sol_wallet);
  let sig = ed25519_sign(&sol_key, &msg);
  assert!(ed25519_verify(&sol_wallet, &msg, &sig));
  let sol_seed = seed_of(ChainTag::Solana, &sol_wallet, &sig).unwrap();
  let sol_input = |wallet: &[u8], sig: &[u8]| json!({ "chain_tag": 1, "wallet": h(wallet), "signature": h(sig) });
  let derived = |chain: ChainTag, seed: &[u8; 32]| {
    let k = derive_keys(seed, chain, &nonce).unwrap();
    json!({ "seed": h(seed), "swap_nonce": h(nonce), "spend_pub": h(k.spend_pub) })
  };
  let mut c = ok_case("solana", sol_input(&sol_wallet, &sig), derived(ChainTag::Solana, &sol_seed));
  c.as_object_mut().unwrap().insert(
    "message".into(),
    json!({
      "site": site, "genesis_hash": h(genesis), "genesis_hash_base58": base58(&genesis), "program_id": h(program),
      "program_id_base58": base58(&program), "wallet_base58": base58(&sol_wallet), "wallet_private_seed": h(sol_key),
      "text": String::from_utf8(msg.clone()).unwrap(), "bytes": h(&msg),
    }),
  );
  cases.push(c);
  // The seed is per wallet: the same signature bytes under another address give another seed.
  let other_wallet = ed25519_public(&fixed("wallet-seed/solana-wallet-2"));
  let other = seed_of(ChainTag::Solana, &other_wallet, &sig).unwrap();
  assert_ne!(other, sol_seed);
  cases.push(ok_case("solana-another-wallet-address", sol_input(&other_wallet, &sig), derived(ChainTag::Solana, &other)));
  cases.push(err_case("solana-signature-63-bytes", sol_input(&sol_wallet, &sig[..63]), "BadLength"));
  cases.push(err_case("solana-signature-65-bytes", sol_input(&sol_wallet, &[&sig[..], &[0u8][..]].concat()), "BadLength"));
  cases.push(err_case("solana-wallet-20-bytes", sol_input(&sol_wallet[..20], &sig), "BadLength"));

  // Ethereum.
  let eth_key = fixed("wallet-seed/ethereum-wallet");
  let eth_wallet = eth_address_of_secret(&eth_key).unwrap();
  let domain = Eip712Domain { chain_id: 31_337, verifying_contract: fixed_n("eip712/contract") };
  let digest = wallet_key_digest(&domain, site, &eth_wallet);
  let sig = ecdsa_sign_digest(&eth_key, &digest).unwrap();
  assert_eq!(ecdsa_recover_address(&digest, &sig).unwrap(), eth_wallet);
  let eth_seed = seed_of(ChainTag::Ethereum, &eth_wallet, &sig).unwrap();
  let eth_input = |wallet: &[u8], sig: &[u8]| json!({ "chain_tag": 2, "wallet": h0x(wallet), "signature": h0x(sig) });
  let eth_out = |seed: &[u8; 32], normalised: &[u8; 65]| {
    let mut v = derived(ChainTag::Ethereum, seed);
    v.as_object_mut().unwrap().insert("normalised_signature".into(), json!(h0x(normalised)));
    v
  };
  let message = json!({ "notice": WALLET_KEY_NOTICE, "site": site, "keyVersion": WALLET_KEY_VERSION, "wallet": h0x(eth_wallet) });
  let mut c = ok_case("ethereum", eth_input(&eth_wallet, &sig), eth_out(&eth_seed, &sig));
  c.as_object_mut().unwrap().insert(
    "message".into(),
    json!({
      "typed_data": typed_data(&domain, "WalletKey", WALLET_KEY_TYPE, message),
      "struct_hash": h0x(wallet_key_struct_hash(site, &eth_wallet)), "digest": h0x(digest), "wallet_private_key": h0x(eth_key),
    }),
  );
  cases.push(c);
  // The same signature spelled with a high s (and the other v): normalised, the same seed.
  let mut high = sig;
  {
    use sigma_fun::secp256k1::fun::{marker::*, Scalar};
    let s_low = Scalar::<Public, NonZero>::from_bytes(sig[32..64].try_into().unwrap()).unwrap();
    high[32..64].copy_from_slice(&(-s_low).to_bytes());
    high[64] = if sig[64] == 27 { 28 } else { 27 };
  }
  assert_eq!(normalize_eth_signature(&high).unwrap(), sig);
  assert_eq!(seed_of(ChainTag::Ethereum, &eth_wallet, &high).unwrap(), eth_seed);
  cases.push(ok_case("ethereum-high-s-normalised", eth_input(&eth_wallet, &high), eth_out(&eth_seed, &sig)));
  // v as 0/1 instead of 27/28.
  let mut v01 = sig;
  v01[64] -= 27;
  assert_eq!(seed_of(ChainTag::Ethereum, &eth_wallet, &v01).unwrap(), eth_seed);
  cases.push(ok_case("ethereum-v-zero-or-one", eth_input(&eth_wallet, &v01), eth_out(&eth_seed, &sig)));
  let mut high01 = high;
  high01[64] -= 27;
  cases.push(ok_case("ethereum-high-s-and-v-zero-or-one", eth_input(&eth_wallet, &high01), eth_out(&eth_seed, &sig)));
  let mut bad_v = sig;
  bad_v[64] = 29;
  cases.push(err_case("ethereum-v-29", eth_input(&eth_wallet, &bad_v), "SignatureInvalid"));
  let mut zero_s = sig;
  zero_s[32..64].fill(0);
  cases.push(err_case("ethereum-s-zero", eth_input(&eth_wallet, &zero_s), "SignatureInvalid"));
  let mut big_s = sig;
  big_s[32..64].fill(0xff);
  cases.push(err_case("ethereum-s-above-the-group-order", eth_input(&eth_wallet, &big_s), "SignatureInvalid"));
  let mut zero_r = sig;
  zero_r[..32].fill(0);
  cases.push(err_case("ethereum-r-zero", eth_input(&eth_wallet, &zero_r), "SignatureInvalid"));
  cases.push(err_case("ethereum-signature-64-bytes", eth_input(&eth_wallet, &sig[..64]), "BadLength"));
  cases.push(err_case("ethereum-wallet-32-bytes", eth_input(&[0x11; 32], &sig), "BadLength"));
  cases.push(err_case("unknown-chain-tag", json!({ "chain_tag": 3, "wallet": h0x(eth_wallet), "signature": h0x(sig) }), "UnknownChainTag"));
  // The two chains never share a seed, even for equal bytes.
  assert_ne!(sol_seed, eth_seed);

  suite(
    "wallet_seed",
    cases,
    vec![
      ("derivation", json!("seed = HKDF-SHA256(ikm = sig, salt = \"xmrswap/v1/wallet-seed\" || 0x00, info = chain_tag (1 byte) || wallet address bytes, L = 32). sig: Solana, the 64 signature bytes; Ethereum, r || s || v (65 bytes) with s in the low half and v in {27, 28}")),
      ("site", json!(site)),
      ("site_note", json!("a stand-in for WALLET_KEY_SITE of @xmrswap/protocol; only the `message` objects depend on it")),
      ("key_version", json!(WALLET_KEY_VERSION)),
      ("wallet_key_type", json!(WALLET_KEY_TYPE)),
      ("wallet_key_type_hash", json!(h0x(wallet_key_type_hash()))),
      ("wallet_key_notice", json!(WALLET_KEY_NOTICE)),
      ("domain", json!({ "name": EIP712_NAME, "version": EIP712_VERSION, "chainId": domain.chain_id, "verifyingContract": h0x(domain.verifying_contract) })),
      ("spend_pub", json!("derive_keys(seed, chain_tag, share_id = swap_nonce).spend_pub: what a returning user compares with the commitment stored in its swap")),
    ],
  )
}

/// SPEC 11.6: `watch_request.json`. The notice key a locker hands to a watcher, the keyed open
/// of a notice (on the notices of `notice.json`: same parties, same bytes), and the
/// authenticated seal of a watch request in wire format 2, with the requests a watcher must
/// refuse.
pub fn watch_request() -> VectorFile {
  use crate::{
    envelope::{notice_key, notice_open_with_key},
    primitives::{ds, ChainTag},
    wallet_key::base58,
    Error,
    watch::{ed25519_public_to_x25519, ed25519_seed_to_x25519, watch_request_aad, watch_request_open, watch_request_seal, WatchBinding, SEALED_NOTICE_KEY_LEN, WATCH_FORMAT},
  };
  let p = parties();
  let mut cases = Vec::new();

  // The notice key: both sides derive the same 32 bytes.
  let key = notice_key(&p.taker_secret, &p.maker_pub, Side::Taker).unwrap();
  assert_eq!(notice_key(&p.maker_secret, &p.taker_pub, Side::Maker).unwrap(), key);
  cases.push(ok_case("notice-key-taker", json!({ "op": "notice_key", "own_secret": h(p.taker_secret), "peer_pub": h(p.maker_pub), "side": "taker" }), json!({ "notice_key": h(key) })));
  cases.push(ok_case("notice-key-maker", json!({ "op": "notice_key", "own_secret": h(p.maker_secret), "peer_pub": h(p.taker_pub), "side": "maker" }), json!({ "notice_key": h(key) })));
  let swapped = notice_key(&p.taker_secret, &p.maker_pub, Side::Maker).unwrap();
  assert_ne!(swapped, key);
  cases.push(ok_case("notice-key-sides-swapped-is-another-key", json!({ "op": "notice_key", "own_secret": h(p.taker_secret), "peer_pub": h(p.maker_pub), "side": "maker" }), json!({ "notice_key": h(swapped) })));
  cases.push(err_case("notice-key-low-order-peer", json!({ "op": "notice_key", "own_secret": h(p.taker_secret), "peer_pub": h(crate::envelope::LOW_ORDER_X25519[2]), "side": "taker" }), "LowOrderEncryptionKey"));

  // The keyed open, on the first notice of notice.json.
  let swap_ref = fixed("notice/swap-ref");
  let txid = fixed("notice/txid");
  let view = scalar("notice/view");
  let nonce: [u8; 24] = fixed_n("notice/nonce");
  let commitment = notice_commitment(&swap_ref, &txid, &view);
  let ct = notice_seal(&NoticeKeys { own_secret: &p.maker_secret, peer_pub: &p.taker_pub, side: Side::Maker, swap_ref: &swap_ref }, &txid, &view, nonce).unwrap();
  let open_in = |key: &[u8; 32], swap_ref: &[u8; 32], ct: &[u8], commitment: &[u8; 32]| json!({ "op": "notice_open_with_key", "notice_key": h(key), "swap_ref": h(swap_ref), "ciphertext": h(ct), "commitment": h(commitment) });
  assert_eq!(notice_open_with_key(&key, &swap_ref, &ct, &commitment).unwrap(), (txid, view));
  cases.push(ok_case("open-with-key", open_in(&key, &swap_ref, &ct, &commitment), json!({ "txid": h(txid), "view": h(view) })));
  cases.push(err_case("open-with-another-key", open_in(&swapped, &swap_ref, &ct, &commitment), "NoticeDecrypt"));
  cases.push(err_case("open-for-another-swap", open_in(&key, &fixed("notice/swap-ref-2"), &ct, &commitment), "NoticeDecrypt"));
  cases.push(err_case("open-against-another-commitment", open_in(&key, &swap_ref, &ct, &fixed("watch/other-commitment")), "NoticeCommitmentMismatch"));
  let mut flipped = ct;
  flipped[60] ^= 1;
  cases.push(err_case("open-altered-ciphertext", open_in(&key, &swap_ref, &flipped, &commitment), "NoticeDecrypt"));
  cases.push(err_case("open-103-bytes", open_in(&key, &swap_ref, &ct[..103], &commitment), "BadLength"));

  // Watch requests. The watcher's key is its Solana key; the locker is the taker in direction A
  // (its one-time encryption key) and the maker in direction B.
  let watcher_seed = fixed("watch/watcher");
  let watcher = ed25519_public(&watcher_seed);
  let watcher_x = ed25519_public_to_x25519(&watcher).unwrap();
  assert_eq!(watcher_x, x25519_public(&ed25519_seed_to_x25519(&watcher_seed)));
  let program = base58(&fixed("watch/program-id"));
  let contract: [u8; 20] = fixed_n("eip712/contract");
  let eth_deployment = format!("31337:{}", h0x(contract));
  let eph = fixed("watch/ephemeral");
  let seal_nonce: [u8; 24] = fixed_n("watch/nonce");
  let issued_at = 1_800_000_500u64;
  let chain_name = |c: ChainTag| if c == ChainTag::Solana { "solana" } else { "ethereum" };
  // The wire body of `POST /watch/v1/swaps`.
  let body = |b: &WatchBinding, sealed: &[u8]| json!({ "v": b.format, "chain": chain_name(b.chain), "swap_ref": h(b.swap_ref), "deployment": b.deployment, "issued_at": b.issued_at, "notice_key": base64(sealed) });
  let open_input = |b: &WatchBinding, sealed: &[u8], locker_pub: &[u8; 32], seed: &[u8; 32]| {
    json!({
      "op": "open", "watcher_seed": h(seed), "locker_enc_pub": h(locker_pub), "format": b.format, "chain_tag": b.chain as u8,
      "deployment": b.deployment, "swap_ref": h(b.swap_ref), "issued_at": d(b.issued_at), "sealed": h(sealed), "body": body(b, sealed),
    })
  };
  let sol = WatchBinding { format: WATCH_FORMAT, chain: ChainTag::Solana, deployment: &program, swap_ref: &swap_ref, watcher: &watcher, issued_at };
  let swap_ref_eth = fixed("watch/swap-id");
  let eth = WatchBinding { format: WATCH_FORMAT, chain: ChainTag::Ethereum, deployment: &eth_deployment, swap_ref: &swap_ref_eth, watcher: &watcher, issued_at: issued_at + 77 };
  let mut sealed_sol = [0u8; SEALED_NOTICE_KEY_LEN];
  for (name, b, locker_secret, locker_pub, direction) in [("seal-solana-direction-a", &sol, &p.taker_secret, &p.taker_pub, "A"), ("seal-ethereum-direction-b", &eth, &p.maker_secret, &p.maker_pub, "B")] {
    let sealed = watch_request_seal(&key, locker_secret, b, &eph, seal_nonce).unwrap();
    assert_eq!(watch_request_open(&sealed, &watcher_seed, locker_pub, b).unwrap(), key);
    cases.push(ok_case(
      name,
      json!({
        "op": "seal", "direction": direction, "notice_key": h(key), "locker_enc_secret": h(locker_secret), "locker_enc_pub": h(locker_pub),
        "watcher": h(watcher), "format": b.format, "chain_tag": b.chain as u8, "deployment": b.deployment, "swap_ref": h(b.swap_ref),
        "issued_at": d(b.issued_at), "ephemeral_secret": h(eph), "nonce": h(seal_nonce),
      }),
      json!({ "aad": h(watch_request_aad(b).unwrap()), "sealed": h(sealed), "body": body(b, &sealed) }),
    ));
    cases.push(ok_case(&name.replace("seal-", "open-"), open_input(b, &sealed, locker_pub, &watcher_seed), json!({ "notice_key": h(key) })));
    if b.chain == ChainTag::Solana {
      sealed_sol = sealed;
    }
  }
  let reject = |name: &str, b: &WatchBinding, sealed: &[u8], locker_pub: &[u8; 32], seed: &[u8; 32], error: Error| -> Value {
    assert_eq!(watch_request_open(sealed, seed, locker_pub, b), Err(error), "{name}");
    err_case(name, open_input(b, sealed, locker_pub, seed), &error.to_string())
  };
  // Sealed by someone who does not hold the locker's encryption secret: a stranger, and the
  // counterparty (who knows the notice key too).
  let stranger = fixed("watch/stranger-enc");
  let by_stranger = watch_request_seal(&key, &stranger, &sol, &eph, seal_nonce).unwrap();
  cases.push(reject("reject-wrong-locker-key-stranger", &sol, &by_stranger, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  let by_counterparty = watch_request_seal(&key, &p.maker_secret, &sol, &eph, seal_nonce).unwrap();
  cases.push(reject("reject-wrong-locker-key-counterparty", &sol, &by_counterparty, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  // Sealed to another watcher.
  let other_seed = fixed("watch/watcher-2");
  let other_watcher = ed25519_public(&other_seed);
  let to_other = watch_request_seal(&key, &p.taker_secret, &WatchBinding { watcher: &other_watcher, ..sol.clone() }, &eph, seal_nonce).unwrap();
  assert_eq!(watch_request_open(&to_other, &other_seed, &p.taker_pub, &sol).unwrap(), key);
  cases.push(reject("reject-wrong-watcher", &sol, &to_other, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  // The locker's genuine request, replayed onto another swap, chain, deployment or time.
  let swap_ref2 = fixed("notice/swap-ref-2");
  cases.push(reject("reject-replay-onto-another-swap", &WatchBinding { swap_ref: &swap_ref2, ..sol.clone() }, &sealed_sol, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  cases.push(reject("reject-replay-onto-another-chain", &WatchBinding { chain: ChainTag::Ethereum, ..sol.clone() }, &sealed_sol, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  let program2 = base58(&fixed("watch/program-id-2"));
  cases.push(reject("reject-replay-onto-another-deployment", &WatchBinding { deployment: &program2, ..sol.clone() }, &sealed_sol, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  cases.push(reject("reject-issued-at-altered", &WatchBinding { issued_at: issued_at + 1, ..sol.clone() }, &sealed_sol, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  let mut altered = sealed_sol;
  altered[SEALED_NOTICE_KEY_LEN - 1] ^= 1;
  cases.push(reject("reject-altered-seal", &sol, &altered, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  let mut low = sealed_sol;
  low[..32].copy_from_slice(&crate::envelope::LOW_ORDER_X25519[2]);
  cases.push(reject("reject-low-order-ephemeral-key", &sol, &low, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  cases.push(reject("reject-103-bytes", &sol, &sealed_sol[..103], &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  // Format 1: the unauthenticated seal that preceded this format
  // (k = HKDF(X25519(eph, W), DS("watch"), eph_pub ‖ W), aad = chain_tag ‖ swap_ref). Its body
  // carried no `v`; it is refused as such, and its bytes do not open as format 2 either.
  let format_1 = {
    use chacha20poly1305::{aead::{Aead, KeyInit, Payload}, XChaCha20Poly1305, XNonce};
    let eph_pub = x25519_public(&eph);
    let dh = crate::envelope::x25519_shared(&eph, &watcher_x).unwrap();
    let mut k = [0u8; 32];
    hkdf::Hkdf::<sha2::Sha256>::new(Some(&ds("watch")), &dh).expand(&[&eph_pub[..], &watcher_x[..]].concat(), &mut k).unwrap();
    let aad = [&[1u8][..], &swap_ref[..]].concat();
    let ct = XChaCha20Poly1305::new((&k).into()).encrypt(XNonce::from_slice(&seal_nonce), Payload { msg: &key, aad: &aad }).unwrap();
    [&eph_pub[..], &seal_nonce[..], &ct[..]].concat()
  };
  assert_eq!(format_1.len(), SEALED_NOTICE_KEY_LEN);
  let v1 = WatchBinding { format: 1, ..sol.clone() };
  assert_eq!(watch_request_open(&format_1, &watcher_seed, &p.taker_pub, &v1), Err(Error::WatchFormatUnsupported));
  let mut input = open_input(&v1, &format_1, &p.taker_pub, &watcher_seed);
  // As it was sent: no version, no deployment, no time.
  input["body"] = json!({ "chain": "solana", "swap_ref": h(swap_ref), "notice_key": base64(&format_1) });
  cases.push(err_case("reject-format-1", input, "WatchFormatUnsupported"));
  cases.push(reject("reject-format-1-bytes-presented-as-format-2", &sol, &format_1, &p.taker_pub, &watcher_seed, Error::WatchKeyInvalid));
  cases.push(reject("reject-format-3", &WatchBinding { format: 3, ..sol.clone() }, &sealed_sol, &p.taker_pub, &watcher_seed, Error::WatchFormatUnsupported));

  suite(
    "watch_request",
    cases,
    vec![
      ("wire_format", json!(WATCH_FORMAT)),
      ("sealed_len", json!(SEALED_NOTICE_KEY_LEN)),
      ("keys", keys_json(&p)),
      ("watcher", json!({ "seed": h(watcher_seed), "ed25519": h(watcher), "ed25519_base58": base58(&watcher), "x25519": h(watcher_x) })),
      (
        "layout",
        json!({
          "notice_key": "HKDF-SHA256(ikm = X25519(own, peer), salt = DS(\"ecdh\"), info = \"notice\" || 0x00 || taker_pub || maker_pub, L = 32)",
          "watcher_x25519": "the X25519 form of the watcher's Ed25519 key: public u = (1 + y) / (1 - y); secret = clamp(SHA-512(seed)[0..32])",
          "seal_key": "HKDF-SHA256(ikm = X25519(eph, W) || X25519(locker_enc, W), salt = DS(\"watch/2\"), info = eph_pub || W || locker_enc_pub, L = 32)",
          "aad": "DS(\"watch-req\") || 0x02 || chain_tag || len(deployment) u8 || deployment (UTF-8) || swap_ref || watcher Ed25519 key || issued_at u64 LE",
          "sealed": "eph_pub[32] || nonce[24] || XChaCha20-Poly1305(seal_key, nonce, aad, notice_key)[48]",
          "deployment": "Solana: the program id, base58. Ethereum: \"<chain id>:<contract, lowercase 0x hex>\"",
          "locker_enc_pub": "read by the watcher from the swap on chain: taker_enc_key in direction A, maker_enc_key in direction B",
          "body": "the JSON of POST /watch/v1/swaps: notice_key is `sealed` in base64. Freshness of issued_at against the swap's lock time and the watcher's clock is the service's check and is not part of these vectors",
        }),
      ),
    ],
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn base64_known_answers() {
    // RFC 4648 section 10.
    for (input, expected) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
      assert_eq!(base64(input.as_bytes()), expected);
    }
  }

  #[test]
  fn ed25519_instruction_layout() {
    let msg = [7u8; 190];
    let data = ed25519_instruction_data(&[1; 32], &[2; 64], &msg);
    assert_eq!(data.len(), 302);
    assert_eq!(&data[..2], &[1, 0]);
    let u16_at = |o: usize| u16::from_le_bytes([data[o], data[o + 1]]);
    assert_eq!(u16_at(2), 48); // signature offset
    assert_eq!(u16_at(4), 0xffff);
    assert_eq!(u16_at(6), 16); // public key offset
    assert_eq!(u16_at(8), 0xffff);
    assert_eq!(u16_at(10), 112); // message offset
    assert_eq!(u16_at(12), 190);
    assert_eq!(u16_at(14), 0xffff);
    assert_eq!(&data[16..48], &[1; 32]);
    assert_eq!(&data[48..112], &[2; 64]);
    assert_eq!(&data[112..], &msg);
  }

  #[test]
  fn largest_responses_fit() {
    for (name, plaintext) in largest_responses(&[1; 32]) {
      // 72 header + 24 nonce + 16 tag + 64 signature.
      assert!(plaintext.len() + 176 <= ENVELOPE_MAX_ONCHAIN, "{name}: {} bytes of plaintext", plaintext.len());
    }
  }
}
