//! SPEC 11.3: the optional wallet-derived swap seed.
//!
//! The taker signs one fixed message with its wallet; the 32-byte swap seed is derived from that
//! signature, so any device that has the wallet can resume swaps. From the seed on everything is
//! SPEC 2.2 unchanged ([`crate::keys::derive_keys`] with `share_id` = the swap's nonce).
//!
//! ```text
//! sig   = Solana: the 64 signature bytes.
//!         Ethereum: r ‖ s ‖ v with s normalised to the low half and v to 27/28 (65 bytes)
//! seed  = HKDF-SHA256(ikm = sig, salt = DS("wallet-seed"), info = chain_tag ‖ wallet address bytes, L = 32)
//! ```
//!
//! The signature is as secret as the seed: it is never stored and never sent anywhere.

use hkdf::Hkdf;
use sha2::Sha256;
use sigma_fun::secp256k1::fun::{marker::*, Scalar};

use crate::{
  error::{Error, Result},
  ethereum::{domain_separator, Eip712Domain},
  primitives::{ds, keccak256, ChainTag},
  sign::eip712_digest,
};

/// `keyVersion` of the Ethereum message and the `v1` of the Solana one.
pub const WALLET_KEY_VERSION: u32 = 1;
/// EIP-712 type of the Ethereum message. The contract has no function that accepts it, and its
/// type hash differs from `Quote` and `Approval`.
pub const WALLET_KEY_TYPE: &str = "WalletKey(string notice,string site,uint32 keyVersion,address wallet)";
/// The `notice` field of the Ethereum message.
pub const WALLET_KEY_NOTICE: &str =
  "Sign this only on the site named below. Anyone who gets this signature can take XMR you have not collected and act on your open swaps.";

const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Base58 with the Bitcoin alphabet, as Solana prints addresses and hashes.
pub fn base58(data: &[u8]) -> String {
  let zeros = data.iter().take_while(|b| **b == 0).count();
  // Big-number division by 58, most significant byte first.
  let mut digits: Vec<u8> = Vec::with_capacity(data.len() * 138 / 100 + 1);
  for byte in data {
    let mut carry = *byte as u32;
    for d in digits.iter_mut() {
      carry += (*d as u32) << 8;
      *d = (carry % 58) as u8;
      carry /= 58;
    }
    while carry > 0 {
      digits.push((carry % 58) as u8);
      carry /= 58;
    }
  }
  let mut out = String::with_capacity(zeros + digits.len());
  for _ in 0..zeros {
    out.push('1');
  }
  for d in digits.iter().rev() {
    out.push(BASE58[*d as usize] as char);
  }
  out
}

/// The exact bytes a Solana wallet signs with `signMessage` (UTF-8, LF line ends, no trailing
/// newline). `site` is `WALLET_KEY_SITE`: the project's canonical site name, not the page's
/// origin, so a self-hosted copy derives the same keys.
pub fn wallet_key_message_solana(site: &str, genesis_hash: &[u8; 32], program_id: &[u8; 32], wallet: &[u8; 32]) -> Vec<u8> {
  format!(
    "Sign this only on {site} to unlock your XMR swap keys.\n\
     Anyone who gets this signature can take XMR you have not collected and act on your open swaps.\n\
     \n\
     xmrswap wallet key v{WALLET_KEY_VERSION}\n\
     cluster: {}\n\
     program: {}\n\
     wallet: {}",
    base58(genesis_hash),
    base58(program_id),
    base58(wallet),
  )
  .into_bytes()
}

pub fn wallet_key_type_hash() -> [u8; 32] {
  keccak256(&[WALLET_KEY_TYPE.as_bytes()])
}

/// `hashStruct(WalletKey)` for `eth_signTypedData_v4`.
pub fn wallet_key_struct_hash(site: &str, wallet: &[u8; 20]) -> [u8; 32] {
  let mut version = [0u8; 32];
  version[28..].copy_from_slice(&WALLET_KEY_VERSION.to_be_bytes());
  let mut addr = [0u8; 32];
  addr[12..].copy_from_slice(wallet);
  keccak256(&[&wallet_key_type_hash(), &keccak256(&[WALLET_KEY_NOTICE.as_bytes()]), &keccak256(&[site.as_bytes()]), &version, &addr])
}

/// The EIP-712 digest an Ethereum wallet signs, under the contract's own domain.
pub fn wallet_key_digest(domain: &Eip712Domain, site: &str, wallet: &[u8; 20]) -> [u8; 32] {
  eip712_digest(&domain_separator(domain), &wallet_key_struct_hash(site, wallet))
}

/// Bring an Ethereum signature to its one canonical spelling: `r ‖ s ‖ v` with `s` in the low
/// half of the group order and `v` in {27, 28}. Wallets differ in both, and the seed must not.
/// Accepts `v` as 0/1 or 27/28. `r` and `s` must be nonzero and below the group order.
pub fn normalize_eth_signature(sig: &[u8]) -> Result<[u8; 65]> {
  let sig: &[u8; 65] = sig.try_into().map_err(|_| Error::BadLength)?;
  let r = Scalar::<Public, NonZero>::from_bytes(sig[..32].try_into().unwrap()).ok_or(Error::SignatureInvalid)?;
  let mut s = Scalar::<Public, NonZero>::from_bytes(sig[32..64].try_into().unwrap()).ok_or(Error::SignatureInvalid)?;
  let mut parity = match sig[64] {
    0 | 27 => 0u8,
    1 | 28 => 1u8,
    _ => return Err(Error::SignatureInvalid),
  };
  if s.is_high() {
    s = -s;
    parity ^= 1;
  }
  let mut out = [0u8; 65];
  out[..32].copy_from_slice(&r.to_bytes());
  out[32..64].copy_from_slice(&s.to_bytes());
  out[64] = 27 + parity;
  Ok(out)
}

/// `walletSeed(chainTag, wallet, signature)`.
///
/// Solana: `wallet` is the 32-byte address and `signature` the 64 bytes of `signMessage` over
/// [`wallet_key_message_solana`]. Ethereum: `wallet` is the 20-byte address and `signature` the
/// 65 bytes of `eth_signTypedData_v4` over the `WalletKey` message; it is normalised first, so a
/// high-s or 0/1-`v` spelling of the same signature gives the same seed.
///
/// The function does not verify the signature: the page proves the seed by the determinism
/// check and by re-deriving the spend commitments of the wallet's swaps.
pub fn wallet_seed(chain: ChainTag, wallet: &[u8], signature: &[u8]) -> Result<[u8; 32]> {
  let (wallet_len, ikm): (usize, Vec<u8>) = match chain {
    ChainTag::Solana => {
      if signature.len() != 64 {
        return Err(Error::BadLength);
      }
      (32, signature.to_vec())
    }
    ChainTag::Ethereum => (20, normalize_eth_signature(signature)?.to_vec()),
  };
  if wallet.len() != wallet_len {
    return Err(Error::BadLength);
  }
  let mut info = Vec::with_capacity(1 + wallet.len());
  info.push(chain as u8);
  info.extend_from_slice(wallet);
  let mut seed = [0u8; 32];
  Hkdf::<Sha256>::new(Some(&ds("wallet-seed")), &ikm).expand(&info, &mut seed).expect("32 bytes is a valid HKDF length");
  Ok(seed)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sign::{ecdsa_recover_address, ecdsa_sign_digest, ed25519_public, ed25519_sign, ed25519_verify, eth_address_of_secret};

  #[test]
  fn base58_known_answers() {
    // The system program and a well-known address.
    assert_eq!(base58(&[0u8; 32]), "11111111111111111111111111111111");
    assert_eq!(base58(b"hello world"), "StV1DL6CwTryKyV");
    assert_eq!(base58(&[0, 0, 1]), "112");
    let token_program = hex::decode("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9").unwrap();
    assert_eq!(base58(&token_program), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  }

  #[test]
  fn solana_message_is_the_exact_text() {
    let m = wallet_key_message_solana("example.org", &[0u8; 32], &[0u8; 32], &[0u8; 32]);
    let text = String::from_utf8(m).unwrap();
    assert_eq!(
      text,
      "Sign this only on example.org to unlock your XMR swap keys.\nAnyone who gets this signature can take XMR you have not collected and act on your open swaps.\n\nxmrswap wallet key v1\ncluster: 11111111111111111111111111111111\nprogram: 11111111111111111111111111111111\nwallet: 11111111111111111111111111111111"
    );
    assert!(!text.ends_with('\n') && !text.contains('\r'));
  }

  #[test]
  fn type_hash_is_its_own() {
    // cast keccak "WalletKey(string notice,string site,uint32 keyVersion,address wallet)"
    assert_eq!(hex::encode(wallet_key_type_hash()), "e3bb51695f7fa67cd15b598258d02602f44de8b18d0f0f8422e917f8981f4a08");
    assert_ne!(wallet_key_type_hash(), crate::ethereum::quote_type_hash());
    assert_ne!(wallet_key_type_hash(), crate::ethereum::approval_type_hash());
  }

  #[test]
  fn solana_seed_is_per_wallet_and_deterministic() {
    let key = [7u8; 32];
    let wallet = ed25519_public(&key);
    let msg = wallet_key_message_solana("example.org", &[1; 32], &[2; 32], &wallet);
    let sig = ed25519_sign(&key, &msg);
    assert!(ed25519_verify(&wallet, &msg, &sig));
    // Ed25519 is deterministic: the second signature is the first.
    assert_eq!(ed25519_sign(&key, &msg), sig);
    let seed = wallet_seed(ChainTag::Solana, &wallet, &sig).unwrap();
    assert_eq!(wallet_seed(ChainTag::Solana, &wallet, &sig).unwrap(), seed);
    // Another wallet address, another signature bit: another seed.
    let mut other = wallet;
    other[0] ^= 1;
    assert_ne!(wallet_seed(ChainTag::Solana, &other, &sig).unwrap(), seed);
    let mut sig2 = sig;
    sig2[63] ^= 1;
    assert_ne!(wallet_seed(ChainTag::Solana, &wallet, &sig2).unwrap(), seed);
    assert_eq!(wallet_seed(ChainTag::Solana, &wallet[..31], &sig), Err(Error::BadLength));
    assert_eq!(wallet_seed(ChainTag::Solana, &wallet, &sig[..63]), Err(Error::BadLength));
    assert_eq!(wallet_seed(ChainTag::Solana, &wallet[..20], &sig), Err(Error::BadLength));
  }

  #[test]
  fn ethereum_spellings_of_one_signature_give_one_seed() {
    let key = [0x42u8; 32];
    let wallet = eth_address_of_secret(&key).unwrap();
    let domain = Eip712Domain { chain_id: 31_337, verifying_contract: [0xcc; 20] };
    let digest = wallet_key_digest(&domain, "example.org", &wallet);
    let sig = ecdsa_sign_digest(&key, &digest).unwrap();
    assert_eq!(ecdsa_recover_address(&digest, &sig).unwrap(), wallet);
    // RFC 6979: signing again gives the same bytes.
    assert_eq!(ecdsa_sign_digest(&key, &digest).unwrap(), sig);
    let seed = wallet_seed(ChainTag::Ethereum, &wallet, &sig).unwrap();
    // v as 0/1.
    let mut v01 = sig;
    v01[64] -= 27;
    assert_eq!(wallet_seed(ChainTag::Ethereum, &wallet, &v01).unwrap(), seed);
    // The high-s twin (s' = n − s, v flipped) is the same signature.
    let mut high = sig;
    let s = Scalar::<Public, NonZero>::from_bytes(sig[32..64].try_into().unwrap()).unwrap();
    high[32..64].copy_from_slice(&(-s).to_bytes());
    high[64] = if sig[64] == 27 { 28 } else { 27 };
    assert_ne!(high, sig);
    assert_eq!(normalize_eth_signature(&high).unwrap(), sig);
    assert_eq!(wallet_seed(ChainTag::Ethereum, &wallet, &high).unwrap(), seed);
    // The chain tag and the wallet separate seeds.
    assert_ne!(wallet_seed(ChainTag::Ethereum, &[0x11; 20], &sig).unwrap(), seed);
    // Malformed signatures.
    assert_eq!(wallet_seed(ChainTag::Ethereum, &wallet, &sig[..64]), Err(Error::BadLength));
    assert_eq!(wallet_seed(ChainTag::Ethereum, &[0u8; 32], &sig), Err(Error::BadLength));
    let mut bad_v = sig;
    bad_v[64] = 29;
    assert_eq!(wallet_seed(ChainTag::Ethereum, &wallet, &bad_v), Err(Error::SignatureInvalid));
    let mut zero_s = sig;
    zero_s[32..64].fill(0);
    assert_eq!(wallet_seed(ChainTag::Ethereum, &wallet, &zero_s), Err(Error::SignatureInvalid));
    let mut big_r = sig;
    big_r[..32].fill(0xff);
    assert_eq!(wallet_seed(ChainTag::Ethereum, &wallet, &big_r), Err(Error::SignatureInvalid));
  }

  #[test]
  fn hkdf_layout() {
    // seed = HKDF-SHA256(ikm = sig, salt = "xmrswap/v1/wallet-seed\0", info = tag ‖ wallet).
    let sig = [9u8; 64];
    let wallet = [3u8; 32];
    let mut info = vec![1u8];
    info.extend_from_slice(&wallet);
    let mut want = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"xmrswap/v1/wallet-seed\0"), &sig).expand(&info, &mut want).unwrap();
    assert_eq!(wallet_seed(ChainTag::Solana, &wallet, &sig).unwrap(), want);
  }
}
