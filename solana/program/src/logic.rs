//! The bridge to `escrow-logic`, the pure rules shared with the reference model (SPEC 11.4).
//!
//! Every decision about a swap is made there: [`decide`] is `machine::gate` (is this call
//! allowed, and which row is it), `machine::plan` says who is paid how much, and
//! `machine::execute_plan` computes the swap after the call. This program supplies what the
//! rules cannot know (who signed, whether a secret opens a commitment, whether a destination
//! can receive) and carries out what they decide (transfers, account writes, events). The Kani
//! proofs of `crates/escrow-logic` therefore cover the rules this program runs; they do not
//! cover this file or anything else that touches accounts.
use anchor_lang::prelude::*;
use escrow_logic::{
    bounds::{BoundError, ChainConsts, SOLANA},
    caps::Caps,
    machine::{self as m, GateError},
};

use crate::{errors::SwapError, state::*};

/// The Solana column of SPEC 3.1.
pub const CONSTS: &ChainConsts = &SOLANA;

/// The machine's view of an on-chain swap.
pub fn view(s: &Swap) -> m::Swap {
    let is_a = s.direction == 0;
    m::Swap {
        state: match s.state {
            1 => m::State::Pending,
            2 => m::State::Active,
            3 => m::State::Noticed,
            4 => m::State::Ready,
            5 => m::State::AbortedFree,
            6 => m::State::AbortedHold,
            7 => m::State::Hold,
            8 => m::State::Withheld,
            9 => m::State::Done,
            10 => m::State::Frozen,
            _ => m::State::None,
        },
        direction: if is_a { m::Direction::A } else { m::Direction::B },
        mode: s.mode,
        outcome: s.outcome,
        deposit_state: s.deposit_state,
        depth: s.depth,
        flags: s.flags,
        amount: s.amount as u128,
        deposit: s.deposit as u128,
        fee_bps: s.fee_bps,
        w_n: s.w_n,
        d_c: s.d_c,
        w_c: s.w_c,
        t_lock: s.t_lock,
        t_pending_deadline: s.t_pending_deadline,
        t_active: s.t_active,
        t_note_deadline: s.t_note_deadline,
        t_notice: s.t_notice,
        t_cut: s.t_cut,
        t_claim_open: s.t_claim_open,
        t_ready: s.t_ready,
        t_claim_deadline: s.t_claim_deadline,
        t_final: s.t_final,
        t_refund: s.t_refund,
        t_settled: s.t_settled,
        owed_taker: s.owed_taker as u128,
        owed_maker: s.owed_maker as u128,
        owed_treasury: s.owed_treasury as u128,
        payout: if is_a {
            m::PayoutTo::None
        } else if s.payout == s.taker {
            m::PayoutTo::Taker
        } else {
            m::PayoutTo::Other
        },
        watcher: s.watcher != Pubkey::default(),
        w_z: s.w_z,
        t_freeze: s.t_freeze,
    }
}

/// An amount the rules computed, in the chain's type. The rules keep every amount of an
/// accepted swap inside `u64` (`open` refuses anything else), so the error is unreachable; it
/// is an error, never a silent truncation.
pub fn amount(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(SwapError::MathOverflow))
}

/// Write the machine's result back. Addresses, keys and byte fields are not the machine's.
pub fn store(s: &mut Swap, n: &m::Swap) -> Result<()> {
    s.state = n.state as u8;
    s.direction = n.direction as u8;
    s.mode = n.mode;
    s.outcome = n.outcome;
    s.deposit_state = n.deposit_state;
    s.depth = n.depth;
    s.flags = n.flags;
    s.amount = amount(n.amount)?;
    s.deposit = amount(n.deposit)?;
    s.fee_bps = n.fee_bps;
    s.w_n = n.w_n;
    s.d_c = n.d_c;
    s.w_c = n.w_c;
    s.t_lock = n.t_lock;
    s.t_pending_deadline = n.t_pending_deadline;
    s.t_active = n.t_active;
    s.t_note_deadline = n.t_note_deadline;
    s.t_notice = n.t_notice;
    s.t_cut = n.t_cut;
    s.t_claim_open = n.t_claim_open;
    s.t_ready = n.t_ready;
    s.t_claim_deadline = n.t_claim_deadline;
    s.t_final = n.t_final;
    s.t_refund = n.t_refund;
    s.t_settled = n.t_settled;
    s.owed_taker = amount(n.owed_taker)?;
    s.owed_maker = amount(n.owed_maker)?;
    s.owed_treasury = amount(n.owed_treasury)?;
    s.w_z = n.w_z;
    s.t_freeze = n.t_freeze;
    Ok(())
}

/// The maker's side of a transition: one counter, the totals, the pending count. Every update
/// saturates; none can fail an instruction (SPEC 3.7).
pub fn record(maker: &mut Maker, asset: u8, fx: &m::Effects) {
    if let Some(c) = fx.counter {
        maker.bump(c);
    }
    if let Some(secs) = fx.response_secs {
        maker.response_secs_sum = maker.response_secs_sum.saturating_add(secs);
    }
    let sat = |v: u128| u64::try_from(v).unwrap_or(u64::MAX);
    if let Some(v) = maker.volume.get_mut(asset as usize) {
        *v = v.saturating_add(sat(fx.volume));
    }
    if let Some(v) = maker.withheld_volume.get_mut(asset as usize) {
        *v = v.saturating_add(sat(fx.withheld_volume));
    }
    match fx.open_pending {
        1 => maker.pending_opened(),
        -1 => maker.pending_closed(),
        _ => {}
    }
}

/// The caps of one asset as the rules read them (SPEC 11.1).
pub fn caps(config: &Config, asset: u8) -> Caps {
    let i = (asset as usize).min(1);
    Caps {
        on: config.caps_on != 0,
        max_swap: config.max_swap[i] as u128,
        max_open: config.max_open[i] as u128,
        open_value: config.open_value[i] as u128,
    }
}

/// What the rules need of the environment for a call on an existing swap: which destinations
/// can receive, and the open value. No cap and no pause can reach an exit (invariant 3), so the
/// switch is passed as it is and the rules ignore it.
pub fn env(config: &Config, asset: u8, can: [bool; 4]) -> m::Env {
    m::Env {
        taker_can_receive: can[0],
        maker_can_receive: can[1],
        treasury_can_receive: can[2],
        payout_can_receive: can[3],
        open_pending: 0,
        caps: caps(config, asset),
        maker_paused: false,
    }
}

/// Index of a party in the `can` array of [`env`].
pub fn party_index(p: m::Party) -> usize {
    match p {
        m::Party::Taker => 0,
        m::Party::Maker => 1,
        m::Party::Treasury => 2,
        m::Party::Payout => 3,
    }
}

/// Every role `key` holds on this swap. A key that holds none is a stranger.
fn roles(key: &Pubkey, swap: &Swap, maker: &Maker) -> [Option<m::Role>; 6] {
    let none = Pubkey::default();
    [
        (*key == swap.taker).then_some(m::Role::TakerWallet),
        (*key == swap.session_key).then_some(m::Role::Session),
        (*key == maker.operator).then_some(m::Role::Operator),
        (*key == maker.owner).then_some(m::Role::Owner),
        (swap.watcher != none && *key == swap.watcher).then_some(m::Role::Watcher),
        (swap.direction != 0 && swap.payout != swap.taker && *key == swap.payout).then_some(m::Role::Payout),
    ]
}

/// `machine::gate` for the signer of an instruction: the call is allowed if it is allowed for
/// any role the signer really holds. Refused, it is refused for the reason its first role gets.
#[inline(never)]
pub fn decide(v: &m::Swap, call: &m::Call, key: &Pubkey, swap: &Swap, maker: &Maker, now: i64) -> Result<m::Row> {
    let mut first: Option<GateError> = None;
    let mut any = false;
    for role in roles(key, swap, maker).into_iter().flatten() {
        any = true;
        match m::gate(v, call, role, now, CONSTS) {
            Ok(row) => return Ok(row),
            Err(e) => {
                first.get_or_insert(e);
            }
        }
    }
    if !any {
        return m::gate(v, call, m::Role::Anyone, now, CONSTS).map_err(gate_error);
    }
    Err(gate_error(first.unwrap_or(GateError::Unauthorized)))
}

/// The frozen error for each refusal of the rules.
pub fn gate_error(e: GateError) -> Error {
    let code = match e {
        GateError::Unauthorized => SwapError::Unauthorized,
        GateError::BadState => SwapError::BadState,
        GateError::WrongDirection => SwapError::WrongDirection,
        GateError::TooEarly => SwapError::TooEarly,
        GateError::TooLate => SwapError::TooLate,
        GateError::BadSecret => SwapError::ScalarMismatch,
        GateError::EvidenceRequired => SwapError::EvidenceRequired,
        GateError::EvidenceMismatch => SwapError::EvidenceMismatch,
        GateError::NothingOwed => SwapError::NothingOwed,
        GateError::ApprovalRequired => SwapError::ApprovalRequired,
        GateError::TooManyPending => SwapError::TooManyPending,
        GateError::MathOverflow => SwapError::MathOverflow,
        GateError::AmountOutOfRange => SwapError::AmountOutOfRange,
        GateError::Bound(b) => return bound_error(b),
        GateError::Paused => SwapError::Paused,
        GateError::SwapCapExceeded => SwapError::SwapCapExceeded,
        GateError::OpenCapExceeded => SwapError::OpenCapExceeded,
        GateError::PayoutInvalid => SwapError::PayoutInvalid,
        GateError::WatcherNotAllowed => SwapError::WatcherNotAllowed,
    };
    code.into()
}

pub fn bound_error(b: BoundError) -> Error {
    match b {
        BoundError::DepositTooHigh => SwapError::DepositTooHigh,
        BoundError::ApprovalWindowOutOfRange => SwapError::ApprovalWindowOutOfRange,
        BoundError::NoticeWindowOutOfRange => SwapError::NoticeWindowOutOfRange,
        BoundError::DepthInvalid => SwapError::DepthInvalid,
        BoundError::ClaimDelayTooShort => SwapError::ClaimDelayTooShort,
        BoundError::ClaimWindowTooShort => SwapError::ClaimWindowTooShort,
        BoundError::FinalWindowOutOfRange => SwapError::FinalWindowOutOfRange,
        BoundError::FreezeWindowOutOfRange => SwapError::FreezeWindowOutOfRange,
    }
    .into()
}
