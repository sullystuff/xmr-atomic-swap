//! Progress, settlement and housekeeping (SPEC 3.4 to 3.6, 4.5).
//!
//! Check order is the reference model's, which the vectors encode: direction, caller, state
//! (and open hash), time gate, then secret or evidence. A call refused only because of the time
//! is `TooLate` if one of its windows in that state has already closed, else `TooEarly`.
//!
//! **Pay or park.** Every payout either moves now or stays in escrow and is added to `owed_*`;
//! a payout never fails an instruction. `claim` and `refund` publish a secret in their
//! arguments, so nothing after the secret check may fail.
//!
//! **Order of effects.** Lamports moved by hand (`sub_lamports` / `add_lamports`, closing the
//! swap account) must come after every CPI in the instruction: the runtime compares the
//! caller's lamport total when a CPI starts, and an account that is not passed to that CPI has
//! not been written back yet. So: token CPIs, then the session-key sweep (a system transfer),
//! then SOL payouts and the close.
use anchor_lang::{prelude::*, system_program};
use anchor_spl::{associated_token::get_associated_token_address, token};

use crate::{
    admin::invalid_arg,
    args::Evidence,
    constants::*,
    contexts::*,
    curve::scalar_matches,
    errors::SwapError,
    events::*,
    state::*,
    util,
};

pub const INCINERATOR_ID: Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

/// A payout destination. The value is also the `who` byte of `withdraw_owed` and of the
/// `PayoutParked` / `OwedWithdrawn` events.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Party {
    Taker = 0,
    Maker = 1,
    Treasury = 2,
}

/// What the tail of a settling instruction does besides paying.
#[derive(Clone, Copy, Default)]
pub struct Tail {
    /// Return a session-key signer's remaining lamports to the taker.
    pub sweep: bool,
    /// Close the swap (and its vault) in this instruction when nothing was parked.
    pub close: bool,
    /// The close is the purpose of the instruction (`close_swap`): fail instead of skipping.
    pub must_close: bool,
    /// The treasury payout is the burned half of a split (`split_mode = 1`).
    pub burn: bool,
}

struct Payout {
    to: Party,
    amount: u64,
}

// ------------------------------------------------------------------ token account views

const TOKEN_ACCOUNT_LEN: usize = 165;
const TOKEN_STATE_OFFSET: usize = 108;
const TOKEN_INITIALIZED: u8 = 1;

/// `(mint, owner, amount, state)` of a classic SPL token account, or `None` if the account is
/// not one.
fn token_view(ai: &AccountInfo) -> Option<(Pubkey, Pubkey, u64, u8)> {
    if *ai.owner != token::ID || ai.data_len() != TOKEN_ACCOUNT_LEN {
        return None;
    }
    let d = ai.try_borrow_data().ok()?;
    Some((
        Pubkey::new_from_array(d[0..32].try_into().ok()?),
        Pubkey::new_from_array(d[32..64].try_into().ok()?),
        u64::from_le_bytes(d[64..72].try_into().ok()?),
        d[TOKEN_STATE_OFFSET],
    ))
}

/// The destination is an initialised, unfrozen token account of `mint` owned by `owner`.
fn token_can_receive(ai: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> bool {
    matches!(token_view(ai), Some((m, o, _, TOKEN_INITIALIZED)) if m == *mint && o == *owner)
}

fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let d = mint.try_borrow_data()?;
    require!(d.len() >= 45, SwapError::MintNotAllowed);
    Ok(d[44])
}

/// SOL: the destination would hold at least its rent minimum afterwards and is not executable.
/// The incinerator is exempt from rent (the runtime wipes it every slot).
fn sol_can_receive(ai: &AccountInfo, amount: u64, rent: &Rent) -> bool {
    if ai.executable || !ai.is_writable {
        return false;
    }
    if *ai.key == INCINERATOR_ID {
        return true;
    }
    ai.lamports().saturating_add(amount) >= rent.minimum_balance(ai.data_len())
}

// ------------------------------------------------------------------ the Settle account list

impl<'info> Settle<'info> {
    fn treasury_pda(&self) -> Result<Pubkey> {
        Pubkey::create_program_address(&[b"treasury", &[self.config.treasury_bump]], &crate::ID)
            .map_err(|_| error!(ErrorCode::ConstraintSeeds))
    }

    /// Checks every instruction on this list shares: the addresses that can never change are
    /// hard requirements (a wrong one is the caller's mistake, like naming the wrong swap); a
    /// destination's *state* is never one.
    fn check_accounts(&self, taker_is_pinned: bool) -> Result<()> {
        require_keys_eq!(self.swap.maker, self.maker.key(), SwapError::Unauthorized);
        if taker_is_pinned {
            require_keys_eq!(self.taker.key(), self.swap.taker, SwapError::Unauthorized);
        }
        let treasury = self.treasury.key();
        require!(
            treasury == self.treasury_pda()? || treasury == INCINERATOR_ID,
            SwapError::Unauthorized
        );
        if self.swap.asset == ASSET_USDC {
            let (Some(mint), Some(vault), Some(_)) = (&self.mint, &self.vault, &self.token_program) else {
                return err!(SwapError::WrongAsset);
            };
            require_keys_eq!(mint.key(), self.config.usdc_mint, SwapError::MintNotAllowed);
            let swap_key = self.swap.key();
            let expected =
                Pubkey::create_program_address(&[b"vault", swap_key.as_ref(), &[self.swap.vault_bump]], &crate::ID)
                    .map_err(|_| error!(ErrorCode::ConstraintSeeds))?;
            require_keys_eq!(vault.key(), expected, ErrorCode::ConstraintSeeds);
        }
        Ok(())
    }

    fn park(&mut self, to: Party, amount: u64, ctr: u8, now: i64) {
        let s = &mut self.swap;
        match to {
            Party::Taker => s.owed_taker = s.owed_taker.saturating_add(amount),
            Party::Maker => s.owed_maker = s.owed_maker.saturating_add(amount),
            Party::Treasury => s.owed_treasury = s.owed_treasury.saturating_add(amount),
        }
        emit!(PayoutParked {
            swap: s.key(),
            maker: s.maker,
            counter: ctr,
            at: now,
            who: to as u8,
            amount,
        });
    }

    /// Token transfer out of the vault, signed by the swap PDA.
    fn vault_transfer(&self, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        let (mint, vault, token_program) = (
            self.mint.as_ref().unwrap(),
            self.vault.as_ref().unwrap(),
            self.token_program.as_ref().unwrap(),
        );
        let seeds: &[&[u8]] = &[b"swap", self.swap.taker.as_ref(), &self.swap.swap_nonce, &[self.swap.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                token::TransferChecked {
                    from: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    to: to.clone(),
                    authority: self.swap.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            mint_decimals(mint)?,
        )
    }

    fn vault_burn(&self, amount: u64) -> Result<()> {
        let (mint, vault, token_program) = (
            self.mint.as_ref().unwrap(),
            self.vault.as_ref().unwrap(),
            self.token_program.as_ref().unwrap(),
        );
        let seeds: &[&[u8]] = &[b"swap", self.swap.taker.as_ref(), &self.swap.swap_nonce, &[self.swap.bump]];
        token::burn(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                token::Burn {
                    mint: mint.to_account_info(),
                    from: vault.to_account_info(),
                    authority: self.swap.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    fn vault_state(&self) -> Option<(u64, u8)> {
        let vault = self.vault.as_ref()?;
        token_view(vault).map(|(_, _, amount, state)| (amount, state))
    }

    /// USDC pay-or-park. Returns whether the payout moved.
    fn pay_token(&self, p: &Payout, maker_wallet: &Pubkey, burn: bool) -> Result<bool> {
        let mint_key = self.mint.as_ref().unwrap().key();
        let Some((_, vault_state)) = self.vault_state() else {
            return Ok(false);
        };
        if vault_state != TOKEN_INITIALIZED {
            return Ok(false); // a frozen escrow can pay nobody
        }
        match p.to {
            Party::Taker => {
                let Some(dest) = &self.taker_token else {
                    return Ok(false);
                };
                // The address is fixed for the life of the swap: a wrong one is refused.
                require_keys_eq!(
                    dest.key(),
                    get_associated_token_address(&self.swap.taker, &mint_key),
                    SwapError::Unauthorized
                );
                if !token_can_receive(dest, &mint_key, &self.swap.taker) {
                    return Ok(false);
                }
                self.vault_transfer(dest, p.amount)?;
            }
            Party::Maker => {
                let Some(dest) = &self.maker_token else {
                    return Ok(false);
                };
                // The maker's wallet can change under a transaction in flight: park, never fail.
                if dest.key() != get_associated_token_address(maker_wallet, &mint_key)
                    || !token_can_receive(dest, &mint_key, maker_wallet)
                {
                    return Ok(false);
                }
                self.vault_transfer(dest, p.amount)?;
            }
            Party::Treasury if burn => self.vault_burn(p.amount)?,
            Party::Treasury => {
                let Some(dest) = &self.treasury_vault else {
                    return Ok(false);
                };
                let (expected, _) =
                    Pubkey::find_program_address(&[b"treasury_vault", mint_key.as_ref()], &crate::ID);
                require_keys_eq!(dest.key(), expected, SwapError::Unauthorized);
                if !token_can_receive(dest, &mint_key, &self.treasury_pda()?) {
                    return Ok(false);
                }
                self.vault_transfer(dest, p.amount)?;
            }
        }
        Ok(true)
    }

    /// SOL pay-or-park. Returns whether the payout moved.
    fn pay_sol(&self, p: &Payout, maker_wallet: &Pubkey, burn: bool, rent: &Rent) -> Result<bool> {
        let dest = match p.to {
            Party::Taker => self.taker.to_account_info(),
            Party::Maker => {
                if self.maker_wallet.key() != *maker_wallet {
                    return Ok(false);
                }
                self.maker_wallet.to_account_info()
            }
            Party::Treasury => {
                let expected = if burn { INCINERATOR_ID } else { self.treasury_pda()? };
                require_keys_eq!(self.treasury.key(), expected, SwapError::Unauthorized);
                self.treasury.to_account_info()
            }
        };
        if dest.key() == self.swap.key() || !sol_can_receive(&dest, p.amount, rent) {
            return Ok(false);
        }
        self.swap.sub_lamports(p.amount)?;
        dest.add_lamports(p.amount)?;
        Ok(true)
    }

    /// Return a session-key signer's remaining lamports to the taker so the throwaway key ends
    /// at exactly zero (the fee was deducted before execution). If the taker cannot hold them
    /// they go to the swap account, which returns every lamport to the taker when it closes.
    fn sweep_session(&self, rent: &Rent) -> Result<()> {
        let caller = self.caller.to_account_info();
        if caller.key() != self.swap.session_key || caller.key() == self.swap.taker {
            return Ok(());
        }
        let left = caller.lamports();
        if left == 0 || *caller.owner != system_program::ID || !caller.data_is_empty() {
            return Ok(());
        }
        let taker = self.taker.to_account_info();
        let to = if taker.key() == self.swap.taker && sol_can_receive(&taker, left, rent) {
            taker
        } else {
            self.swap.to_account_info()
        };
        system_program::transfer(
            CpiContext::new(self.system_program.to_account_info(), system_program::Transfer { from: caller, to }),
            left,
        )
    }

    /// Empty the vault of anything left (dust sent after settlement) and close it, rent to the
    /// taker. Returns false if that is impossible right now (a frozen vault that holds tokens).
    fn close_vault(&self) -> Result<bool> {
        let Some((amount, state)) = self.vault_state() else {
            return Ok(true); // already closed
        };
        if amount > 0 {
            if state != TOKEN_INITIALIZED {
                return Ok(false);
            }
            let mint_key = self.mint.as_ref().unwrap().key();
            let to_treasury = match &self.treasury_vault {
                Some(dest) => {
                    let (expected, _) =
                        Pubkey::find_program_address(&[b"treasury_vault", mint_key.as_ref()], &crate::ID);
                    dest.key() == expected && token_can_receive(dest, &mint_key, &self.treasury_pda()?)
                }
                None => false,
            };
            if to_treasury {
                self.vault_transfer(self.treasury_vault.as_ref().unwrap(), amount)?;
            } else {
                self.vault_burn(amount)?;
            }
        }
        let seeds: &[&[u8]] = &[b"swap", self.swap.taker.as_ref(), &self.swap.swap_nonce, &[self.swap.bump]];
        token::close_account(CpiContext::new_with_signer(
            self.token_program.as_ref().unwrap().to_account_info(),
            token::CloseAccount {
                account: self.vault.as_ref().unwrap().to_account_info(),
                destination: self.taker.to_account_info(),
                authority: self.swap.to_account_info(),
            },
            &[seeds],
        ))?;
        Ok(true)
    }

    /// The tail of every settling instruction: pay or park each payout, sweep the session key,
    /// close the swap if asked and possible. State and counters are already written.
    fn finish(&mut self, payouts: &[Payout], maker_wallet: Pubkey, tail: Tail, ctr: u8, now: i64) -> Result<()> {
        let rent = Rent::get()?;
        let usdc = self.swap.asset == ASSET_USDC;
        let mut parked_any = false;

        if usdc {
            for p in payouts.iter().filter(|p| p.amount > 0) {
                if !self.pay_token(p, &maker_wallet, tail.burn)? {
                    self.park(p.to, p.amount, ctr, now);
                    parked_any = true;
                }
            }
        }

        let nothing_owed = self.swap.owed_taker == 0 && self.swap.owed_maker == 0 && self.swap.owed_treasury == 0;
        // SOL payouts have not moved yet, so decide them first: a close needs them all to land.
        let sol_all_land = usdc
            || payouts.iter().filter(|p| p.amount > 0).all(|p| match p.to {
                Party::Taker => sol_can_receive(&self.taker, p.amount, &rent),
                Party::Maker => {
                    self.maker_wallet.key() == maker_wallet && sol_can_receive(&self.maker_wallet, p.amount, &rent)
                }
                Party::Treasury => sol_can_receive(&self.treasury, p.amount, &rent),
            });
        // The rent goes to the taker, so the taker must be able to hold lamports.
        let taker_ok = self.taker.key() == self.swap.taker && !self.taker.executable && self.taker.is_writable;
        let mut closing = tail.close && !parked_any && nothing_owed && sol_all_land && taker_ok;
        if closing && usdc {
            closing = self.close_vault()?;
            if !closing && tail.must_close {
                return err!(SwapError::VaultNotEmpty);
            }
        }
        if tail.must_close && !closing {
            return err!(SwapError::NotClosable);
        }

        if tail.sweep {
            self.sweep_session(&rent)?;
        }

        if !usdc {
            for p in payouts.iter().filter(|p| p.amount > 0) {
                if !self.pay_sol(p, &maker_wallet, tail.burn, &rent)? {
                    self.park(p.to, p.amount, ctr, now);
                }
            }
        }

        if closing {
            emit!(SwapClosed { swap: self.swap.key(), maker: self.swap.maker, counter: counter::NONE, at: now });
            self.swap.close(self.taker.to_account_info())?;
        }
        Ok(())
    }

    /// DONE, with the counter of the transition as the outcome.
    fn settle(&mut self, ctr: u8, now: i64) {
        let s = &mut self.swap;
        s.state = state::DONE;
        s.outcome = ctr;
        s.t_settled = now;
        self.maker.bump(ctr);
    }
}

fn gate_before(now: i64, limit: i64) -> Result<()> {
    require!(now < limit, SwapError::TooLate);
    Ok(())
}
fn gate_from(now: i64, start: i64) -> Result<()> {
    require!(now >= start, SwapError::TooEarly);
    Ok(())
}

/// Who signed, relative to a swap.
struct Caller {
    taker_wallet: bool,
    /// The taker's wallet or the swap's session key.
    taker: bool,
    operator: bool,
    owner: bool,
}

fn caller_of(key: &Pubkey, swap: &Swap, maker: &Maker) -> Caller {
    Caller {
        taker_wallet: *key == swap.taker,
        taker: *key == swap.taker || *key == swap.session_key,
        operator: *key == maker.operator,
        owner: *key == maker.owner,
    }
}

impl Caller {
    /// The locker escrows the chain asset and can refund it. A: taker. B: maker.
    fn locker(&self, is_a: bool) -> bool {
        if is_a {
            self.taker
        } else {
            self.operator
        }
    }
    /// The claimer locks XMR and can claim. A: maker. B: taker.
    fn claimer(&self, is_a: bool) -> bool {
        if is_a {
            self.operator
        } else {
            self.taker
        }
    }
}

// ------------------------------------------------------------------ pending exits

/// A3, B3.
pub fn reject(ctx: Context<Settle>, expected_open: [u8; 32], reason: u8) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    let swap_key = a.swap.key();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.operator, SwapError::Unauthorized);
    require!(
        a.swap.state == state::PENDING && a.swap.open_hash(&swap_key) == expected_open,
        SwapError::BadState
    );
    // B3: window mode only.
    require!(a.swap.is_a() || a.swap.mode == mode::WINDOW, SwapError::BadState);
    require!(reason <= 2, SwapError::BadState);
    let ctr = if reason == 0 { counter::REJECTIONS } else { counter::REJECTIONS_NO_FAULT };
    let stake = if a.swap.is_a() { a.swap.amount } else { a.swap.deposit };
    a.settle(ctr, now);
    a.maker.pending_closed();
    emit!(SwapRejected { swap: swap_key, maker: a.maker.key(), counter: ctr, at: now });
    let maker_wallet = a.maker.operator;
    a.finish(
        &[Payout { to: Party::Taker, amount: stake }],
        maker_wallet,
        Tail { close: true, ..Tail::default() },
        ctr,
        now,
    )
}

/// A4, B2.
pub fn cancel_pending(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.taker, SwapError::Unauthorized);
    require!(a.swap.state == state::PENDING, SwapError::BadState);
    let ctr = counter::PENDING_CANCELS;
    let stake = if a.swap.is_a() { a.swap.amount } else { a.swap.deposit };
    a.settle(ctr, now);
    a.maker.pending_closed();
    emit!(PendingCancelled { swap: a.swap.key(), maker: a.maker.key(), counter: ctr, at: now });
    let maker_wallet = a.maker.operator;
    a.finish(
        &[Payout { to: Party::Taker, amount: stake }],
        maker_wallet,
        Tail { close: true, sweep: true, ..Tail::default() },
        ctr,
        now,
    )
}

/// A5, B4.
pub fn expire_pending(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    require!(a.swap.state == state::PENDING, SwapError::BadState);
    gate_from(now, a.swap.t_pending_deadline)?;
    // A take outside window mode that the maker never funded is the maker's fault.
    let fault = !a.swap.is_a() && a.swap.mode != mode::WINDOW;
    let ctr = if fault { counter::MISSED_FUNDS } else { counter::APPROVAL_TIMEOUTS };
    let stake = if a.swap.is_a() { a.swap.amount } else { a.swap.deposit };
    a.settle(ctr, now);
    a.maker.pending_closed();
    emit!(PendingExpired { swap: a.swap.key(), maker: a.maker.key(), counter: ctr, at: now });
    let maker_wallet = a.maker.operator;
    a.finish(
        &[Payout { to: Party::Taker, amount: stake }],
        maker_wallet,
        Tail { close: true, ..Tail::default() },
        ctr,
        now,
    )
}

// ------------------------------------------------------------------ progress (Short list)

fn check_short(a: &Short) -> Result<()> {
    require_keys_eq!(a.swap.maker, a.maker.key(), SwapError::Unauthorized);
    Ok(())
}

/// A6, B6.
pub fn post_notice(ctx: Context<Short>, commitment: [u8; 32], ciphertext: [u8; 104]) -> Result<()> {
    let a = ctx.accounts;
    check_short(a)?;
    let now = util::now()?;
    let is_a = a.swap.is_a();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.claimer(is_a), SwapError::Unauthorized);
    require!(a.swap.state == state::ACTIVE, SwapError::BadState);
    let s = &mut a.swap;
    if is_a {
        gate_before(now, s.t_note_deadline.min(s.t_final))?;
    } else {
        // A late notice is still accepted until T_nl; it only costs the taker its protection
        // against a withheld deposit.
        gate_before(now, s.t_nl().min(s.t_final))?;
        if now >= s.t_note_deadline {
            s.flags |= flag::LATE_NOTICE;
        }
    }
    s.state = state::NOTICED;
    s.flags |= flag::NOTICE;
    s.notice_commitment = commitment;
    s.notice_ct = ciphertext;
    s.t_notice = now;
    s.t_cut = now + util::delta_cut(s.depth);
    s.t_claim_open = now + s.d_c as i64;
    a.maker.bump(counter::NOTICES);
    emit!(NoticePosted { swap: s.key(), maker: s.maker, counter: counter::NOTICES, at: now, commitment });
    Ok(())
}

/// A9, B7.
pub fn set_ready(ctx: Context<Short>) -> Result<()> {
    let a = ctx.accounts;
    check_short(a)?;
    let now = util::now()?;
    let is_a = a.swap.is_a();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.locker(is_a), SwapError::Unauthorized);
    require!(a.swap.state == state::NOTICED, SwapError::BadState);
    let s = &mut a.swap;
    gate_from(now, s.t_ready_min())?;
    gate_before(now, s.t_claim_open.min(s.t_final))?;
    s.state = state::READY;
    s.t_ready = now;
    s.t_claim_deadline = now + s.w_c as i64;
    a.maker.bump(counter::READIES);
    emit!(ReadySet { swap: s.key(), maker: s.maker, counter: counter::READIES, at: now });
    Ok(())
}

/// SPEC 3.6: the maker keeps the deposit in escrow past the hold.
pub fn withhold(ctx: Context<Short>, evidence: Option<Evidence>) -> Result<()> {
    let a = ctx.accounts;
    check_short(a)?;
    let now = util::now()?;
    let swap_key = a.swap.key();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.operator, SwapError::Unauthorized);
    require!(a.swap.state == state::HOLD, SwapError::BadState);
    // Refused at or after T_hold even if nobody has cranked release_deposit.
    gate_before(now, a.swap.t_hold())?;
    let s = &mut a.swap;
    let mut txid = [0u8; 32];
    let mut view = [0u8; 32];
    // Direction A with a notice on record: the maker must open its own notice. Anywhere else no
    // evidence exists to demand, and any supplied is ignored.
    if s.is_a() && s.has(flag::NOTICE) {
        let Some(e) = evidence else {
            return err!(SwapError::EvidenceRequired);
        };
        require!(
            Swap::notice_opening(&swap_key, &e.txid, &e.view) == s.notice_commitment,
            SwapError::EvidenceMismatch
        );
        s.evidence_txid = e.txid;
        s.evidence_view = e.view;
        s.flags |= flag::EVIDENCE;
        txid = e.txid;
        view = e.view;
    }
    s.state = state::WITHHELD;
    s.deposit_state = deposit_state::WITHHELD;
    let amount = s.deposit;
    let asset = s.asset as usize;
    let m = &mut a.maker;
    m.bump(counter::WITHHOLDS);
    if let Some(v) = m.withheld_volume.get_mut(asset) {
        *v = v.saturating_add(amount);
    }
    emit!(DepositWithheld {
        swap: swap_key,
        maker: m.key(),
        counter: counter::WITHHOLDS,
        at: now,
        amount,
        txid,
        view,
    });
    Ok(())
}

/// SPEC 3.6: the claimer posts the opening of its notice in clear.
pub fn publish_evidence(ctx: Context<Short>, txid: [u8; 32], view: [u8; 32]) -> Result<()> {
    let a = ctx.accounts;
    check_short(a)?;
    let now = util::now()?;
    let swap_key = a.swap.key();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.claimer(a.swap.is_a()), SwapError::Unauthorized);
    // "NOTICED or later, any state including DONE": a notice is on record.
    require!(a.swap.has(flag::NOTICE), SwapError::BadState);
    require!(
        Swap::notice_opening(&swap_key, &txid, &view) == a.swap.notice_commitment,
        SwapError::EvidenceMismatch
    );
    let s = &mut a.swap;
    s.evidence_txid = txid;
    s.evidence_view = view;
    s.flags |= flag::EVIDENCE;
    emit!(EvidencePublished { swap: swap_key, maker: s.maker, counter: counter::NONE, at: now, txid, view });
    Ok(())
}

// ------------------------------------------------------------------ aborts and keyless exits

/// A7a-d, B8.
pub fn abort(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    let is_a = a.swap.is_a();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.claimer(is_a), SwapError::Unauthorized);
    let swap_key = a.swap.key();
    let maker_key = a.maker.key();
    let maker_wallet = a.maker.operator;
    let s = &mut a.swap;
    if is_a {
        match s.state {
            state::ACTIVE => {
                // A7a: no notice was ever accepted, so the XMR was never locked: a keyless,
                // full refund at once.
                gate_before(now, s.t_note_deadline.min(s.t_final))?;
                let ctr = counter::ABORTS_PRE_NOTICE;
                let amount = s.amount;
                a.settle(ctr, now);
                emit!(Aborted { swap: swap_key, maker: maker_key, counter: ctr, at: now, new_state: state::DONE });
                return a.finish(
                    &[Payout { to: Party::Taker, amount }],
                    maker_wallet,
                    Tail { close: true, ..Tail::default() },
                    ctr,
                    now,
                );
            }
            state::NOTICED => {
                gate_before(now, s.t_final)?;
                let (new_state, ctr) = if now < s.t_claim_open {
                    (state::ABORTED_FREE, counter::ABORTS_EARLY) // A7b
                } else {
                    (state::ABORTED_HOLD, counter::ABORTS_LATE) // A7c
                };
                s.state = new_state;
                a.maker.bump(ctr);
                emit!(Aborted { swap: swap_key, maker: maker_key, counter: ctr, at: now, new_state });
            }
            state::READY => {
                // A7d: the maker gives up a claim it was entitled to.
                gate_before(now, s.t_final)?;
                s.state = state::ABORTED_FREE;
                a.maker.bump(counter::MISSED_CLAIMS);
                emit!(Aborted {
                    swap: swap_key,
                    maker: maker_key,
                    counter: counter::MISSED_CLAIMS,
                    at: now,
                    new_state: state::ABORTED_FREE,
                });
            }
            _ => return err!(SwapError::BadState),
        }
    } else {
        // B8.
        require!(matches!(s.state, state::NOTICED | state::READY), SwapError::BadState);
        gate_before(now, s.t_final)?;
        s.state = state::ABORTED_HOLD;
        a.maker.bump(counter::TAKER_ABORTS);
        emit!(Aborted {
            swap: swap_key,
            maker: maker_key,
            counter: counter::TAKER_ABORTS,
            at: now,
            new_state: state::ABORTED_HOLD,
        });
    }
    Ok(())
}

/// A8.
pub fn refund_unnoticed(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    require!(a.swap.is_a(), SwapError::WrongDirection);
    require!(a.swap.state == state::ACTIVE, SwapError::BadState);
    gate_from(now, a.swap.t_note_deadline)?;
    let ctr = counter::MISSED_NOTICES;
    let amount = a.swap.amount;
    a.settle(ctr, now);
    emit!(RefundedKeyless { swap: a.swap.key(), maker: a.maker.key(), counter: ctr, at: now });
    let maker_wallet = a.maker.operator;
    a.finish(
        &[Payout { to: Party::Taker, amount }],
        maker_wallet,
        Tail { close: true, ..Tail::default() },
        ctr,
        now,
    )
}

/// B11.
pub fn expire_unnoticed(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    require!(!a.swap.is_a(), SwapError::WrongDirection);
    require!(a.swap.state == state::ACTIVE, SwapError::BadState);
    gate_from(now, a.swap.t_exp())?;
    let ctr = counter::EXPIRED_REFUNDS;
    let (deposit, amount) = (a.swap.deposit, a.swap.amount);
    a.settle(ctr, now);
    // The maker's escrow is parked, never pushed: nobody with authority over it is present.
    if amount > 0 {
        a.park(Party::Maker, amount, ctr, now);
    }
    emit!(ExpiredUnnoticed { swap: a.swap.key(), maker: a.maker.key(), counter: ctr, at: now });
    let maker_wallet = a.maker.operator;
    a.finish(&[Payout { to: Party::Taker, amount: deposit }], maker_wallet, Tail::default(), ctr, now)
}

// ------------------------------------------------------------------ secret-bearing calls

/// How a refund treats the deposit.
#[derive(PartialEq, Eq)]
enum RefundKind {
    /// The deposit stays in escrow (HOLD), unless it is zero.
    Held,
    /// Everything is returned at once.
    Free,
}

/// A10a-g, B9a-h.
pub fn refund(ctx: Context<Settle>, secret: [u8; 32]) -> Result<()> {
    use RefundKind::*;
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    let is_a = a.swap.is_a();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.locker(is_a), SwapError::Unauthorized);
    let s = &a.swap;
    let t_final = s.t_final;
    let (kind, ctr) = if is_a {
        match s.state {
            // A keyed refund is valid in ACTIVE at every instant.
            state::ACTIVE if now < s.t_note_deadline => (Held, counter::TAKER_CANCELS_APPROVED), // A10a
            state::ACTIVE => (Free, counter::MISSED_NOTICES),                                    // A10g
            state::NOTICED if now < s.t_claim_open.min(t_final) => (Held, counter::TAKER_REFUNDS_NOTICED), // A10b
            state::READY if now < s.t_claim_deadline => return err!(SwapError::TooEarly),
            state::READY if now < t_final => (Free, counter::MISSED_CLAIMS), // A10e
            state::ABORTED_HOLD if now < t_final => (Held, counter::REFUNDS_AFTER_ABORT), // A10c
            state::ABORTED_FREE if now < t_final => (Free, counter::REFUNDS_AFTER_ABORT), // A10d
            state::NOTICED | state::READY | state::ABORTED_HOLD | state::ABORTED_FREE => {
                // Between the last pre-expiry window and T_exp the claimer alone may move.
                require!(now >= s.t_exp(), SwapError::TooLate);
                (Free, counter::EXPIRED_REFUNDS) // A10f
            }
            _ => return err!(SwapError::BadState),
        }
    } else {
        match s.state {
            state::ACTIVE if now < s.t_note_deadline => (Free, counter::BACKOUTS_PRE_NOTICE), // B9a
            state::ACTIVE => (Held, counter::TAKER_NO_NOTICE),                                // B9b
            state::NOTICED if now < s.t_cut.min(t_final) => {
                if s.has(flag::LATE_NOTICE) {
                    (Held, counter::TAKER_NO_NOTICE) // B9h
                } else {
                    (Free, counter::BACKOUTS_POST_NOTICE) // B9c
                }
            }
            state::NOTICED if now < s.t_claim_open.min(t_final) => (Held, counter::REFUNDS_UNCONFIRMED), // B9d
            state::READY if now < s.t_claim_deadline => return err!(SwapError::TooEarly),
            state::READY if now < t_final => (Held, counter::TAKER_MISSED_CLAIMS), // B9e
            state::ABORTED_HOLD if now < t_final => (Held, counter::REFUNDS_AFTER_ABORT), // B9f
            state::NOTICED | state::READY | state::ABORTED_HOLD => {
                require!(now >= s.t_exp(), SwapError::TooLate);
                (Free, counter::EXPIRED_REFUNDS) // B9g
            }
            _ => return err!(SwapError::BadState),
        }
    };
    let commitment = if is_a { &s.taker_spend_pub } else { &s.maker_spend_pub };
    require!(scalar_matches(&secret, commitment), SwapError::ScalarMismatch);

    // ---- nothing below may fail: the secret is public.
    let held = kind == Held && s.deposit > 0;
    let (amount, deposit) = (s.amount, s.deposit);
    let maker_wallet = a.maker.operator;
    let swap_key = a.swap.key();
    let maker_key = a.maker.key();
    {
        let s = &mut a.swap;
        s.revealed = secret;
        s.flags |= flag::REVEALED | flag::REVEALER_LOCKER;
        s.t_refund = now;
    }
    let mut payouts = [Payout { to: Party::Taker, amount: 0 }, Payout { to: Party::Taker, amount: 0 }];
    if is_a {
        // D is part of amount.
        payouts[0] = Payout { to: Party::Taker, amount: if held { amount - deposit } else { amount } };
    } else {
        payouts[0] = Payout { to: Party::Maker, amount };
        if !held {
            payouts[1] = Payout { to: Party::Taker, amount: deposit };
        }
    }
    if held {
        a.swap.state = state::HOLD;
        a.swap.deposit_state = deposit_state::HELD;
        a.maker.bump(ctr);
    } else {
        a.settle(ctr, now);
    }
    emit!(Refunded { swap: swap_key, maker: maker_key, counter: ctr, at: now, secret, deposit_held: held });
    a.finish(&payouts, maker_wallet, Tail { sweep: is_a, ..Tail::default() }, ctr, now)
}

/// A11a-c, B10a-c.
pub fn claim(ctx: Context<Settle>, secret: [u8; 32]) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    let is_a = a.swap.is_a();
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    require!(who.claimer(is_a), SwapError::Unauthorized);
    let s = &a.swap;
    let ctr = match s.state {
        state::READY if now < s.t_claim_deadline.min(s.t_final) => counter::COMPLETED, // A11a, B10a
        state::READY if now < s.t_final => return err!(SwapError::TooLate),
        state::NOTICED if now < s.t_claim_open => return err!(SwapError::TooEarly),
        state::NOTICED if now < s.t_final => {
            if is_a {
                counter::CLAIMS_WITHOUT_READY // A11b
            } else {
                counter::TAKER_CLAIMS_WITHOUT_READY // B10b
            }
        }
        state::ABORTED_FREE | state::ABORTED_HOLD if now < s.t_final => return err!(SwapError::TooEarly),
        state::NOTICED | state::READY | state::ABORTED_FREE | state::ABORTED_HOLD => {
            // [T_final, T_exp): the claimer may claim in any post-notice state.
            gate_before(now, s.t_exp())?;
            counter::CLAIMS_AFTER_FINAL // A11c, B10c
        }
        _ => return err!(SwapError::BadState),
    };
    let commitment = if is_a { &s.maker_spend_pub } else { &s.taker_spend_pub };
    require!(scalar_matches(&secret, commitment), SwapError::ScalarMismatch);

    // ---- nothing below may fail: the secret is public.
    let (amount, deposit, asset) = (s.amount, s.deposit, s.asset as usize);
    let fee = util::bps_of(amount, s.fee_bps);
    let paid = if is_a { amount - fee } else { (amount - fee).saturating_add(deposit) };
    // A: the payout address set by the cold owner key, never the operator.
    let maker_wallet = a.maker.payout;
    let swap_key = a.swap.key();
    let maker_key = a.maker.key();
    {
        let s = &mut a.swap;
        s.revealed = secret;
        s.flags |= flag::REVEALED;
    }
    a.settle(ctr, now);
    if let Some(v) = a.maker.volume.get_mut(asset) {
        *v = v.saturating_add(amount);
    }
    emit!(Claimed { swap: swap_key, maker: maker_key, counter: ctr, at: now, secret, paid, fee });
    let payouts = [
        Payout { to: if is_a { Party::Maker } else { Party::Taker }, amount: paid },
        Payout { to: Party::Treasury, amount: fee },
    ];
    a.finish(&payouts, maker_wallet, Tail { sweep: !is_a, ..Tail::default() }, ctr, now)
}

// ------------------------------------------------------------------ deposit sub-machine

pub fn release_deposit(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    let who = caller_of(a.caller.key, &a.swap, &a.maker);
    let (ctr, deposit_state) = match a.swap.state {
        state::HOLD => {
            // Anyone once the hold is over; the operator at any time.
            if !who.operator {
                gate_from(now, a.swap.t_hold())?;
            }
            (counter::DEPOSITS_RETURNED, deposit_state::RETURNED)
        }
        state::WITHHELD => {
            require!(who.operator, SwapError::Unauthorized);
            (counter::RELEASES, deposit_state::RELEASED)
        }
        _ => return err!(SwapError::BadState),
    };
    let amount = a.swap.deposit;
    a.swap.deposit_state = deposit_state;
    a.settle(ctr, now);
    emit!(DepositReleased { swap: a.swap.key(), maker: a.maker.key(), counter: ctr, at: now, amount });
    let maker_wallet = a.maker.operator;
    a.finish(&[Payout { to: Party::Taker, amount }], maker_wallet, Tail::default(), ctr, now)
}

pub fn split_deposit(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    require!(a.swap.state == state::WITHHELD, SwapError::BadState);
    gate_from(now, a.swap.t_split())?;
    let ctr = counter::SPLITS;
    let d = a.swap.deposit;
    // ceil(D / 2) to the taker, floor(D / 2) to the treasury (or burned).
    let to_treasury = d / 2;
    let to_taker = d - to_treasury;
    a.swap.deposit_state = deposit_state::SPLIT;
    a.settle(ctr, now);
    emit!(DepositSplit { swap: a.swap.key(), maker: a.maker.key(), counter: ctr, at: now, to_taker, to_treasury });
    let maker_wallet = a.maker.operator;
    let burn = a.config.split_mode == 1;
    a.finish(
        &[Payout { to: Party::Taker, amount: to_taker }, Payout { to: Party::Treasury, amount: to_treasury }],
        maker_wallet,
        Tail { burn, ..Tail::default() },
        ctr,
        now,
    )
}

// ------------------------------------------------------------------ housekeeping

/// Pull a parked payout. `who`: 0 taker (signer: the taker's wallet; any destination), 1 maker
/// (signer: the maker's owner; any destination), 2 treasury (anyone; destination pinned).
/// Carries no secret, so it may fail.
pub fn withdraw_owed(ctx: Context<Settle>, who: u8) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(false)?;
    let now = util::now()?;
    let caller = caller_of(a.caller.key, &a.swap, &a.maker);
    let (party, authorised, owed) = match who {
        0 => (Party::Taker, caller.taker_wallet, a.swap.owed_taker),
        1 => (Party::Maker, caller.owner, a.swap.owed_maker),
        2 => (Party::Treasury, true, a.swap.owed_treasury),
        _ => return Err(invalid_arg()),
    };
    require!(authorised, SwapError::Unauthorized);
    require!(owed > 0, SwapError::NothingOwed);

    if a.swap.asset == ASSET_USDC {
        let dest = match party {
            Party::Taker => a.taker_token.as_ref(),
            Party::Maker => a.maker_token.as_ref(),
            Party::Treasury => a.treasury_vault.as_ref(),
        }
        .ok_or(SwapError::WrongAsset)?;
        if party == Party::Treasury {
            let mint_key = a.mint.as_ref().unwrap().key();
            let (expected, _) = Pubkey::find_program_address(&[b"treasury_vault", mint_key.as_ref()], &crate::ID);
            require_keys_eq!(dest.key(), expected, SwapError::Unauthorized);
        }
        a.vault_transfer(dest, owed)?;
    } else {
        let dest = match party {
            Party::Taker => a.taker.to_account_info(),
            Party::Maker => a.maker_wallet.to_account_info(),
            Party::Treasury => {
                require_keys_eq!(a.treasury.key(), a.treasury_pda()?, SwapError::Unauthorized);
                a.treasury.to_account_info()
            }
        };
        require_keys_neq!(dest.key(), a.swap.key(), SwapError::Unauthorized);
        a.swap.sub_lamports(owed)?;
        dest.add_lamports(owed)?;
    }
    let s = &mut a.swap;
    match party {
        Party::Taker => s.owed_taker = 0,
        Party::Maker => s.owed_maker = 0,
        Party::Treasury => s.owed_treasury = 0,
    }
    emit!(OwedWithdrawn { swap: s.key(), maker: s.maker, counter: counter::NONE, at: now, who, amount: owed });
    Ok(())
}

/// Close a settled swap, all rent to the taker. A stranger can never close an account that
/// holds a revealed scalar: the party that did not reveal still has to read it.
pub fn close_swap(ctx: Context<Settle>) -> Result<()> {
    let a = ctx.accounts;
    a.check_accounts(true)?;
    let now = util::now()?;
    let s = &a.swap;
    require!(
        s.state == state::DONE && s.owed_taker == 0 && s.owed_maker == 0 && s.owed_treasury == 0,
        SwapError::NotClosable
    );
    if s.has(flag::REVEALED) {
        let who = caller_of(a.caller.key, s, &a.maker);
        let is_a = s.is_a();
        // The party that needs the revealed scalar: the claimer after a refund, the locker
        // after a claim.
        let reader = if s.has(flag::REVEALER_LOCKER) { who.claimer(is_a) } else { who.locker(is_a) };
        let grace_over = now >= s.t_settled.saturating_add(CLOSE_GRACE_SECS);
        require!(reader || (who.taker && grace_over), SwapError::Unauthorized);
    }
    let maker_wallet = a.maker.operator;
    a.finish(&[], maker_wallet, Tail { sweep: true, close: true, must_close: true, burn: false }, counter::NONE, now)
}
