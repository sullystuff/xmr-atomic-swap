//! SPEC 2.8: message encryption (the envelope) and the fixed-size lock notice.
//!
//! ```text
//! dh      = X25519(own secret, peer public)              reject an all-zero result
//! K(use)  = HKDF-SHA256(ikm = dh, salt = DS("ecdh"), info = use ‖ 0x00 ‖ taker_pub ‖ maker_pub, L = 32)
//! uses    : "t2m" (taker to maker), "m2t" (maker to taker), "notice" (the lock notice)
//! cipher  : XChaCha20-Poly1305, 24-byte nonce
//! ```
//!
//! Envelope layout:
//!
//! | Offset | Size | Field |
//! | --- | --- | --- |
//! | 0 | 2 | Magic `58 53` ("XS") |
//! | 2 | 1 | Version = 1 |
//! | 3 | 1 | Flags: bit 0 set = sent by the maker |
//! | 4 | 4 | Maker encryption key version, u32 LE |
//! | 8 | 32 | `taker_pub`: the non-maker party's X25519 public key |
//! | 40 | 32 | `swap_ref`, or zeros |
//! | 72 | 24 | Nonce |
//! | 96 | n + 16 | Ciphertext and tag. Associated data = bytes 0..72 |
//! | end | 64 | Only when flag bit 0 is set: Ed25519 signature by the maker's operator key over `DS("envelope-sig") ‖ bytes[0 .. end−64]` |

use chacha20poly1305::{
  aead::{Aead, KeyInit, Payload},
  XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::{
  error::{Error, Result},
  primitives::{ds, sha256},
  sign::{ed25519_sign, ed25519_verify},
};

pub const ENVELOPE_MAGIC: [u8; 2] = [0x58, 0x53];
pub const ENVELOPE_VERSION: u8 = 1;
pub const ENVELOPE_FLAG_FROM_MAKER: u8 = 1;
pub const ENVELOPE_HEADER_LEN: usize = 72;
pub const ENVELOPE_NONCE_LEN: usize = 24;
pub const ENVELOPE_TAG_LEN: usize = 16;
pub const ENVELOPE_SIG_LEN: usize = 64;
/// Size cap when posted on Solana (`post_message`) or as an Ethereum event.
pub const ENVELOPE_MAX_ONCHAIN: usize = 900;
/// Size cap over Tor.
pub const ENVELOPE_MAX_TOR: usize = 16_384;
pub const NOTICE_CT_LEN: usize = 104;

/// The seven low-order points of Curve25519 as 255-bit u-coordinates (libsodium's blacklist):
/// 0, 1, the two points of order 8, `p − 1`, `p` and `p + 1`. X25519 ignores bit 255, so each
/// also has an alias with that bit set: fourteen 32-byte strings in total.
pub const LOW_ORDER_X25519: [[u8; 32]; 7] = [
  [0; 32],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [
    0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09, 0x8d,
    0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00,
  ],
  [
    0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef, 0x5b, 0x04, 0x44, 0x5c,
    0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f, 0x11, 0x57,
  ],
  [
    0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ],
  [
    0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ],
  [
    0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
  ],
];

/// `isLowOrderX25519(pub)`: true for the fourteen encodings whose Diffie-Hellman result is zero
/// for every secret. The on-chain rule is the same: clear bit 255, compare with the seven.
pub fn is_low_order_x25519(public: &[u8; 32]) -> bool {
  let mut masked = *public;
  masked[31] &= 0x7f;
  LOW_ORDER_X25519.iter().any(|p| *p == masked)
}

/// `x25519Public(secret)`.
pub fn x25519_public(secret: &[u8; 32]) -> [u8; 32] {
  x25519_dalek::x25519(*secret, x25519_dalek::X25519_BASEPOINT_BYTES)
}

/// `X25519(own secret, peer public)`, refusing low-order peers and an all-zero result.
pub fn x25519_shared(own_secret: &[u8; 32], peer_public: &[u8; 32]) -> Result<[u8; 32]> {
  if is_low_order_x25519(peer_public) {
    return Err(Error::LowOrderEncryptionKey);
  }
  let dh = x25519_dalek::x25519(*own_secret, *peer_public);
  if dh == [0u8; 32] {
    return Err(Error::LowOrderEncryptionKey);
  }
  Ok(dh)
}

/// What a derived key is used for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyUse {
  TakerToMaker,
  MakerToTaker,
  Notice,
}
impl KeyUse {
  pub fn label(self) -> &'static str {
    match self {
      KeyUse::TakerToMaker => "t2m",
      KeyUse::MakerToTaker => "m2t",
      KeyUse::Notice => "notice",
    }
  }
}

/// `K(use)`.
pub fn derive_key(dh: &[u8; 32], key_use: KeyUse, taker_pub: &[u8; 32], maker_pub: &[u8; 32]) -> [u8; 32] {
  let mut info = Vec::with_capacity(72);
  info.extend_from_slice(key_use.label().as_bytes());
  info.push(0);
  info.extend_from_slice(taker_pub);
  info.extend_from_slice(maker_pub);
  let mut out = [0u8; 32];
  Hkdf::<Sha256>::new(Some(&ds("ecdh")), dh).expand(&info, &mut out).expect("32 bytes is a valid HKDF length");
  out
}

/// Which side of the Diffie-Hellman pair the caller is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
  Taker,
  Maker,
}

/// Both parties' key for `key_use`, from the caller's secret and the peer's public key.
fn pair_key(own_secret: &[u8; 32], peer_pub: &[u8; 32], side: Side, key_use: KeyUse) -> Result<[u8; 32]> {
  let mut dh = x25519_shared(own_secret, peer_pub)?;
  let own_pub = x25519_public(own_secret);
  let key = match side {
    Side::Taker => derive_key(&dh, key_use, &own_pub, peer_pub),
    Side::Maker => derive_key(&dh, key_use, peer_pub, &own_pub),
  };
  dh.zeroize();
  Ok(key)
}

/// Parsed bytes 0..72 of an envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvelopeHeader {
  pub version: u8,
  pub flags: u8,
  pub maker_key_version: u32,
  pub taker_pub: [u8; 32],
  pub swap_ref: [u8; 32],
}
impl EnvelopeHeader {
  pub fn from_maker(&self) -> bool {
    self.flags & ENVELOPE_FLAG_FROM_MAKER != 0
  }
}

/// Arguments of [`envelope_seal`].
pub struct SealArgs<'a> {
  /// True when the maker is the sender (sets flag bit 0; the result still needs [`envelope_sign`]).
  pub from_maker: bool,
  pub maker_key_version: u32,
  /// The sender's X25519 secret.
  pub own_secret: &'a [u8; 32],
  /// The recipient's X25519 public key.
  pub peer_pub: &'a [u8; 32],
  /// `swap_ref`, or zeros when the message concerns no swap.
  pub swap_ref: &'a [u8; 32],
  pub plaintext: &'a [u8],
  /// 24 random bytes. Never reuse one with the same key.
  pub nonce: [u8; 24],
  /// Size cap for the finished envelope including the maker's signature: 900 on-chain, 16,384 over Tor.
  pub max_len: usize,
}

/// `envelopeSeal(args)`: header, nonce, ciphertext and tag. A maker's envelope is not complete
/// until [`envelope_sign`] has appended the operator signature.
pub fn envelope_seal(a: &SealArgs) -> Result<Vec<u8>> {
  let total =
    ENVELOPE_HEADER_LEN + ENVELOPE_NONCE_LEN + a.plaintext.len() + ENVELOPE_TAG_LEN + if a.from_maker { ENVELOPE_SIG_LEN } else { 0 };
  if total > a.max_len.min(ENVELOPE_MAX_TOR) {
    return Err(Error::EnvelopeTooLarge);
  }
  let (side, key_use) = if a.from_maker { (Side::Maker, KeyUse::MakerToTaker) } else { (Side::Taker, KeyUse::TakerToMaker) };
  let mut key = pair_key(a.own_secret, a.peer_pub, side, key_use)?;
  let taker_pub = if a.from_maker { *a.peer_pub } else { x25519_public(a.own_secret) };

  let mut out = Vec::with_capacity(total);
  out.extend_from_slice(&ENVELOPE_MAGIC);
  out.push(ENVELOPE_VERSION);
  out.push(if a.from_maker { ENVELOPE_FLAG_FROM_MAKER } else { 0 });
  out.extend_from_slice(&a.maker_key_version.to_le_bytes());
  out.extend_from_slice(&taker_pub);
  out.extend_from_slice(a.swap_ref);
  debug_assert_eq!(out.len(), ENVELOPE_HEADER_LEN);
  let ct = XChaCha20Poly1305::new((&key).into())
    .encrypt(XNonce::from_slice(&a.nonce), Payload { msg: a.plaintext, aad: &out })
    .map_err(|_| Error::EnvelopeTooLarge)?;
  key.zeroize();
  out.extend_from_slice(&a.nonce);
  out.extend_from_slice(&ct);
  Ok(out)
}

/// Parse and sanity-check the fixed part of an envelope.
pub fn envelope_header(envelope: &[u8]) -> Result<EnvelopeHeader> {
  let min = ENVELOPE_HEADER_LEN + ENVELOPE_NONCE_LEN + ENVELOPE_TAG_LEN;
  if envelope.len() > ENVELOPE_MAX_TOR {
    return Err(Error::EnvelopeTooLarge);
  }
  if envelope.len() < min || envelope[..2] != ENVELOPE_MAGIC || envelope[2] != ENVELOPE_VERSION {
    return Err(Error::EnvelopeMalformed);
  }
  let flags = envelope[3];
  if flags & !ENVELOPE_FLAG_FROM_MAKER != 0 {
    return Err(Error::EnvelopeMalformed);
  }
  if flags & ENVELOPE_FLAG_FROM_MAKER != 0 && envelope.len() < min + ENVELOPE_SIG_LEN {
    return Err(Error::EnvelopeMalformed);
  }
  Ok(EnvelopeHeader {
    version: envelope[2],
    flags,
    maker_key_version: u32::from_le_bytes(envelope[4..8].try_into().unwrap()),
    taker_pub: envelope[8..40].try_into().unwrap(),
    swap_ref: envelope[40..72].try_into().unwrap(),
  })
}

fn sig_message(signed_part: &[u8]) -> Vec<u8> {
  let mut m = ds("envelope-sig");
  m.extend_from_slice(signed_part);
  m
}

/// `envelopeSign`: append the maker's operator signature to an envelope sealed with
/// `from_maker`. `operator_seed` is the 32-byte Ed25519 seed of the Solana operator key.
pub fn envelope_sign(envelope: &[u8], operator_seed: &[u8; 32]) -> Result<Vec<u8>> {
  if envelope.len() < ENVELOPE_HEADER_LEN + ENVELOPE_NONCE_LEN + ENVELOPE_TAG_LEN
    || envelope[..2] != ENVELOPE_MAGIC
    || envelope[2] != ENVELOPE_VERSION
    || envelope[3] != ENVELOPE_FLAG_FROM_MAKER
  {
    return Err(Error::EnvelopeMalformed);
  }
  if envelope.len() + ENVELOPE_SIG_LEN > ENVELOPE_MAX_TOR {
    return Err(Error::EnvelopeTooLarge);
  }
  let sig = ed25519_sign(operator_seed, &sig_message(envelope));
  let mut out = envelope.to_vec();
  out.extend_from_slice(&sig);
  Ok(out)
}

/// `envelopeVerifySig`: true iff the envelope has flag bit 0 set and its last 64 bytes are a
/// valid signature by `operator_pub` (the maker's operator key read from the registry).
pub fn envelope_verify_sig(envelope: &[u8], operator_pub: &[u8; 32]) -> bool {
  let Ok(header) = envelope_header(envelope) else { return false };
  if !header.from_maker() {
    return false;
  }
  let (body, sig) = envelope.split_at(envelope.len() - ENVELOPE_SIG_LEN);
  ed25519_verify(operator_pub, &sig_message(body), sig.try_into().unwrap())
}

/// Arguments of [`envelope_open`].
pub struct OpenArgs<'a> {
  pub envelope: &'a [u8],
  /// The recipient's X25519 secret.
  pub own_secret: &'a [u8; 32],
  /// Recipient is a taker: the maker's X25519 public key of the version in the header.
  /// Recipient is the maker: ignored (the taker's key is in the header).
  pub maker_pub: Option<&'a [u8; 32]>,
  /// Recipient is a taker: the maker's operator key from the registry. Required; a maker's
  /// envelope is never opened without checking its signature.
  pub operator_pub: Option<&'a [u8; 32]>,
}

/// `envelopeOpen(args)`: authenticate and decrypt.
pub fn envelope_open(a: &OpenArgs) -> Result<(Vec<u8>, EnvelopeHeader)> {
  let header = envelope_header(a.envelope)?;
  let own_pub = x25519_public(a.own_secret);
  let (key, ct_end) = if header.from_maker() {
    // To a taker: the header must name the recipient's own key, and the operator must have signed.
    let operator = a.operator_pub.ok_or(Error::EnvelopeBadSignature)?;
    if !envelope_verify_sig(a.envelope, operator) {
      return Err(Error::EnvelopeBadSignature);
    }
    if header.taker_pub != own_pub {
      return Err(Error::EnvelopeMalformed);
    }
    let maker_pub = a.maker_pub.ok_or(Error::EnvelopeMalformed)?;
    (pair_key(a.own_secret, maker_pub, Side::Taker, KeyUse::MakerToTaker)?, a.envelope.len() - ENVELOPE_SIG_LEN)
  } else {
    (pair_key(a.own_secret, &header.taker_pub, Side::Maker, KeyUse::TakerToMaker)?, a.envelope.len())
  };
  let nonce = &a.envelope[ENVELOPE_HEADER_LEN..ENVELOPE_HEADER_LEN + ENVELOPE_NONCE_LEN];
  let ct = &a.envelope[ENVELOPE_HEADER_LEN + ENVELOPE_NONCE_LEN..ct_end];
  let mut key = key;
  let plaintext = XChaCha20Poly1305::new((&key).into())
    .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: &a.envelope[..ENVELOPE_HEADER_LEN] })
    .map_err(|_| Error::EnvelopeDecrypt);
  key.zeroize();
  Ok((plaintext?, header))
}

/// `noticeCommitment(swapRef, txid, view)` = `SHA256( DS("notice") ‖ swap_ref ‖ txid ‖ v_C )`.
///
/// `txid` is the 32 bytes of the Monero transaction id as its hex string reads. The Ethereum
/// contract computes the same bytes as
/// `sha256(abi.encodePacked("xmrswap/v1/notice", bytes1(0), swapId, txid, view))`.
pub fn notice_commitment(swap_ref: &[u8; 32], txid: &[u8; 32], view: &[u8; 32]) -> [u8; 32] {
  sha256(&[&ds("notice"), swap_ref, txid, view])
}

/// Arguments shared by [`notice_seal`] and [`notice_open`].
pub struct NoticeKeys<'a> {
  /// The caller's X25519 secret (taker: the swap's one-time `enc` key; maker: the key of the
  /// version recorded in the swap).
  pub own_secret: &'a [u8; 32],
  /// The counterparty's X25519 public key as stored in the swap (`taker_enc_key` / `maker_enc_key`).
  pub peer_pub: &'a [u8; 32],
  /// Which party the caller is.
  pub side: Side,
  pub swap_ref: &'a [u8; 32],
}

/// `noticeSeal(...)`: `nonce[24] ‖ XChaCha20-Poly1305(K("notice"), aad = swap_ref, txid ‖ v_C)`,
/// 104 bytes. Sealed by the claimer (A: maker, B: taker).
pub fn notice_seal(k: &NoticeKeys, txid: &[u8; 32], view: &[u8; 32], nonce: [u8; 24]) -> Result<[u8; NOTICE_CT_LEN]> {
  let mut key = pair_key(k.own_secret, k.peer_pub, k.side, KeyUse::Notice)?;
  let mut pt = [0u8; 64];
  pt[..32].copy_from_slice(txid);
  pt[32..].copy_from_slice(view);
  let ct = XChaCha20Poly1305::new((&key).into())
    .encrypt(XNonce::from_slice(&nonce), Payload { msg: &pt, aad: k.swap_ref })
    .map_err(|_| Error::NoticeDecrypt)?;
  key.zeroize();
  pt.zeroize();
  let mut out = [0u8; NOTICE_CT_LEN];
  out[..24].copy_from_slice(&nonce);
  out[24..].copy_from_slice(&ct);
  Ok(out)
}

/// `noticeOpen(...)`: decrypt and require the opening to match the on-chain commitment. Any
/// failure means "no lock".
pub fn notice_open(k: &NoticeKeys, ciphertext: &[u8], commitment: &[u8; 32]) -> Result<([u8; 32], [u8; 32])> {
  if ciphertext.len() != NOTICE_CT_LEN {
    return Err(Error::BadLength);
  }
  let mut key = pair_key(k.own_secret, k.peer_pub, k.side, KeyUse::Notice)?;
  let pt = XChaCha20Poly1305::new((&key).into())
    .decrypt(XNonce::from_slice(&ciphertext[..24]), Payload { msg: &ciphertext[24..], aad: k.swap_ref })
    .map_err(|_| Error::NoticeDecrypt);
  key.zeroize();
  let pt = pt?;
  let txid: [u8; 32] = pt[..32].try_into().unwrap();
  let view: [u8; 32] = pt[32..].try_into().unwrap();
  if notice_commitment(k.swap_ref, &txid, &view) != *commitment {
    return Err(Error::NoticeCommitmentMismatch);
  }
  Ok((txid, view))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sign::ed25519_public;

  fn h(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
  }

  #[test]
  fn x25519_rfc7748_vectors() {
    // RFC 7748 section 6.1.
    let a = h("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    let b = h("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
    assert_eq!(hex::encode(x25519_public(&a)), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    assert_eq!(hex::encode(x25519_public(&b)), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    let shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
    assert_eq!(hex::encode(x25519_shared(&a, &x25519_public(&b)).unwrap()), shared);
    assert_eq!(hex::encode(x25519_shared(&b, &x25519_public(&a)).unwrap()), shared);
  }

  #[test]
  fn xchacha20poly1305_draft_vector() {
    // draft-irtf-cfrg-xchacha-03, appendix A.3.1.
    let key: Vec<u8> = (0x80u8..=0x9f).collect();
    let nonce: Vec<u8> = (0x40u8..=0x57).collect();
    let aad = hex::decode("50515253c0c1c2c3c4c5c6c7").unwrap();
    let pt = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
    let ct = XChaCha20Poly1305::new_from_slice(&key)
      .unwrap()
      .encrypt(XNonce::from_slice(&nonce), Payload { msg: pt, aad: &aad })
      .unwrap();
    assert_eq!(hex::encode(&ct[..16]), "bd6d179d3e83d43b9576579493c0e939");
    assert_eq!(hex::encode(&ct[ct.len() - 16..]), "c0875924c1c7987947deafd8780acf49");
  }

  #[test]
  fn low_order_table_is_exactly_the_zero_dh_set() {
    let secrets = [[1u8; 32], [0x55; 32], h("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")];
    for p in LOW_ORDER_X25519 {
      for top in [0u8, 0x80] {
        let mut enc = p;
        enc[31] |= top;
        assert!(is_low_order_x25519(&enc));
        for s in secrets {
          // The raw primitive really gives zero for these...
          assert_eq!(x25519_dalek::x25519(s, enc), [0u8; 32], "{}", hex::encode(enc));
          // ...and the wrapper refuses them.
          assert_eq!(x25519_shared(&s, &enc), Err(Error::LowOrderEncryptionKey));
        }
      }
    }
    // Honest keys are not flagged, and neither are near misses.
    for i in 0..50u8 {
      let k = x25519_public(&sha256(&[b"x", &[i]]));
      assert!(!is_low_order_x25519(&k));
    }
    let mut two = [0u8; 32];
    two[0] = 2;
    assert!(!is_low_order_x25519(&two));
    let mut pm2 = LOW_ORDER_X25519[4];
    pm2[0] = 0xeb;
    assert!(!is_low_order_x25519(&pm2));
  }

  struct Parties {
    taker_secret: [u8; 32],
    taker_pub: [u8; 32],
    maker_secret: [u8; 32],
    maker_pub: [u8; 32],
    operator_seed: [u8; 32],
    operator_pub: [u8; 32],
  }
  fn parties() -> Parties {
    let taker_secret = sha256(&[b"taker enc"]);
    let maker_secret = sha256(&[b"maker enc"]);
    let operator_seed = sha256(&[b"operator"]);
    Parties {
      taker_secret,
      taker_pub: x25519_public(&taker_secret),
      maker_secret,
      maker_pub: x25519_public(&maker_secret),
      operator_seed,
      operator_pub: ed25519_public(&operator_seed),
    }
  }

  #[test]
  fn taker_to_maker_round_trip() {
    let p = parties();
    let swap_ref = [7u8; 32];
    let env = envelope_seal(&SealArgs {
      from_maker: false,
      maker_key_version: 3,
      own_secret: &p.taker_secret,
      peer_pub: &p.maker_pub,
      swap_ref: &swap_ref,
      plaintext: br#"{"t":"inbox","text":"hello"}"#,
      nonce: [9u8; 24],
      max_len: ENVELOPE_MAX_ONCHAIN,
    })
    .unwrap();
    assert_eq!(&env[..4], &[0x58, 0x53, 1, 0]);
    assert_eq!(env.len(), 72 + 24 + 28 + 16);
    let (pt, header) =
      envelope_open(&OpenArgs { envelope: &env, own_secret: &p.maker_secret, maker_pub: None, operator_pub: None }).unwrap();
    assert_eq!(pt, br#"{"t":"inbox","text":"hello"}"#);
    assert_eq!(header.maker_key_version, 3);
    assert_eq!(header.taker_pub, p.taker_pub);
    assert_eq!(header.swap_ref, swap_ref);
    assert!(!header.from_maker());
    // A third party cannot open it.
    let eve = sha256(&[b"eve"]);
    assert_eq!(
      envelope_open(&OpenArgs { envelope: &env, own_secret: &eve, maker_pub: None, operator_pub: None }).unwrap_err(),
      Error::EnvelopeDecrypt
    );
    // Every header byte is authenticated.
    for i in [3usize, 4, 8, 40, 71, 72, 96, env.len() - 1] {
      let mut bad = env.clone();
      bad[i] ^= 0x02;
      assert!(
        envelope_open(&OpenArgs { envelope: &bad, own_secret: &p.maker_secret, maker_pub: None, operator_pub: None }).is_err(),
        "byte {i}"
      );
    }
  }

  fn maker_envelope(p: &Parties, plaintext: &[u8]) -> Vec<u8> {
    let sealed = envelope_seal(&SealArgs {
      from_maker: true,
      maker_key_version: 2,
      own_secret: &p.maker_secret,
      peer_pub: &p.taker_pub,
      swap_ref: &[0u8; 32],
      plaintext,
      nonce: [4u8; 24],
      max_len: ENVELOPE_MAX_ONCHAIN,
    })
    .unwrap();
    envelope_sign(&sealed, &p.operator_seed).unwrap()
  }

  #[test]
  fn maker_to_taker_requires_the_operator_signature() {
    let p = parties();
    let env = maker_envelope(&p, b"{\"t\":\"ack\"}");
    assert!(envelope_verify_sig(&env, &p.operator_pub));
    let open = |env: &[u8], op: Option<&[u8; 32]>| {
      envelope_open(&OpenArgs { envelope: env, own_secret: &p.taker_secret, maker_pub: Some(&p.maker_pub), operator_pub: op })
    };
    let (pt, header) = open(&env, Some(&p.operator_pub)).unwrap();
    assert_eq!(pt, b"{\"t\":\"ack\"}");
    assert!(header.from_maker());
    assert_eq!(header.taker_pub, p.taker_pub);

    // No operator key supplied, a different operator, a stripped or altered signature.
    assert_eq!(open(&env, None).unwrap_err(), Error::EnvelopeBadSignature);
    let other = ed25519_public(&sha256(&[b"other operator"]));
    assert_eq!(open(&env, Some(&other)).unwrap_err(), Error::EnvelopeBadSignature);
    assert!(open(&env[..env.len() - 64], Some(&p.operator_pub)).is_err());
    let mut bad = env.clone();
    let n = bad.len();
    bad[n - 1] ^= 1;
    assert_eq!(open(&bad, Some(&p.operator_pub)).unwrap_err(), Error::EnvelopeBadSignature);
    // Signed by the right operator but encrypted to someone else's key.
    let eve = sha256(&[b"eve"]);
    assert_eq!(
      envelope_open(&OpenArgs { envelope: &env, own_secret: &eve, maker_pub: Some(&p.maker_pub), operator_pub: Some(&p.operator_pub) })
        .unwrap_err(),
      Error::EnvelopeMalformed
    );
    // The flag cannot be cleared to skip the signature: the header is authenticated and the
    // direction keys differ.
    let mut unflagged = env[..env.len() - 64].to_vec();
    unflagged[3] = 0;
    assert!(envelope_open(&OpenArgs { envelope: &unflagged, own_secret: &p.maker_secret, maker_pub: None, operator_pub: None }).is_err());
    assert!(!envelope_verify_sig(&unflagged, &p.operator_pub));
  }

  #[test]
  fn direction_keys_are_distinct() {
    let p = parties();
    let dh = x25519_shared(&p.taker_secret, &p.maker_pub).unwrap();
    assert_eq!(dh, x25519_shared(&p.maker_secret, &p.taker_pub).unwrap());
    let t2m = derive_key(&dh, KeyUse::TakerToMaker, &p.taker_pub, &p.maker_pub);
    let m2t = derive_key(&dh, KeyUse::MakerToTaker, &p.taker_pub, &p.maker_pub);
    let notice = derive_key(&dh, KeyUse::Notice, &p.taker_pub, &p.maker_pub);
    assert_ne!(t2m, m2t);
    assert_ne!(t2m, notice);
    assert_ne!(m2t, notice);
    // Swapping the public keys in `info` changes the key.
    assert_ne!(t2m, derive_key(&dh, KeyUse::TakerToMaker, &p.maker_pub, &p.taker_pub));
  }

  #[test]
  fn size_caps_and_malformed_inputs() {
    let p = parties();
    let seal = |len: usize, max: usize, from_maker: bool| {
      envelope_seal(&SealArgs {
        from_maker,
        maker_key_version: 1,
        own_secret: if from_maker { &p.maker_secret } else { &p.taker_secret },
        peer_pub: if from_maker { &p.taker_pub } else { &p.maker_pub },
        swap_ref: &[0u8; 32],
        plaintext: &vec![b'a'; len],
        nonce: [1u8; 24],
        max_len: max,
      })
    };
    // 900 = 72 + 24 + n + 16 for a taker; a maker's also carries 64 bytes of signature.
    assert_eq!(seal(788, ENVELOPE_MAX_ONCHAIN, false).unwrap().len(), 900);
    assert_eq!(seal(789, ENVELOPE_MAX_ONCHAIN, false).unwrap_err(), Error::EnvelopeTooLarge);
    assert_eq!(seal(724, ENVELOPE_MAX_ONCHAIN, true).unwrap().len(), 836);
    assert_eq!(seal(725, ENVELOPE_MAX_ONCHAIN, true).unwrap_err(), Error::EnvelopeTooLarge);
    assert!(seal(ENVELOPE_MAX_TOR - 112, usize::MAX, false).is_ok());
    assert_eq!(seal(ENVELOPE_MAX_TOR - 111, usize::MAX, false).unwrap_err(), Error::EnvelopeTooLarge);

    let good = seal(10, 900, false).unwrap();
    let open = |e: &[u8]| envelope_open(&OpenArgs { envelope: e, own_secret: &p.maker_secret, maker_pub: None, operator_pub: None });
    let mut bad = good.clone();
    bad[0] = 0x59;
    assert_eq!(open(&bad).unwrap_err(), Error::EnvelopeMalformed);
    let mut bad = good.clone();
    bad[2] = 2;
    assert_eq!(open(&bad).unwrap_err(), Error::EnvelopeMalformed);
    let mut bad = good.clone();
    bad[3] = 2; // unknown flag bit
    assert_eq!(open(&bad).unwrap_err(), Error::EnvelopeMalformed);
    assert_eq!(open(&good[..100]).unwrap_err(), Error::EnvelopeMalformed);
    assert_eq!(open(&vec![0u8; ENVELOPE_MAX_TOR + 1]).unwrap_err(), Error::EnvelopeTooLarge);
    // Sealing to a low-order key is refused.
    assert_eq!(
      envelope_seal(&SealArgs {
        from_maker: false,
        maker_key_version: 1,
        own_secret: &p.taker_secret,
        peer_pub: &LOW_ORDER_X25519[2],
        swap_ref: &[0u8; 32],
        plaintext: b"x",
        nonce: [1u8; 24],
        max_len: 900,
      })
      .unwrap_err(),
      Error::LowOrderEncryptionKey
    );
    // envelope_sign refuses a taker envelope.
    assert_eq!(envelope_sign(&good, &p.operator_seed).unwrap_err(), Error::EnvelopeMalformed);
  }

  #[test]
  fn notice_round_trip_and_failures() {
    let p = parties();
    let swap_ref = sha256(&[b"swap"]);
    let txid = sha256(&[b"txid"]);
    let view = crate::primitives::clamp252(sha256(&[b"view"]));
    let commitment = notice_commitment(&swap_ref, &txid, &view);
    assert_eq!(commitment, sha256(&[b"xmrswap/v1/notice\0", &swap_ref, &txid, &view]));

    // Direction A: the maker seals, the taker opens.
    let maker = NoticeKeys { own_secret: &p.maker_secret, peer_pub: &p.taker_pub, side: Side::Maker, swap_ref: &swap_ref };
    let taker = NoticeKeys { own_secret: &p.taker_secret, peer_pub: &p.maker_pub, side: Side::Taker, swap_ref: &swap_ref };
    let ct = notice_seal(&maker, &txid, &view, [3u8; 24]).unwrap();
    assert_eq!(ct.len(), 104);
    assert_eq!(notice_open(&taker, &ct, &commitment).unwrap(), (txid, view));
    // Direction B: the taker seals, the maker opens. Same key, same bytes.
    assert_eq!(notice_seal(&taker, &txid, &view, [3u8; 24]).unwrap(), ct);
    assert_eq!(notice_open(&maker, &ct, &commitment).unwrap(), (txid, view));

    // A ciphertext that decrypts but does not open the commitment is "no lock".
    let other_txid = sha256(&[b"another txid"]);
    let lying = notice_seal(&maker, &other_txid, &view, [3u8; 24]).unwrap();
    assert_eq!(notice_open(&taker, &lying, &commitment), Err(Error::NoticeCommitmentMismatch));
    // Tampered ciphertext, wrong swap (aad), wrong key, wrong length.
    let mut bad = ct;
    bad[50] ^= 1;
    assert_eq!(notice_open(&taker, &bad, &commitment), Err(Error::NoticeDecrypt));
    let other_ref = sha256(&[b"other swap"]);
    let wrong_swap = NoticeKeys { swap_ref: &other_ref, ..NoticeKeys { own_secret: &p.taker_secret, peer_pub: &p.maker_pub, side: Side::Taker, swap_ref: &swap_ref } };
    assert_eq!(notice_open(&wrong_swap, &ct, &commitment), Err(Error::NoticeDecrypt));
    let eve = sha256(&[b"eve"]);
    let eve_keys = NoticeKeys { own_secret: &eve, peer_pub: &p.maker_pub, side: Side::Taker, swap_ref: &swap_ref };
    assert_eq!(notice_open(&eve_keys, &ct, &commitment), Err(Error::NoticeDecrypt));
    assert_eq!(notice_open(&taker, &ct[..103], &commitment), Err(Error::BadLength));
    // The envelope keys cannot open a notice: uses are separated.
    let dh = x25519_shared(&p.taker_secret, &p.maker_pub).unwrap();
    let m2t = derive_key(&dh, KeyUse::MakerToTaker, &p.taker_pub, &p.maker_pub);
    assert!(XChaCha20Poly1305::new((&m2t).into())
      .decrypt(XNonce::from_slice(&ct[..24]), Payload { msg: &ct[24..], aad: &swap_ref })
      .is_err());
  }
}
