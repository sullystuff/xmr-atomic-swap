//! SPEC 2.7: the Merkle key pool of an Ethereum quote.
//!
//! ```text
//! leaf_i = keccak256( keccak256( abi.encode(uint32 i, address keyAddr, address keyAddr2, bytes32 S) ) )
//! node   = keccak256( min(a, b) ‖ max(a, b) )         (sorted pair, as OpenZeppelin MerkleProof)
//! ```
//!
//! Pool size is a power of two, 2 to 256 leaves, in index order. The proof is the sibling
//! hashes, bottom-up; the contract checks it with `MerkleProof.verifyCalldata`.

use crate::{
  error::{Error, Result},
  primitives::keccak256,
};

pub const MERKLE_MIN_LEAVES: usize = 2;
pub const MERKLE_MAX_LEAVES: usize = 256;

/// `keyLeaf(index, keyAddr, keyAddr2, spendPub)`.
pub fn key_leaf(index: u32, key_addr: &[u8; 20], key_addr2: &[u8; 20], spend_pub: &[u8; 32]) -> [u8; 32] {
  // abi.encode: four 32-byte words; uint32 and address are left-padded, bytes32 is as is.
  let mut enc = [0u8; 128];
  enc[28..32].copy_from_slice(&index.to_be_bytes());
  enc[44..64].copy_from_slice(key_addr);
  enc[76..96].copy_from_slice(key_addr2);
  enc[96..128].copy_from_slice(spend_pub);
  keccak256(&[&keccak256(&[&enc])])
}

fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
  if a <= b {
    keccak256(&[a, b])
  } else {
    keccak256(&[b, a])
  }
}

fn check_size(n: usize) -> Result<()> {
  if !(MERKLE_MIN_LEAVES..=MERKLE_MAX_LEAVES).contains(&n) || !n.is_power_of_two() {
    return Err(Error::MerklePoolSize);
  }
  Ok(())
}

/// `merkleRoot(leaves)`.
pub fn merkle_root(leaves: &[[u8; 32]]) -> Result<[u8; 32]> {
  check_size(leaves.len())?;
  let mut level = leaves.to_vec();
  while level.len() > 1 {
    level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
  }
  Ok(level[0])
}

/// `merkleProof(leaves, index)`: sibling hashes, bottom-up.
pub fn merkle_proof(leaves: &[[u8; 32]], index: usize) -> Result<Vec<[u8; 32]>> {
  check_size(leaves.len())?;
  if index >= leaves.len() {
    return Err(Error::MerkleIndex);
  }
  let mut proof = Vec::new();
  let mut level = leaves.to_vec();
  let mut i = index;
  while level.len() > 1 {
    proof.push(level[i ^ 1]);
    level = level.chunks(2).map(|p| node(&p[0], &p[1])).collect();
    i >>= 1;
  }
  Ok(proof)
}

/// What `MerkleProof.verify` computes: fold the leaf with each sibling as a sorted pair.
pub fn merkle_verify(leaf: &[u8; 32], proof: &[[u8; 32]], root: &[u8; 32]) -> bool {
  let mut h = *leaf;
  for sibling in proof {
    h = node(&h, sibling);
  }
  h == *root
}

#[cfg(test)]
mod tests {
  use super::*;

  fn leaves(n: usize) -> Vec<[u8; 32]> {
    (0..n as u32)
      .map(|i| {
        let a: [u8; 20] = keccak256(&[b"a", &i.to_be_bytes()])[..20].try_into().unwrap();
        let b: [u8; 20] = keccak256(&[b"b", &i.to_be_bytes()])[..20].try_into().unwrap();
        key_leaf(i, &a, &b, &keccak256(&[b"s", &i.to_be_bytes()]))
      })
      .collect()
  }

  #[test]
  fn leaf_known_answer() {
    // Independent value, computed with foundry's cast:
    //   cast keccak $(cast keccak $(cast abi-encode "f(uint32,address,address,bytes32)" 7 \
    //     0x1111111111111111111111111111111111111111 0x2222222222222222222222222222222222222222 \
    //     0x3333333333333333333333333333333333333333333333333333333333333333))
    let leaf = key_leaf(7, &[0x11; 20], &[0x22; 20], &[0x33; 32]);
    assert_eq!(hex::encode(leaf), "3643db369aa9d6be5b1faf3115e4e3f2af9c0514e02ee2b0ddf6bb712a6b1108");
  }

  #[test]
  fn two_leaf_root_is_sorted_pair_hash() {
    let l = leaves(2);
    let (lo, hi) = if l[0] <= l[1] { (l[0], l[1]) } else { (l[1], l[0]) };
    assert_eq!(merkle_root(&l).unwrap(), keccak256(&[&lo, &hi]));
  }

  #[test]
  fn every_proof_verifies_for_every_size() {
    for n in [2usize, 4, 8, 16, 32, 64, 128, 256] {
      let l = leaves(n);
      let root = merkle_root(&l).unwrap();
      for i in 0..n {
        let proof = merkle_proof(&l, i).unwrap();
        assert_eq!(proof.len(), n.trailing_zeros() as usize);
        assert!(merkle_verify(&l[i], &proof, &root));
        // A proof for one leaf does not verify another leaf.
        assert!(!merkle_verify(&l[(i + 1) % n], &proof, &root));
      }
    }
  }

  #[test]
  fn tampered_proofs_and_roots_fail() {
    let l = leaves(16);
    let root = merkle_root(&l).unwrap();
    let mut proof = merkle_proof(&l, 5).unwrap();
    proof[2][0] ^= 1;
    assert!(!merkle_verify(&l[5], &proof, &root));
    let proof = merkle_proof(&l, 5).unwrap();
    let mut bad_root = root;
    bad_root[31] ^= 1;
    assert!(!merkle_verify(&l[5], &proof, &bad_root));
    assert!(!merkle_verify(&l[5], &proof[..3], &root));
    // The same share at another index is another leaf.
    let moved = key_leaf(6, &[1; 20], &[2; 20], &[3; 32]);
    assert_ne!(moved, key_leaf(5, &[1; 20], &[2; 20], &[3; 32]));
  }

  #[test]
  fn sizes_and_indices_checked() {
    for n in [0usize, 1, 3, 5, 6, 100, 257, 512] {
      assert_eq!(merkle_root(&vec![[0u8; 32]; n]), Err(Error::MerklePoolSize), "{n}");
      assert_eq!(merkle_proof(&vec![[0u8; 32]; n], 0), Err(Error::MerklePoolSize), "{n}");
    }
    assert_eq!(merkle_proof(&leaves(4), 4), Err(Error::MerkleIndex));
  }
}
