//! `swap-core`: the single implementation of SPEC section 2 (cryptography and encodings), the
//! pure reference model of the state machine of SPEC section 3, and the joint-address sweep.
//!
//! Everything here is reached from TypeScript through `@xmrswap/core-wasm`. The Solana program and
//! the Ethereum contract re-implement only the verification halves they need and prove agreement
//! by consuming the vectors this crate generates (`gen-vectors`, SPEC 2.12).
//!
//! Section map:
//!
//! | SPEC | Module |
//! | --- | --- |
//! | 2.1 primitives | [`primitives`] |
//! | 2.2 key shares | [`keys`] |
//! | 2.3 point validation | [`point`] |
//! | 2.4 proof of knowledge | [`pok`] |
//! | 2.5 joint address | [`address`] |
//! | 2.6 twin keys, DLEQ | [`twin`], [`dleq`] |
//! | 2.7 Merkle key pool | [`merkle`] |
//! | 2.8 envelopes, lock notice | [`envelope`] |
//! | 2.9, 3.12, 4.2 Solana signed objects and hashes | [`solana`] |
//! | 2.10, 3.12 EIP-712 objects, compact quote, open hash | [`ethereum`] |
//! | 2.11 sweep | [`sweep`] |
//! | 2.12 passphrase sealing | [`passphrase`] |
//! | 3.1 arithmetic and deadlines | [`amounts`] |
//! | 3 state machine | [`model`] |

#![forbid(unsafe_code)]

pub mod address;
pub mod amounts;
pub mod dleq;
pub mod envelope;
pub mod error;
pub mod ethereum;
pub mod keys;
pub mod merkle;
pub mod model;
pub mod passphrase;
pub mod point;
pub mod pok;
pub mod primitives;
pub mod sign;
pub mod solana;
pub mod sweep;
pub mod twin;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use error::Error;
