//! Solana-side byte formats: the advance approval (SPEC 2.9), the offer terms hash (SPEC 4.2)
//! and the open hash (SPEC 3.12). All integers little-endian.

use crate::{
  error::{Error, Result},
  primitives::{ds, sha256},
};

/// Length of an advance-approval message.
pub const SOL_APPROVAL_LEN: usize = 190;
/// `asset` / `direction` wildcard in an advance approval.
pub const ANY: u8 = 0xff;

/// The fields of an advance approval, signed by the maker's operator key and presented as an
/// Ed25519 precompile instruction in the lock transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolApproval {
  /// `Config.cluster_tag` (the genesis hash).
  pub cluster_tag: [u8; 32],
  pub program_id: [u8; 32],
  /// Maker PDA.
  pub maker: [u8; 32],
  /// The only wallet that may use it.
  pub taker: [u8; 32],
  /// `0`, `1`, or `0xff` = any.
  pub asset: u8,
  /// `0` = A, `1` = B, `0xff` = any.
  pub direction: u8,
  /// Largest single swap, in piconero.
  pub max_xmr: u64,
  /// Chain time. Valid while `not_before <= now <= expires_at`.
  pub not_before: i64,
  pub expires_at: i64,
  /// Must equal `maker.approval_epoch`.
  pub epoch: u32,
  /// Random; for logs.
  pub approval_id: u64,
}

/// `encodeSolApproval(fields)`: the exact 190 bytes the operator signs.
///
/// | Offset | Field |
/// | --- | --- |
/// | 0 | `DS("sol-approval")` (24) |
/// | 24 | `cluster_tag` |
/// | 56 | `program_id` |
/// | 88 | `maker` |
/// | 120 | `taker` |
/// | 152 | `asset` |
/// | 153 | `direction` |
/// | 154 | `max_xmr` u64 |
/// | 162 | `not_before` i64 |
/// | 170 | `expires_at` i64 |
/// | 178 | `epoch` u32 |
/// | 182 | `approval_id` u64 |
pub fn encode_sol_approval(a: &SolApproval) -> [u8; SOL_APPROVAL_LEN] {
  let mut out = Vec::with_capacity(SOL_APPROVAL_LEN);
  out.extend_from_slice(&ds("sol-approval"));
  out.extend_from_slice(&a.cluster_tag);
  out.extend_from_slice(&a.program_id);
  out.extend_from_slice(&a.maker);
  out.extend_from_slice(&a.taker);
  out.push(a.asset);
  out.push(a.direction);
  out.extend_from_slice(&a.max_xmr.to_le_bytes());
  out.extend_from_slice(&a.not_before.to_le_bytes());
  out.extend_from_slice(&a.expires_at.to_le_bytes());
  out.extend_from_slice(&a.epoch.to_le_bytes());
  out.extend_from_slice(&a.approval_id.to_le_bytes());
  out.try_into().expect("190 bytes")
}

/// Parse the 190 bytes back (what the program does with the precompile instruction's message).
pub fn decode_sol_approval(msg: &[u8]) -> Result<SolApproval> {
  if msg.len() != SOL_APPROVAL_LEN || msg[..24] != ds("sol-approval")[..] {
    return Err(Error::BadLength);
  }
  let b32 = |o: usize| -> [u8; 32] { msg[o..o + 32].try_into().unwrap() };
  Ok(SolApproval {
    cluster_tag: b32(24),
    program_id: b32(56),
    maker: b32(88),
    taker: b32(120),
    asset: msg[152],
    direction: msg[153],
    max_xmr: u64::from_le_bytes(msg[154..162].try_into().unwrap()),
    not_before: i64::from_le_bytes(msg[162..170].try_into().unwrap()),
    expires_at: i64::from_le_bytes(msg[170..178].try_into().unwrap()),
    epoch: u32::from_le_bytes(msg[178..182].try_into().unwrap()),
    approval_id: u64::from_le_bytes(msg[182..190].try_into().unwrap()),
  })
}

/// Whether an approval admits a lock at chain time `now`: validity is **inclusive** on both
/// ends, and the wildcard `0xff` matches any asset or direction.
pub fn sol_approval_admits(a: &SolApproval, now: i64, asset: u8, direction: u8, xmr: u64, epoch: u32) -> bool {
  a.not_before <= now
    && now <= a.expires_at
    && (a.asset == ANY || a.asset == asset)
    && (a.direction == ANY || a.direction == direction)
    && xmr <= a.max_xmr
    && a.epoch == epoch
}

/// The terms of an offer that a taker pins with `expected_terms_hash`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OfferTermsHashInput {
  pub asset: u8,
  pub direction: u8,
  pub mode: u8,
  pub dep_bps: u16,
  /// `FEE_BPS` (5).
  pub fee_bps: u16,
  pub w_a: u32,
  pub w_n: u32,
  pub d_c: u32,
  pub w_c: u32,
  pub w_f: u32,
  pub depth_above: [u64; 3],
  pub depths: [u8; 3],
  /// `W_z`, the freeze window (SPEC 11.6); 0 = the offer accepts no watcher.
  pub w_z: u32,
}

/// `termsHash(fields)`:
///
/// ```text
/// SHA256( DS("terms") ‖ asset ‖ direction ‖ mode ‖ dep_bps (u16) ‖ FEE_BPS (u16)
///         ‖ w_a ‖ w_n ‖ d_c ‖ w_c ‖ w_f (u32 each)
///         ‖ depth_above[0] (u64) ‖ depths[0] (u8) ‖ depth_above[1] ‖ depths[1] ‖ depth_above[2] ‖ depths[2]
///         ‖ w_z (u32) )
/// ```
///
/// 58 bytes after the tag (Amendment 1 appended `w_z`).
pub fn terms_hash(t: &OfferTermsHashInput) -> [u8; 32] {
  sha256(&[&ds("terms"), &terms_preimage(t)])
}

/// Length of [`terms_preimage`].
pub const TERMS_PREIMAGE_LEN: usize = 58;

/// The 58 bytes hashed after the tag.
pub fn terms_preimage(t: &OfferTermsHashInput) -> [u8; TERMS_PREIMAGE_LEN] {
  let mut v = Vec::with_capacity(TERMS_PREIMAGE_LEN);
  v.extend_from_slice(&[t.asset, t.direction, t.mode]);
  v.extend_from_slice(&t.dep_bps.to_le_bytes());
  v.extend_from_slice(&t.fee_bps.to_le_bytes());
  for w in [t.w_a, t.w_n, t.d_c, t.w_c, t.w_f] {
    v.extend_from_slice(&w.to_le_bytes());
  }
  for i in 0..3 {
    v.extend_from_slice(&t.depth_above[i].to_le_bytes());
    v.push(t.depths[i]);
  }
  v.extend_from_slice(&t.w_z.to_le_bytes());
  v.try_into().expect("58 bytes")
}

/// What `approve`, `fund` and `reject` bind to on Solana (SPEC 3.12). The program recomputes it
/// from the swap account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenHashSolanaInput {
  pub swap: [u8; 32],
  pub t_lock: i64,
  pub direction: u8,
  pub asset: u8,
  pub xmr: u64,
  pub amount: u64,
  pub deposit: u64,
  pub taker_spend_pub: [u8; 32],
  /// The locker's view share as stored at lock: `v_T` in direction A, zeros in direction B.
  pub locker_view: [u8; 32],
  pub taker_enc_key: [u8; 32],
  pub maker_enc_key: [u8; 32],
  /// SPEC 11.2: the payout address named at `take` (`Swap.payout`); zeros in direction A.
  pub payout: [u8; 32],
  /// SPEC 11.6: the watcher the taker named at `lock`; zeros when none, and zeros in direction
  /// B (the maker names its watcher at `fund`, after the hash is fixed).
  pub watcher: [u8; 32],
}

/// `openHashSolana(fields)`:
///
/// ```text
/// SHA256( DS("open") ‖ swap PDA ‖ t_lock (i64) ‖ direction ‖ asset ‖ xmr (u64) ‖ amount (u64) ‖ deposit (u64)
///         ‖ taker_spend_pub ‖ locker_view ‖ taker_enc_key ‖ maker_enc_key ‖ payout ‖ watcher )
/// ```
pub fn open_hash_solana(o: &OpenHashSolanaInput) -> [u8; 32] {
  sha256(&[
    &ds("open"),
    &o.swap,
    &o.t_lock.to_le_bytes(),
    &[o.direction, o.asset],
    &o.xmr.to_le_bytes(),
    &o.amount.to_le_bytes(),
    &o.deposit.to_le_bytes(),
    &o.taker_spend_pub,
    &o.locker_view,
    &o.taker_enc_key,
    &o.maker_enc_key,
    &o.payout,
    &o.watcher,
  ])
}

#[cfg(test)]
mod tests {
  use super::*;

  fn approval() -> SolApproval {
    SolApproval {
      cluster_tag: [1; 32],
      program_id: [2; 32],
      maker: [3; 32],
      taker: [4; 32],
      asset: 1,
      direction: ANY,
      max_xmr: 0x0102030405060708,
      not_before: 1_800_000_000,
      expires_at: 1_800_086_400,
      epoch: 7,
      approval_id: 0xdead_beef_0000_0001,
    }
  }

  #[test]
  fn approval_layout() {
    let a = approval();
    let m = encode_sol_approval(&a);
    assert_eq!(m.len(), 190);
    assert_eq!(&m[..24], b"xmrswap/v1/sol-approval\0");
    assert_eq!(m[24..56], [1; 32]);
    assert_eq!(m[56..88], [2; 32]);
    assert_eq!(m[88..120], [3; 32]);
    assert_eq!(m[120..152], [4; 32]);
    assert_eq!(m[152], 1);
    assert_eq!(m[153], 0xff);
    assert_eq!(m[154..162], [8, 7, 6, 5, 4, 3, 2, 1]);
    assert_eq!(m[162..170], 1_800_000_000i64.to_le_bytes());
    assert_eq!(m[170..178], 1_800_086_400i64.to_le_bytes());
    assert_eq!(m[178..182], [7, 0, 0, 0]);
    assert_eq!(m[182..190], 0xdead_beef_0000_0001u64.to_le_bytes());
    assert_eq!(decode_sol_approval(&m).unwrap(), a);
    assert!(decode_sol_approval(&m[..189]).is_err());
    let mut bad = m;
    bad[0] ^= 1;
    assert!(decode_sol_approval(&bad).is_err());
  }

  #[test]
  fn approval_validity_is_inclusive() {
    let a = approval();
    let ok = |now, asset, dir, xmr, epoch| sol_approval_admits(&a, now, asset, dir, xmr, epoch);
    assert!(!ok(a.not_before - 1, 1, 0, 1, 7));
    assert!(ok(a.not_before, 1, 0, 1, 7));
    assert!(ok(a.expires_at, 1, 1, 1, 7));
    assert!(!ok(a.expires_at + 1, 1, 0, 1, 7));
    assert!(!ok(a.not_before, 0, 0, 1, 7)); // wrong asset
    assert!(ok(a.not_before, 1, 0, a.max_xmr, 7));
    assert!(!ok(a.not_before, 1, 0, a.max_xmr + 1, 7));
    assert!(!ok(a.not_before, 1, 0, 1, 8)); // stale epoch
  }

  #[test]
  fn approval_is_bound_to_cluster_program_maker_and_taker() {
    // A signature over one approval says nothing about another: every binding field changes the
    // signed bytes.
    let a = approval();
    let base = encode_sol_approval(&a);
    let variants: [&dyn Fn(&mut SolApproval); 4] =
      [&|x| x.cluster_tag[0] ^= 1, &|x| x.program_id[0] ^= 1, &|x| x.maker[0] ^= 1, &|x| x.taker[0] ^= 1];
    let seed = [5u8; 32];
    let sig = crate::sign::ed25519_sign(&seed, &base);
    let public = crate::sign::ed25519_public(&seed);
    assert!(crate::sign::ed25519_verify(&public, &base, &sig));
    for f in variants {
      let mut b = a.clone();
      f(&mut b);
      let other = encode_sol_approval(&b);
      assert_ne!(other, base);
      assert!(!crate::sign::ed25519_verify(&public, &other, &sig));
    }
  }

  #[test]
  fn terms_hash_layout() {
    let t = OfferTermsHashInput {
      asset: 0,
      direction: 0,
      mode: 1,
      dep_bps: 100,
      fee_bps: 5,
      w_a: 60,
      w_n: 600,
      d_c: 6_060,
      w_c: 1_800,
      w_f: 604_800,
      depth_above: [0, 1_000_000_000_000, 50_000_000_000_000],
      depths: [2, 10, 25],
      w_z: 86_400,
    };
    let pre = terms_preimage(&t);
    assert_eq!(pre.len(), 58);
    assert_eq!(&pre[54..58], &86_400u32.to_le_bytes());
    assert_eq!(&pre[..7], &[0, 0, 1, 100, 0, 5, 0]);
    assert_eq!(&pre[7..11], &60u32.to_le_bytes());
    assert_eq!(&pre[23..27], &604_800u32.to_le_bytes());
    assert_eq!(&pre[27..35], &0u64.to_le_bytes());
    assert_eq!(pre[35], 2);
    assert_eq!(&pre[36..44], &1_000_000_000_000u64.to_le_bytes());
    assert_eq!(pre[44], 10);
    assert_eq!(pre[53], 25);
    assert_eq!(terms_hash(&t), sha256(&[b"xmrswap/v1/terms\0", &pre]));
    // Any term change changes the hash.
    let mut t2 = t.clone();
    t2.d_c += 1;
    assert_ne!(terms_hash(&t), terms_hash(&t2));
    let mut t3 = t.clone();
    t3.depths[2] = 24;
    assert_ne!(terms_hash(&t), terms_hash(&t3));
    // The freeze window is a term: an offer with one never hashes like the same offer without.
    let mut t4 = t.clone();
    t4.w_z = 0;
    assert_ne!(terms_hash(&t), terms_hash(&t4));
  }

  #[test]
  fn open_hash_binds_every_field() {
    let base = OpenHashSolanaInput {
      swap: [1; 32],
      t_lock: 1_800_000_000,
      direction: 0,
      asset: 1,
      xmr: 2_000_000_000_000,
      amount: 300_000_000,
      deposit: 3_000_000,
      taker_spend_pub: [2; 32],
      locker_view: [3; 32],
      taker_enc_key: [4; 32],
      maker_enc_key: [5; 32],
      payout: [6; 32],
      watcher: [7; 32],
    };
    let h = open_hash_solana(&base);
    // Layout: tag(16) ‖ 32 ‖ 8 ‖ 1 ‖ 1 ‖ 8 ‖ 8 ‖ 8 ‖ 32×6.
    let mut pre = b"xmrswap/v1/open\0".to_vec();
    pre.extend_from_slice(&[1; 32]);
    pre.extend_from_slice(&1_800_000_000i64.to_le_bytes());
    pre.extend_from_slice(&[0, 1]);
    pre.extend_from_slice(&2_000_000_000_000u64.to_le_bytes());
    pre.extend_from_slice(&300_000_000u64.to_le_bytes());
    pre.extend_from_slice(&3_000_000u64.to_le_bytes());
    for b in [2u8, 3, 4, 5, 6, 7] {
      pre.extend_from_slice(&[b; 32]);
    }
    assert_eq!(pre.len(), 16 + 32 + 8 + 2 + 24 + 192);
    assert_eq!(h, sha256(&[&pre]));
    let muts: [&dyn Fn(&mut OpenHashSolanaInput); 13] = [
      &|o| o.swap[0] ^= 1,
      &|o| o.t_lock += 1,
      &|o| o.direction = 1,
      &|o| o.asset = 0,
      &|o| o.xmr += 1,
      &|o| o.amount += 1,
      &|o| o.deposit += 1,
      &|o| o.taker_spend_pub[0] ^= 1,
      &|o| o.locker_view[0] ^= 1,
      &|o| o.taker_enc_key[0] ^= 1,
      &|o| o.maker_enc_key[0] ^= 1,
      &|o| o.payout[0] ^= 1,
      &|o| o.watcher[0] ^= 1,
    ];
    for f in muts {
      let mut o = base.clone();
      f(&mut o);
      assert_ne!(open_hash_solana(&o), h);
    }
  }
}
