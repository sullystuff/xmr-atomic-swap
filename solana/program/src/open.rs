//! Opening a swap (SPEC 4.4): `lock` (A1), `take` (B1), `approve` (A2), `fund` (B5).
use anchor_lang::{prelude::*, system_program};
use anchor_spl::token;
use solana_curve25519::edwards::PodEdwardsPoint;

use crate::{
    approval,
    args::*,
    constants::*,
    contexts::*,
    curve::{self, is_canonical_nonzero_scalar, is_low_order_x25519, is_valid_key_commitment},
    errors::SwapError,
    events::*,
    state::*,
    util::{self, asset_amount, bps_of, check_bounds, create_pda_account, is_uninitialized, tier_index, Params, Pending},
};

/// What `lock` and `take` have in common.
pub struct OpenArgs {
    pub direction: u8,
    pub swap_nonce: [u8; 16],
    pub session_lamports: u64,
    pub asset: u8,
    pub xmr: u64,
    /// A: `max_pay`. B: `min_receive`.
    pub limit: u64,
    pub expected_terms_hash: [u8; 32],
    pub min_seq: u64,
    pub taker_spend_pub: [u8; 32],
    pub taker_pok: [u8; 64],
    /// A: `v_T`. B: zeros (the locker is the maker; its view share arrives with `fund`).
    pub taker_view: [u8; 32],
    pub taker_enc_key: [u8; 32],
    pub maker_enc_version: u32,
    pub key_hint: u8,
    pub approval_ix: Option<u8>,
}

impl OpenArgs {
    #[inline(never)]
    pub fn from_lock(a: LockArgs) -> Box<Self> {
        Box::new(OpenArgs {
            direction: DIR_A,
            swap_nonce: a.swap_nonce,
            session_lamports: a.session_lamports,
            asset: a.asset,
            xmr: a.xmr,
            limit: a.max_pay,
            expected_terms_hash: a.expected_terms_hash,
            min_seq: a.min_seq,
            taker_spend_pub: a.taker_spend_pub,
            taker_pok: a.taker_pok,
            taker_view: a.taker_view,
            taker_enc_key: a.taker_enc_key,
            maker_enc_version: a.maker_enc_version,
            key_hint: a.key_hint,
            approval_ix: a.approval_ix,
        })
    }
    #[inline(never)]
    pub fn from_take(a: TakeArgs) -> Box<Self> {
        Box::new(OpenArgs {
            direction: DIR_B,
            swap_nonce: a.swap_nonce,
            session_lamports: a.session_lamports,
            asset: a.asset,
            xmr: a.xmr,
            limit: a.min_receive,
            expected_terms_hash: a.expected_terms_hash,
            min_seq: a.min_seq,
            taker_spend_pub: a.taker_spend_pub,
            taker_pok: a.taker_pok,
            taker_view: [0; 32],
            taker_enc_key: a.taker_enc_key,
            maker_enc_version: a.maker_enc_version,
            key_hint: 0,
            approval_ix: a.approval_ix,
        })
    }
}

/// The terms a swap copies from its offer or quote.
struct Terms {
    offer_mode: u8,
    amount: u64,
    price: u64,
    params: Params,
}

/// Step 2 of SPEC 4.4: everything the taker supplies that the program can check by itself.
#[inline(never)]
fn check_taker_inputs(a: &OpenArgs, swap_key: &Pubkey) -> Result<()> {
    require!(
        is_valid_key_commitment(&PodEdwardsPoint(a.taker_spend_pub)),
        SwapError::InvalidKeyCommitment
    );
    require!(
        curve::pok_verify(&a.taker_spend_pub, &swap_key.to_bytes(), &a.taker_pok),
        SwapError::InvalidProofOfKnowledge
    );
    if a.direction == DIR_A {
        require!(is_canonical_nonzero_scalar(&a.taker_view), SwapError::InvalidScalar);
    }
    require!(!is_low_order_x25519(&a.taker_enc_key), SwapError::InvalidEncryptionKey);
    Ok(())
}

/// Step 3 against an offer.
#[inline(never)]
fn terms_from_offer(offer: &Offer, maker_key: &Pubkey, a: &OpenArgs, now: i64) -> Result<Terms> {
    require_keys_eq!(offer.maker, *maker_key, SwapError::Unauthorized);
    require!(offer.direction == a.direction, SwapError::WrongDirection);
    require!(offer.asset == a.asset, SwapError::WrongAsset);
    require!(offer.enabled != 0, SwapError::OfferDisabled);
    // Validity is inclusive: live while now <= updated_at + valid_secs.
    require!(now <= offer.updated_at.saturating_add(offer.valid_secs as i64), SwapError::OfferStale);
    require!(offer.seq >= a.min_seq, SwapError::SeqTooOld);
    require!(offer.terms_hash == a.expected_terms_hash, SwapError::TermsChanged);
    require!(offer.min_xmr <= a.xmr && a.xmr <= offer.max_xmr, SwapError::AmountOutOfRange);
    let tier = tier_index(a.xmr, &offer.price_above, offer.prices_used()).ok_or(SwapError::TiersInvalid)?;
    let price = offer.prices[tier];
    let amount = asset_amount(a.xmr, price, a.direction == DIR_A)?;
    if a.direction == DIR_A {
        require!(amount <= a.limit, SwapError::PriceMoved);
    } else {
        require!(amount >= a.limit, SwapError::PriceMoved);
    }
    // No used tier leaves depth 0, which the bounds refuse (DepthInvalid).
    let depth = tier_index(a.xmr, &offer.depth_above, offer.depths_used()).map(|i| offer.depths[i]).unwrap_or(0);
    Ok(Terms {
        offer_mode: offer.mode,
        amount,
        price,
        params: Params {
            w_a: offer.w_a,
            w_n: offer.w_n,
            d_c: offer.d_c,
            w_c: offer.w_c,
            w_f: offer.w_f,
            depth,
            dep_bps: offer.dep_bps,
        },
    })
}

/// Step 3 against a taker-bound quote.
#[inline(never)]
fn terms_from_quote(
    quote: &Quote,
    maker: &Maker,
    maker_key: &Pubkey,
    taker_key: &Pubkey,
    a: &OpenArgs,
    now: i64,
) -> Result<Terms> {
    require_keys_eq!(quote.maker, *maker_key, SwapError::QuoteMismatch);
    require_keys_eq!(quote.taker, *taker_key, SwapError::QuoteMismatch);
    require!(quote.direction == a.direction && quote.asset == a.asset, SwapError::QuoteMismatch);
    require!(now <= quote.expires_at, SwapError::QuoteExpired);
    require!(quote.epoch == maker.quote_epoch, SwapError::StaleEpoch);
    require!(quote.xmr == a.xmr, SwapError::QuoteMismatch);
    if a.direction == DIR_A {
        require!(quote.amount <= a.limit, SwapError::PriceMoved);
    } else {
        require!(quote.amount >= a.limit, SwapError::PriceMoved);
    }
    Ok(Terms {
        offer_mode: mode::QUOTE,
        amount: quote.amount,
        price: 0,
        params: Params {
            w_a: 0,
            w_n: quote.w_n,
            d_c: quote.d_c,
            w_c: quote.w_c,
            w_f: quote.w_f,
            depth: quote.depth,
            dep_bps: quote.dep_bps,
        },
    })
}

/// The first pool slot at or after `hint` (wrapping) that is filled and unused; marks it used.
fn take_pool_key(offer: &mut Offer, hint: u8) -> Result<[u8; 32]> {
    for i in 0..POOL_SLOTS {
        let slot = (hint as usize + i) % POOL_SLOTS;
        let bit = 1u16 << slot;
        if offer.pool_filled & bit != 0 && offer.pool_used & bit == 0 {
            offer.pool_used |= bit;
            return Ok(offer.pool[slot]);
        }
    }
    err!(SwapError::NoKeyAvailable)
}

#[inline(never)]
fn write_swap(ai: &AccountInfo, swap: &Swap) -> Result<()> {
    let mut data = ai.try_borrow_mut_data()?;
    swap.try_serialize(&mut &mut data[..])
}

pub fn open(ctx: Context<OpenSwap>, a: Box<OpenArgs>) -> Result<()> {
    let acc = ctx.accounts;
    let now = util::now()?;
    let taker_key = acc.taker.key();
    let maker_key = acc.maker.key();
    let is_a = a.direction == DIR_A;

    let (swap_key, swap_bump) =
        Pubkey::find_program_address(&[b"swap", taker_key.as_ref(), &a.swap_nonce], &crate::ID);
    require_keys_eq!(acc.swap.key(), swap_key, ErrorCode::ConstraintSeeds);
    // "No such swap": a live swap at this address cannot be overwritten.
    require!(is_uninitialized(&acc.swap), SwapError::BadState);

    // 1. The maker takes new swaps, and the taker encrypts to a key version that is still valid.
    require!(acc.maker.paused == 0, SwapError::Paused);
    let maker_enc_key = if a.maker_enc_version == acc.maker.enc_key_version {
        acc.maker.enc_key
    } else if a.maker_enc_version.checked_add(1) == Some(acc.maker.enc_key_version)
        && now < acc.maker.prev_enc_key_expires_at
    {
        acc.maker.prev_enc_key
    } else {
        return err!(SwapError::StaleKeyVersion);
    };

    // 2. The taker's share, proof, view share and encryption key; the asset and its accounts.
    check_taker_inputs(&a, &swap_key)?;
    require!(a.asset <= ASSET_USDC, SwapError::WrongAsset);
    let usdc = a.asset == ASSET_USDC;
    let token_accounts =
        acc.mint.is_some() && acc.taker_token.is_some() && acc.vault.is_some() && acc.token_program.is_some();
    let no_token_accounts =
        acc.mint.is_none() && acc.taker_token.is_none() && acc.vault.is_none() && acc.token_program.is_none();
    require!(if usdc { token_accounts } else { no_token_accounts }, SwapError::WrongAsset);
    if let Some(mint) = &acc.mint {
        require_keys_eq!(mint.key(), acc.config.usdc_mint, SwapError::MintNotAllowed);
    }

    // 3. Terms, price and size from the offer or the quote (exactly one).
    let from_quote = acc.quote.is_some();
    let terms = match (&acc.offer, &acc.quote) {
        (Some(offer), None) => terms_from_offer(offer, &maker_key, &a, now)?,
        (None, Some(quote)) => {
            let receiver = acc.quote_rent_receiver.as_ref().ok_or(SwapError::QuoteMismatch)?;
            require_keys_eq!(receiver.key(), acc.maker.operator, SwapError::Unauthorized);
            terms_from_quote(quote, &acc.maker, &maker_key, &taker_key, &a, now)?
        }
        _ => return err!(SwapError::BadState),
    };

    // 4. An advance approval, when one is presented, must be valid for this lock.
    let approved = match a.approval_ix {
        Some(index) => {
            let sysvar = acc.instructions_sysvar.as_ref().ok_or(SwapError::SignatureInstructionInvalid)?;
            let approval = approval::load(
                sysvar,
                index,
                &acc.maker.operator,
                &acc.config.cluster_tag,
                &crate::ID,
                &maker_key,
                &taker_key,
            )?;
            require!(
                approval.admits(now, a.asset, a.direction, a.xmr, acc.maker.approval_epoch),
                SwapError::ApprovalInvalid
            );
            true
        }
        None => false,
    };

    // 5. The start state (SPEC 3.8).
    require!(terms.offer_mode != mode::ADVANCE || approved, SwapError::ApprovalRequired);
    let effective = match terms.offer_mode {
        mode::QUOTE => mode::QUOTE,
        mode::AUTO => mode::AUTO,
        _ if approved => mode::ADVANCE,
        m => m,
    };
    let window = effective == mode::WINDOW;
    let pending = match (is_a, window) {
        (_, true) => Pending::ApprovalWindow,
        (true, false) => Pending::None,
        (false, false) => Pending::FundingWindow,
    };
    check_bounds(&terms.params, pending)?;

    let mut maker_spend_pub = [0u8; 32];
    if pending == Pending::None {
        // ACTIVE at lock: the maker's share is fixed now.
        if let Some(offer) = acc.offer.as_mut() {
            maker_spend_pub = take_pool_key(offer, a.key_hint)?;
        } else if let Some(quote) = &acc.quote {
            maker_spend_pub = quote.maker_spend_pub;
        }
    } else {
        require!(acc.maker.open_pending < MAX_OPEN_PENDING, SwapError::TooManyPending);
        acc.maker.pending_opened();
    }
    // Capacity is consumed when a swap starts bound: ACTIVE in A, any take outside window mode.
    if !window {
        if let Some(offer) = acc.offer.as_mut() {
            offer.capacity_xmr = offer.capacity_xmr.checked_sub(a.xmr).ok_or(SwapError::CapacityExceeded)?;
        }
    }

    // 6. A smaller transfer to a new address would fail the transaction.
    let rent = Rent::get()?;
    require!(a.session_lamports >= rent.minimum_balance(0), SwapError::SessionBudgetTooLow);

    // ---- effects
    let deposit = bps_of(terms.amount, terms.params.dep_bps);
    let escrow_in = if is_a { terms.amount } else { deposit };
    let system = acc.system_program.to_account_info();
    let taker_ai = acc.taker.to_account_info();
    let swap_ai = acc.swap.to_account_info();

    create_pda_account(
        &taker_ai,
        &swap_ai,
        &system,
        &crate::ID,
        SWAP_SIZE,
        &[b"swap", taker_key.as_ref(), &a.swap_nonce, &[swap_bump]],
    )?;

    let mut vault_bump = 0u8;
    if usdc {
        let (mint, taker_token, vault, token_program) = (
            acc.mint.as_ref().unwrap(),
            acc.taker_token.as_ref().unwrap(),
            acc.vault.as_ref().unwrap(),
            acc.token_program.as_ref().unwrap(),
        );
        let (vault_key, bump) = Pubkey::find_program_address(&[b"vault", swap_key.as_ref()], &crate::ID);
        require_keys_eq!(vault.key(), vault_key, ErrorCode::ConstraintSeeds);
        vault_bump = bump;
        create_pda_account(
            &taker_ai,
            &vault.to_account_info(),
            &system,
            &token::ID,
            token::TokenAccount::LEN,
            &[b"vault", swap_key.as_ref(), &[bump]],
        )?;
        token::initialize_account3(CpiContext::new(
            token_program.to_account_info(),
            token::InitializeAccount3 {
                account: vault.to_account_info(),
                mint: mint.to_account_info(),
                authority: swap_ai.clone(),
            },
        ))?;
        if escrow_in > 0 {
            token::transfer_checked(
                CpiContext::new(
                    token_program.to_account_info(),
                    token::TransferChecked {
                        from: taker_token.to_account_info(),
                        mint: mint.to_account_info(),
                        to: vault.to_account_info(),
                        authority: taker_ai.clone(),
                    },
                ),
                escrow_in,
                mint.decimals,
            )?;
        }
    } else if escrow_in > 0 {
        system_program::transfer(
            CpiContext::new(system.clone(), system_program::Transfer { from: taker_ai.clone(), to: swap_ai.clone() }),
            escrow_in,
        )?;
    }
    system_program::transfer(
        CpiContext::new(
            system.clone(),
            system_program::Transfer { from: taker_ai.clone(), to: acc.session_key.to_account_info() },
        ),
        a.session_lamports,
    )?;

    let mut swap = Swap::new_boxed();
    swap.taker = taker_key;
    swap.maker = maker_key;
    swap.direction = a.direction;
    swap.asset = a.asset;
    swap.mode = effective;
    swap.outcome = counter::NONE;
    swap.depth = terms.params.depth;
    swap.bump = swap_bump;
    swap.vault_bump = vault_bump;
    swap.swap_nonce = a.swap_nonce;
    swap.session_key = acc.session_key.key();
    swap.taker_enc_key = a.taker_enc_key;
    swap.maker_enc_version = a.maker_enc_version;
    swap.maker_enc_key = maker_enc_key;
    swap.amount = terms.amount;
    swap.deposit = deposit;
    swap.xmr = a.xmr;
    swap.price = terms.price;
    swap.dep_bps = terms.params.dep_bps;
    swap.fee_bps = FEE_BPS;
    swap.w_n = terms.params.w_n;
    swap.d_c = terms.params.d_c;
    swap.w_c = terms.params.w_c;
    swap.taker_spend_pub = a.taker_spend_pub;
    swap.maker_spend_pub = maker_spend_pub;
    swap.locker_view = a.taker_view;
    swap.t_lock = now;
    swap.t_final = now + terms.params.w_f as i64;
    if pending == Pending::None {
        swap.state = state::ACTIVE;
        swap.t_active = now;
        swap.t_note_deadline = now + terms.params.w_n as i64;
    } else {
        swap.state = state::PENDING;
        swap.t_pending_deadline = now + util::pending_window(&terms.params, pending) as i64;
    }
    write_swap(&swap_ai, &swap)?;

    let ctr = if is_a { counter::LOCKS } else { counter::TAKES };
    acc.maker.bump(ctr);
    emit!(SwapOpened {
        swap: swap_key,
        maker: maker_key,
        counter: ctr,
        at: now,
        taker: taker_key,
        direction: a.direction,
        asset: a.asset,
        mode: effective,
        state: swap.state,
        amount: swap.amount,
        deposit,
        xmr: a.xmr,
        depth: swap.depth,
    });

    // The quote is single-use: consumed and closed, rent to the operator. Last, because moving
    // lamports by hand must follow every CPI.
    if from_quote {
        let receiver = acc.quote_rent_receiver.as_ref().unwrap().to_account_info();
        acc.quote.as_ref().unwrap().close(receiver)?;
    }
    Ok(())
}

/// Validate a maker's share and its proof (`ctx` = maker PDA).
#[inline(never)]
fn check_maker_share(share: &[u8; 32], pok: &[u8; 64], maker_key: &Pubkey) -> Result<()> {
    require!(is_valid_key_commitment(&PodEdwardsPoint(*share)), SwapError::InvalidKeyCommitment);
    require!(curve::pok_verify(share, &maker_key.to_bytes(), pok), SwapError::InvalidProofOfKnowledge);
    Ok(())
}

/// A2.
pub fn approve(
    ctx: Context<Approve>,
    expected_open: [u8; 32],
    maker_spend_pub: [u8; 32],
    maker_pok: [u8; 64],
) -> Result<()> {
    let acc = ctx.accounts;
    let now = util::now()?;
    let swap_key = acc.swap.key();
    let maker_key = acc.maker.key();
    require!(acc.swap.is_a(), SwapError::WrongDirection);
    require_keys_eq!(acc.operator.key(), acc.maker.operator, SwapError::Unauthorized);
    require!(
        acc.swap.state == state::PENDING && acc.swap.open_hash(&swap_key) == expected_open,
        SwapError::BadState
    );
    require!(now < acc.swap.t_pending_deadline, SwapError::TooLate);
    check_maker_share(&maker_spend_pub, &maker_pok, &maker_key)?;

    let s = &mut acc.swap;
    s.maker_spend_pub = maker_spend_pub;
    s.state = state::ACTIVE;
    s.t_active = now;
    s.t_note_deadline = now + s.w_n as i64;
    let response = (now - s.t_lock).max(0) as u64;
    let m = &mut acc.maker;
    m.bump(counter::APPROVALS);
    m.response_secs_sum = m.response_secs_sum.saturating_add(response);
    m.pending_closed();
    emit!(SwapApproved { swap: swap_key, maker: maker_key, counter: counter::APPROVALS, at: now });
    Ok(())
}

/// B5.
pub fn fund(
    ctx: Context<Fund>,
    expected_open: [u8; 32],
    maker_spend_pub: [u8; 32],
    maker_pok: [u8; 64],
    maker_view: [u8; 32],
) -> Result<()> {
    let acc = ctx.accounts;
    let now = util::now()?;
    let swap_key = acc.swap.key();
    let maker_key = acc.maker.key();
    require!(!acc.swap.is_a(), SwapError::WrongDirection);
    require_keys_eq!(acc.operator.key(), acc.maker.operator, SwapError::Unauthorized);
    require!(
        acc.swap.state == state::PENDING && acc.swap.open_hash(&swap_key) == expected_open,
        SwapError::BadState
    );
    require!(now < acc.swap.t_pending_deadline, SwapError::TooLate);
    check_maker_share(&maker_spend_pub, &maker_pok, &maker_key)?;
    require!(is_canonical_nonzero_scalar(&maker_view), SwapError::InvalidScalar);

    let amount = acc.swap.amount;
    if acc.swap.asset == ASSET_USDC {
        let (Some(mint), Some(from), Some(vault), Some(token_program)) =
            (&acc.mint, &acc.operator_token, &acc.vault, &acc.token_program)
        else {
            return err!(SwapError::WrongAsset);
        };
        require_keys_eq!(mint.key(), acc.config.usdc_mint, SwapError::MintNotAllowed);
        let expected =
            Pubkey::create_program_address(&[b"vault", swap_key.as_ref(), &[acc.swap.vault_bump]], &crate::ID)
                .map_err(|_| error!(ErrorCode::ConstraintSeeds))?;
        require_keys_eq!(vault.key(), expected, ErrorCode::ConstraintSeeds);
        token::transfer_checked(
            CpiContext::new(
                token_program.to_account_info(),
                token::TransferChecked {
                    from: from.to_account_info(),
                    mint: mint.to_account_info(),
                    to: vault.to_account_info(),
                    authority: acc.operator.to_account_info(),
                },
            ),
            amount,
            mint.decimals,
        )?;
    } else {
        system_program::transfer(
            CpiContext::new(
                acc.system_program.to_account_info(),
                system_program::Transfer { from: acc.operator.to_account_info(), to: acc.swap.to_account_info() },
            ),
            amount,
        )?;
    }

    let s = &mut acc.swap;
    s.maker_spend_pub = maker_spend_pub;
    s.locker_view = maker_view;
    s.state = state::ACTIVE;
    s.t_active = now;
    s.t_note_deadline = now + s.w_n as i64;
    let response = (now - s.t_lock).max(0) as u64;
    let m = &mut acc.maker;
    m.bump(counter::APPROVALS);
    m.response_secs_sum = m.response_secs_sum.saturating_add(response);
    m.pending_closed();
    emit!(SwapApproved { swap: swap_key, maker: maker_key, counter: counter::APPROVALS, at: now });
    Ok(())
}
