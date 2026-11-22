//! One error type for the cryptographic half of the crate. The variant name is the string that
//! appears in the `error` field of a vector case and in the message of the JS exception.

use core::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
  /// An argument has the wrong length or shape.
  BadLength,
  /// 32 bytes that are not a canonical scalar (`>= l`).
  ScalarNotCanonical,
  /// A scalar that must be nonzero is zero (a zero spend share burns its `share_id`).
  ScalarZero,
  /// A spend share outside `0 < s < 2^252`.
  ScalarOutOfRange,
  /// Not the canonical encoding of a non-identity point of the prime-order subgroup.
  InvalidKeyCommitment,
  /// The revealed scalar does not open the commitment.
  ScalarMismatch,
  PokInvalid,
  /// The two view shares sum to zero, or the two spend commitments sum to the identity.
  JointKeyDegenerate,
  UnknownNetwork,
  UnknownChainTag,
  /// DLEQ blob: longer than 60,000 bytes.
  DleqTooLarge,
  /// DLEQ blob: version byte is not 1, or the blob is too short to hold its header.
  DleqBadVersion,
  /// DLEQ blob: bincode did not decode, or left bytes over.
  DleqMalformed,
  /// DLEQ blob: decoded, but the proof does not verify for the two points it names.
  DleqInvalid,
  /// Merkle pool: size is not a power of two between 2 and 256, or the index is out of range.
  MerklePoolSize,
  MerkleIndex,
  /// X25519 public key is one of the low-order points (the Diffie-Hellman result would be zero).
  LowOrderEncryptionKey,
  EnvelopeTooLarge,
  /// Envelope: bad magic, version, length, or flag/key mismatch.
  EnvelopeMalformed,
  /// Envelope: authentication failed (wrong key, tampered header or ciphertext).
  EnvelopeDecrypt,
  /// Envelope sent by a maker without a valid operator signature.
  EnvelopeBadSignature,
  /// Notice ciphertext does not authenticate.
  NoticeDecrypt,
  /// Notice decrypts, but `(txid, view)` does not open the on-chain commitment.
  NoticeCommitmentMismatch,
  SignatureInvalid,
  /// A field does not fit its wire type (for example a price above `u128` in the compact quote).
  FieldOutOfRange,
  /// A swap whose `amount` or `xmr` is zero (SPEC 3.1).
  AmountOutOfRange,
  /// Amount arithmetic overflowed its on-chain type.
  MathOverflow,
  PassphraseDecrypt,
  PassphraseMalformed,
}

impl fmt::Display for Error {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{self:?}")
  }
}
impl std::error::Error for Error {}

pub type Result<T> = core::result::Result<T, Error>;
