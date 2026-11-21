//! The wasm-bindgen surface behind `@xmrswap/core-wasm` (SPEC 2.12).
//!
//! Byte arguments are `Uint8Array`; `u64` and larger integers are `bigint`; structured arguments
//! and results are plain objects with camelCase keys. A failure throws an `Error` whose message
//! is the name of the [`crate::Error`] variant (for example `PokInvalid`).
//!
//! Built twice (`--target web` and `--target nodejs`). `sweepJoint` uses the global `fetch` in
//! both.

use core::future::Future;

use js_sys::{Array, BigInt, Object, Reflect, Uint8Array};
use monero_daemon_rpc::{HttpTransport, MoneroDaemon};
use monero_wallet::interface::InterfaceError;
use send_wrapper::SendWrapper;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::{
  address::{joint_address, Network},
  amounts::{self, Chain, EventTimes, Pending, SwapParams},
  dleq, envelope,
  envelope::{NoticeKeys, OpenArgs, SealArgs, Side},
  error::Error,
  ethereum::{self, Eip712Domain, EthApproval, EthQuote, OpenHashEthereumInput},
  keys, merkle, passphrase, point, pok,
  primitives::ChainTag,
  solana::{self, OfferTermsHashInput, OpenHashSolanaInput, SolApproval},
  sweep, twin,
};

type JsResult<T> = Result<T, JsError>;

fn err(e: Error) -> JsError {
  JsError::new(&e.to_string())
}
fn bad(field: &str) -> JsError {
  JsError::new(&format!("BadArgument: {field}"))
}
fn fixed<const N: usize>(b: &[u8], name: &str) -> JsResult<[u8; N]> {
  <[u8; N]>::try_from(b).map_err(|_| bad(&format!("{name} must be {N} bytes")))
}

// ---------------------------------------------------------------- object helpers

fn get(o: &JsValue, key: &str) -> JsValue {
  Reflect::get(o, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}
fn has(o: &JsValue, key: &str) -> bool {
  let v = get(o, key);
  !v.is_undefined() && !v.is_null()
}
fn get_bytes<const N: usize>(o: &JsValue, key: &str) -> JsResult<[u8; N]> {
  let v = get(o, key);
  if !v.is_instance_of::<Uint8Array>() {
    return Err(bad(&format!("{key} must be a Uint8Array")));
  }
  fixed(&Uint8Array::from(v).to_vec(), key)
}
fn get_vec(o: &JsValue, key: &str) -> JsResult<Vec<u8>> {
  let v = get(o, key);
  if !v.is_instance_of::<Uint8Array>() {
    return Err(bad(&format!("{key} must be a Uint8Array")));
  }
  Ok(Uint8Array::from(v).to_vec())
}
fn get_opt_bytes<const N: usize>(o: &JsValue, key: &str) -> JsResult<Option<[u8; N]>> {
  if has(o, key) {
    Ok(Some(get_bytes(o, key)?))
  } else {
    Ok(None)
  }
}
/// A non-negative integer given as a `bigint` or as a safe-integer `number`.
fn to_u128(v: &JsValue, key: &str) -> JsResult<u128> {
  if let Some(f) = v.as_f64() {
    if f >= 0.0 && f.fract() == 0.0 && f <= 9_007_199_254_740_991.0 {
      return Ok(f as u128);
    }
    return Err(bad(&format!("{key} must be a non-negative integer")));
  }
  if v.is_bigint() {
    let s: String = BigInt::from(v.clone()).to_string(10).map_err(|_| bad(key))?.into();
    return s.parse::<u128>().map_err(|_| bad(&format!("{key} is out of range")));
  }
  Err(bad(&format!("{key} must be a bigint or a number")))
}
fn to_i64(v: &JsValue, key: &str) -> JsResult<i64> {
  if let Some(f) = v.as_f64() {
    if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 {
      return Ok(f as i64);
    }
    return Err(bad(&format!("{key} must be an integer")));
  }
  if v.is_bigint() {
    let s: String = BigInt::from(v.clone()).to_string(10).map_err(|_| bad(key))?.into();
    return s.parse::<i64>().map_err(|_| bad(&format!("{key} is out of range")));
  }
  Err(bad(&format!("{key} must be a bigint or a number")))
}
fn get_u128(o: &JsValue, key: &str) -> JsResult<u128> {
  to_u128(&get(o, key), key)
}
fn get_u64(o: &JsValue, key: &str) -> JsResult<u64> {
  u64::try_from(get_u128(o, key)?).map_err(|_| bad(&format!("{key} is out of range")))
}
fn get_u32(o: &JsValue, key: &str) -> JsResult<u32> {
  u32::try_from(get_u128(o, key)?).map_err(|_| bad(&format!("{key} is out of range")))
}
fn get_u16(o: &JsValue, key: &str) -> JsResult<u16> {
  u16::try_from(get_u128(o, key)?).map_err(|_| bad(&format!("{key} is out of range")))
}
fn get_u8(o: &JsValue, key: &str) -> JsResult<u8> {
  u8::try_from(get_u128(o, key)?).map_err(|_| bad(&format!("{key} is out of range")))
}
fn get_i64(o: &JsValue, key: &str) -> JsResult<i64> {
  to_i64(&get(o, key), key)
}
fn get_opt_i64(o: &JsValue, key: &str) -> JsResult<Option<i64>> {
  if has(o, key) {
    Ok(Some(get_i64(o, key)?))
  } else {
    Ok(None)
  }
}
fn get_bool(o: &JsValue, key: &str) -> JsResult<bool> {
  get(o, key).as_bool().ok_or_else(|| bad(&format!("{key} must be a boolean")))
}
fn get_str(o: &JsValue, key: &str) -> JsResult<String> {
  get(o, key).as_string().ok_or_else(|| bad(&format!("{key} must be a string")))
}
fn get_array<T, const N: usize>(o: &JsValue, key: &str, f: impl Fn(&JsValue, &str) -> JsResult<T>) -> JsResult<[T; N]> {
  let v = get(o, key);
  if !Array::is_array(&v) {
    return Err(bad(&format!("{key} must be an array of {N}")));
  }
  let a = Array::from(&v);
  if a.length() as usize != N {
    return Err(bad(&format!("{key} must be an array of {N}")));
  }
  let mut out = Vec::with_capacity(N);
  for i in 0..N {
    out.push(f(&a.get(i as u32), key)?);
  }
  out.try_into().map_err(|_| bad(key))
}

fn big(v: u128) -> JsValue {
  BigInt::new(&JsValue::from_str(&v.to_string())).expect("decimal digits parse as a BigInt").into()
}
fn big_i(v: i64) -> JsValue {
  BigInt::new(&JsValue::from_str(&v.to_string())).expect("decimal digits parse as a BigInt").into()
}
fn bytes(b: &[u8]) -> JsValue {
  Uint8Array::from(b).into()
}
struct Obj(Object);
impl Obj {
  fn new() -> Self {
    Obj(Object::new())
  }
  fn set(self, key: &str, v: impl Into<JsValue>) -> Self {
    Reflect::set(&self.0, &JsValue::from_str(key), &v.into()).expect("setting a property on a plain object");
    self
  }
  fn done(self) -> JsValue {
    self.0.into()
  }
}

fn chain_of(name: &str) -> JsResult<Chain> {
  match name {
    "solana" => Ok(Chain::Solana),
    "ethereum" => Ok(Chain::Ethereum),
    _ => Err(bad("chain must be \"solana\" or \"ethereum\"")),
  }
}

// ---------------------------------------------------------------- 2.2 keys

#[wasm_bindgen(js_name = deriveKeys)]
pub fn derive_keys(seed: &[u8], chain_tag: u8, share_id: &[u8]) -> JsResult<JsValue> {
  let k = keys::derive_keys(&fixed(seed, "seed")?, ChainTag::from_u8(chain_tag).map_err(err)?, &fixed(share_id, "shareId")?)
    .map_err(err)?;
  Ok(
    Obj::new()
      .set("spend", bytes(&k.spend))
      .set("spendPub", bytes(&k.spend_pub))
      .set("view", bytes(&k.view))
      .set("sessionSecret", bytes(&k.session_secret))
      .set("sessionPub", bytes(&k.session_pub))
      .set("encSecret", bytes(&k.enc_secret))
      .set("encPub", bytes(&k.enc_pub))
      .done(),
  )
}

#[wasm_bindgen(js_name = contactShareId)]
pub fn contact_share_id(maker_pda: &[u8]) -> JsResult<Vec<u8>> {
  Ok(keys::contact_share_id(&fixed(maker_pda, "makerPda")?).to_vec())
}

// ---------------------------------------------------------------- 2.3, 2.4, 2.5

#[wasm_bindgen(js_name = validatePoint)]
pub fn validate_point(p: &[u8]) -> bool {
  <[u8; 32]>::try_from(p).map(|p| point::validate_point(&p)).unwrap_or(false)
}

#[wasm_bindgen(js_name = scalarMatches)]
pub fn scalar_matches(s: &[u8], commitment: &[u8]) -> bool {
  match (<[u8; 32]>::try_from(s), <[u8; 32]>::try_from(commitment)) {
    (Ok(s), Ok(c)) => point::scalar_matches(&s, &c),
    _ => false,
  }
}

#[wasm_bindgen(js_name = addScalars)]
pub fn add_scalars(a: &[u8], b: &[u8]) -> JsResult<Vec<u8>> {
  Ok(point::add_scalars(&fixed(a, "a")?, &fixed(b, "b")?).map_err(err)?.to_vec())
}

#[wasm_bindgen(js_name = pokProve)]
pub fn pok_prove(s: &[u8], ctx: &[u8]) -> JsResult<Vec<u8>> {
  Ok(pok::pok_prove(&fixed(s, "s")?, &fixed(ctx, "ctx")?).map_err(err)?.to_vec())
}

#[wasm_bindgen(js_name = pokVerify)]
pub fn pok_verify(spend_pub: &[u8], ctx: &[u8], proof: &[u8]) -> bool {
  match (<[u8; 32]>::try_from(spend_pub), <[u8; 32]>::try_from(ctx), <[u8; 64]>::try_from(proof)) {
    (Ok(s), Ok(c), Ok(p)) => pok::pok_verify(&s, &c, &p),
    _ => false,
  }
}

#[wasm_bindgen(js_name = jointAddress)]
pub fn joint_address_js(spend_pub_a: &[u8], spend_pub_b: &[u8], view_a: &[u8], view_b: &[u8], network: &str) -> JsResult<JsValue> {
  let j = joint_address(
    &fixed(spend_pub_a, "spendPubA")?,
    &fixed(spend_pub_b, "spendPubB")?,
    &fixed(view_a, "viewA")?,
    &fixed(view_b, "viewB")?,
    Network::parse(network).map_err(err)?,
  )
  .map_err(err)?;
  Ok(
    Obj::new()
      .set("address", j.address)
      .set("spendPub", bytes(&j.spend_pub))
      .set("viewPriv", bytes(&j.view_priv))
      .set("viewPub", bytes(&j.view_pub))
      .done(),
  )
}

// ---------------------------------------------------------------- 2.6

#[wasm_bindgen(js_name = twinCommitments)]
pub fn twin_commitments(s: &[u8]) -> JsResult<JsValue> {
  let t = twin::twin_commitments(&fixed(s, "s")?).map_err(err)?;
  Ok(
    Obj::new()
      .set("keyAddr", bytes(&t.key_addr))
      .set("keyAddr2", bytes(&t.key_addr2))
      .set("secpCompressed", bytes(&t.secp_compressed))
      .done(),
  )
}

#[wasm_bindgen(js_name = dleqProve)]
pub fn dleq_prove(s: &[u8]) -> JsResult<Vec<u8>> {
  dleq::dleq_prove(&fixed(s, "s")?).map_err(err)
}

#[wasm_bindgen(js_name = dleqVerify)]
pub fn dleq_verify(blob: &[u8]) -> JsResult<JsValue> {
  let st = dleq::dleq_verify(blob).map_err(err)?;
  Ok(
    Obj::new()
      .set("spendPub", bytes(&st.spend_pub))
      .set("keyAddr", bytes(&st.key_addr))
      .set("keyAddr2", bytes(&st.key_addr2))
      .set("secpCompressed", bytes(&st.secp_compressed))
      .done(),
  )
}

// ---------------------------------------------------------------- 2.7

fn leaves_of(leaves: &Array) -> JsResult<Vec<[u8; 32]>> {
  let mut out = Vec::with_capacity(leaves.length() as usize);
  for v in leaves.iter() {
    if !v.is_instance_of::<Uint8Array>() {
      return Err(bad("leaves must be an array of Uint8Array(32)"));
    }
    out.push(fixed(&Uint8Array::from(v).to_vec(), "leaf")?);
  }
  Ok(out)
}

#[wasm_bindgen(js_name = keyLeaf)]
pub fn key_leaf(index: u32, key_addr: &[u8], key_addr2: &[u8], spend_pub: &[u8]) -> JsResult<Vec<u8>> {
  Ok(merkle::key_leaf(index, &fixed(key_addr, "keyAddr")?, &fixed(key_addr2, "keyAddr2")?, &fixed(spend_pub, "spendPub")?).to_vec())
}

#[wasm_bindgen(js_name = merkleRoot)]
pub fn merkle_root(leaves: Array) -> JsResult<Vec<u8>> {
  Ok(merkle::merkle_root(&leaves_of(&leaves)?).map_err(err)?.to_vec())
}

#[wasm_bindgen(js_name = merkleProof)]
pub fn merkle_proof(leaves: Array, index: u32) -> JsResult<Array> {
  let proof = merkle::merkle_proof(&leaves_of(&leaves)?, index as usize).map_err(err)?;
  Ok(proof.iter().map(|h| bytes(h)).collect())
}

// ---------------------------------------------------------------- 2.8

#[wasm_bindgen(js_name = x25519Public)]
pub fn x25519_public(secret: &[u8]) -> JsResult<Vec<u8>> {
  Ok(envelope::x25519_public(&fixed(secret, "secret")?).to_vec())
}

#[wasm_bindgen(js_name = isLowOrderX25519)]
pub fn is_low_order_x25519(public: &[u8]) -> JsResult<bool> {
  Ok(envelope::is_low_order_x25519(&fixed(public, "pub")?))
}

fn random_nonce() -> JsResult<[u8; 24]> {
  let mut n = [0u8; 24];
  getrandom::getrandom(&mut n).map_err(|_| JsError::new("RandomnessUnavailable"))?;
  Ok(n)
}

/// `{ fromMaker, makerKeyVersion, ownSecret, peerPub, swapRef?, plaintext, nonce?, maxLen? }`
#[wasm_bindgen(js_name = envelopeSeal)]
pub fn envelope_seal(args: JsValue) -> JsResult<Vec<u8>> {
  let own_secret: [u8; 32] = get_bytes(&args, "ownSecret")?;
  let peer_pub: [u8; 32] = get_bytes(&args, "peerPub")?;
  let swap_ref: [u8; 32] = get_opt_bytes(&args, "swapRef")?.unwrap_or([0u8; 32]);
  let plaintext = get_vec(&args, "plaintext")?;
  let nonce = match get_opt_bytes::<24>(&args, "nonce")? {
    Some(n) => n,
    None => random_nonce()?,
  };
  let max_len = if has(&args, "maxLen") { get_u32(&args, "maxLen")? as usize } else { envelope::ENVELOPE_MAX_TOR };
  envelope::envelope_seal(&SealArgs {
    from_maker: get_bool(&args, "fromMaker")?,
    maker_key_version: get_u32(&args, "makerKeyVersion")?,
    own_secret: &own_secret,
    peer_pub: &peer_pub,
    swap_ref: &swap_ref,
    plaintext: &plaintext,
    nonce,
    max_len,
  })
  .map_err(err)
}

fn header_obj(h: &envelope::EnvelopeHeader) -> JsValue {
  Obj::new()
    .set("version", h.version)
    .set("flags", h.flags)
    .set("fromMaker", h.from_maker())
    .set("makerKeyVersion", h.maker_key_version)
    .set("takerPub", bytes(&h.taker_pub))
    .set("swapRef", bytes(&h.swap_ref))
    .done()
}

/// `{ envelope, ownSecret, makerPub?, operatorPub? }` → `{ plaintext, header }`
#[wasm_bindgen(js_name = envelopeOpen)]
pub fn envelope_open(args: JsValue) -> JsResult<JsValue> {
  let env = get_vec(&args, "envelope")?;
  let own_secret: [u8; 32] = get_bytes(&args, "ownSecret")?;
  let maker_pub = get_opt_bytes::<32>(&args, "makerPub")?;
  let operator_pub = get_opt_bytes::<32>(&args, "operatorPub")?;
  let (plaintext, header) = envelope::envelope_open(&OpenArgs {
    envelope: &env,
    own_secret: &own_secret,
    maker_pub: maker_pub.as_ref(),
    operator_pub: operator_pub.as_ref(),
  })
  .map_err(err)?;
  Ok(Obj::new().set("plaintext", bytes(&plaintext)).set("header", header_obj(&header)).done())
}

/// Parse bytes 0..72 without decrypting.
#[wasm_bindgen(js_name = envelopeHeader)]
pub fn envelope_header(envelope: &[u8]) -> JsResult<JsValue> {
  Ok(header_obj(&envelope::envelope_header(envelope).map_err(err)?))
}

#[wasm_bindgen(js_name = envelopeSign)]
pub fn envelope_sign(envelope: &[u8], operator_seed: &[u8]) -> JsResult<Vec<u8>> {
  envelope::envelope_sign(envelope, &fixed(operator_seed, "operatorSeed")?).map_err(err)
}

#[wasm_bindgen(js_name = envelopeVerifySig)]
pub fn envelope_verify_sig(envelope: &[u8], operator_pub: &[u8]) -> bool {
  <[u8; 32]>::try_from(operator_pub).map(|k| envelope::envelope_verify_sig(envelope, &k)).unwrap_or(false)
}

#[wasm_bindgen(js_name = noticeCommitment)]
pub fn notice_commitment(swap_ref: &[u8], txid: &[u8], view: &[u8]) -> JsResult<Vec<u8>> {
  Ok(envelope::notice_commitment(&fixed(swap_ref, "swapRef")?, &fixed(txid, "txid")?, &fixed(view, "view")?).to_vec())
}

fn side_of(args: &JsValue) -> JsResult<Side> {
  match get_str(args, "side")?.as_str() {
    "taker" => Ok(Side::Taker),
    "maker" => Ok(Side::Maker),
    _ => Err(bad("side must be \"taker\" or \"maker\"")),
  }
}

/// `{ ownSecret, peerPub, side, swapRef, txid, view, nonce? }` → `Uint8Array(104)`
#[wasm_bindgen(js_name = noticeSeal)]
pub fn notice_seal(args: JsValue) -> JsResult<Vec<u8>> {
  let own_secret: [u8; 32] = get_bytes(&args, "ownSecret")?;
  let peer_pub: [u8; 32] = get_bytes(&args, "peerPub")?;
  let swap_ref: [u8; 32] = get_bytes(&args, "swapRef")?;
  let nonce = match get_opt_bytes::<24>(&args, "nonce")? {
    Some(n) => n,
    None => random_nonce()?,
  };
  let k = NoticeKeys { own_secret: &own_secret, peer_pub: &peer_pub, side: side_of(&args)?, swap_ref: &swap_ref };
  Ok(envelope::notice_seal(&k, &get_bytes(&args, "txid")?, &get_bytes(&args, "view")?, nonce).map_err(err)?.to_vec())
}

/// `{ ownSecret, peerPub, side, swapRef, ciphertext, commitment }` → `{ txid, view }`
#[wasm_bindgen(js_name = noticeOpen)]
pub fn notice_open(args: JsValue) -> JsResult<JsValue> {
  let own_secret: [u8; 32] = get_bytes(&args, "ownSecret")?;
  let peer_pub: [u8; 32] = get_bytes(&args, "peerPub")?;
  let swap_ref: [u8; 32] = get_bytes(&args, "swapRef")?;
  let k = NoticeKeys { own_secret: &own_secret, peer_pub: &peer_pub, side: side_of(&args)?, swap_ref: &swap_ref };
  let (txid, view) =
    envelope::notice_open(&k, &get_vec(&args, "ciphertext")?, &get_bytes(&args, "commitment")?).map_err(err)?;
  Ok(Obj::new().set("txid", bytes(&txid)).set("view", bytes(&view)).done())
}

// ---------------------------------------------------------------- 2.9, 4.2, 3.12

#[wasm_bindgen(js_name = encodeSolApproval)]
pub fn encode_sol_approval(f: JsValue) -> JsResult<Vec<u8>> {
  Ok(
    solana::encode_sol_approval(&SolApproval {
      cluster_tag: get_bytes(&f, "clusterTag")?,
      program_id: get_bytes(&f, "programId")?,
      maker: get_bytes(&f, "maker")?,
      taker: get_bytes(&f, "taker")?,
      asset: get_u8(&f, "asset")?,
      direction: get_u8(&f, "direction")?,
      max_xmr: get_u64(&f, "maxXmr")?,
      not_before: get_i64(&f, "notBefore")?,
      expires_at: get_i64(&f, "expiresAt")?,
      epoch: get_u32(&f, "epoch")?,
      approval_id: get_u64(&f, "approvalId")?,
    })
    .to_vec(),
  )
}

#[wasm_bindgen(js_name = termsHash)]
pub fn terms_hash(f: JsValue) -> JsResult<Vec<u8>> {
  Ok(
    solana::terms_hash(&OfferTermsHashInput {
      asset: get_u8(&f, "asset")?,
      direction: get_u8(&f, "direction")?,
      mode: get_u8(&f, "mode")?,
      dep_bps: get_u16(&f, "depBps")?,
      fee_bps: if has(&f, "feeBps") { get_u16(&f, "feeBps")? } else { amounts::SOLANA.fee_bps },
      w_a: get_u32(&f, "wA")?,
      w_n: get_u32(&f, "wN")?,
      d_c: get_u32(&f, "dC")?,
      w_c: get_u32(&f, "wC")?,
      w_f: get_u32(&f, "wF")?,
      depth_above: get_array(&f, "depthAbove", |v, k| u64::try_from(to_u128(v, k)?).map_err(|_| bad(k)))?,
      depths: get_array(&f, "depths", |v, k| u8::try_from(to_u128(v, k)?).map_err(|_| bad(k)))?,
    })
    .to_vec(),
  )
}

#[wasm_bindgen(js_name = openHashSolana)]
pub fn open_hash_solana(f: JsValue) -> JsResult<Vec<u8>> {
  Ok(
    solana::open_hash_solana(&OpenHashSolanaInput {
      swap: get_bytes(&f, "swap")?,
      t_lock: get_i64(&f, "tLock")?,
      direction: get_u8(&f, "direction")?,
      asset: get_u8(&f, "asset")?,
      xmr: get_u64(&f, "xmr")?,
      amount: get_u64(&f, "amount")?,
      deposit: get_u64(&f, "deposit")?,
      taker_spend_pub: get_bytes(&f, "takerSpendPub")?,
      locker_view: get_bytes(&f, "lockerView")?,
      taker_enc_key: get_bytes(&f, "takerEncKey")?,
      maker_enc_key: get_bytes(&f, "makerEncKey")?,
    })
    .to_vec(),
  )
}

#[wasm_bindgen(js_name = openHashEthereum)]
pub fn open_hash_ethereum(f: JsValue) -> JsResult<Vec<u8>> {
  Ok(
    ethereum::open_hash_ethereum(&OpenHashEthereumInput {
      swap_id: get_bytes(&f, "swapId")?,
      t_lock: get_u64(&f, "tLock")?,
      direction: get_u8(&f, "direction")?,
      token: get_bytes(&f, "token")?,
      xmr: get_u64(&f, "xmr")?,
      amount: get_u128(&f, "amount")?,
      deposit: get_u128(&f, "deposit")?,
      taker_spend_pub: get_bytes(&f, "takerSpendPub")?,
      taker_key: get_bytes(&f, "takerKey")?,
      taker_key2: get_bytes(&f, "takerKey2")?,
      taker_view: get_bytes(&f, "takerView")?,
      taker_enc_key: get_bytes(&f, "takerEncKey")?,
      maker_enc_key: get_bytes(&f, "makerEncKey")?,
      key_leaf: get_bytes(&f, "keyLeaf")?,
    })
    .to_vec(),
  )
}

/// `swapId = keccak256(abi.encode(taker, bytes16 swapNonce))` (SPEC 5.3).
#[wasm_bindgen(js_name = ethSwapId)]
pub fn eth_swap_id(taker: &[u8], swap_nonce: &[u8]) -> JsResult<Vec<u8>> {
  Ok(ethereum::swap_id(&fixed(taker, "taker")?, &fixed(swap_nonce, "swapNonce")?).to_vec())
}

// ---------------------------------------------------------------- 2.10

fn quote_of(q: &JsValue) -> JsResult<EthQuote> {
  let u64s = |v: &JsValue, k: &str| u64::try_from(to_u128(v, k)?).map_err(|_| bad(k));
  Ok(EthQuote {
    maker: get_bytes(q, "maker")?,
    taker: get_bytes(q, "taker")?,
    token: get_bytes(q, "token")?,
    direction: get_u8(q, "direction")?,
    approval_mode: get_u8(q, "approvalMode")?,
    min_xmr: get_u64(q, "minXmr")?,
    max_xmr: get_u64(q, "maxXmr")?,
    tier_xmr: get_array(q, "tierXmr", u64s)?,
    tier_price: get_array(q, "tierPrice", |v, k| to_u128(v, k).map_err(|_| err(Error::FieldOutOfRange)))?,
    depth_xmr: get_array(q, "depthXmr", u64s)?,
    depth: get_array(q, "depth", |v, k| u8::try_from(to_u128(v, k)?).map_err(|_| bad(k)))?,
    deposit_bps: get_u16(q, "depositBps")?,
    approval_window: get_u32(q, "approvalWindow")?,
    notice_window: get_u32(q, "noticeWindow")?,
    claim_delay: get_u32(q, "claimDelay")?,
    claim_window: get_u32(q, "claimWindow")?,
    final_window: get_u32(q, "finalWindow")?,
    valid_until: get_u64(q, "validUntil")?,
    epoch: get_u32(q, "epoch")?,
    key_root: get_bytes(q, "keyRoot")?,
    quote_id: get_u64(q, "quoteId")?,
  })
}
fn quote_obj(q: &EthQuote) -> JsValue {
  let arr = |vals: [JsValue; 3]| -> JsValue { vals.into_iter().collect::<Array>().into() };
  Obj::new()
    .set("maker", bytes(&q.maker))
    .set("taker", bytes(&q.taker))
    .set("token", bytes(&q.token))
    .set("direction", q.direction)
    .set("approvalMode", q.approval_mode)
    .set("minXmr", big(q.min_xmr as u128))
    .set("maxXmr", big(q.max_xmr as u128))
    .set("tierXmr", arr(q.tier_xmr.map(|v| big(v as u128))))
    .set("tierPrice", arr(q.tier_price.map(big)))
    .set("depthXmr", arr(q.depth_xmr.map(|v| big(v as u128))))
    .set("depth", arr(q.depth.map(|v| JsValue::from(v))))
    .set("depositBps", q.deposit_bps)
    .set("approvalWindow", q.approval_window)
    .set("noticeWindow", q.notice_window)
    .set("claimDelay", q.claim_delay)
    .set("claimWindow", q.claim_window)
    .set("finalWindow", q.final_window)
    .set("validUntil", big(q.valid_until as u128))
    .set("epoch", q.epoch)
    .set("keyRoot", bytes(&q.key_root))
    .set("quoteId", big(q.quote_id as u128))
    .done()
}
fn domain_of(d: &JsValue) -> JsResult<Eip712Domain> {
  Ok(Eip712Domain { chain_id: get_u64(d, "chainId")?, verifying_contract: get_bytes(d, "verifyingContract")? })
}

/// `encodeEthQuoteCompact(quote, sig?)` → 251 bytes, or 316 with the signature.
#[wasm_bindgen(js_name = encodeEthQuoteCompact)]
pub fn encode_eth_quote_compact(quote: JsValue, sig: Option<Vec<u8>>) -> JsResult<Vec<u8>> {
  let q = quote_of(&quote)?;
  match sig {
    Some(s) => Ok(ethereum::encode_eth_quote_compact_signed(&q, &fixed(&s, "sig")?).to_vec()),
    None => Ok(ethereum::encode_eth_quote_compact(&q).to_vec()),
  }
}

/// → `{ quote, sig? }`
#[wasm_bindgen(js_name = decodeEthQuoteCompact)]
pub fn decode_eth_quote_compact(b: &[u8]) -> JsResult<JsValue> {
  let (q, sig) = ethereum::decode_eth_quote_compact(b).map_err(err)?;
  let o = Obj::new().set("quote", quote_obj(&q));
  Ok(match sig {
    Some(s) => o.set("sig", bytes(&s)),
    None => o,
  }
  .done())
}

#[wasm_bindgen(js_name = quoteDigest)]
pub fn quote_digest(domain: JsValue, quote: JsValue) -> JsResult<Vec<u8>> {
  Ok(ethereum::quote_digest(&domain_of(&domain)?, &quote_of(&quote)?).to_vec())
}

#[wasm_bindgen(js_name = approvalDigest)]
pub fn approval_digest(domain: JsValue, a: JsValue) -> JsResult<Vec<u8>> {
  Ok(
    ethereum::approval_digest(
      &domain_of(&domain)?,
      &EthApproval {
        maker: get_bytes(&a, "maker")?,
        taker: get_bytes(&a, "taker")?,
        token: get_bytes(&a, "token")?,
        direction: get_u8(&a, "direction")?,
        max_xmr: get_u64(&a, "maxXmr")?,
        not_before: get_u64(&a, "notBefore")?,
        valid_until: get_u64(&a, "validUntil")?,
        epoch: get_u32(&a, "epoch")?,
        approval_id: get_bytes(&a, "approvalId")?,
      },
    )
    .to_vec(),
  )
}

// ---------------------------------------------------------------- 3 arithmetic

fn consts_of(chain: Option<String>) -> JsResult<amounts::ChainConsts> {
  match chain {
    Some(name) => Ok(*chain_of(&name)?.consts()),
    // No chain named: only the 128-bit limit applies.
    None => Ok(amounts::ETHEREUM),
  }
}

/// Direction A: `ceil(xmr × price / 10^12)`. With `chain`, also enforces that chain's amount type.
#[wasm_bindgen(js_name = payAmount)]
pub fn pay_amount(xmr: JsValue, price: JsValue, chain: Option<String>) -> JsResult<JsValue> {
  let xmr = u64::try_from(to_u128(&xmr, "xmr")?).map_err(|_| bad("xmr is out of range"))?;
  Ok(big(amounts::pay_amount(xmr, to_u128(&price, "price")?, &consts_of(chain)?).map_err(err)?))
}

/// Direction B: `floor(xmr × price / 10^12)`.
#[wasm_bindgen(js_name = receiveAmount)]
pub fn receive_amount(xmr: JsValue, price: JsValue, chain: Option<String>) -> JsResult<JsValue> {
  let xmr = u64::try_from(to_u128(&xmr, "xmr")?).map_err(|_| bad("xmr is out of range"))?;
  Ok(big(amounts::receive_amount(xmr, to_u128(&price, "price")?, &consts_of(chain)?).map_err(err)?))
}

#[wasm_bindgen(js_name = depositOf)]
pub fn deposit_of(amount: JsValue, bps: u16) -> JsResult<JsValue> {
  Ok(big(amounts::deposit_of(to_u128(&amount, "amount")?, bps)))
}

#[wasm_bindgen(js_name = feeOf)]
pub fn fee_of(amount: JsValue, bps: u16) -> JsResult<JsValue> {
  Ok(big(amounts::fee_of(to_u128(&amount, "amount")?, bps)))
}

/// `{ toTaker, toTreasury }` of a 60-day split.
#[wasm_bindgen(js_name = splitOf)]
pub fn split_of(deposit: JsValue) -> JsResult<JsValue> {
  let (taker, treasury) = amounts::split_of(to_u128(&deposit, "deposit")?);
  Ok(Obj::new().set("toTaker", big(taker)).set("toTreasury", big(treasury)).done())
}

/// `deadlines({ chain, pending, wA, wN, dC, wC, wF, depth, depBps, tLock, tActive?, tNotice?, tReady?, tRefund? })`
///
/// Returns the bound check for a swap that starts in `pending` (`"none"`, `"approval"` or
/// `"funding"`), the derived minima, and every deadline the given event times determine.
#[wasm_bindgen(js_name = deadlines)]
pub fn deadlines(p: JsValue) -> JsResult<JsValue> {
  let chain = chain_of(&get_str(&p, "chain")?)?;
  let c = chain.consts();
  let pending = match get_str(&p, "pending")?.as_str() {
    "none" => Pending::None,
    "approval" => Pending::ApprovalWindow,
    "funding" => Pending::FundingWindow,
    _ => return Err(bad("pending must be \"none\", \"approval\" or \"funding\"")),
  };
  let params = SwapParams {
    w_a: get_u32(&p, "wA")?,
    w_n: get_u32(&p, "wN")?,
    d_c: get_u32(&p, "dC")?,
    w_c: get_u32(&p, "wC")?,
    w_f: get_u32(&p, "wF")?,
    depth: get_u8(&p, "depth")?,
    dep_bps: get_u16(&p, "depBps")?,
  };
  let times = EventTimes {
    t_lock: get_i64(&p, "tLock")?,
    t_active: get_opt_i64(&p, "tActive")?,
    t_notice: get_opt_i64(&p, "tNotice")?,
    t_ready: get_opt_i64(&p, "tReady")?,
    t_refund: get_opt_i64(&p, "tRefund")?,
  };
  let d = amounts::deadlines(&params, pending, &times, c);
  let opt = |v: Option<i64>| v.map(big_i).unwrap_or(JsValue::NULL);
  let bound_error = match amounts::check_bounds(&params, pending, c) {
    Ok(()) => JsValue::NULL,
    Err(e) => JsValue::from_str(crate::model::ModelError::Bound(e).name()),
  };
  Ok(
    Obj::new()
      .set("boundError", bound_error)
      .set("wP", amounts::pending_window(&params, pending))
      .set("deltaCut", big_i(amounts::delta_cut(params.depth, c)))
      .set("minClaimDelay", big_i(amounts::min_claim_delay(params.depth, c)))
      .set("minClaimWindow", big_i(amounts::min_claim_window(c)))
      .set("minFinalWindow", big_i(amounts::min_final_window(&params, amounts::pending_window(&params, pending))))
      .set("tPend", opt(d.t_pend))
      .set("tNote", opt(d.t_note))
      .set("tCut", opt(d.t_cut))
      .set("tCo", opt(d.t_co))
      .set("tReadyMin", opt(d.t_ready_min))
      .set("tCd", opt(d.t_cd))
      .set("tFinal", big_i(d.t_final))
      .set("tNl", big_i(d.t_nl))
      .set("tExp", big_i(d.t_exp))
      .set("tHold", opt(d.t_hold))
      .set("tSplit", opt(d.t_split))
      .done(),
  )
}

// ---------------------------------------------------------------- passphrase

#[wasm_bindgen(js_name = passphraseSeal)]
pub fn passphrase_seal(passphrase: &[u8], plaintext: &[u8]) -> JsResult<Vec<u8>> {
  let mut salt = [0u8; passphrase::PASSPHRASE_SALT_LEN];
  let mut nonce = [0u8; passphrase::PASSPHRASE_NONCE_LEN];
  getrandom::getrandom(&mut salt).map_err(|_| JsError::new("RandomnessUnavailable"))?;
  getrandom::getrandom(&mut nonce).map_err(|_| JsError::new("RandomnessUnavailable"))?;
  Ok(passphrase::passphrase_seal_with(passphrase, plaintext, &salt, &nonce))
}

#[wasm_bindgen(js_name = passphraseOpen)]
pub fn passphrase_open(passphrase: &[u8], sealed: &[u8]) -> JsResult<Vec<u8>> {
  passphrase::passphrase_open(passphrase, sealed).map_err(err)
}

// ---------------------------------------------------------------- 2.11 sweep

#[wasm_bindgen]
extern "C" {
  /// The global `fetch`, present in browsers, workers and Node 18+.
  #[wasm_bindgen(js_name = fetch)]
  fn global_fetch(url: &str, init: &JsValue) -> js_sys::Promise;
}

#[derive(Clone)]
struct FetchTransport {
  base: String,
}

async fn fetch_post(url: String, body: Vec<u8>, limit: Option<usize>) -> Result<Vec<u8>, String> {
  let js = |e: JsValue| format!("{e:?}");
  // No Content-Type header: monerod does not need one, and without it the POST is a CORS
  // "simple request" (no preflight round trip).
  let init = Obj::new().set("method", "POST").set("mode", "cors").set("body", bytes(&body)).done();
  let resp = JsFuture::from(global_fetch(&url, &init)).await.map_err(js)?;
  if !get(&resp, "ok").as_bool().unwrap_or(false) {
    return Err(format!("HTTP {} from {url}", get(&resp, "status").as_f64().unwrap_or(0.0)));
  }
  let array_buffer: js_sys::Function = get(&resp, "arrayBuffer").dyn_into().map_err(js)?;
  let promise: js_sys::Promise = array_buffer.call0(&resp).map_err(js)?.dyn_into().map_err(js)?;
  let buf = JsFuture::from(promise).await.map_err(js)?;
  let out = Uint8Array::new(&buf).to_vec();
  if limit.is_some_and(|l| out.len() > l) {
    return Err("response exceeded size limit".into());
  }
  Ok(out)
}

impl HttpTransport for FetchTransport {
  fn post(&self, route: &str, body: Vec<u8>, limit: Option<usize>) -> impl Send + Future<Output = Result<Vec<u8>, InterfaceError>> {
    let url = format!("{}/{}", self.base.trim_end_matches('/'), route.trim_start_matches('/'));
    // JS promises are not Send. wasm32 in a tab, a worker or Node is single-threaded, so
    // SendWrapper (which panics only if polled from another thread) is sound here. Do not move
    // this to a threaded wasm build unchanged.
    SendWrapper::new(async move { fetch_post(url, body, limit).await.map_err(InterfaceError::InterfaceError) })
  }
}

/// `sweepJoint({ daemonUrl, network, spendKey, viewKey, lockHeight, lockTxid, outputIndex, destination, maxFee, publish })`
/// → `Promise<{ jointAddress, txid, amount, fee, txHex, published, ignored: [{ output, amount }] }>`
#[wasm_bindgen(js_name = sweepJoint)]
pub async fn sweep_joint(params: JsValue) -> JsResult<JsValue> {
  let fail = |e: sweep::SweepError| JsError::new(&format!("Sweep{}: {e}", variant(&e)));
  let p = sweep::SweepParams {
    spend_key: get_bytes(&params, "spendKey")?,
    view_key: get_bytes(&params, "viewKey")?,
    lock_height: get_u32(&params, "lockHeight")? as usize,
    lock_txid: get_bytes(&params, "lockTxid")?,
    output_index: get_u64(&params, "outputIndex")?,
    destination: get_str(&params, "destination")?,
    network: Network::parse(&get_str(&params, "network")?).map_err(err)?,
    max_fee: get_u64(&params, "maxFee")?,
    publish: get_bool(&params, "publish")?,
  };
  let daemon = MoneroDaemon::new(FetchTransport { base: get_str(&params, "daemonUrl")? })
    .await
    .map_err(|e| JsError::new(&format!("SweepDaemon: connect: {e:?}")))?;
  let o = sweep::sweep_joint(&daemon, p).await.map_err(fail)?;
  let ignored: Array = o
    .ignored
    .iter()
    .map(|(id, amount)| Obj::new().set("output", id.as_str()).set("amount", big(*amount as u128)).done())
    .collect();
  Ok(
    Obj::new()
      .set("jointAddress", o.joint_address)
      .set("txid", o.txid)
      .set("amount", big(o.amount as u128))
      .set("fee", big(o.fee as u128))
      .set("txHex", o.tx_hex)
      .set("published", o.published)
      .set("ignored", ignored)
      .done(),
  )
}

fn variant(e: &sweep::SweepError) -> &'static str {
  use sweep::SweepError::*;
  match e {
    InvalidKey(_) => "InvalidKey",
    InvalidDestination(_) => "InvalidDestination",
    Daemon(_) => "Daemon",
    Locked { .. } => "Locked",
    OutputNotFound => "OutputNotFound",
    DuplicateOutputKey => "DuplicateOutputKey",
    FeeAboveCap { .. } => "FeeAboveCap",
    AmountBelowFee { .. } => "AmountBelowFee",
    Build(_) => "Build",
    Sign(_) => "Sign",
    Publish(_) => "Publish",
  }
}

/// Crate version and the wasm-bindgen version it must be bound with.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}
