# Solana: checking a revealed ed25519 key share on-chain

2026-11-21. Research for the Solana program in `docs/DESIGN.md`.

Everything marked **RAN** was executed here: a prototype Anchor program built with `cargo build-sbf` and 18 in-process LiteSVM tests, all passing. **RPC** means a read-only call against mainnet-beta (genesis `5eykt4Us…`, cluster version 4.4.1). **READ** means source or documentation only.

The prototype is in `.scratch/solana-curve/` (gitignored, `target/` deleted). To re-run:

```sh
cd .scratch/solana-curve/program && cargo build-sbf      # -> target/deploy/curve_check.so (415 KB)
cd ../tests && cargo test -- --nocapture                 # 18 tests, about 20 s after the first build
```

## Verdicts

| # | Question | Answer | Basis |
|---|---|---|---|
| 1 | Syscall, availability, cost | `sol_curve_group_op` (curve id 0 = Edwards, op 2 = MUL) through `solana_curve25519::edwards::multiply_edwards`. Active on mainnet-beta since epoch 637. `s·G == S` costs 2,208 CU. | RAN + RPC |
| 2 | Prototype and harness | Anchor 0.32.1 program works. LiteSVM 0.16.0 is the newest harness that builds on rustc 1.94. | RAN |
| 3 | Monero compatibility | Byte-identical encodings. All 272 of Monero's own `secret_key_to_public_key` vectors agree with the on-chain check. Committed points need an explicit prime-order check; `sol_curve_validate_point` is not enough. | RAN |
| 4 | Program design | See [Design recommendations](#design-recommendations). Escrow, session key, close and messaging paths were run; RPC-side behaviour was read. | RAN in part |

## 1. The syscall

### What to call

| Syscall | Wrapper in `solana-curve25519` | Use here |
|---|---|---|
| `sol_curve_group_op(0, 2, scalar, point, out)` | `multiply_edwards(&PodScalar, &PodEdwardsPoint) -> Option<PodEdwardsPoint>` | `s·G == S` on claim and refund; subgroup check at lock |
| `sol_curve_group_op(0, 1, a, b, out)` | `subtract_edwards` | negation inside the subgroup check |
| `sol_curve_multiscalar_mul(0, …)` | `multiscalar_multiply_edwards(&[PodScalar], &[PodEdwardsPoint])` | not needed; dearer than MUL for one point |
| `sol_curve_validate_point(0, point)` | `validate_edwards(&PodEdwardsPoint) -> bool` | not sufficient by itself, see section 3 |

There is no "multiply by the basepoint" syscall. Pass G as a constant: `58 66 66 … 66` (y = 4/5, 32 bytes).

`multiply_edwards` returns `None` when the scalar is not canonical (≥ l) or the point does not decompress. Its output is always the canonical compression, so comparing output bytes with stored bytes is a complete equality check.

### Mainnet status (RPC, read-only)

```
7rcw5UtqgDTBBv2EcynNfYckgdAaH1MAsCjKgXMkN7Ri | active since epoch 637 | slot 275184000 | enable curve25519 syscalls
eca6zf6JJRjQsYYPkBHF3N32MTzur4n2WL4QiiacPCL  | active since epoch 607 | slot 262224008 | restrict curve25519 multiscalar multiplication vector lengths
```

This closes the open item "Confirm the curve syscall used to check a revealed key share is available on mainnet". LiteSVM's pinned mainnet feature list carries the same activation slot, and `LiteSVM::new()` uses that list, so the tests run under mainnet's feature set.

### Compute units (RAN)

Measured inside the program with `sol_log_compute_units` around each call, net of the 101 CU the logging itself costs. Runtime prices are from `solana-program-runtime` 4.2.2 `execution_budget.rs`.

| Call | Measured CU | Runtime price |
|---|---|---|
| `validate_edwards` | 174 | 159 |
| `multiply_edwards` (the `s·G` check) | 2,208 | 2,177 |
| `subtract_edwards` | 505 | 475 |
| `multiscalar_multiply_edwards`, 1 point | 2,315 | 2,273 |
| `multiscalar_multiply_edwards`, 2 points | 3,091 | 2,273 + 758 |
| `is_valid_key_commitment` (MUL + SUB) | 2,750 | — |

Whole transactions in the prototype:

| Instruction | CU |
|---|---|
| `reveal` (check + event + close) | 5,900 to 8,900 |
| `claim_sol` | 6,373 |
| `refund_sol` by session key, with sweep | 8,485 |
| `lock_token` (two `init`s, two subgroup checks, token transfer) | 28,500 to 43,500 |
| `claim_token` (transfer + close vault + close swap) | 14,600 to 23,600 |
| `refund_token` by session key | 16,700 to 22,700 |

The spread is Anchor's PDA bump search: each failed bump costs about 1,500 CU and the count depends on the address. Storing the bump and using `bump = swap.bump` avoids it after `init`. A 60,000 CU limit covers every instruction here.

### Crates

`anchor-lang` 0.32.1 no longer depends on the `solana-program` monolith. It re-exports the 2.x split crates as `anchor_lang::solana_program`, and that facade has no `sol_log_compute_units` (use `solana_msg::syscalls::sol_log_compute_units_`).

`solana-curve25519` has no Solana type dependencies, only `bytemuck`, `solana-define-syscall` and (off-chain) `curve25519-dalek` 4.1.3. Versions 2.3.13, 3.1.14 and 4.0.1 all compile into the Anchor 0.32.1 program (RAN: build only for 3.x and 4.x; tests ran against 2.3.13). The API is the same in all three. Use 2.3.13 so `solana-define-syscall` is not duplicated.

Off-chain the same crate computes with dalek, so the helper functions below also run in native unit tests.

## 2. Prototype

### Program `Cargo.toml` (compiles with solana-cli 3.0.9, platform-tools v1.51, rustc 1.84.1-sbpf)

```toml
[package]
name = "curve-check"
version = "0.1.0"
edition = "2021"
rust-version = "1.84" # = platform-tools v1.51 rustc; drives MSRV-aware resolution

[lib]
crate-type = ["cdylib", "lib"]
name = "curve_check"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
# declared only to silence anchor's `unexpected cfg` warnings
anchor-debug = []
custom-heap = []
custom-panic = []

[dependencies]
anchor-lang = { version = "=0.32.1", features = ["event-cpi"] }
anchor-spl = { version = "=0.32.1", default-features = false, features = ["token", "token_2022"] }
solana-curve25519 = "=2.3.13"
solana-msg = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
```

`.cargo/config.toml`, next to it (required, see below):

```toml
[resolver]
incompatible-rust-versions = "fallback"
```

**Build trap.** `cargo build-sbf` compiles with cargo 1.84, which cannot parse edition-2024 manifests. A lockfile generated without the two settings above pulls `toml_parser` 1.1.6, `zeroize_derive` 1.5.0 and others, and the build fails with `feature edition2024 is required`. With `rust-version = "1.84"` plus the fallback resolver, the host cargo (1.94) writes a lockfile that the SBF toolchain accepts. Commit `Cargo.lock`.

Resolved versions that matter: `anchor-lang` 0.32.1, `anchor-spl` 0.32.1, `solana-curve25519` 2.3.13, `solana-define-syscall` 2.3.0, `solana-msg` 2.2.1, `solana-pubkey` 2.4.0, `solana-instruction` 2.3.3, `solana-account-info` 2.3.0, `solana-sysvar` 2.3.0, `spl-token` 8.0.0, `spl-token-2022` 8.0.1, `borsh` 1.8.1, `zeroize` 1.8.2.

`anchor idl build` also works on stable 1.94 once an `Anchor.toml` with `[workspace] members = [...]` exists (RAN). Its discriminators match the hand-computed ones used in the tests.

### The check (`program/src/curve.rs`)

```rust
use solana_curve25519::{
    edwards::{multiply_edwards, subtract_edwards, PodEdwardsPoint},
    scalar::PodScalar,
};

/// Compressed ed25519 basepoint G (y = 4/5, x positive). Same G as Monero.
pub const ED25519_BASEPOINT: PodEdwardsPoint = PodEdwardsPoint([
    0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
]);

/// Canonical compressed identity (x = 0, y = 1).
pub const IDENTITY: PodEdwardsPoint = PodEdwardsPoint([
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/// l - 1, little-endian, where l = 2^252 + 27742317777372353535851937790883648493.
pub const L_MINUS_1: PodScalar = PodScalar([
    236, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 16,
]);

/// True iff `p` is the canonical encoding of a non-identity point of the
/// prime-order subgroup. One MUL + one SUB syscall (2,750 CU).
///
/// -((l-1)·P) == P  <=>  l·P == 0. The syscall output is always the canonical
/// compression, so byte equality with the input also rejects non-canonical
/// encodings (y >= p, "negative zero" x). Off-curve inputs make MUL fail.
pub fn is_valid_key_commitment(p: &PodEdwardsPoint) -> bool {
    if *p == IDENTITY {
        return false;
    }
    let Some(t) = multiply_edwards(&L_MINUS_1, p) else {
        return false;
    };
    let Some(neg_t) = subtract_edwards(&IDENTITY, &t) else {
        return false;
    };
    neg_t == *p
}

/// True iff `s` is a canonical scalar (< l) and s·G == `commitment` (2,208 CU).
/// The syscall itself rejects non-canonical scalars (returns None).
pub fn scalar_matches(s: &[u8; 32], commitment: &[u8; 32]) -> bool {
    match multiply_edwards(&PodScalar(*s), &ED25519_BASEPOINT) {
        Some(p) => p.0 == *commitment,
        None => false,
    }
}
```

The scalar `l` itself is not a canonical scalar, so `l·P` cannot be asked for directly. That is why the check multiplies by `l − 1` and negates.

### Tests that ran (all pass)

`tests/curve.rs`

| Test | Shows |
|---|---|
| `positive_matching_scalar_is_accepted` | commit S, reveal s, event carries s, account closed, rent returned |
| `negative_wrong_scalar_is_rejected` | random scalar, s+1, −s and 0 all fail with `ScalarMismatch`; s still works afterwards |
| `non_canonical_scalar_is_rejected` | s + l (same point mathematically), l, and `ff…ff` all fail |
| `commit_rejects_identity_torsion_noncanonical_and_off_curve` | 18 bad points rejected; 100 honest points accepted |
| `validate_point_syscall_alone_is_not_enough` | `sol_curve_validate_point` accepts 17 of those 18 |
| `unchecked_torsioned_commitment_can_never_be_opened` | S + T stored without the check cannot be opened by s |
| `monero_secret_key_to_public_key_vectors` | 256 Monero key pairs accepted, 16 unreduced secrets refused |
| `compute_unit_costs` | the CU table above |

`tests/escrow.rs`

| Test | Shows |
|---|---|
| `sol_lock_ready_claim` | SOL held in the swap PDA; claim blocked before ready; stranger cannot set ready or claim; session key sets ready and pays its own fee; maker paid; rent returned to taker |
| `sol_refund_by_session_key_after_deadline` | `TooEarly` one second before the deadline; refund destination pinned to the taker; session key swept to exactly 0; taker out fees only |
| `sol_refund_by_taker_wallet_also_works` | wallet fallback |
| `session_key_funded_below_rent_minimum_fails_the_lock` | both rent traps, see session keys below |
| `lock_rejects_bad_key_commitments_and_duplicate_ids` | subgroup check at lock; same swap id cannot be reused |
| `token_lock_ready_claim` | SPL mint with 6 decimals, PDA vault, payout, vault and swap both closed, both rents back to the taker |
| `token_refund_by_session_key` | token refund to the taker's token account, signed and paid by the session key |
| `slot_and_timestamp_are_independent_sysvar_fields` | `warp_to_slot` does not move `unix_timestamp` |

`tests/registry_messages.rs`

| Test | Shows |
|---|---|
| `list_makers_by_discriminator` | filtering program accounts on the first 8 bytes returns exactly the maker accounts |
| `message_posting_costs` | CU for the three message options; event decoded from logs and from the inner instruction |

### Test harness

**Constraint found.** rustc 1.94 cannot build current LiteSVM: 0.17 and 0.18 need agave 4.3 or later, which declares `rust-version` 1.97.1 or higher. LiteSVM 0.16.0 resolves to agave 4.2.2 and builds. Upgrading the host toolchain lifts this.

The test crate does not link the program crate. Anchor 0.32 sits on solana 2.x types and LiteSVM on 3.x/4.x, so sharing types means two incompatible `Pubkey`s. The tests load the built `.so` and encode instructions by hand: `sha256("global:<name>")[..8]` followed by borsh arguments. This is about 15 lines per instruction and keeps the two dependency trees apart.

`tests/Cargo.toml`:

```toml
[package]
name = "curve-check-tests"
version = "0.1.0"
edition = "2021"
publish = false
rust-version = "1.94"

[dev-dependencies]
litesvm = "=0.16.0"
litesvm-token = "=0.16.0"
solana-keypair = "3"
solana-signer = "3"
solana-transaction = "4"
solana-message = "4"
solana-instruction = "3"
solana-pubkey = { version = "4", features = ["curve25519"] }
solana-clock = "3"
solana-rent = "4"
solana-system-interface = { version = "3", features = ["bincode"] }
sha2 = "0.10"
curve25519-dalek = "4"
base64 = "0.22"
rand = "0.8"
```

With the same `.cargo/config.toml` as the program. Resolved: `litesvm` 0.16.0, `litesvm-token` 0.16.0, `solana-program-runtime` 4.2.2, `agave-feature-set` 4.2.2, `solana-pubkey` 4.2.1, `solana-instruction` 3.4.1, `solana-transaction` 4.1.6, `solana-message` 4.4.1, `solana-keypair` 3.1.2, `solana-signer` 3.0.1, `solana-clock` 3.1.1, `solana-rent` 4.3.0, `solana-system-interface` 3.2.0, `spl-token-interface` 3.0.0, `curve25519-dalek` 4.1.3.

Core of `tests/common/mod.rs`:

```rust
pub fn setup() -> LiteSVM {
    // LiteSVM::new() = features active on mainnet-beta (litesvm's pinned list)
    // + builtins + sysvars + SPL Token / Token-2022 / ATA / Memo, sigverify on.
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM_ID, SO)
        .expect("build first: (cd ../program && cargo build-sbf)");
    // Mainnet-beta's Rent sysvar today (read 2026-11-21): 5,080 lamports/byte,
    // threshold 1.0. The crate default is still the old 6,960.
    svm.set_sysvar(&solana_rent::Rent::with_lamports_per_byte(5_080));
    // Start from a realistic clock; a fresh LiteSVM has unix_timestamp = 0.
    let mut clock: Clock = svm.get_sysvar();
    clock.slot = 300_000_000;
    clock.unix_timestamp = 1_795_000_000;
    svm.set_sysvar(&clock);
    svm
}

/// SOL: svm.airdrop() is in-process only and touches no network.
pub fn funded(svm: &mut LiteSVM, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), lamports).unwrap();
    kp
}

/// Advance wall-clock and slot together (400 ms slots).
pub fn warp_secs(svm: &mut LiteSVM, secs: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += secs;
    clock.slot += (secs as u64) * 5 / 2;
    svm.set_sysvar(&clock);
    svm.expire_blockhash();
}

/// First signer pays the fee.
pub fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair])
    -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let msg = Message::new(ixs, Some(&signers[0].pubkey()));
    let tx = Transaction::new(signers, msg, svm.latest_blockhash());
    let res = svm.send_transaction(tx);
    // New blockhash per tx: otherwise re-sending a byte-identical tx (a retry
    // after a failed attempt) is rejected as AlreadyProcessed.
    svm.expire_blockhash();
    res
}

fn sighash(namespace: &str, name: &str) -> [u8; 8] {
    Sha256::digest(format!("{namespace}:{name}"))[..8].try_into().unwrap()
}
pub fn ix_disc(name: &str) -> [u8; 8] { sighash("global", name) }       // instruction
pub fn account_disc(name: &str) -> [u8; 8] { sighash("account", name) } // account type
pub fn event_disc(name: &str) -> [u8; 8] { sighash("event", name) }     // event

/// Anchor errors surface as InstructionError::Custom(6000 + variant index).
pub fn assert_custom_err(res: Result<TransactionMetadata, FailedTransactionMetadata>, code: u32) {
    let err = res.expect_err("transaction should have failed");
    assert!(format!("{:?}", err.err).contains(&format!("Custom({code})")), "{}", err.meta.pretty_logs());
}

/// Events emitted with `emit!` ("Program data: <base64>" log lines).
pub fn logged_events(meta: &TransactionMetadata, name: &str) -> Vec<Vec<u8>> {
    use base64::Engine;
    let disc = event_disc(name);
    meta.logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .filter(|d| d.len() >= 8 && d[..8] == disc)
        .map(|d| d[8..].to_vec())
        .collect()
}
```

SPL tokens, using `litesvm-token` (the token programs ship inside LiteSVM):

```rust
let mint = CreateMint::new(&mut svm, &issuer).decimals(6).send().unwrap();
let taker_ata = CreateAssociatedTokenAccount::new(&mut svm, &issuer, &mint)
    .owner(&taker.pubkey()).send().unwrap();
MintTo::new(&mut svm, &issuer, &mint, &taker_ata, 1_000_000_000).send().unwrap();
// balance: u64 LE at bytes 64..72 of the token account
```

Harness lessons, each hit while writing the tests:

- **Fresh blockhash per transaction.** A retry that is byte-identical to a failed attempt is rejected as `AlreadyProcessed`.
- **Set the clock.** A new LiteSVM starts at `unix_timestamp = 0`. `warp_to_slot` moves only the slot.
- **Set rent to mainnet's value.** See the rent note under Design.
- **Failed transactions still charge the fee payer.** Balance assertions must count them.
- **PDA bump search changes CU from run to run.** Assert ranges, not exact totals.

## 3. Monero compatibility and point checks

### Encodings (RAN)

| Item | Monero | Solana syscall | Match |
|---|---|---|---|
| Secret scalar | 32 bytes little-endian, must be < l (`sc_check`) | `PodScalar`, rejected unless canonical (< l) | identical |
| Public point | 32 bytes: y little-endian, sign of x in bit 255 | `PodEdwardsPoint`, same compressed Edwards Y | identical |
| Basepoint | ed25519 G | the constant above | identical |

Proof: Monero's `tests/crypto/tests.txt` has 272 `secret_key_to_public_key` rows. For the 256 `true` rows, the program accepted the public key as a commitment and then accepted the secret key as its opening. For the 16 `false` rows (secrets not reduced mod l), the program refused the scalar. The file is saved at `.scratch/solana-curve/vectors/`.

Consequence for clients: reduce mod l before use, and send exactly the 32 reduced bytes. A scalar that is right mod l but encoded as s + l is refused on-chain. That is the behaviour wanted: there is one accepted opening per commitment.

### Checks on a committed point (RAN)

Run `is_valid_key_commitment` on both key commitments when the swap is created (and on each key share in an offer's pool when it is published).

| Input | `sol_curve_validate_point` | `is_valid_key_commitment` |
|---|---|---|
| Honest `s·G` | accept | accept |
| Identity | accept | reject |
| The 7 other small-order points | accept | reject |
| Prime-order point + torsion (7 variants) | accept | reject |
| Non-canonical y (y ≥ p) | accept | reject |
| "Negative zero" x sign | accept | reject |
| Off-curve | reject | reject |

Why it matters:

- **Torsioned point: funds stuck.** `S' = S + T` is on the curve but no scalar opens it, so the claim or refund that needs it can never succeed. Shown by test.
- **Identity or small order: degenerate joint key.** The Monero joint spend key is `S_maker + S_taker`. A share with no prime-order component contributes nothing there.
- **Non-canonical bytes: two encodings of one key.** Equality on bytes would fail for a point that Monero treats as the same key.

Not covered by any on-chain point check (READ, reasoning only): a commitment does not prove its author knows the scalar. A party who sees the other share first can publish `S' = k·G − S_other` and control the joint Monero key alone. They can never open `S'` on Solana, so the protocol must make sure no path pays them without an opening. The usual fix is a proof of knowledge of each share, checked by the counterparty off-chain before locking. This belongs in the protocol spec.

## Design recommendations

### PDAs and layout

| Account | Seeds | Notes |
|---|---|---|
| Config | `["config"]` | treasury, fee bps, allowed mints, admin |
| Maker | `["maker", owner]` | fixed-size fields first so `memcmp` offsets stay stable; variable data (onion address, contacts, offers) last |
| Swap | `["swap", taker, swap_id]` | `swap_id` chosen by the client (8 random bytes); taker pays rent |
| Token vault | `["vault", swap]` | SPL token account, authority = swap PDA |

- **Store every bump** and verify with `bump = account.bump`. It saves the bump search on every later instruction.
- **Prototype `Swap` is 226 bytes** (8 + 4 pubkeys + amount + two points + deadline + id + flags): 0.0018 SOL rent on mainnet today. The real one will be larger; rent is returned on close.
- **Batch locks.** One transaction fits several `lock` instructions only up to the 1,232-byte packet limit. Each lock carries about 180 bytes of arguments plus accounts, so plan on 3 to 4 legs per transaction, or use an address lookup table (READ).

### Escrow (RAN)

- **SOL: hold it in the swap PDA.** Lock is a system transfer into the PDA. Pay out by `swap.sub_lamports(amount)?; dest.add_lamports(amount)?;`, which needs no CPI because the program owns the account.
- **`close = taker` sends the whole balance.** On refund that is escrow plus rent in one step. On claim, move the escrow to the maker first, then let `close` return the remainder.
- **Tokens: a PDA token account per swap.** `init` with `token::authority = swap`. Pay out with `transfer_checked` signed by the swap seeds, then `close_account` to return the vault's rent, then close the swap. This is cheaper than an associated token account and needs no ATA program.
- **Pin every destination.** `address = swap.taker`, `address = swap.maker`, and `token::authority = taker` on token destinations. The tests confirm a session key or a stranger cannot redirect a payout.
- **USDC is on the classic Token program** (RPC: mint `EPjF…Dt1v` is owned by `Tokenkeg…`). Check the mint against an allow-list in Config. If Token-2022 mints are ever allowed, reject transfer-fee and transfer-hook extensions.

### Session keys (RAN)

Store `session_key: Pubkey` in the swap at lock. The key does not sign the lock, so the wallet prompt is unchanged. Authorise with:

```rust
#[account(mut, constraint = authority.key() == swap.session_key || authority.key() == swap.taker
    @ SwapError::Unauthorized)]
pub authority: Signer<'info>,
```

The session key must pay its own transaction fees, or the wallet is back in the loop. The lock instruction forwards lamports to it. Two rent rules bite here, both reproduced:

- **Funding below the rent minimum fails the lock.** Sending "two fees' worth" (10,000 lamports) to a new address gives `InsufficientFundsForRent`.
- **A fee payer must end each transaction rent-exempt or at exactly zero.** With rent minimum + 1 fee, the first transaction works and the second cannot be paid for.

So fund it with rent minimum + (number of transactions expected + retries) × fee, and have the last instruction sweep it to zero:

```rust
/// If the signer is the session key (not the taker's wallet), return every
/// lamport it still holds to the taker so the throwaway key ends at zero.
fn sweep_session<'info>(system: &Program<'info, System>, authority: &Signer<'info>,
                        taker: &UncheckedAccount<'info>) -> Result<()> {
    let left = authority.lamports();
    if authority.key() == taker.key() || left == 0 { return Ok(()); }
    system_program::transfer(
        CpiContext::new(system.to_account_info(),
            system_program::Transfer { from: authority.to_account_info(), to: taker.to_account_info() }),
        left)
}
```

The fee is deducted before execution, so sweeping the full remaining balance leaves exactly zero. In the test the taker ends out only the fees. Failed attempts still cost a fee, so leave headroom for retries: an auto-refund that runs out of fee money is a lost refund.

Also needed and not prototyped: a sweep on the claim path, so a session key that only ever set ready does not strand its rent minimum (0.00065 SOL).

### Keep the revealed scalar in account state

The prototype emits the scalar in an event and closes the swap. That is not safe enough for the real program. After a claim the taker's XMR depends on reading the maker's scalar, and after a refund the maker's XMR depends on reading the taker's. If the swap account is closed in the same instruction, the only copies are in transaction history, which RPC nodes prune and log collectors truncate.

Recommended: claim and refund write the 32-byte scalar into the swap account and mark it settled. Funds move immediately. The account is closed in a later instruction by the party who needed the scalar (or by anyone after a delay), with rent still going to the taker. `getAccountInfo` on the swap PDA then returns the key half from any RPC node. Cost: the taker's rent is returned a little later.

### Messages (RAN for cost, READ for RPC behaviour)

| Option | CU at 64 / 256 / 700 bytes | Extra accounts | Where the data lives | Risk |
|---|---|---|---|---|
| Instruction data only | 819 / 819 / 819 | none | the transaction itself | readers must fetch and decode transactions |
| `emit!` (log) | 1,292 / 1,673 / 2,118 | none | `Program data:` log line | logs are truncated at 10 kB per transaction and some RPCs drop them |
| `emit_cpi!` | 10,827 / 12,553 / 16,108 | event authority + program | inner instruction data | none of the above; 8 to 13 times the CU |
| Account data | not measured | one account | account state | rent, and someone must close it |
| Memo program | not measured | none | instruction data + log | same as the first two, with a CPI or extra instruction |

Recommendation:

- **Inbox messages, quote requests, approvals:** instruction data only. Pass the recipient's maker PDA (and the swap PDA when there is one) as a read-only account, so `getSignaturesForAddress(makerPda)` lists the inbox and `logsSubscribe` with `mentions` gives a live feed. Add `emit!` as well if a log-based indexer is wanted; it is 500 to 1,300 CU more.
- **Lock notice** (transaction ID and view-key half): write it into the swap account. The design already lists it as swap state, and the refund rules depend on whether it exists.
- **Revealed key halves:** swap account state, as above.
- **Size limit:** a transaction is 1,232 bytes. With one signature and a handful of accounts, about 900 bytes of ciphertext fit.

CU does not change the base fee (5,000 lamports per signature). It matters only for priority fees.

### Listing makers (RAN in-process, READ for RPC)

Anchor's account discriminator is `sha256("account:<Name>")[..8]`, at offset 0.

| Account | Bytes | Hex | Base58 (for `memcmp.bytes`) |
|---|---|---|---|
| `Maker` | `[31, 255, 232, 61, 38, 28, 189, 147]` | `1fffe83d261cbd93` | `6MSKcZArUDQ` |
| `Swap` | `[53, 206, 146, 152, 44, 97, 120, 177]` | `35ce92982c6178b1` | `9zzgj4NEBqr` |

```ts
const makers = await connection.getProgramAccounts(PROGRAM_ID, {
  filters: [{ memcmp: { offset: 0, bytes: "6MSKcZArUDQ" } }],
});
// a taker's open swaps: add { memcmp: { offset: 8, bytes: takerPubkey.toBase58() } }
```

These values hold only while the account names stay `Maker` and `Swap`. Put `owner`/`taker`/`maker` at fixed offsets right after the discriminator so they can be filtered the same way.

`getProgramAccounts` is the heaviest RPC call. Public endpoints rate-limit or disable it. Keep maker accounts small, use `dataSlice` when only keys are needed, and say in the self-hosting docs that the RPC endpoint must allow it.

### Deadlines: `unix_timestamp`, not slot

Use `Clock::get()?.unix_timestamp` (i64 seconds) for every deadline. Use `slot` only as a record, such as the registration slot.

- **The design's windows are wall-clock:** 60 seconds, 10 minutes, 60 minutes, 30 minutes, 7 days, 60 days, and "confirmation time plus 15 minutes" for Monero.
- **Slot length is not a constant.** It is nominally 400 ms, varies under load, and is due to change with Alpenglow. A 7-day deadline in slots could be off by hours (READ).
- **`unix_timestamp` is a stake-weighted validator estimate.** It is monotonic but can trail real time, historically by seconds and during degraded periods by more (READ). Clients should read the on-chain clock when computing "time left", and the auto-refund margin should allow for the lag.
- **Tested:** the boundary is `>=`; one second before the deadline fails with `TooEarly`, the deadline second succeeds.

### Rent on mainnet has changed (RPC)

The Rent sysvar on mainnet-beta now reads 5,080 lamports per byte with a threshold of 1.0. The long-standing figure was 6,960 (3,480 × 2 years), and the Rust crates and LiteSVM still default to it.

| Size | Mainnet today | Old default |
|---|---|---|
| 0 bytes (a session key) | 650,240 lamports | 890,880 |
| 165 bytes (token account) | 1,488,440 | 2,039,280 |
| 226 bytes (prototype swap) | 1,798,320 | 2,463,840 |
| 415 KB program | about 2.1 SOL | about 2.9 SOL |

Never hard-code a rent figure. On-chain use `Rent::get()`; in clients call `getMinimumBalanceForRentExemption`. The harness sets the sysvar to the mainnet value.

### Other notes

- **Program size.** The prototype with `anchor-spl` is 415 KB. The real program will be larger; budget 3 to 6 SOL of rent for the program data account, more if deployed with spare room for upgrades.
- **Box the token accounts.** `Box<InterfaceAccount<…>>` on every mint and token account kept the instructions inside the SBF stack frame.
- **Scratch contents.** `.scratch/solana-curve/keys/program.json` is a throwaway program keypair for the prototype ID. Do not reuse it for a deployment.

## What was not tested

- Nothing was deployed or sent to any cluster. Mainnet behaviour is inferred from the feature gate being active and from LiteSVM running the same agave runtime (4.2.2) under mainnet's feature list. Mainnet itself reports 4.4.1.
- `solana-curve25519` 3.1.14 and 4.0.1 were compiled but the tests ran only against 2.3.13.
- RPC behaviour: `getProgramAccounts` filters, `getSignaturesForAddress`, log truncation and history pruning are from documentation.
- Clock drift figures are from documentation.
- Token-2022 mints, frozen token accounts, address lookup tables and multi-leg batch locks.
- Browser-side key generation (for example `@noble/curves`); only `curve25519-dalek` was used off-chain.
