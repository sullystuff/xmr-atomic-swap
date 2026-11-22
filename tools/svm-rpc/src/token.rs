//! SPL Token account layouts, written and read by hand so the facade never needs a mint
//! authority's secret key. Offsets are those of `spl_token::state::{Mint, Account}`.

use {
    serde_json::{json, Value},
    solana_pubkey::Pubkey,
    std::str::FromStr,
};

pub const MINT_LEN: usize = 82;
pub const ACCOUNT_LEN: usize = 165;
const STATE_OFFSET: usize = 108;

pub fn token_program() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}
pub fn token_2022_program() -> Pubkey {
    Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
}
pub fn ata_program() -> Pubkey {
    Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
}

pub fn is_token_program(owner: &Pubkey) -> bool {
    *owner == token_program() || *owner == token_2022_program()
}

pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program().as_ref(), mint.as_ref()],
        &ata_program(),
    )
    .0
}

fn coption_key(out: &mut [u8], key: Option<&Pubkey>) {
    if let Some(k) = key {
        out[..4].copy_from_slice(&1u32.to_le_bytes());
        out[4..36].copy_from_slice(k.as_ref());
    }
}

fn read_coption_key(data: &[u8]) -> Option<Pubkey> {
    (data[..4] == 1u32.to_le_bytes()).then(|| key_at(data, 4))
}

fn key_at(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().unwrap())
}

fn u64_at(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

/// A mint with `authority` as both mint and freeze authority (USDC has both).
pub fn pack_mint(authority: &Pubkey, decimals: u8, supply: u64) -> Vec<u8> {
    let mut d = vec![0u8; MINT_LEN];
    coption_key(&mut d[0..36], Some(authority));
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    coption_key(&mut d[46..82], Some(authority));
    d
}

pub fn pack_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; ACCOUNT_LEN];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[STATE_OFFSET] = 1;
    d
}

pub struct Mint {
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub decimals: u8,
    pub freeze_authority: Option<Pubkey>,
}

/// Token-2022 mints carry extensions after byte 165 with an account-type byte of 1 at 165.
pub fn read_mint(data: &[u8]) -> Option<Mint> {
    let plain = data.len() == MINT_LEN;
    let extended = data.len() > ACCOUNT_LEN && data[ACCOUNT_LEN] == 1;
    if !(plain || extended) || data[45] != 1 {
        return None;
    }
    Some(Mint {
        mint_authority: read_coption_key(&data[0..36]),
        supply: u64_at(data, 36),
        decimals: data[44],
        freeze_authority: read_coption_key(&data[46..82]),
    })
}

pub struct TokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub delegate: Option<Pubkey>,
    pub state: u8,
    pub native_reserve: Option<u64>,
    pub delegated_amount: u64,
    pub close_authority: Option<Pubkey>,
}

pub fn read_account(data: &[u8]) -> Option<TokenAccount> {
    let plain = data.len() == ACCOUNT_LEN;
    let extended = data.len() > ACCOUNT_LEN && data[ACCOUNT_LEN] == 2;
    if !(plain || extended) || data[STATE_OFFSET] == 0 {
        return None;
    }
    Some(TokenAccount {
        mint: key_at(data, 0),
        owner: key_at(data, 32),
        amount: u64_at(data, 64),
        delegate: read_coption_key(&data[72..108]),
        state: data[STATE_OFFSET],
        native_reserve: (data[109..113] == 1u32.to_le_bytes()).then(|| u64_at(data, 113)),
        delegated_amount: u64_at(data, 121),
        close_authority: read_coption_key(&data[129..165]),
    })
}

pub fn set_amount(data: &mut [u8], amount: u64) {
    data[64..72].copy_from_slice(&amount.to_le_bytes());
}

pub fn set_supply(data: &mut [u8], supply: u64) {
    data[36..44].copy_from_slice(&supply.to_le_bytes());
}

pub fn set_frozen(data: &mut [u8], frozen: bool) {
    data[STATE_OFFSET] = if frozen { 2 } else { 1 };
}

/// The `UiTokenAmount` object of the RPC API.
pub fn ui_amount(amount: u64, decimals: u8) -> Value {
    let d = decimals as usize;
    let digits = format!("{amount:0>width$}", width = d + 1);
    let (int, frac) = digits.split_at(digits.len() - d);
    let frac = frac.trim_end_matches('0');
    let s = if frac.is_empty() { int.to_string() } else { format!("{int}.{frac}") };
    json!({
        "amount": amount.to_string(),
        "decimals": decimals,
        "uiAmount": amount as f64 / 10f64.powi(decimals as i32),
        "uiAmountString": s,
    })
}

fn opt_key(k: &Option<Pubkey>) -> Value {
    k.map(|k| Value::String(k.to_string())).unwrap_or(Value::Null)
}

pub fn parsed_mint(m: &Mint) -> Value {
    json!({ "type": "mint", "info": {
        "decimals": m.decimals,
        "freezeAuthority": opt_key(&m.freeze_authority),
        "isInitialized": true,
        "mintAuthority": opt_key(&m.mint_authority),
        "supply": m.supply.to_string(),
    }})
}

pub fn parsed_account(a: &TokenAccount, decimals: u8) -> Value {
    let mut info = json!({
        "isNative": a.native_reserve.is_some(),
        "mint": a.mint.to_string(),
        "owner": a.owner.to_string(),
        "state": if a.state == 2 { "frozen" } else { "initialized" },
        "tokenAmount": ui_amount(a.amount, decimals),
    });
    if let Some(d) = &a.delegate {
        info["delegate"] = Value::String(d.to_string());
        info["delegatedAmount"] = ui_amount(a.delegated_amount, decimals);
    }
    if let Some(r) = a.native_reserve {
        info["rentExemptReserve"] = ui_amount(r, decimals);
    }
    if let Some(c) = &a.close_authority {
        info["closeAuthority"] = Value::String(c.to_string());
    }
    json!({ "type": "account", "info": info })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_amount_strings() {
        assert_eq!(ui_amount(1_500_000, 6)["uiAmountString"], "1.5");
        assert_eq!(ui_amount(0, 6)["uiAmountString"], "0");
        assert_eq!(ui_amount(1, 6)["uiAmountString"], "0.000001");
        assert_eq!(ui_amount(42, 0)["uiAmountString"], "42");
        assert_eq!(ui_amount(u64::MAX, 6)["amount"], "18446744073709551615");
        assert_eq!(ui_amount(u64::MAX, 6)["uiAmountString"], "18446744073709.551615");
    }

    #[test]
    fn layouts_round_trip() {
        let (auth, mint, owner) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let m = read_mint(&pack_mint(&auth, 6, 77)).unwrap();
        assert_eq!((m.decimals, m.supply), (6, 77));
        assert_eq!((m.mint_authority, m.freeze_authority), (Some(auth), Some(auth)));
        let mut data = pack_account(&mint, &owner, 5);
        let a = read_account(&data).unwrap();
        assert_eq!((a.mint, a.owner, a.amount, a.state), (mint, owner, 5, 1));
        set_frozen(&mut data, true);
        assert_eq!(read_account(&data).unwrap().state, 2);
        assert!(read_account(&[0u8; ACCOUNT_LEN]).is_none());
        assert!(read_mint(&data).is_none());
    }
}
