//! Advance approvals (SPEC 2.9, 4.6): an Ed25519 signature by the maker's operator key over a
//! 190-byte message, carried by an Ed25519 precompile instruction in the same transaction and
//! read here through the instructions sysvar.
//!
//! The precompile has already verified the signature when the program runs: a transaction whose
//! Ed25519 instruction does not verify never executes. What is left is to prove that the
//! instruction at `approval_ix` *is* that precompile, that the signature, key and message it
//! verified all live inside it, and that the key and message are the ones this lock needs.
use anchor_lang::prelude::*;
#[allow(deprecated)]
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

use crate::{constants::*, errors::SwapError};

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// `asset` / `direction` wildcard.
pub const ANY: u8 = 0xff;

/// Header of the precompile's instruction data: `num_signatures: u8`, one byte of padding, then
/// one 14-byte offsets struct per signature.
const HEADER_LEN: usize = 2;
const OFFSETS_LEN: usize = 14;
const THIS_INSTRUCTION: u16 = u16::MAX;

/// The fields of an approval that are not bindings (those are compared, not returned).
pub struct Approval {
    pub asset: u8,
    pub direction: u8,
    pub max_xmr: u64,
    pub not_before: i64,
    pub expires_at: i64,
    pub epoch: u32,
    pub approval_id: u64,
}

impl Approval {
    /// Validity is inclusive on both ends; `0xff` matches any asset or direction.
    pub fn admits(&self, now: i64, asset: u8, direction: u8, xmr: u64, epoch: u32) -> bool {
        self.not_before <= now
            && now <= self.expires_at
            && (self.asset == ANY || self.asset == asset)
            && (self.direction == ANY || self.direction == direction)
            && xmr <= self.max_xmr
            && self.epoch == epoch
    }
}

fn u16_at(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([data[at], data[at + 1]])
}

/// Read and check the Ed25519 instruction at `index`.
///
/// `SignatureInstructionInvalid`: the instruction is not a well-formed single-signature Ed25519
/// precompile call that keeps signature, key and message inside itself.
/// `ApprovalInvalid`: it is, but the key is not the operator, or the message is not an approval
/// for this cluster, program, maker and taker.
#[inline(never)]
pub fn load(
    sysvar: &AccountInfo,
    index: u8,
    operator: &Pubkey,
    cluster_tag: &[u8; 32],
    program_id: &Pubkey,
    maker: &Pubkey,
    taker: &Pubkey,
) -> Result<Approval> {
    require_keys_eq!(*sysvar.key, ix_sysvar::ID, SwapError::SignatureInstructionInvalid);
    #[allow(deprecated)]
    let ix = ix_sysvar::load_instruction_at_checked(index as usize, sysvar)
        .map_err(|_| error!(SwapError::SignatureInstructionInvalid))?;
    require_keys_eq!(ix.program_id, ED25519_PROGRAM_ID, SwapError::SignatureInstructionInvalid);

    let data = &ix.data[..];
    require!(data.len() >= HEADER_LEN + OFFSETS_LEN, SwapError::SignatureInstructionInvalid);
    require!(data[0] == 1, SwapError::SignatureInstructionInvalid);
    let sig_offset = u16_at(data, 2) as usize;
    let sig_ix = u16_at(data, 4);
    let key_offset = u16_at(data, 6) as usize;
    let key_ix = u16_at(data, 8);
    let msg_offset = u16_at(data, 10) as usize;
    let msg_len = u16_at(data, 12) as usize;
    let msg_ix = u16_at(data, 14);
    require!(
        sig_ix == THIS_INSTRUCTION && key_ix == THIS_INSTRUCTION && msg_ix == THIS_INSTRUCTION,
        SwapError::SignatureInstructionInvalid
    );
    require!(
        sig_offset + 64 <= data.len() && key_offset + 32 <= data.len() && msg_offset + msg_len <= data.len(),
        SwapError::SignatureInstructionInvalid
    );

    require!(data[key_offset..key_offset + 32] == operator.to_bytes(), SwapError::ApprovalInvalid);
    require!(msg_len == SOL_APPROVAL_LEN, SwapError::ApprovalInvalid);
    let m = &data[msg_offset..msg_offset + SOL_APPROVAL_LEN];
    require!(m[..24] == *DS_SOL_APPROVAL, SwapError::ApprovalInvalid);
    require!(m[24..56] == cluster_tag[..], SwapError::ApprovalInvalid);
    require!(m[56..88] == program_id.to_bytes(), SwapError::ApprovalInvalid);
    require!(m[88..120] == maker.to_bytes(), SwapError::ApprovalInvalid);
    require!(m[120..152] == taker.to_bytes(), SwapError::ApprovalInvalid);

    Ok(Approval {
        asset: m[152],
        direction: m[153],
        max_xmr: u64::from_le_bytes(m[154..162].try_into().unwrap()),
        not_before: i64::from_le_bytes(m[162..170].try_into().unwrap()),
        expires_at: i64::from_le_bytes(m[170..178].try_into().unwrap()),
        epoch: u32::from_le_bytes(m[178..182].try_into().unwrap()),
        approval_id: u64::from_le_bytes(m[182..190].try_into().unwrap()),
    })
}
