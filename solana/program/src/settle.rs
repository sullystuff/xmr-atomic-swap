//! Progress, settlement and housekeeping (SPEC 3.4 to 3.6, 4.5, 11.1, 11.2, 11.6).
//!
//! **The rules are not here.** Whether a call is allowed, which row it is, who it pays and what
//! the swap looks like afterwards are decided by `escrow-logic` (`machine::gate`, `plan`,
//! `execute_plan`), the crate the reference model is built on and the Kani proofs cover. This
//! file supplies what the rules cannot know and carries out what they decide:
//!
//! 1. it works out who signed, whether the secret, the evidence or the open hash matches, and
//!    asks the gate;
//! 2. for every payout of the row's plan it works out whether the destination can receive
//!    **now** (pay or park), creating the payout's token account first where SPEC 11.2 allows;
//! 3. it lets the rules compute the new record and writes it, with the maker's counters and
//!    the asset's open value (SPEC 11.1);
//! 4. it moves the funds the rules said move.
//!
//! **Invariant 3.** Nothing in this file reads a cap, a pause bit, an epoch or the caps switch,
//! and `split_mode` is read only to choose where the treasury's half of a split is *tried*: the
//! wrong account in that slot parks the half, it never fails the instruction.
//!
//! **Pay or park.** A payout either moves now or stays in escrow and is added to `owed_*`; a
//! payout never fails an instruction. `claim` and `refund` publish a secret in their arguments,
//! so nothing after the secret check may fail.
//!
//! **Order of effects.** Lamports moved by hand (`sub_lamports` / `add_lamports`, closing the
//! swap account) must come after every CPI in the instruction: the runtime compares the
//! caller's lamport total when a CPI starts, and an account that is not passed to that CPI has
//! not been written back yet. So: token CPIs, then the session-key sweep (a system transfer),
//! then SOL payouts and the close.
use anchor_lang::{prelude::*, system_program};
use anchor_spl::{associated_token, associated_token::get_associated_token_address, token};
use escrow_logic::machine as m;

use crate::{
    admin::invalid_arg, args::Evidence, constants::*, contexts::*, curve::scalar_matches, errors::SwapError,
    events::*, logic, state::*, util,
};

pub const INCINERATOR_ID: Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

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

// ------------------------------------------------------------------ the accounts of a settlement

/// The accounts of the Settle list (and, for `claim` and `withdraw_owed`, the payout accounts),
/// whichever of the two account structs they came from.
pub struct Ctx<'a, 'info> {
    caller: AccountInfo<'info>,
    swap: &'a mut Box<Account<'info, Swap>>,
    maker: &'a mut Box<Account<'info, Maker>>,
    config: &'a mut Box<Account<'info, Config>>,
    taker: AccountInfo<'info>,
    maker_wallet: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    mint: Option<AccountInfo<'info>>,
    vault: Option<AccountInfo<'info>>,
    taker_token: Option<AccountInfo<'info>>,
    maker_token: Option<AccountInfo<'info>>,
    treasury_vault: Option<AccountInfo<'info>>,
    token_program: Option<AccountInfo<'info>>,
    payout: Option<AccountInfo<'info>>,
    payout_token: Option<AccountInfo<'info>>,
    ata_program: Option<AccountInfo<'info>>,
}

fn info<'info, T: ToAccountInfo<'info>>(a: &Option<T>) -> Option<AccountInfo<'info>> {
    a.as_ref().map(|x| x.to_account_info())
}

impl<'info> Settle<'info> {
    #[inline(never)]
    fn ctx<'a>(&'a mut self) -> Ctx<'a, 'info> {
        Ctx {
            caller: self.caller.to_account_info(),
            taker: self.taker.to_account_info(),
            maker_wallet: self.maker_wallet.to_account_info(),
            treasury: self.treasury.to_account_info(),
            system_program: self.system_program.to_account_info(),
            mint: info(&self.mint),
            vault: info(&self.vault),
            taker_token: info(&self.taker_token),
            maker_token: info(&self.maker_token),
            treasury_vault: info(&self.treasury_vault),
            token_program: info(&self.token_program),
            payout: None,
            payout_token: None,
            ata_program: None,
            swap: &mut self.swap,
            maker: &mut self.maker,
            config: &mut self.config,
        }
    }
}

impl<'info> SettlePayout<'info> {
    #[inline(never)]
    fn ctx<'a>(&'a mut self) -> Ctx<'a, 'info> {
        Ctx {
            caller: self.caller.to_account_info(),
            taker: self.taker.to_account_info(),
            maker_wallet: self.maker_wallet.to_account_info(),
            treasury: self.treasury.to_account_info(),
            system_program: self.system_program.to_account_info(),
            mint: info(&self.mint),
            vault: info(&self.vault),
            taker_token: info(&self.taker_token),
            maker_token: info(&self.maker_token),
            treasury_vault: info(&self.treasury_vault),
            token_program: info(&self.token_program),
            payout: Some(self.payout.to_account_info()),
            payout_token: info(&self.payout_token),
            // Any other account in this slot simply means "no token account will be created".
            ata_program: info(&self.associated_token_program).filter(|p| *p.key == associated_token::ID && p.executable),
            swap: &mut self.swap,
            maker: &mut self.maker,
            config: &mut self.config,
        }
    }
}

/// Where one payout goes, once the accounts have been checked.
enum Target<'info> {
    /// The destination cannot receive now: park.
    Park,
    /// Lamports, moved by hand out of the swap account.
    Sol(AccountInfo<'info>),
    /// Tokens, transferred out of the vault.
    Token(AccountInfo<'info>),
    /// Tokens, burned out of the vault (`split_mode = 1`).
    Burn,
}

/// What the tail of a settling instruction does besides paying.
#[derive(Clone, Copy, Default)]
struct Tail {
    /// Return a session-key signer's remaining lamports to the taker.
    sweep: bool,
    /// `split_deposit`: the treasury accounts are tried, never required.
    split: bool,
}

impl<'a, 'info> Ctx<'a, 'info> {
    fn usdc(&self) -> bool {
        self.swap.asset == ASSET_USDC
    }

    fn treasury_pda(&self) -> Result<Pubkey> {
        Pubkey::create_program_address(&[b"treasury", &[self.config.treasury_bump]], &crate::ID)
            .map_err(|_| error!(ErrorCode::ConstraintSeeds))
    }

    fn treasury_vault_pda(&self) -> Pubkey {
        let mint = self.mint.as_ref().map(|m| *m.key).unwrap_or_default();
        Pubkey::find_program_address(&[b"treasury_vault", mint.as_ref()], &crate::ID).0
    }

    /// Checks every instruction on this list shares. Addresses that can never change are hard
    /// requirements (a wrong one is the caller's mistake, like naming the wrong swap); a
    /// destination's *state* is never one.
    fn check_accounts(&self, taker_is_pinned: bool) -> Result<()> {
        require_keys_eq!(self.swap.maker, self.maker.key(), SwapError::Unauthorized);
        if taker_is_pinned {
            require_keys_eq!(*self.taker.key, self.swap.taker, SwapError::Unauthorized);
        }
        if self.usdc() {
            let (Some(mint), Some(vault), Some(_)) = (&self.mint, &self.vault, &self.token_program) else {
                return err!(SwapError::WrongAsset);
            };
            require_keys_eq!(*mint.key, self.config.usdc_mint, SwapError::MintNotAllowed);
            let swap_key = self.swap.key();
            let expected =
                Pubkey::create_program_address(&[b"vault", swap_key.as_ref(), &[self.swap.vault_bump]], &crate::ID)
                    .map_err(|_| error!(ErrorCode::ConstraintSeeds))?;
            require_keys_eq!(*vault.key, expected, ErrorCode::ConstraintSeeds);
        }
        Ok(())
    }

    fn vault_state(&self) -> Option<(u64, u8)> {
        token_view(self.vault.as_ref()?).map(|(_, _, amount, state)| (amount, state))
    }

    /// A frozen (or missing) escrow can pay nobody.
    fn vault_usable(&self) -> bool {
        matches!(self.vault_state(), Some((_, TOKEN_INITIALIZED)))
    }

    /// Token transfer out of the vault, signed by the swap PDA.
    fn vault_transfer(&self, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        let (mint, vault, token_program) = (
            self.mint.as_ref().ok_or(SwapError::WrongAsset)?,
            self.vault.as_ref().ok_or(SwapError::WrongAsset)?,
            self.token_program.as_ref().ok_or(SwapError::WrongAsset)?,
        );
        let seeds: &[&[u8]] = &[b"swap", self.swap.taker.as_ref(), &self.swap.swap_nonce, &[self.swap.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program.clone(),
                token::TransferChecked {
                    from: vault.clone(),
                    mint: mint.clone(),
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
            self.mint.as_ref().ok_or(SwapError::WrongAsset)?,
            self.vault.as_ref().ok_or(SwapError::WrongAsset)?,
            self.token_program.as_ref().ok_or(SwapError::WrongAsset)?,
        );
        let seeds: &[&[u8]] = &[b"swap", self.swap.taker.as_ref(), &self.swap.swap_nonce, &[self.swap.bump]];
        token::burn(
            CpiContext::new_with_signer(
                token_program.clone(),
                token::Burn { mint: mint.clone(), from: vault.clone(), authority: self.swap.to_account_info() },
                &[seeds],
            ),
            amount,
        )
    }

    /// SPEC 11.2: create the payout's associated token account at the caller's cost, when every
    /// precondition holds, so that the creation cannot fail the instruction. Returns whether the
    /// account exists and can receive afterwards.
    fn ensure_payout_token(&self, owner: &Pubkey, rent: &Rent) -> Result<bool> {
        let (Some(dest), Some(mint), Some(wallet), Some(token_program)) =
            (&self.payout_token, &self.mint, &self.payout, &self.token_program)
        else {
            return Ok(false);
        };
        if token_can_receive(dest, mint.key, owner) {
            return Ok(true);
        }
        let Some(ata_program) = &self.ata_program else {
            return Ok(false);
        };
        // Only an address nothing lives at yet; only for the wallet the proceeds belong to; only
        // if the caller is an ordinary wallet that keeps its own rent after paying this one.
        let creatable = *dest.owner == system_program::ID
            && dest.data_is_empty()
            && dest.is_writable
            && wallet.key == owner
            && *self.caller.owner == system_program::ID
            && self.caller.data_is_empty()
            && self.caller.lamports()
                >= rent.minimum_balance(TOKEN_ACCOUNT_LEN).saturating_add(rent.minimum_balance(0));
        if !creatable {
            return Ok(false);
        }
        associated_token::create_idempotent(CpiContext::new(
            ata_program.clone(),
            associated_token::Create {
                payer: self.caller.clone(),
                associated_token: dest.clone(),
                authority: wallet.clone(),
                mint: mint.clone(),
                system_program: self.system_program.clone(),
                token_program: token_program.clone(),
            },
        ))?;
        Ok(token_can_receive(dest, mint.key, owner))
    }

    /// Where a payout of `row` to `to` goes, and whether it can land now.
    fn target(&self, row: m::Row, to: m::Party, amount: u64, tail: Tail, rent: &Rent) -> Result<Target<'info>> {
        let usdc = self.usdc();
        if usdc && !self.vault_usable() {
            return Ok(Target::Park);
        }
        let is_claim = matches!(row, m::Row::Claim { .. });
        let mint_key = self.mint.as_ref().map(|a| *a.key).unwrap_or_default();
        // A direction-B claim pays the payout address named at take, whoever submits it
        // (SPEC 11.2). Everything else a taker is paid returns to the wallet that opened the swap.
        if matches!(to, m::Party::Payout) || (is_claim && matches!(to, m::Party::Taker)) {
            let owner = self.swap.payout;
            let wallet = self.payout.as_ref().ok_or(SwapError::Unauthorized)?;
            require_keys_eq!(*wallet.key, owner, SwapError::Unauthorized);
            if !usdc {
                return Ok(if sol_can_receive(wallet, amount, rent) { Target::Sol(wallet.clone()) } else { Target::Park });
            }
            let Some(dest) = &self.payout_token else {
                return Ok(Target::Park);
            };
            require_keys_eq!(*dest.key, get_associated_token_address(&owner, &mint_key), SwapError::Unauthorized);
            return Ok(if self.ensure_payout_token(&owner, rent)? { Target::Token(dest.clone()) } else { Target::Park });
        }
        match to {
            m::Party::Taker => {
                if !usdc {
                    return Ok(if sol_can_receive(&self.taker, amount, rent) {
                        Target::Sol(self.taker.clone())
                    } else {
                        Target::Park
                    });
                }
                // The address is fixed for the life of the swap: a missing or wrong one is the
                // caller's mistake and is refused (otherwise any caller of a keyless instruction
                // could force the taker's money to be parked).
                let dest = self.taker_token.as_ref().ok_or(SwapError::WrongAsset)?;
                require_keys_eq!(
                    *dest.key,
                    get_associated_token_address(&self.swap.taker, &mint_key),
                    SwapError::Unauthorized
                );
                Ok(if token_can_receive(dest, &mint_key, &self.swap.taker) { Target::Token(dest.clone()) } else { Target::Park })
            }
            m::Party::Maker => {
                // A claim pays the payout address the cold owner key set; a refund returns to the
                // operator that funded. Either can change under a transaction in flight: park,
                // never fail.
                let wallet = if is_claim { self.maker.payout } else { self.maker.operator };
                if !usdc {
                    let ok = *self.maker_wallet.key == wallet && sol_can_receive(&self.maker_wallet, amount, rent);
                    return Ok(if ok { Target::Sol(self.maker_wallet.clone()) } else { Target::Park });
                }
                let Some(dest) = &self.maker_token else {
                    return Ok(Target::Park);
                };
                let ok = *dest.key == get_associated_token_address(&wallet, &mint_key)
                    && token_can_receive(dest, &mint_key, &wallet);
                Ok(if ok { Target::Token(dest.clone()) } else { Target::Park })
            }
            m::Party::Treasury => {
                let burn = tail.split && self.config.split_mode == 1;
                if !usdc {
                    let expected = if burn { INCINERATOR_ID } else { self.treasury_pda()? };
                    if *self.treasury.key != expected {
                        // SPEC 11.1: the admin's `split_mode` names the account a split expects.
                        // Flipping it must not fail a split in flight: the half is parked.
                        require!(tail.split, SwapError::Unauthorized);
                        return Ok(Target::Park);
                    }
                    return Ok(if sol_can_receive(&self.treasury, amount, rent) {
                        Target::Sol(self.treasury.clone())
                    } else {
                        Target::Park
                    });
                }
                if burn {
                    return Ok(Target::Burn);
                }
                let expected = self.treasury_vault_pda();
                let dest = match &self.treasury_vault {
                    Some(d) if *d.key == expected => d,
                    _ if tail.split => return Ok(Target::Park),
                    Some(_) => return err!(SwapError::Unauthorized),
                    None => return err!(SwapError::WrongAsset),
                };
                Ok(if token_can_receive(dest, &mint_key, &self.treasury_pda()?) { Target::Token(dest.clone()) } else { Target::Park })
            }
            m::Party::Payout => err!(SwapError::Unauthorized), // handled above
        }
    }

    /// Return a session-key signer's remaining lamports to the taker so the throwaway key ends
    /// at exactly zero (the fee was deducted before execution). If the taker cannot hold them
    /// they go to the swap account, which returns every lamport to the taker when it closes.
    fn sweep_session(&self, rent: &Rent) -> Result<()> {
        let caller = &self.caller;
        if *caller.key != self.swap.session_key || *caller.key == self.swap.taker {
            return Ok(());
        }
        let left = caller.lamports();
        if left == 0 || *caller.owner != system_program::ID || !caller.data_is_empty() {
            return Ok(());
        }
        let to = if *self.taker.key == self.swap.taker && sol_can_receive(&self.taker, left, rent) {
            self.taker.clone()
        } else {
            self.swap.to_account_info()
        };
        system_program::transfer(
            CpiContext::new(self.system_program.clone(), system_program::Transfer { from: caller.clone(), to }),
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
            let mint_key = self.mint.as_ref().map(|a| *a.key).unwrap_or_default();
            let to_treasury = match &self.treasury_vault {
                Some(dest) => {
                    *dest.key == self.treasury_vault_pda() && token_can_receive(dest, &mint_key, &self.treasury_pda()?)
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
            self.token_program.as_ref().ok_or(SwapError::WrongAsset)?.clone(),
            token::CloseAccount {
                account: self.vault.as_ref().ok_or(SwapError::WrongAsset)?.clone(),
                destination: self.taker.clone(),
                authority: self.swap.to_account_info(),
            },
            &[seeds],
        ))?;
        Ok(true)
    }

    /// The rent goes to the taker, so the taker must be able to hold lamports.
    fn taker_holds_lamports(&self) -> bool {
        *self.taker.key == self.swap.taker && !self.taker.executable && self.taker.is_writable
    }

    /// One call on an existing swap, from the gate to the last lamport. Returns the row and what
    /// it did, for the caller's own fields (the secret, the evidence) and its event.
    #[inline(never)]
    fn run(&mut self, call: &m::Call, tail: Tail, now: i64) -> Result<(m::Row, m::Effects)> {
        self.check_accounts(true)?;
        let rent = Rent::get()?;
        let asset = self.swap.asset;
        let usdc = self.usdc();
        let v = logic::view(&self.swap);

        // 1. The gate: the swap, the call, who signed and the time. Nothing else.
        let row = logic::decide(&v, call, self.caller.key, &self.swap, &self.maker, now)?;

        // 2. The plan, and for each payout whether it can land now.
        let plan = m::plan(&v, row);
        let mut targets: [Target<'info>; m::MAX_PAYOUTS] = [Target::Park, Target::Park];
        let mut can = [true; 4];
        for (i, line) in plan.pays.iter().enumerate() {
            if line.amount == 0 || line.park {
                continue;
            }
            targets[i] = self.target(row, line.to, logic::amount(line.amount)?, tail, &rent)?;
            if matches!(targets[i], Target::Park) {
                can[logic::party_index(line.to)] = false;
            }
        }

        // 3. The record after the call, the maker's counters, the open value (SPEC 11.1: one
        //    subtraction, at the transition that leaves the open states; it cannot fail).
        let fx = m::execute_plan(&v, row, &plan, now, &logic::env(&self.config, asset, can), logic::CONSTS);
        logic::store(self.swap, &fx.state)?;
        logic::record(self.maker, asset, &fx);
        self.config.open_value[(asset as usize).min(1)] = u64::try_from(fx.open_value_after).unwrap_or(u64::MAX);
        let ctr = fx.counter.unwrap_or(counter::NONE);
        let (swap_key, maker_key) = (self.swap.key(), self.maker.key());
        for p in fx.payouts.as_slice().iter().filter(|p| p.parked) {
            emit!(PayoutParked {
                swap: swap_key,
                maker: maker_key,
                counter: ctr,
                at: now,
                who: who_of(p.to),
                amount: logic::amount(p.amount)?,
            });
        }

        // 4. The funds. Token CPIs first.
        let paid = fx.payouts.as_slice();
        if usdc {
            for (i, p) in paid.iter().enumerate().filter(|(_, p)| !p.parked) {
                let amount = logic::amount(p.amount)?;
                match &targets[line_of(&plan, i)] {
                    Target::Token(dest) => self.vault_transfer(dest, amount)?,
                    Target::Burn => self.vault_burn(amount)?,
                    _ => return err!(SwapError::MathOverflow), // unreachable: not parked means a target
                }
            }
        }
        // A row marked "closed" closes the swap in the same instruction when nothing was parked
        // (the rules say so) and the accounts allow it; otherwise it stays DONE for `close_swap`.
        let mut closing = fx.closed && self.taker_holds_lamports();
        if closing && usdc {
            closing = self.close_vault()?;
        }
        if tail.sweep {
            self.sweep_session(&rent)?;
        }
        if !usdc {
            for (i, p) in paid.iter().enumerate().filter(|(_, p)| !p.parked) {
                let amount = logic::amount(p.amount)?;
                match &targets[line_of(&plan, i)] {
                    Target::Sol(dest) => {
                        self.swap.sub_lamports(amount)?;
                        dest.add_lamports(amount)?;
                    }
                    _ => return err!(SwapError::MathOverflow), // unreachable
                }
            }
        }
        if closing {
            emit!(SwapClosed { swap: swap_key, maker: maker_key, counter: counter::NONE, at: now });
            self.swap.close(self.taker.clone())?;
        }
        Ok((row, fx))
    }
}

/// The `who` byte of `PayoutParked` and `OwedWithdrawn`: 0 taker (or its payout address),
/// 1 maker, 2 treasury.
fn who_of(p: m::Party) -> u8 {
    match p {
        m::Party::Taker | m::Party::Payout => 0,
        m::Party::Maker => 1,
        m::Party::Treasury => 2,
    }
}

/// The plan line behind the `i`-th payout of the effects (lines with a zero amount are skipped
/// by the rules, in order).
fn line_of(plan: &m::Plan, i: usize) -> usize {
    let mut seen = 0;
    for (k, line) in plan.pays.iter().enumerate() {
        if line.amount == 0 {
            continue;
        }
        if seen == i {
            return k;
        }
        seen += 1;
    }
    0
}

fn total_for(fx: &m::Effects, to: m::Party) -> u64 {
    u64::try_from(fx.payouts.total_for(to)).unwrap_or(u64::MAX)
}

// ------------------------------------------------------------------ pending exits

fn reason_of(reason: u8) -> m::RejectReason {
    match reason {
        0 => m::RejectReason::MakerChoice,
        1 => m::RejectReason::UnusableInput,
        _ => m::RejectReason::LeafConsumed,
    }
}

/// A3, B3.
pub fn reject(ctx: Context<Settle>, expected_open: [u8; 32], reason: u8) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    // A reason the protocol does not define matches no row.
    let open_ok = reason <= 2 && c.swap.open_hash(&swap_key) == expected_open;
    let (_, fx) = c.run(&m::Call::Reject { open_ok, reason: reason_of(reason) }, Tail::default(), now)?;
    emit!(SwapRejected { swap: swap_key, maker: maker_key, counter: fx.counter.unwrap_or(counter::NONE), at: now });
    Ok(())
}

/// A4, B2.
pub fn cancel_pending(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let (_, fx) = c.run(&m::Call::CancelPending, Tail { sweep: true, ..Tail::default() }, now)?;
    emit!(PendingCancelled { swap: swap_key, maker: maker_key, counter: fx.counter.unwrap_or(counter::NONE), at: now });
    Ok(())
}

/// A5, B4.
pub fn expire_pending(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let (_, fx) = c.run(&m::Call::ExpirePending, Tail::default(), now)?;
    emit!(PendingExpired { swap: swap_key, maker: maker_key, counter: fx.counter.unwrap_or(counter::NONE), at: now });
    Ok(())
}

// ------------------------------------------------------------------ progress (Short list)

/// A call on the Short list: no funds move and the open value does not change (none of these
/// rows leaves the open states), so `config` is only read.
#[inline(never)]
fn short(a: &mut Short, call: &m::Call, now: i64) -> Result<(m::Row, m::Effects)> {
    require_keys_eq!(a.swap.maker, a.maker.key(), SwapError::Unauthorized);
    let v = logic::view(&a.swap);
    let row = logic::decide(&v, call, a.caller.key, &a.swap, &a.maker, now)?;
    let fx = m::execute(&v, row, now, &logic::env(&a.config, a.swap.asset, [true; 4]), logic::CONSTS);
    logic::store(&mut a.swap, &fx.state)?;
    logic::record(&mut a.maker, a.swap.asset, &fx);
    Ok((row, fx))
}

/// A6, B6.
pub fn post_notice(ctx: Context<Short>, commitment: [u8; 32], ciphertext: [u8; 104]) -> Result<()> {
    let a = ctx.accounts;
    let now = util::now()?;
    short(a, &m::Call::PostNotice, now)?;
    a.swap.notice_commitment = commitment;
    a.swap.notice_ct = ciphertext;
    emit!(NoticePosted { swap: a.swap.key(), maker: a.maker.key(), counter: counter::NOTICES, at: now, commitment });
    Ok(())
}

/// A9, B7, Z2 (unfreezing).
pub fn set_ready(ctx: Context<Short>) -> Result<()> {
    let a = ctx.accounts;
    let now = util::now()?;
    short(a, &m::Call::SetReady, now)?;
    emit!(ReadySet { swap: a.swap.key(), maker: a.maker.key(), counter: counter::READIES, at: now });
    Ok(())
}

/// Z1 (SPEC 11.6): the watcher the swap names, or the locker, pauses the claimer's
/// claim-without-ready until `T_ff = max(t_Z + W_z, T_co)`. It reveals nothing and moves nothing.
pub fn freeze(ctx: Context<Short>) -> Result<()> {
    let a = ctx.accounts;
    let now = util::now()?;
    let (_, fx) = short(a, &m::Call::Freeze, now)?;
    emit!(Frozen {
        swap: a.swap.key(),
        maker: a.maker.key(),
        counter: counter::FREEZES,
        at: now,
        taker: a.swap.taker,
        watcher: a.swap.watcher,
        frozen_until: fx.state.t_ff(),
    });
    Ok(())
}

/// SPEC 3.6: the maker keeps the deposit in escrow past the hold.
pub fn withhold(ctx: Context<Short>, evidence: Option<Evidence>) -> Result<()> {
    let a = ctx.accounts;
    let now = util::now()?;
    let swap_key = a.swap.key();
    let opens = match &evidence {
        None => m::Evidence::Absent,
        Some(e) if Swap::notice_opening(&swap_key, &e.txid, &e.view) == a.swap.notice_commitment => m::Evidence::Opens,
        Some(_) => m::Evidence::Mismatch,
    };
    let (row, _) = short(a, &m::Call::Withhold(opens), now)?;
    let mut txid = [0u8; 32];
    let mut view = [0u8; 32];
    // Direction A with a notice on record: the maker opened its own notice and the opening is
    // kept. Anywhere else no evidence exists to demand, and any supplied is ignored.
    if let (m::Row::Withhold { evidence: true }, Some(e)) = (row, evidence) {
        a.swap.evidence_txid = e.txid;
        a.swap.evidence_view = e.view;
        txid = e.txid;
        view = e.view;
    }
    emit!(DepositWithheld {
        swap: swap_key,
        maker: a.maker.key(),
        counter: counter::WITHHOLDS,
        at: now,
        amount: a.swap.deposit,
        txid,
        view,
    });
    Ok(())
}

/// SPEC 3.6: the claimer posts the opening of its notice in clear.
pub fn publish_evidence(ctx: Context<Short>, txid: [u8; 32], view: [u8; 32]) -> Result<()> {
    let a = ctx.accounts;
    let now = util::now()?;
    let swap_key = a.swap.key();
    let opens = Swap::notice_opening(&swap_key, &txid, &view) == a.swap.notice_commitment;
    short(a, &m::Call::PublishEvidence { opens }, now)?;
    a.swap.evidence_txid = txid;
    a.swap.evidence_view = view;
    emit!(EvidencePublished { swap: swap_key, maker: a.maker.key(), counter: counter::NONE, at: now, txid, view });
    Ok(())
}

// ------------------------------------------------------------------ aborts and keyless exits

/// A7a-d, B8, Z5.
pub fn abort(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let (_, fx) = c.run(&m::Call::Abort, Tail::default(), now)?;
    emit!(Aborted {
        swap: swap_key,
        maker: maker_key,
        counter: fx.counter.unwrap_or(counter::NONE),
        at: now,
        new_state: fx.state.state as u8,
    });
    Ok(())
}

/// A8.
pub fn refund_unnoticed(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let (_, fx) = c.run(&m::Call::RefundUnnoticed, Tail::default(), now)?;
    emit!(RefundedKeyless { swap: swap_key, maker: maker_key, counter: fx.counter.unwrap_or(counter::NONE), at: now });
    Ok(())
}

/// B11.
pub fn expire_unnoticed(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let (_, fx) = c.run(&m::Call::ExpireUnnoticed, Tail::default(), now)?;
    emit!(ExpiredUnnoticed { swap: swap_key, maker: maker_key, counter: fx.counter.unwrap_or(counter::NONE), at: now });
    Ok(())
}

// ------------------------------------------------------------------ secret-bearing calls

/// A10a-g, B9a-h, Z3.
pub fn refund(ctx: Context<Settle>, secret: [u8; 32]) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let is_a = c.swap.is_a();
    // The locker's commitment: A the taker's, B the maker's.
    let secret_ok = scalar_matches(&secret, if is_a { &c.swap.taker_spend_pub } else { &c.swap.maker_spend_pub });
    let (row, fx) = c.run(&m::Call::Refund { secret_ok }, Tail { sweep: is_a, ..Tail::default() }, now)?;
    // The other side recovers its XMR with this scalar: it is account state, not only an event.
    c.swap.revealed = secret;
    emit!(Refunded {
        swap: swap_key,
        maker: maker_key,
        counter: fx.counter.unwrap_or(counter::NONE),
        at: now,
        secret,
        deposit_held: matches!(row, m::Row::Refund { held: true, .. }),
    });
    Ok(())
}

/// A11a-c, B10a-c, Z4. In direction B the proceeds go to the payout address named at `take`
/// and to no other, whoever submits the claim (SPEC 11.2).
pub fn claim(ctx: Context<SettlePayout>, secret: [u8; 32]) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let is_a = c.swap.is_a();
    if is_a {
        require_keys_eq!(c.payout.as_ref().map(|p| *p.key).unwrap_or_default(), c.swap.taker, SwapError::Unauthorized);
    }
    // The claimer's commitment: A the maker's, B the taker's.
    let secret_ok = scalar_matches(&secret, if is_a { &c.swap.maker_spend_pub } else { &c.swap.taker_spend_pub });
    let (_, fx) = c.run(&m::Call::Claim { secret_ok }, Tail { sweep: !is_a, ..Tail::default() }, now)?;
    c.swap.revealed = secret;
    let fee = total_for(&fx, m::Party::Treasury);
    let paid = total_for(&fx, m::Party::Maker)
        .saturating_add(total_for(&fx, m::Party::Taker))
        .saturating_add(total_for(&fx, m::Party::Payout));
    emit!(Claimed { swap: swap_key, maker: maker_key, counter: fx.counter.unwrap_or(counter::NONE), at: now, secret, paid, fee });
    Ok(())
}

// ------------------------------------------------------------------ deposit sub-machine

pub fn release_deposit(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let (_, fx) = c.run(&m::Call::ReleaseDeposit, Tail::default(), now)?;
    emit!(DepositReleased {
        swap: swap_key,
        maker: maker_key,
        counter: fx.counter.unwrap_or(counter::NONE),
        at: now,
        amount: total_for(&fx, m::Party::Taker),
    });
    Ok(())
}

/// `ceil(D / 2)` to the taker, `floor(D / 2)` to the treasury, or burned when `split_mode` is 1.
/// The treasury's half is parked if the account given for it is not the one the current mode
/// names: an admin flipping the mode cannot fail a split in flight (SPEC 11.1).
pub fn split_deposit(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let mut c = ctx.accounts.ctx();
    let (swap_key, maker_key) = (c.swap.key(), c.maker.key());
    let (_, fx) = c.run(&m::Call::SplitDeposit, Tail { split: true, ..Tail::default() }, now)?;
    emit!(DepositSplit {
        swap: swap_key,
        maker: maker_key,
        counter: fx.counter.unwrap_or(counter::NONE),
        at: now,
        to_taker: total_for(&fx, m::Party::Taker),
        to_treasury: total_for(&fx, m::Party::Treasury),
    });
    Ok(())
}

// ------------------------------------------------------------------ housekeeping

/// Pull a parked payout. It carries no secret, so it may fail.
///
/// * `who = 0`: the taker's wallet, to the destination it names in `taker` / `taker_token`.
///   On a direction-B swap that ended in a claim with a payout address other than the taker's,
///   the balance belongs to that address (SPEC 11.2): the payout address signs and names any
///   destination in `payout` / `payout_token`, or **anyone** delivers it with `payout` /
///   `payout_token` being the payout address and its associated token account (created at the
///   caller's cost when the associated-token program is passed). The taking wallet cannot
///   redirect it.
/// * `who = 1`: the maker's owner, to `maker_wallet` / `maker_token`.
/// * `who = 2`: anyone, to the treasury and nowhere else.
pub fn withdraw_owed(ctx: Context<SettlePayout>, who: u8) -> Result<()> {
    let now = util::now()?;
    let c = ctx.accounts.ctx();
    c.check_accounts(false)?;
    let rent = Rent::get()?;
    let usdc = c.usdc();
    let v = logic::view(&c.swap);
    let payout_slot = c.payout.as_ref().map(|p| *p.key).unwrap_or_default();
    let pinned = payout_slot == c.swap.payout;
    let party = match who {
        // Proceeds parked for a payout address: delivered to it, or pulled by it.
        0 if v.payout_owed() && (pinned || *c.caller.key == c.swap.payout) => m::Party::Payout,
        0 => m::Party::Taker,
        1 => m::Party::Maker,
        2 => m::Party::Treasury,
        _ => return Err(invalid_arg()),
    };
    let row = logic::decide(&v, &m::Call::WithdrawOwed(party), c.caller.key, &c.swap, &c.maker, now)?;
    let plan = m::plan(&v, row);
    let owed = logic::amount(plan.pays[0].amount)?;

    let mint_key = c.mint.as_ref().map(|a| *a.key).unwrap_or_default();
    if usdc {
        let dest = match party {
            m::Party::Taker => c.taker_token.clone(),
            m::Party::Maker => c.maker_token.clone(),
            m::Party::Treasury => {
                let dest = c.treasury_vault.clone().ok_or(SwapError::WrongAsset)?;
                require_keys_eq!(*dest.key, c.treasury_vault_pda(), SwapError::Unauthorized);
                Some(dest)
            }
            m::Party::Payout => {
                let dest = c.payout_token.clone().ok_or(SwapError::WrongAsset)?;
                // The payout address itself may name any token account; anyone else delivers to
                // its associated token account and nowhere else.
                if *c.caller.key != c.swap.payout {
                    require_keys_eq!(
                        *dest.key,
                        get_associated_token_address(&c.swap.payout, &mint_key),
                        SwapError::Unauthorized
                    );
                    c.ensure_payout_token(&c.swap.payout, &rent)?;
                }
                Some(dest)
            }
        }
        .ok_or(SwapError::WrongAsset)?;
        c.vault_transfer(&dest, owed)?;
    } else {
        let dest = match party {
            m::Party::Taker => c.taker.clone(),
            m::Party::Maker => c.maker_wallet.clone(),
            m::Party::Treasury => {
                require_keys_eq!(*c.treasury.key, c.treasury_pda()?, SwapError::Unauthorized);
                c.treasury.clone()
            }
            // Pinned to the payout address unless the payout address itself signed.
            m::Party::Payout => c.payout.clone().ok_or(SwapError::Unauthorized)?,
        };
        require_keys_neq!(*dest.key, c.swap.key(), SwapError::Unauthorized);
        c.swap.sub_lamports(owed)?;
        dest.add_lamports(owed)?;
    }
    let fx = m::execute_plan(&v, row, &plan, now, &logic::env(&c.config, c.swap.asset, [true; 4]), logic::CONSTS);
    logic::store(c.swap, &fx.state)?;
    emit!(OwedWithdrawn { swap: c.swap.key(), maker: c.swap.maker, counter: counter::NONE, at: now, who, amount: owed });
    Ok(())
}

/// Close a settled swap, all rent to the taker. A stranger can never close an account that
/// holds a revealed scalar: the party that did not reveal still has to read it.
pub fn close_swap(ctx: Context<Settle>) -> Result<()> {
    let now = util::now()?;
    let c = ctx.accounts.ctx();
    c.check_accounts(true)?;
    let s = &**c.swap;
    require!(
        s.state == state::DONE && s.owed_taker == 0 && s.owed_maker == 0 && s.owed_treasury == 0,
        SwapError::NotClosable
    );
    if s.has(flag::REVEALED) {
        let key = c.caller.key;
        let taker = *key == s.taker || *key == s.session_key;
        let operator = *key == c.maker.operator;
        let (locker, claimer) = if s.is_a() { (taker, operator) } else { (operator, taker) };
        // The party that needs the revealed scalar: the claimer after a refund, the locker
        // after a claim.
        let reader = if s.has(flag::REVEALER_LOCKER) { claimer } else { locker };
        let grace_over = now >= s.t_settled.saturating_add(CLOSE_GRACE_SECS);
        require!(reader || (taker && grace_over), SwapError::Unauthorized);
    }
    require!(c.taker_holds_lamports(), SwapError::NotClosable);
    if c.usdc() && !c.close_vault()? {
        return err!(SwapError::VaultNotEmpty);
    }
    c.sweep_session(&Rent::get()?)?;
    emit!(SwapClosed { swap: c.swap.key(), maker: c.swap.maker, counter: counter::NONE, at: now });
    c.swap.close(c.taker.clone())
}
