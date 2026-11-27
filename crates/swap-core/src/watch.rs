//! SPEC 11.6: the watch request a locker posts to its watcher, wire format 2.
//!
//! The request carries one secret, the swap's notice key ([`crate::envelope::notice_key`]),
//! sealed to the watcher's Ed25519 key (in its X25519 form) and authenticated with the locker's
//! encryption key recorded in the swap, so that only the swap's locker can make a request the
//! watcher accepts:
//!
//! ```text
//! W      = X25519 form of the watcher's Ed25519 key (u = (1 + y) / (1 − y))
//! k      = HKDF-SHA256(ikm  = X25519(eph, W) ‖ X25519(locker_enc, W),
//!                      salt = DS("watch/2"),
//!                      info = eph_pub ‖ W ‖ locker_enc_pub, L = 32)
//! aad    = DS("watch-req") ‖ 0x02 ‖ chain_tag ‖ len(deployment) (u8) ‖ deployment (UTF-8)
//!          ‖ swap_ref ‖ watcher Ed25519 key ‖ issued_at (u64 LE)
//! sealed = eph_pub[32] ‖ nonce[24] ‖ XChaCha20-Poly1305(k, nonce, aad, notice_key)[48]     (104 bytes)
//! ```
//!
//! `deployment` is the program id in base58 (Solana) or `"<chain id>:<contract, lowercase 0x>"`
//! (Ethereum). The watcher computes the static term as `X25519(w, locker_enc_pub)` with
//! `locker_enc_pub` read from the swap on chain (`taker_enc_key` in direction A, `maker_enc_key`
//! in B). Format 1 (no static term, no deployment, no time) is refused.

use chacha20poly1305::{
  aead::{Aead, KeyInit, Payload},
  XChaCha20Poly1305, XNonce,
};
use curve25519_dalek::edwards::CompressedEdwardsY;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::{
  envelope::{is_low_order_x25519, x25519_public, x25519_shared},
  error::{Error, Result},
  primitives::{ds, sha512, ChainTag},
  sign::ed25519_public,
};

/// The wire format of a watch request.
pub const WATCH_FORMAT: u8 = 2;
/// `eph_pub[32] ‖ nonce[24] ‖ ciphertext[32] ‖ tag[16]`.
pub const SEALED_NOTICE_KEY_LEN: usize = 104;

/// The X25519 public key of an Ed25519 public key. The key must be the canonical encoding of a
/// curve point whose X25519 form is not low-order (`WatchKeyInvalid`).
pub fn ed25519_public_to_x25519(ed: &[u8; 32]) -> Result<[u8; 32]> {
  let compressed = CompressedEdwardsY(*ed);
  let point = compressed.decompress().ok_or(Error::WatchKeyInvalid)?;
  if point.compress() != compressed {
    return Err(Error::WatchKeyInvalid);
  }
  let mont = point.to_montgomery().to_bytes();
  if is_low_order_x25519(&mont) {
    return Err(Error::WatchKeyInvalid);
  }
  Ok(mont)
}

/// The X25519 secret of an Ed25519 seed: the clamped first half of `SHA-512(seed)`, the scalar
/// the Ed25519 public key is made from.
pub fn ed25519_seed_to_x25519(seed: &[u8; 32]) -> [u8; 32] {
  let mut h = sha512(&[seed]);
  let mut out = [0u8; 32];
  out.copy_from_slice(&h[..32]);
  h.zeroize();
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  out
}

/// Everything a watch request is bound to besides the two keys that seal it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchBinding<'a> {
  /// The wire format; anything but [`WATCH_FORMAT`] is `WatchFormatUnsupported`.
  pub format: u8,
  pub chain: ChainTag,
  /// The program id (base58), or `chainId:contract`. 1 to 255 bytes.
  pub deployment: &'a str,
  pub swap_ref: &'a [u8; 32],
  /// The watcher's Ed25519 key (its Solana key).
  pub watcher: &'a [u8; 32],
  /// Unix seconds, below 2^63.
  pub issued_at: u64,
}

/// The associated data of the seal: nothing in the binding can change without the open failing.
pub fn watch_request_aad(b: &WatchBinding) -> Result<Vec<u8>> {
  if b.format != WATCH_FORMAT {
    return Err(Error::WatchFormatUnsupported);
  }
  let dep = b.deployment.as_bytes();
  if dep.is_empty() || dep.len() > 255 || b.issued_at >= 1 << 63 {
    return Err(Error::FieldOutOfRange);
  }
  let mut v = ds("watch-req");
  v.push(WATCH_FORMAT);
  v.push(b.chain as u8);
  v.push(dep.len() as u8);
  v.extend_from_slice(dep);
  v.extend_from_slice(b.swap_ref);
  v.extend_from_slice(b.watcher);
  v.extend_from_slice(&b.issued_at.to_le_bytes());
  Ok(v)
}

fn seal_key(dh_eph: &[u8; 32], dh_static: &[u8; 32], eph_pub: &[u8; 32], watcher_x: &[u8; 32], locker_pub: &[u8; 32]) -> [u8; 32] {
  let mut ikm = [0u8; 64];
  ikm[..32].copy_from_slice(dh_eph);
  ikm[32..].copy_from_slice(dh_static);
  let mut info = [0u8; 96];
  info[..32].copy_from_slice(eph_pub);
  info[32..64].copy_from_slice(watcher_x);
  info[64..].copy_from_slice(locker_pub);
  let mut out = [0u8; 32];
  Hkdf::<Sha256>::new(Some(&ds("watch/2")), &ikm).expand(&info, &mut out).expect("32 bytes is a valid HKDF length");
  ikm.zeroize();
  out
}

/// `watchRequestSeal(...)`: seal `notice_key` to the watcher named in `binding`, authenticated
/// as the holder of `locker_enc_secret` (the secret of the locker's encryption key recorded in
/// the swap). `ephemeral_secret` and `nonce` must be fresh randomness.
pub fn watch_request_seal(
  notice_key: &[u8; 32],
  locker_enc_secret: &[u8; 32],
  binding: &WatchBinding,
  ephemeral_secret: &[u8; 32],
  nonce: [u8; 24],
) -> Result<[u8; SEALED_NOTICE_KEY_LEN]> {
  let aad = watch_request_aad(binding)?;
  let w = ed25519_public_to_x25519(binding.watcher)?;
  let eph_pub = x25519_public(ephemeral_secret);
  let mut dh_eph = x25519_shared(ephemeral_secret, &w)?;
  let mut dh_static = x25519_shared(locker_enc_secret, &w)?;
  let mut key = seal_key(&dh_eph, &dh_static, &eph_pub, &w, &x25519_public(locker_enc_secret));
  dh_eph.zeroize();
  dh_static.zeroize();
  let ct = XChaCha20Poly1305::new((&key).into())
    .encrypt(XNonce::from_slice(&nonce), Payload { msg: notice_key, aad: &aad })
    .map_err(|_| Error::WatchKeyInvalid);
  key.zeroize();
  let ct = ct?;
  let mut out = [0u8; SEALED_NOTICE_KEY_LEN];
  out[..32].copy_from_slice(&eph_pub);
  out[32..56].copy_from_slice(&nonce);
  out[56..].copy_from_slice(&ct);
  Ok(out)
}

/// `watchRequestOpen(...)`: the watcher's side. `watcher_seed` is the 32-byte seed of its
/// Ed25519 key, `locker_enc_pub` the locker's encryption key **read from the swap on chain**,
/// and `binding.watcher` is ignored in favour of the seed's own public key. Returns the notice
/// key, or `WatchKeyInvalid` for anything not sealed by that locker to this watcher for this
/// chain, deployment, swap and time.
pub fn watch_request_open(sealed: &[u8], watcher_seed: &[u8; 32], locker_enc_pub: &[u8; 32], binding: &WatchBinding) -> Result<[u8; 32]> {
  let own = ed25519_public(watcher_seed);
  let aad = watch_request_aad(&WatchBinding { watcher: &own, ..binding.clone() })?;
  if sealed.len() != SEALED_NOTICE_KEY_LEN {
    return Err(Error::WatchKeyInvalid);
  }
  let eph_pub: [u8; 32] = sealed[..32].try_into().unwrap();
  let mut secret = ed25519_seed_to_x25519(watcher_seed);
  let w = x25519_public(&secret);
  let dh = x25519_shared(&secret, &eph_pub).and_then(|e| x25519_shared(&secret, locker_enc_pub).map(|s| (e, s)));
  secret.zeroize();
  let (mut dh_eph, mut dh_static) = dh.map_err(|_| Error::WatchKeyInvalid)?;
  let mut key = seal_key(&dh_eph, &dh_static, &eph_pub, &w, locker_enc_pub);
  dh_eph.zeroize();
  dh_static.zeroize();
  let pt = XChaCha20Poly1305::new((&key).into())
    .decrypt(XNonce::from_slice(&sealed[32..56]), Payload { msg: &sealed[56..], aad: &aad })
    .map_err(|_| Error::WatchKeyInvalid);
  key.zeroize();
  pt?.try_into().map_err(|_| Error::WatchKeyInvalid)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::envelope::{notice_commitment, notice_key, notice_open_with_key, notice_seal, NoticeKeys, Side};

  fn binding<'a>(swap_ref: &'a [u8; 32], watcher: &'a [u8; 32]) -> WatchBinding<'a> {
    WatchBinding { format: 2, chain: ChainTag::Solana, deployment: "5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u", swap_ref, watcher, issued_at: 1_800_000_000 }
  }

  #[test]
  fn ed25519_keys_convert_consistently() {
    // The X25519 form of the public key is the public key of the X25519 form of the seed.
    for seed in [[1u8; 32], [0x42; 32], [0xff; 32]] {
      let ed = ed25519_public(&seed);
      assert_eq!(ed25519_public_to_x25519(&ed).unwrap(), x25519_public(&ed25519_seed_to_x25519(&seed)));
    }
    // Not a point, a non-canonical encoding, and the identity (u = 0, low order).
    let mut identity = [0u8; 32];
    identity[0] = 1;
    assert_eq!(ed25519_public_to_x25519(&identity), Err(Error::WatchKeyInvalid));
    assert_eq!(ed25519_public_to_x25519(&[0xff; 32]), Err(Error::WatchKeyInvalid));
    let mut two = [0u8; 32];
    two[0] = 2; // y = 2 is not on the curve
    assert_eq!(ed25519_public_to_x25519(&two), Err(Error::WatchKeyInvalid));
  }

  #[test]
  fn the_notice_key_opens_the_notice_and_nothing_else() {
    let (taker, maker) = ([3u8; 32], [4u8; 32]);
    let (tp, mp) = (x25519_public(&taker), x25519_public(&maker));
    let key = notice_key(&taker, &mp, Side::Taker).unwrap();
    assert_eq!(notice_key(&maker, &tp, Side::Maker).unwrap(), key);
    assert_ne!(notice_key(&taker, &mp, Side::Maker).unwrap(), key);
    let swap_ref = [9u8; 32];
    let (txid, view) = ([5u8; 32], [6u8; 32]);
    let ct = notice_seal(&NoticeKeys { own_secret: &maker, peer_pub: &tp, side: Side::Maker, swap_ref: &swap_ref }, &txid, &view, [7; 24]).unwrap();
    let commitment = notice_commitment(&swap_ref, &txid, &view);
    assert_eq!(notice_open_with_key(&key, &swap_ref, &ct, &commitment).unwrap(), (txid, view));
    assert_eq!(notice_open_with_key(&[0; 32], &swap_ref, &ct, &commitment), Err(Error::NoticeDecrypt));
    assert_eq!(notice_open_with_key(&key, &[8; 32], &ct, &commitment), Err(Error::NoticeDecrypt));
    assert_eq!(notice_open_with_key(&key, &swap_ref, &ct, &[0; 32]), Err(Error::NoticeCommitmentMismatch));
    assert_eq!(notice_open_with_key(&key, &swap_ref, &ct[..103], &commitment), Err(Error::BadLength));
  }

  #[test]
  fn only_the_locker_seals_for_this_watcher_swap_and_time() {
    let watcher_seed = [0x11u8; 32];
    let watcher = ed25519_public(&watcher_seed);
    let locker = [0x22u8; 32];
    let locker_pub = x25519_public(&locker);
    let swap_ref = [0x33u8; 32];
    let key = [0x44u8; 32];
    let b = binding(&swap_ref, &watcher);
    let sealed = watch_request_seal(&key, &locker, &b, &[0x55; 32], [0x66; 24]).unwrap();
    assert_eq!(sealed.len(), 104);
    assert_eq!(&sealed[..32], &x25519_public(&[0x55; 32]));
    assert_eq!(&sealed[32..56], &[0x66; 24]);
    assert_eq!(watch_request_open(&sealed, &watcher_seed, &locker_pub, &b).unwrap(), key);
    // The aad layout.
    let aad = watch_request_aad(&b).unwrap();
    assert_eq!(&aad[..21], b"xmrswap/v1/watch-req\0");
    assert_eq!(&aad[21..24], &[2, 1, 44]);
    assert_eq!(aad.len(), 24 + 44 + 32 + 32 + 8);
    assert_eq!(&aad[aad.len() - 8..], &1_800_000_000u64.to_le_bytes());
    // Another locker key, watcher, swap, chain, deployment or time; an altered byte; format 1.
    let bad = |r: Result<[u8; 32]>| assert_eq!(r, Err(Error::WatchKeyInvalid));
    bad(watch_request_open(&sealed, &watcher_seed, &x25519_public(&[0x23; 32]), &b));
    bad(watch_request_open(&sealed, &[0x12; 32], &locker_pub, &b));
    bad(watch_request_open(&sealed, &watcher_seed, &locker_pub, &WatchBinding { swap_ref: &[0x34; 32], ..b.clone() }));
    bad(watch_request_open(&sealed, &watcher_seed, &locker_pub, &WatchBinding { chain: ChainTag::Ethereum, ..b.clone() }));
    bad(watch_request_open(&sealed, &watcher_seed, &locker_pub, &WatchBinding { deployment: "1:0x00", ..b.clone() }));
    bad(watch_request_open(&sealed, &watcher_seed, &locker_pub, &WatchBinding { issued_at: b.issued_at + 1, ..b.clone() }));
    let mut flipped = sealed;
    flipped[70] ^= 1;
    bad(watch_request_open(&flipped, &watcher_seed, &locker_pub, &b));
    bad(watch_request_open(&sealed[..103], &watcher_seed, &locker_pub, &b));
    let mut low = sealed;
    low[..32].fill(0);
    bad(watch_request_open(&low, &watcher_seed, &locker_pub, &b));
    bad(watch_request_open(&sealed, &watcher_seed, &[0; 32], &b));
    assert_eq!(watch_request_open(&sealed, &watcher_seed, &locker_pub, &WatchBinding { format: 1, ..b.clone() }), Err(Error::WatchFormatUnsupported));
    assert_eq!(watch_request_seal(&key, &locker, &WatchBinding { format: 1, ..b.clone() }, &[0x55; 32], [0x66; 24]), Err(Error::WatchFormatUnsupported));
    assert_eq!(watch_request_seal(&key, &locker, &WatchBinding { deployment: "", ..b.clone() }, &[0x55; 32], [0x66; 24]), Err(Error::FieldOutOfRange));
    assert_eq!(watch_request_seal(&key, &locker, &WatchBinding { issued_at: 1 << 63, ..b.clone() }, &[0x55; 32], [0x66; 24]), Err(Error::FieldOutOfRange));
    // The open ignores the watcher named in the binding: its own key is what is bound.
    assert_eq!(watch_request_open(&sealed, &watcher_seed, &locker_pub, &WatchBinding { watcher: &[0; 32], ..b.clone() }).unwrap(), key);
  }
}
