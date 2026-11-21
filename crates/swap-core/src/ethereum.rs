//! Ethereum-side byte formats: the EIP-712 `Quote` and `Approval` (SPEC 2.10), the compact quote
//! for the Solana board, `swapId` (SPEC 5.3) and the open hash (SPEC 3.12).

use crate::{
  error::{Error, Result},
  primitives::{keccak256, sha256},
  sign::eip712_digest,
};

pub const EIP712_NAME: &str = "XmrAtomicSwap";
pub const EIP712_VERSION: &str = "1";
pub const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
pub const QUOTE_TYPE: &str = "Quote(address maker,address taker,address token,uint8 direction,uint8 approvalMode,uint64 minXmr,uint64 maxXmr,uint64[3] tierXmr,uint256[3] tierPrice,uint64[3] depthXmr,uint8[3] depth,uint16 depositBps,uint32 approvalWindow,uint32 noticeWindow,uint32 claimDelay,uint32 claimWindow,uint32 finalWindow,uint64 validUntil,uint32 epoch,bytes32 keyRoot,uint64 quoteId)";
pub const APPROVAL_TYPE: &str = "Approval(address maker,address taker,address token,uint8 direction,uint64 maxXmr,uint64 notBefore,uint64 validUntil,uint32 epoch,bytes32 approvalId)";

/// `token` wildcard in an `Approval`.
pub const ANY_TOKEN: [u8; 20] = [0xff; 20];
/// `direction` wildcard in an `Approval`.
pub const ANY_DIRECTION: u8 = 255;
/// Compact quote without the signature.
pub const COMPACT_QUOTE_LEN: usize = 251;
pub const ETH_SIG_LEN: usize = 65;
/// Compact quote followed by its 65-byte signature.
pub const COMPACT_QUOTE_SIGNED_LEN: usize = COMPACT_QUOTE_LEN + ETH_SIG_LEN;

/// EIP-712 domain: `name = "XmrAtomicSwap"`, `version = "1"`, and these two.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Eip712Domain {
  pub chain_id: u64,
  /// The proxy address.
  pub verifying_contract: [u8; 20],
}

/// The signed Ethereum quote. Prices are `uint256` on the wire; this crate carries them as
/// `u128`, which is what the compact board form holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EthQuote {
  pub maker: [u8; 20],
  /// Zero = public quote; otherwise bound to this taker.
  pub taker: [u8; 20],
  /// Zero = ETH.
  pub token: [u8; 20],
  /// 0 = A, 1 = B.
  pub direction: u8,
  /// 0 auto, 1 window, 2 advance approval required.
  pub approval_mode: u8,
  pub min_xmr: u64,
  pub max_xmr: u64,
  pub tier_xmr: [u64; 3],
  pub tier_price: [u128; 3],
  pub depth_xmr: [u64; 3],
  pub depth: [u8; 3],
  pub deposit_bps: u16,
  pub approval_window: u32,
  pub notice_window: u32,
  pub claim_delay: u32,
  pub claim_window: u32,
  pub final_window: u32,
  /// Valid while `block.timestamp <= validUntil`.
  pub valid_until: u64,
  pub epoch: u32,
  pub key_root: [u8; 32],
  pub quote_id: u64,
}

/// The signed Ethereum advance approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EthApproval {
  pub maker: [u8; 20],
  pub taker: [u8; 20],
  /// A token, or [`ANY_TOKEN`].
  pub token: [u8; 20],
  /// 0, 1, or 255 = any.
  pub direction: u8,
  pub max_xmr: u64,
  pub not_before: u64,
  pub valid_until: u64,
  pub epoch: u32,
  pub approval_id: [u8; 32],
}

fn word_u(v: u128) -> [u8; 32] {
  let mut w = [0u8; 32];
  w[16..].copy_from_slice(&v.to_be_bytes());
  w
}
fn word_addr(a: &[u8; 20]) -> [u8; 32] {
  let mut w = [0u8; 32];
  w[12..].copy_from_slice(a);
  w
}
/// EIP-712 encoding of a fixed-size array: `keccak256` of the concatenated 32-byte elements.
fn word_array(values: [u128; 3]) -> [u8; 32] {
  keccak256(&[&word_u(values[0]), &word_u(values[1]), &word_u(values[2])])
}

pub fn domain_separator(d: &Eip712Domain) -> [u8; 32] {
  keccak256(&[
    &keccak256(&[DOMAIN_TYPE.as_bytes()]),
    &keccak256(&[EIP712_NAME.as_bytes()]),
    &keccak256(&[EIP712_VERSION.as_bytes()]),
    &word_u(d.chain_id as u128),
    &word_addr(&d.verifying_contract),
  ])
}

pub fn quote_type_hash() -> [u8; 32] {
  keccak256(&[QUOTE_TYPE.as_bytes()])
}
pub fn approval_type_hash() -> [u8; 32] {
  keccak256(&[APPROVAL_TYPE.as_bytes()])
}

/// `hashStruct(Quote)`.
pub fn quote_struct_hash(q: &EthQuote) -> [u8; 32] {
  keccak256(&[
    &quote_type_hash(),
    &word_addr(&q.maker),
    &word_addr(&q.taker),
    &word_addr(&q.token),
    &word_u(q.direction as u128),
    &word_u(q.approval_mode as u128),
    &word_u(q.min_xmr as u128),
    &word_u(q.max_xmr as u128),
    &word_array(q.tier_xmr.map(|v| v as u128)),
    &word_array(q.tier_price),
    &word_array(q.depth_xmr.map(|v| v as u128)),
    &word_array(q.depth.map(|v| v as u128)),
    &word_u(q.deposit_bps as u128),
    &word_u(q.approval_window as u128),
    &word_u(q.notice_window as u128),
    &word_u(q.claim_delay as u128),
    &word_u(q.claim_window as u128),
    &word_u(q.final_window as u128),
    &word_u(q.valid_until as u128),
    &word_u(q.epoch as u128),
    &q.key_root,
    &word_u(q.quote_id as u128),
  ])
}

/// `hashStruct(Approval)`.
pub fn approval_struct_hash(a: &EthApproval) -> [u8; 32] {
  keccak256(&[
    &approval_type_hash(),
    &word_addr(&a.maker),
    &word_addr(&a.taker),
    &word_addr(&a.token),
    &word_u(a.direction as u128),
    &word_u(a.max_xmr as u128),
    &word_u(a.not_before as u128),
    &word_u(a.valid_until as u128),
    &word_u(a.epoch as u128),
    &a.approval_id,
  ])
}

/// `quoteDigest(domain, quote)`: what the operator signs and the contract's `hashQuote` returns.
pub fn quote_digest(d: &Eip712Domain, q: &EthQuote) -> [u8; 32] {
  eip712_digest(&domain_separator(d), &quote_struct_hash(q))
}

/// `approvalDigest(domain, approval)`.
pub fn approval_digest(d: &Eip712Domain, a: &EthApproval) -> [u8; 32] {
  eip712_digest(&domain_separator(d), &approval_struct_hash(a))
}

/// `encodeEthQuoteCompact(fields)`: the struct fields in order, little-endian, `address` as 20
/// bytes, prices as `u128`: 251 bytes. Dynamic fields: `tierPrice` at 102..150, `validUntil` at
/// 199..207, `quoteId` at 243..251.
pub fn encode_eth_quote_compact(q: &EthQuote) -> [u8; COMPACT_QUOTE_LEN] {
  let mut v = Vec::with_capacity(COMPACT_QUOTE_LEN);
  v.extend_from_slice(&q.maker);
  v.extend_from_slice(&q.taker);
  v.extend_from_slice(&q.token);
  v.push(q.direction);
  v.push(q.approval_mode);
  v.extend_from_slice(&q.min_xmr.to_le_bytes());
  v.extend_from_slice(&q.max_xmr.to_le_bytes());
  for x in q.tier_xmr {
    v.extend_from_slice(&x.to_le_bytes());
  }
  for x in q.tier_price {
    v.extend_from_slice(&x.to_le_bytes());
  }
  for x in q.depth_xmr {
    v.extend_from_slice(&x.to_le_bytes());
  }
  v.extend_from_slice(&q.depth);
  v.extend_from_slice(&q.deposit_bps.to_le_bytes());
  for x in [q.approval_window, q.notice_window, q.claim_delay, q.claim_window, q.final_window] {
    v.extend_from_slice(&x.to_le_bytes());
  }
  v.extend_from_slice(&q.valid_until.to_le_bytes());
  v.extend_from_slice(&q.epoch.to_le_bytes());
  v.extend_from_slice(&q.key_root);
  v.extend_from_slice(&q.quote_id.to_le_bytes());
  v.try_into().expect("251 bytes")
}

/// The compact form followed by the 65-byte signature, as stored in an `EthBoard` slot pair.
pub fn encode_eth_quote_compact_signed(q: &EthQuote, sig: &[u8; ETH_SIG_LEN]) -> [u8; COMPACT_QUOTE_SIGNED_LEN] {
  let mut out = [0u8; COMPACT_QUOTE_SIGNED_LEN];
  out[..COMPACT_QUOTE_LEN].copy_from_slice(&encode_eth_quote_compact(q));
  out[COMPACT_QUOTE_LEN..].copy_from_slice(sig);
  out
}

/// `decodeEthQuoteCompact(bytes)`: accepts 251 bytes (no signature) or 316 (with one).
pub fn decode_eth_quote_compact(b: &[u8]) -> Result<(EthQuote, Option<[u8; ETH_SIG_LEN]>)> {
  if b.len() != COMPACT_QUOTE_LEN && b.len() != COMPACT_QUOTE_SIGNED_LEN {
    return Err(Error::BadLength);
  }
  let mut o = 0usize;
  let mut take = |n: usize| {
    let s = &b[o..o + n];
    o += n;
    s
  };
  let a20 = |s: &[u8]| -> [u8; 20] { s.try_into().unwrap() };
  let u64le = |s: &[u8]| u64::from_le_bytes(s.try_into().unwrap());
  let u32le = |s: &[u8]| u32::from_le_bytes(s.try_into().unwrap());
  let maker = a20(take(20));
  let taker = a20(take(20));
  let token = a20(take(20));
  let direction = take(1)[0];
  let approval_mode = take(1)[0];
  let min_xmr = u64le(take(8));
  let max_xmr = u64le(take(8));
  let tier_xmr = [u64le(take(8)), u64le(take(8)), u64le(take(8))];
  let mut tier_price = [0u128; 3];
  for p in tier_price.iter_mut() {
    *p = u128::from_le_bytes(take(16).try_into().unwrap());
  }
  let depth_xmr = [u64le(take(8)), u64le(take(8)), u64le(take(8))];
  let depth: [u8; 3] = take(3).try_into().unwrap();
  let deposit_bps = u16::from_le_bytes(take(2).try_into().unwrap());
  let approval_window = u32le(take(4));
  let notice_window = u32le(take(4));
  let claim_delay = u32le(take(4));
  let claim_window = u32le(take(4));
  let final_window = u32le(take(4));
  let valid_until = u64le(take(8));
  let epoch = u32le(take(4));
  let key_root: [u8; 32] = take(32).try_into().unwrap();
  let quote_id = u64le(take(8));
  let sig = (b.len() == COMPACT_QUOTE_SIGNED_LEN).then(|| take(ETH_SIG_LEN).try_into().unwrap());
  Ok((
    EthQuote {
      maker,
      taker,
      token,
      direction,
      approval_mode,
      min_xmr,
      max_xmr,
      tier_xmr,
      tier_price,
      depth_xmr,
      depth,
      deposit_bps,
      approval_window,
      notice_window,
      claim_delay,
      claim_window,
      final_window,
      valid_until,
      epoch,
      key_root,
      quote_id,
    },
    sig,
  ))
}

/// `swapId = keccak256(abi.encode(taker, bytes16 swapNonce))`.
pub fn swap_id(taker: &[u8; 20], swap_nonce: &[u8; 16]) -> [u8; 32] {
  let mut nonce_word = [0u8; 32];
  nonce_word[..16].copy_from_slice(swap_nonce); // bytesN is right-padded
  keccak256(&[&word_addr(taker), &nonce_word])
}

/// What `approve`, `fund` and `reject` bind to on Ethereum (SPEC 3.12).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenHashEthereumInput {
  pub swap_id: [u8; 32],
  pub t_lock: u64,
  pub direction: u8,
  pub token: [u8; 20],
  pub xmr: u64,
  pub amount: u128,
  pub deposit: u128,
  pub taker_spend_pub: [u8; 32],
  pub taker_key: [u8; 20],
  pub taker_key2: [u8; 20],
  pub taker_view: [u8; 32],
  pub taker_enc_key: [u8; 32],
  pub maker_enc_key: [u8; 32],
  pub key_leaf: [u8; 32],
}

/// `openHashEthereum(fields)`:
///
/// ```text
/// sha256( abi.encodePacked( "xmrswap/v1/open", bytes1(0), swapId, uint64 tLock, uint8 direction, address token,
///         uint64 xmr, uint256 amount, uint256 deposit, bytes32 takerSpendPub, address takerKey, address takerKey2,
///         bytes32 takerView, bytes32 takerEncKey, bytes32 makerEncKey, bytes32 keyLeaf ) )
/// ```
pub fn open_hash_ethereum(o: &OpenHashEthereumInput) -> [u8; 32] {
  sha256(&[
    b"xmrswap/v1/open",
    &[0u8],
    &o.swap_id,
    &o.t_lock.to_be_bytes(),
    &[o.direction],
    &o.token,
    &o.xmr.to_be_bytes(),
    &word_u(o.amount),
    &word_u(o.deposit),
    &o.taker_spend_pub,
    &o.taker_key,
    &o.taker_key2,
    &o.taker_view,
    &o.taker_enc_key,
    &o.maker_enc_key,
    &o.key_leaf,
  ])
}

/// Whether a quote is live at `block.timestamp == now`: validity is inclusive.
pub fn quote_live(q: &EthQuote, now: u64) -> bool {
  now <= q.valid_until
}

/// Whether an approval admits a lock: `notBefore <= now <= validUntil`, wildcards honoured.
pub fn eth_approval_admits(a: &EthApproval, now: u64, taker: &[u8; 20], token: &[u8; 20], direction: u8, xmr: u64, epoch: u32) -> bool {
  a.not_before <= now
    && now <= a.valid_until
    && a.taker == *taker
    && (a.token == ANY_TOKEN || a.token == *token)
    && (a.direction == ANY_DIRECTION || a.direction == direction)
    && xmr <= a.max_xmr
    && a.epoch == epoch
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  pub(crate) fn sample_quote() -> EthQuote {
    EthQuote {
      maker: [0x11; 20],
      taker: [0; 20],
      token: [0; 20],
      direction: 0,
      approval_mode: 1,
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
      key_root: [0xab; 32],
      quote_id: 42,
    }
  }
  pub(crate) fn sample_domain() -> Eip712Domain {
    Eip712Domain { chain_id: 31_337, verifying_contract: [0xcc; 20] }
  }

  #[test]
  fn type_hashes() {
    // Independent values: `cast keccak "<type string>"`.
    assert_eq!(hex::encode(keccak256(&[DOMAIN_TYPE.as_bytes()])), "8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f");
    assert_eq!(hex::encode(quote_type_hash()), "bbaa88f19d79db179edb8c0e0e584639d3b44fd19bfe90f15bafc1b883ce2712");
    assert_eq!(hex::encode(approval_type_hash()), "6a011fedd9a048a0d601d9ffb67283b6b706782fc0291875b93d3521c799de3f");
  }

  #[test]
  fn domain_separator_known_answer() {
    // cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" <typehash> <keccak(name)> <keccak(version)> 31337 0xcccc…)
    assert_eq!(hex::encode(domain_separator(&sample_domain())), "67654bdffa5e09b5ee68cc5e3d52688a4be0eee38c41862f4867bae5872d5d68");
  }

  #[test]
  fn compact_layout_and_round_trip() {
    let q = sample_quote();
    let c = encode_eth_quote_compact(&q);
    assert_eq!(c.len(), 251);
    // Offsets frozen in SPEC 4.2 (EthBoard).
    assert_eq!(&c[..20], &[0x11; 20]);
    assert_eq!(c[60], 0);
    assert_eq!(c[61], 1);
    assert_eq!(&c[62..70], &100_000_000_000u64.to_le_bytes());
    assert_eq!(&c[102..118], &61_000_000_000_000_000u128.to_le_bytes());
    assert_eq!(&c[134..150], &60_000_000_000_000_000u128.to_le_bytes());
    assert_eq!(&c[174..177], &[2, 10, 25]);
    assert_eq!(&c[177..179], &100u16.to_le_bytes());
    assert_eq!(&c[199..207], &1_800_000_150u64.to_le_bytes());
    assert_eq!(&c[207..211], &3u32.to_le_bytes());
    assert_eq!(&c[211..243], &[0xab; 32]);
    assert_eq!(&c[243..251], &42u64.to_le_bytes());
    assert_eq!(decode_eth_quote_compact(&c).unwrap(), (q.clone(), None));
    let signed = encode_eth_quote_compact_signed(&q, &[7u8; 65]);
    assert_eq!(decode_eth_quote_compact(&signed).unwrap(), (q, Some([7u8; 65])));
    assert_eq!(decode_eth_quote_compact(&c[..250]), Err(Error::BadLength));
    assert_eq!(decode_eth_quote_compact(&signed[..300]), Err(Error::BadLength));
  }

  #[test]
  fn digest_changes_with_every_field_and_with_the_domain() {
    let d = sample_domain();
    let q = sample_quote();
    let base = quote_digest(&d, &q);
    let muts: [&dyn Fn(&mut EthQuote); 21] = [
      &|q| q.maker[0] ^= 1,
      &|q| q.taker[0] ^= 1,
      &|q| q.token[0] ^= 1,
      &|q| q.direction = 1,
      &|q| q.approval_mode = 0,
      &|q| q.min_xmr += 1,
      &|q| q.max_xmr += 1,
      &|q| q.tier_xmr[1] += 1,
      &|q| q.tier_price[2] += 1,
      &|q| q.depth_xmr[2] += 1,
      &|q| q.depth[0] = 3,
      &|q| q.deposit_bps += 1,
      &|q| q.approval_window += 1,
      &|q| q.notice_window += 1,
      &|q| q.claim_delay += 1,
      &|q| q.claim_window += 1,
      &|q| q.final_window += 1,
      &|q| q.valid_until += 1,
      &|q| q.epoch += 1,
      &|q| q.key_root[0] ^= 1,
      &|q| q.quote_id += 1,
    ];
    for f in muts {
      let mut m = q.clone();
      f(&mut m);
      assert_ne!(quote_digest(&d, &m), base);
    }
    // Replay across domains: another chain id or another contract gives another digest.
    assert_ne!(quote_digest(&Eip712Domain { chain_id: 1, ..d.clone() }, &q), base);
    assert_ne!(quote_digest(&Eip712Domain { verifying_contract: [0xcd; 20], ..d.clone() }, &q), base);
    // A signature for one domain does not recover the signer in another.
    let key = [0x42u8; 32];
    let signer = crate::sign::eth_address_of_secret(&key).unwrap();
    let sig = crate::sign::ecdsa_sign_digest(&key, &base).unwrap();
    assert_eq!(crate::sign::ecdsa_recover_address(&base, &sig).unwrap(), signer);
    let other = quote_digest(&Eip712Domain { chain_id: 1, ..d.clone() }, &q);
    assert_ne!(crate::sign::ecdsa_recover_address(&other, &sig).ok(), Some(signer));
    // A Quote digest is never an Approval digest for the same domain (type hashes differ).
    let a = EthApproval {
      maker: q.maker,
      taker: [0x22; 20],
      token: ANY_TOKEN,
      direction: ANY_DIRECTION,
      max_xmr: 5,
      not_before: 1,
      valid_until: 2,
      epoch: 3,
      approval_id: [9; 32],
    };
    assert_ne!(approval_digest(&d, &a), base);
  }

  #[test]
  fn validity_is_inclusive() {
    let q = sample_quote();
    assert!(quote_live(&q, q.valid_until));
    assert!(!quote_live(&q, q.valid_until + 1));
    let a = EthApproval {
      maker: [1; 20],
      taker: [2; 20],
      token: ANY_TOKEN,
      direction: 0,
      max_xmr: 10,
      not_before: 100,
      valid_until: 200,
      epoch: 1,
      approval_id: [0; 32],
    };
    let ok = |now, taker: [u8; 20], dir, xmr, epoch| eth_approval_admits(&a, now, &taker, &[9; 20], dir, xmr, epoch);
    assert!(!ok(99, [2; 20], 0, 10, 1));
    assert!(ok(100, [2; 20], 0, 10, 1));
    assert!(ok(200, [2; 20], 0, 10, 1));
    assert!(!ok(201, [2; 20], 0, 10, 1));
    assert!(!ok(150, [3; 20], 0, 10, 1));
    assert!(!ok(150, [2; 20], 1, 10, 1));
    assert!(!ok(150, [2; 20], 0, 11, 1));
    assert!(!ok(150, [2; 20], 0, 10, 2));
  }

  #[test]
  fn swap_id_and_open_hash() {
    // cast keccak $(cast abi-encode "f(address,bytes16)" 0x2222222222222222222222222222222222222222 0x000102030405060708090a0b0c0d0e0f)
    let nonce: [u8; 16] = core::array::from_fn(|i| i as u8);
    let id = swap_id(&[0x22; 20], &nonce);
    assert_eq!(hex::encode(id), "35bb89e41faf2c3a7756a17c7b772337d11c1d9b49eea8db9370e8e2458b30b5");
    let o = OpenHashEthereumInput {
      swap_id: id,
      t_lock: 1_800_000_000,
      direction: 0,
      token: [0; 20],
      xmr: 2_000_000_000_000,
      amount: 122_000_000_000_000_000,
      deposit: 1_220_000_000_000_000,
      taker_spend_pub: [1; 32],
      taker_key: [2; 20],
      taker_key2: [3; 20],
      taker_view: [4; 32],
      taker_enc_key: [5; 32],
      maker_enc_key: [6; 32],
      key_leaf: [7; 32],
    };
    let h = open_hash_ethereum(&o);
    // Packed length: 15 + 1 + 32 + 8 + 1 + 20 + 8 + 32 + 32 + 32 + 20 + 20 + 32×4.
    let mut pre = b"xmrswap/v1/open\0".to_vec();
    pre.extend_from_slice(&id);
    pre.extend_from_slice(&1_800_000_000u64.to_be_bytes());
    pre.push(0);
    pre.extend_from_slice(&[0; 20]);
    pre.extend_from_slice(&2_000_000_000_000u64.to_be_bytes());
    pre.extend_from_slice(&word_u(122_000_000_000_000_000));
    pre.extend_from_slice(&word_u(1_220_000_000_000_000));
    pre.extend_from_slice(&[1; 32]);
    pre.extend_from_slice(&[2; 20]);
    pre.extend_from_slice(&[3; 20]);
    for b in [4u8, 5, 6, 7] {
      pre.extend_from_slice(&[b; 32]);
    }
    assert_eq!(pre.len(), 16 + 32 + 8 + 1 + 20 + 8 + 64 + 32 + 40 + 128);
    assert_eq!(h, sha256(&[&pre]));
    let mut o2 = o.clone();
    o2.key_leaf[0] ^= 1;
    assert_ne!(open_hash_ethereum(&o2), h);
    let mut o3 = o.clone();
    o3.amount += 1;
    assert_ne!(open_hash_ethereum(&o3), h);
  }
}
