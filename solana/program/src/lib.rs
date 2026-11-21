use anchor_lang::prelude::*;
declare_id!("5SDDBJfrRbEehBjzKwZKRLdRNyqHi6sNynGwmmUW947u");
#[program]
pub mod xmr_swap {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> { Ok(()) }
}
#[derive(Accounts)]
pub struct Ping<'info> { pub signer: Signer<'info> }
