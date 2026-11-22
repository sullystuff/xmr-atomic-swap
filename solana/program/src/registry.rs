//! Registry instructions (SPEC 4.3): the maker record, offers, the key pool, the Ethereum
//! board, taker-bound quotes and messages.
use anchor_lang::prelude::*;

use crate::{
    admin::{ensure_arg, invalid_arg},
    args::*,
    constants::*,
    contexts::*,
    curve::{self, is_low_order_x25519, is_valid_key_commitment},
    errors::SwapError,
    events::*,
    state::*,
    util::{self, check_bounds, create_pda_account, is_uninitialized, tiers_well_formed, Params, Pending},
};
use solana_curve25519::edwards::PodEdwardsPoint;

// ------------------------------------------------------------------ the maker record

pub fn register_maker(
    ctx: Context<RegisterMaker>,
    operator: Pubkey,
    payout: Pubkey,
    enc_key: [u8; 32],
) -> Result<()> {
    require!(!is_low_order_x25519(&enc_key), SwapError::InvalidEncryptionKey);
    let clock = Clock::get()?;
    let m = &mut ctx.accounts.maker;
    m.owner = ctx.accounts.owner.key();
    m.operator = operator;
    m.payout = payout;
    m.enc_key = enc_key;
    m.enc_key_version = 1;
    m.registered_slot = clock.slot;
    m.registered_at = clock.unix_timestamp;
    m.bump = ctx.bumps.maker;
    emit!(MakerRegistered {
        maker: m.key(),
        owner: m.owner,
        operator,
        payout,
        enc_key,
        at: clock.unix_timestamp,
    });
    Ok(())
}

fn owner_only(a: &MakerByOwner) -> Result<()> {
    require_keys_eq!(a.owner.key(), a.maker.owner, SwapError::Unauthorized);
    Ok(())
}
fn operator_only(a: &MakerByOperator) -> Result<()> {
    require_keys_eq!(a.operator.key(), a.maker.operator, SwapError::Unauthorized);
    Ok(())
}

/// Also increments both epochs: every outstanding approval and quote dies with the old key.
pub fn set_operator(ctx: Context<MakerByOwner>, operator: Pubkey) -> Result<()> {
    owner_only(ctx.accounts)?;
    let m = &mut ctx.accounts.maker;
    m.operator = operator;
    m.approval_epoch = m.approval_epoch.wrapping_add(1);
    m.quote_epoch = m.quote_epoch.wrapping_add(1);
    emit!(OperatorChanged {
        maker: m.key(),
        operator,
        approval_epoch: m.approval_epoch,
        quote_epoch: m.quote_epoch,
        at: util::now()?,
    });
    Ok(())
}

pub fn set_payout(ctx: Context<MakerByOwner>, payout: Pubkey) -> Result<()> {
    owner_only(ctx.accounts)?;
    let m = &mut ctx.accounts.maker;
    m.payout = payout;
    emit!(PayoutChanged { maker: m.key(), payout, at: util::now()? });
    Ok(())
}

pub fn set_eth_link(ctx: Context<MakerByOwner>, eth_address: [u8; 20]) -> Result<()> {
    owner_only(ctx.accounts)?;
    let now = util::now()?;
    let m = &mut ctx.accounts.maker;
    // First promote a matured pending link.
    if m.eth_link_next_at != 0 && now >= m.eth_link_next_at {
        m.eth_link = m.eth_link_next;
        m.eth_link_next = [0; 20];
        m.eth_link_next_at = 0;
    }
    let old = m.eth_link;
    let effective_at;
    if m.eth_link == [0; 20] && m.eth_link_next_at == 0 {
        // No link and none pending: the first link is immediate.
        m.eth_link = eth_address;
        effective_at = now;
    } else {
        // A change or removal waits LINK_DELAY_SECS.
        m.eth_link_next = eth_address;
        m.eth_link_next_at = now + LINK_DELAY_SECS;
        effective_at = m.eth_link_next_at;
    }
    emit!(LinkChanged { maker: m.key(), old, new: eth_address, effective_at });
    Ok(())
}

/// Bit 0 belongs to the owner, bit 1 to the operator. Nonzero = no new swaps.
pub fn set_paused(ctx: Context<MakerByOwnerOrOperator>, paused: bool) -> Result<()> {
    let signer = ctx.accounts.authority.key();
    let m = &mut ctx.accounts.maker;
    let mut bits = 0u8;
    if signer == m.owner {
        bits |= 1;
    }
    if signer == m.operator {
        bits |= 2;
    }
    require!(bits != 0, SwapError::Unauthorized);
    if paused {
        m.paused |= bits;
    } else {
        m.paused &= !bits;
    }
    emit!(PausedChanged { maker: m.key(), paused: m.paused, at: util::now()? });
    Ok(())
}

pub fn bump_epochs(ctx: Context<MakerByOwnerOrOperator>, approvals: bool, quotes: bool) -> Result<()> {
    let signer = ctx.accounts.authority.key();
    let m = &mut ctx.accounts.maker;
    require!(signer == m.owner || signer == m.operator, SwapError::Unauthorized);
    if approvals {
        m.approval_epoch = m.approval_epoch.wrapping_add(1);
    }
    if quotes {
        m.quote_epoch = m.quote_epoch.wrapping_add(1);
    }
    emit!(EpochsBumped {
        maker: m.key(),
        approval_epoch: m.approval_epoch,
        quote_epoch: m.quote_epoch,
        at: util::now()?,
    });
    Ok(())
}

pub fn rotate_enc_key(ctx: Context<MakerByOperator>, new_key: [u8; 32], prev_expires_at: i64) -> Result<()> {
    operator_only(ctx.accounts)?;
    require!(!is_low_order_x25519(&new_key), SwapError::InvalidEncryptionKey);
    require!(prev_expires_at >= util::now()?, SwapError::TooLate);
    let m = &mut ctx.accounts.maker;
    m.prev_enc_key = m.enc_key;
    m.prev_enc_key_expires_at = prev_expires_at;
    m.enc_key = new_key;
    m.enc_key_version = m.enc_key_version.checked_add(1).ok_or(SwapError::MathOverflow)?;
    emit!(EncKeyRotated { maker: m.key(), version: m.enc_key_version, key: new_key, prev_expires_at });
    Ok(())
}

/// Empty clears. Otherwise 56 base32 characters (`a-z2-7`) + `.onion`.
pub fn set_onion(ctx: Context<MakerByOperator>, onion: String) -> Result<()> {
    operator_only(ctx.accounts)?;
    if !onion.is_empty() {
        let b = onion.as_bytes();
        require!(b.len() == MAX_ONION_LEN && b.ends_with(b".onion"), SwapError::OnionInvalid);
        require!(
            b[..56].iter().all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(c)),
            SwapError::OnionInvalid
        );
    }
    let m = &mut ctx.accounts.maker;
    m.onion = onion.clone();
    emit!(OnionChanged { maker: m.key(), onion });
    Ok(())
}

pub fn set_contacts(ctx: Context<MakerByOperator>, contacts: Vec<Contact>) -> Result<()> {
    operator_only(ctx.accounts)?;
    require!(contacts.len() <= MAX_CONTACTS, SwapError::ContactsTooLong);
    require!(contacts.iter().all(|c| c.value.len() <= MAX_CONTACT_LEN), SwapError::ContactsTooLong);
    let m = &mut ctx.accounts.maker;
    let count = contacts.len() as u8;
    m.contacts = contacts;
    emit!(ContactsChanged { maker: m.key(), count });
    Ok(())
}

pub fn set_inbox_policy(ctx: Context<MakerByOperator>, policy: u8) -> Result<()> {
    operator_only(ctx.accounts)?;
    ensure_arg(policy <= 1)?;
    let m = &mut ctx.accounts.maker;
    m.inbox_policy = policy;
    emit!(InboxPolicyChanged { maker: m.key(), policy });
    Ok(())
}

// ------------------------------------------------------------------ offers

#[inline(never)]
fn load_offer(ai: &AccountInfo) -> Result<Box<Offer>> {
    require_keys_eq!(*ai.owner, crate::ID, ErrorCode::AccountOwnedByWrongProgram);
    let data = ai.try_borrow_data()?;
    Ok(Box::new(Offer::try_deserialize(&mut &data[..])?))
}

#[inline(never)]
fn store_offer(ai: &AccountInfo, offer: &Offer) -> Result<()> {
    let mut data = ai.try_borrow_mut_data()?;
    offer.try_serialize(&mut &mut data[..])
}

#[inline(never)]
fn blank_offer() -> Box<Offer> {
    Box::new(Offer {
        maker: Pubkey::default(),
        asset: 0,
        direction: 0,
        enabled: 0,
        mode: 0,
        bump: 0,
        seq: 0,
        updated_at: 0,
        valid_secs: 0,
        min_xmr: 0,
        max_xmr: 0,
        capacity_xmr: 0,
        price_above: [0; 3],
        prices: [0; 3],
        depth_above: [0; 3],
        depths: [0; 3],
        dep_bps: 0,
        w_a: 0,
        w_n: 0,
        d_c: 0,
        w_c: 0,
        w_f: 0,
        terms_hash: [0; 32],
        pool_filled: 0,
        pool_used: 0,
        pool: [[0; 32]; 16],
        reserved: [0; 34],
    })
}

/// The bounds of SPEC 3.1 for an offer's terms, against its deepest used depth tier and the
/// longest pending window a swap from this offer can have.
fn check_offer_terms(direction: u8, t: &OfferTerms) -> Result<()> {
    ensure_arg(t.mode <= mode::ADVANCE)?;
    require!(t.min_xmr <= t.max_xmr && t.max_xmr > 0, SwapError::AmountOutOfRange);
    require!(t.price_above[0] == 0, SwapError::TiersInvalid);
    let used = [t.depths[0] != 0, t.depths[1] != 0, t.depths[2] != 0];
    require!(used != [false; 3], SwapError::DepthInvalid);
    require!(tiers_well_formed(&t.depth_above, used), SwapError::TiersInvalid);
    let deepest = t.depths.iter().copied().max().unwrap_or(0);
    let window = t.mode == mode::WINDOW;
    // The deepest tier has the largest claim-delay floor; nothing else depends on the depth.
    let p = Params { w_a: t.w_a, w_n: t.w_n, d_c: t.d_c, w_c: t.w_c, w_f: t.w_f, depth: deepest, dep_bps: t.dep_bps };
    // Every pending kind a swap from this offer can start in must satisfy the bounds: window
    // mode waits W_a; a take outside window mode (or with an advance approval) waits W_n.
    if window {
        check_bounds(&p, Pending::ApprovalWindow)?;
    }
    if direction == DIR_B {
        check_bounds(&p, Pending::FundingWindow)?;
    } else {
        check_bounds(&p, Pending::None)?;
    }
    Ok(())
}

pub fn set_offer(ctx: Context<SetOffer>, asset: u8, direction: u8, terms: OfferTerms) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.operator.key(), a.maker.operator, SwapError::Unauthorized);
    require!(asset <= ASSET_USDC, SwapError::WrongAsset);
    require!(direction <= DIR_B, SwapError::WrongDirection);
    check_offer_terms(direction, &terms)?;

    let maker_key = a.maker.key();
    let seeds: [&[u8]; 4] = [b"offer", maker_key.as_ref(), &[asset], &[direction]];
    let (expected, bump) = Pubkey::find_program_address(&seeds, &crate::ID);
    require_keys_eq!(a.offer.key(), expected, ErrorCode::ConstraintSeeds);

    let offer_ai = a.offer.to_account_info();
    let mut offer = if is_uninitialized(&offer_ai) {
        create_pda_account(
            &a.operator.to_account_info(),
            &offer_ai,
            &a.system_program.to_account_info(),
            &crate::ID,
            OFFER_SIZE,
            &[b"offer", maker_key.as_ref(), &[asset], &[direction], &[bump]],
        )?;
        let mut o = blank_offer();
        o.maker = maker_key;
        o.asset = asset;
        o.direction = direction;
        o.bump = bump;
        o
    } else {
        load_offer(&offer_ai)?
    };

    offer.mode = terms.mode;
    offer.min_xmr = terms.min_xmr;
    offer.max_xmr = terms.max_xmr;
    offer.valid_secs = terms.valid_secs;
    offer.price_above = terms.price_above;
    offer.depth_above = terms.depth_above;
    offer.depths = terms.depths;
    offer.dep_bps = terms.dep_bps;
    offer.w_a = terms.w_a;
    offer.w_n = terms.w_n;
    offer.d_c = terms.d_c;
    offer.w_c = terms.w_c;
    offer.w_f = terms.w_f;
    offer.terms_hash = offer.compute_terms_hash();
    offer.seq = offer.seq.saturating_add(1);
    // The offer is live only after the next refresh.
    offer.prices = [0; 3];
    offer.enabled = 0;
    store_offer(&offer_ai, &offer)?;
    emit!(OfferSet { maker: maker_key, asset, direction, seq: offer.seq, terms_hash: offer.terms_hash });
    Ok(())
}

/// Byte offsets inside the `EthBoard` account.
const BOARD_HEADER: usize = 8 + 32 + 1;
const BOARD_SLOT_LEN: usize = 1 + 8 + 251 + 65;
const SLOT_UPDATED_AT: usize = 1;
const SLOT_QUOTE: usize = 9;
const SLOT_SIG: usize = 9 + 251;

fn check_board(ai: &AccountInfo, maker: &Pubkey) -> Result<()> {
    require_keys_eq!(*ai.owner, crate::ID, ErrorCode::AccountOwnedByWrongProgram);
    let data = ai.try_borrow_data()?;
    require!(data.len() >= ETH_BOARD_SIZE, ErrorCode::AccountDidNotDeserialize);
    require!(data[..8] == *EthBoard::DISCRIMINATOR, ErrorCode::AccountDiscriminatorMismatch);
    require!(data[8..40] == maker.to_bytes(), SwapError::Unauthorized);
    Ok(())
}

pub fn refresh_offers(
    ctx: Context<RefreshOffers>,
    offers: Vec<OfferRefresh>,
    eth: Vec<EthQuoteRefresh>,
) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.operator.key(), a.maker.operator, SwapError::Unauthorized);
    let maker_key = a.maker.key();
    let now = util::now()?;
    ensure_arg(offers.len() == ctx.remaining_accounts.len())?;

    for (r, ai) in offers.iter().zip(ctx.remaining_accounts.iter()) {
        let mut offer = load_offer(ai)?;
        require_keys_eq!(offer.maker, maker_key, SwapError::Unauthorized);
        require!(offer.asset == r.asset, SwapError::WrongAsset);
        require!(offer.direction == r.direction, SwapError::WrongDirection);
        if r.enabled {
            let used = [r.prices[0] != 0, r.prices[1] != 0, r.prices[2] != 0];
            require!(tiers_well_formed(&offer.price_above, used), SwapError::TiersInvalid);
        }
        offer.prices = r.prices;
        offer.capacity_xmr = r.capacity_xmr;
        offer.enabled = r.enabled as u8;
        offer.seq = offer.seq.saturating_add(1);
        offer.updated_at = now;
        store_offer(ai, &offer)?;
    }

    if !eth.is_empty() {
        let Some(board) = a.eth_board.as_mut() else {
            return Err(invalid_arg());
        };
        require_keys_eq!(board.maker, maker_key, SwapError::Unauthorized);
        for q in eth.iter() {
            ensure_arg((q.slot as usize) < ETH_BOARD_SLOTS)?;
            let slot = &mut board.slots[q.slot as usize];
            // Only a slot that holds a full quote can be refreshed.
            ensure_arg(slot.used == 1)?;
            slot.updated_at = now;
            // Dynamic fields of the compact form: tierPrice 102..150, validUntil 199..207, quoteId 243..251.
            for (i, p) in q.tier_price.iter().enumerate() {
                slot.quote[102 + i * 16..118 + i * 16].copy_from_slice(&p.to_le_bytes());
            }
            slot.quote[199..207].copy_from_slice(&q.valid_until.to_le_bytes());
            slot.quote[243..251].copy_from_slice(&q.quote_id.to_le_bytes());
            slot.sig = q.sig;
        }
    }
    emit!(OffersRefreshed { maker: maker_key, count: (offers.len() + eth.len()) as u8 });
    Ok(())
}

pub fn refill_keys(ctx: Context<RefillKeys>, asset: u8, slots: Vec<KeySlot>) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.operator.key(), a.maker.operator, SwapError::Unauthorized);
    let maker_key = a.maker.key();
    require_keys_eq!(a.offer.maker, maker_key, SwapError::Unauthorized);
    require!(a.offer.direction == DIR_A, SwapError::WrongDirection);
    require!(a.offer.asset == asset, SwapError::WrongAsset);
    ensure_arg(!slots.is_empty() && slots.len() <= MAX_KEY_SLOTS_PER_REFILL)?;
    let ctx_bytes = maker_key.to_bytes();
    for s in slots.iter() {
        ensure_arg((s.index as usize) < POOL_SLOTS)?;
        let bit = 1u16 << s.index;
        // A share that is published and not yet taken cannot be replaced under a taker's feet.
        require!(
            a.offer.pool_filled & bit == 0 || a.offer.pool_used & bit != 0,
            SwapError::KeySlotBusy
        );
        require!(is_valid_key_commitment(&PodEdwardsPoint(s.share)), SwapError::InvalidKeyCommitment);
        require!(curve::pok_verify(&s.share, &ctx_bytes, &s.pok), SwapError::InvalidProofOfKnowledge);
        a.offer.pool[s.index as usize] = s.share;
        a.offer.pool_filled |= bit;
        a.offer.pool_used &= !bit;
    }
    emit!(KeysRefilled { maker: maker_key, asset, count: slots.len() as u8 });
    Ok(())
}

pub fn set_eth_quote(ctx: Context<SetEthQuote>, slot: u8, quote: [u8; 251], sig: [u8; 65]) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.operator.key(), a.maker.operator, SwapError::Unauthorized);
    ensure_arg((slot as usize) < ETH_BOARD_SLOTS)?;
    let maker_key = a.maker.key();
    let (expected, bump) = Pubkey::find_program_address(&[b"eth_board", maker_key.as_ref()], &crate::ID);
    require_keys_eq!(a.eth_board.key(), expected, ErrorCode::ConstraintSeeds);
    let board = a.eth_board.to_account_info();
    if is_uninitialized(&board) {
        create_pda_account(
            &a.operator.to_account_info(),
            &board,
            &a.system_program.to_account_info(),
            &crate::ID,
            ETH_BOARD_SIZE,
            &[b"eth_board", maker_key.as_ref(), &[bump]],
        )?;
        let mut data = board.try_borrow_mut_data()?;
        data[..8].copy_from_slice(EthBoard::DISCRIMINATOR);
        data[8..40].copy_from_slice(&maker_key.to_bytes());
        data[40] = bump;
    } else {
        check_board(&board, &maker_key)?;
    }
    let now = util::now()?;
    let mut data = board.try_borrow_mut_data()?;
    let base = BOARD_HEADER + slot as usize * BOARD_SLOT_LEN;
    data[base] = 1;
    data[base + SLOT_UPDATED_AT..base + SLOT_UPDATED_AT + 8].copy_from_slice(&now.to_le_bytes());
    data[base + SLOT_QUOTE..base + SLOT_QUOTE + 251].copy_from_slice(&quote);
    data[base + SLOT_SIG..base + SLOT_SIG + 65].copy_from_slice(&sig);
    emit!(EthQuoteSet { maker: maker_key, slot });
    Ok(())
}

// ------------------------------------------------------------------ taker-bound quotes

pub fn post_quote(ctx: Context<PostQuote>, terms: QuoteTerms) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.operator.key(), a.maker.operator, SwapError::Unauthorized);
    require!(terms.asset <= ASSET_USDC, SwapError::WrongAsset);
    require!(terms.direction <= DIR_B, SwapError::WrongDirection);
    let p = Params {
        w_a: 0,
        w_n: terms.w_n,
        d_c: terms.d_c,
        w_c: terms.w_c,
        w_f: terms.w_f,
        depth: terms.depth,
        dep_bps: terms.dep_bps,
    };
    // A quote is treated as AUTO: W_p = 0 in A, W_n in B.
    check_bounds(&p, if terms.direction == DIR_A { Pending::None } else { Pending::FundingWindow })?;
    let now = util::now()?;
    require!(terms.expires_at >= now, SwapError::QuoteExpired);
    require!(terms.expires_at <= now + MAX_QUOTE_SECS, SwapError::QuoteMismatch);
    let maker_key = a.maker.key();
    let mut share = [0u8; 32];
    if terms.direction == DIR_A {
        require!(
            is_valid_key_commitment(&PodEdwardsPoint(terms.maker_spend_pub)),
            SwapError::InvalidKeyCommitment
        );
        require!(
            curve::pok_verify(&terms.maker_spend_pub, &maker_key.to_bytes(), &terms.maker_pok),
            SwapError::InvalidProofOfKnowledge
        );
        share = terms.maker_spend_pub;
    }
    let q = &mut a.quote;
    q.maker = maker_key;
    q.taker = terms.taker;
    q.asset = terms.asset;
    q.direction = terms.direction;
    q.depth = terms.depth;
    q.bump = ctx.bumps.quote;
    q.xmr = terms.xmr;
    q.amount = terms.amount;
    q.dep_bps = terms.dep_bps;
    q.w_n = terms.w_n;
    q.d_c = terms.d_c;
    q.w_c = terms.w_c;
    q.w_f = terms.w_f;
    q.maker_spend_pub = share;
    q.expires_at = terms.expires_at;
    q.epoch = a.maker.quote_epoch;
    q.quote_id = terms.quote_id;
    q.reserved = [0; 30];
    emit!(QuotePosted { maker: maker_key, quote_id: terms.quote_id, taker: terms.taker });
    Ok(())
}

/// The operator at any time; anyone once `now > expires_at`. The rent returns to the operator.
pub fn cancel_quote(ctx: Context<CancelQuote>) -> Result<()> {
    let a = ctx.accounts;
    require_keys_eq!(a.quote.maker, a.maker.key(), SwapError::QuoteMismatch);
    require_keys_eq!(a.quote_rent_receiver.key(), a.maker.operator, SwapError::Unauthorized);
    let now = util::now()?;
    require!(
        a.caller.key() == a.maker.operator || now > a.quote.expires_at,
        SwapError::Unauthorized
    );
    let quote_id = a.quote.quote_id;
    a.quote.close(a.quote_rent_receiver.to_account_info())?;
    emit!(QuoteCancelled { maker: a.maker.key(), quote_id });
    Ok(())
}

// ------------------------------------------------------------------ messages

/// The message is the instruction data: nothing is written and nothing is emitted.
pub fn post_message(_ctx: Context<PostMessage>, payload: Vec<u8>) -> Result<()> {
    require!(payload.len() <= MAX_MESSAGE_LEN, SwapError::MessageTooLarge);
    require!(payload.len() >= 2 && payload[..2] == MESSAGE_MAGIC, SwapError::MessageMalformed);
    Ok(())
}
