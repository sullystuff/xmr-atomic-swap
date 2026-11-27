//! The pure rules of the escrow machine, shared by the reference model (`swap_core::model`) and
//! the Solana program (SPEC 11.4).
//!
//! `#![no_std]`, no dependencies, no allocation, no `unsafe`. Everything here is a total function
//! of its arguments:
//!
//! * [`amounts`]: pay, receive, deposit, fee, split, tiers (SPEC 3.1);
//! * [`bounds`]: the protocol constants per chain, the per-swap bounds and every deadline
//!   (SPEC 3.1, 3.2, 11.6);
//! * [`caps`]: the beta caps and the open-value accounting (SPEC 11.1);
//! * [`machine`]: the gate of every row of SPEC 3.4 to 3.6 and 11.6 ([`machine::gate`]), the
//!   payout plan of each row ([`machine::plan`]) and the whole transition ([`machine::apply`]);
//! * [`encodings`]: byte-level validators that need no curve arithmetic.
//!
//! The Kani proof harnesses of SPEC 11.4 are in `src/proofs/` (`cfg(kani)`); `KANI.md` lists each
//! with its bound and its last result.

#![no_std]
#![forbid(unsafe_code)]

pub mod amounts;
pub mod bounds;
pub mod caps;
pub mod encodings;
pub mod machine;

#[cfg(kani)]
mod proofs;
