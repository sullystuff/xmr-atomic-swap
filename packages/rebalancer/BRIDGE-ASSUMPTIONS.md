# wXMR bridge: assumed program interface

The bridge adapter encodes instructions and decodes accounts **without the bridge's IDL**. SPEC
7.7 and 10.1 say the project owner supplies the current IDL at
`packages/rebalancer/vendor/wxmr_bridge.json`; it has not been supplied, and nothing was copied
from the operator's workspace into this repository.

Everything below comes from `docs/research/local-assets.md` section 3 and SPEC 7.7. The single
source in code is the `LAYOUT` table in `src/bridge/program.ts`; the encoders, the decoders and
the conformance test all read it.

## How it is checked

| Check | Where | Status |
| --- | --- | --- |
| Encodings match this document (golden bytes, account order and flags, PDA addresses) | `test/bridge-program.test.ts` | Runs always |
| Every row below matches the owner-supplied IDL | `test/bridge-idl.test.ts` | **Skipped until `vendor/wxmr_bridge.json` exists**; prints a warning and a skipped test saying so |
| Read-only cross-check | `WXMR_BRIDGE_IDL=<path> pnpm --filter @xmrswap/rebalancer test` | Run once on 2026-11-21 against the operator's backend IDL, in place, without copying it: all 17 conformance checks passed. This is not a substitute for the owner placing the file. |
| The deployed program matches the source the facts came from | Not possible here (no network) | **Open.** `local-assets.md` notes the local build output is older than the source. Confirm before relying on `cancel_withdrawal` and the deposit fee. |

## Constants

| Item | Assumed value |
| --- | --- |
| Program id | `EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8` |
| wXMR mint | `WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp`, classic SPL Token, 12 decimals |
| Minimum, each way | 100,000,000,000 piconero (0.1 XMR), checked against `amount` as passed |
| Withdrawal fee | `BridgeConfig.fee_bps` (10 expected), or the per-user `FeeOverride` when that account exists and is owned by the program |
| Fee arithmetic, `exact_out = false` | `fee = amount * bps / 10000` rounded down; net paid = `amount - fee` |
| Deposit fee | 10 bps of the gross XMR credited |
| Cancel delay | 300 s after `created_at`, Solana clock |
| Heartbeat staleness | 360 s on either `updated_at` or the payload's `observedAt` |

## Discriminators

Anchor's rule: the first 8 bytes of `sha256("<prefix>:<name>")`.

| Kind | Prefix | Name | Bytes (hex) |
| --- | --- | --- | --- |
| Instruction | `global` | `request_withdrawal` | `fb5579cd38c90cb1` |
| Instruction | `global` | `cancel_withdrawal` | `b768b5fa1c80d246` |
| Instruction | `global` | `create_deposit_account` | `19d952cf16967ab5` |
| Account | `account` | `BridgeConfig` | `28ce33e9f628b255` |
| Account | `account` | `FeeOverride` | `2d2129f8fdecef55` |
| Account | `account` | `DepositRecord` | `53e80a1ffb31bda7` |
| Account | `account` | `WithdrawalRecord` | `583b9acad8d2d3ed` |
| Account | `account` | `UserWithdrawalState` | `ce5d3f6a2292e7e6` |
| Account | `account` | `Heartbeat` | `6ab4d833b0744331` |
| Account | `account` | `HeartbeatPage` | `46c9691be07a33f9` |
| Account | `account` | `AuditRecord` | `1785fa0c553c408b` |
| Event | `event` | `WithdrawCompletedEvent` | `c0a228c5535ec642` |
| Event | `event` | `WithdrawRevertedEvent` | `295eba2138188550` |

## Instruction arguments (Borsh, after the discriminator)

| Instruction | Arguments, in order |
| --- | --- |
| `request_withdrawal` | `nonce: u64` LE, `amount: u64` LE, `xmr_address: String` (u32 LE length + UTF-8), `exact_out: bool` (one byte) |
| `cancel_withdrawal` | none |
| `create_deposit_account` | none |

The adapter always sends `exact_out = false` with `amount` equal to the wXMR a swap delivered.

## Instruction accounts

`w` = writable, `s` = signer.

| # | `request_withdrawal` | `cancel_withdrawal` | `create_deposit_account` |
| --- | --- | --- | --- |
| 1 | `config` | `config` | `config` |
| 2 | `withdrawal` w (init) | `withdrawal` w (closed) | `deposit` w (init) |
| 3 | `wxmr_mint` w | `wxmr_mint` w | `user` w s |
| 4 | `user_token_account` w | `user_token_account` w (the owner's ATA) | `system_program` |
| 5 | `fee_treasury` w | `user` w s | |
| 6 | `fee_override` | `authority` w (= `config.authority`, read from chain) | |
| 7 | `user` w s | `withdrawal_state` w | |
| 8 | `token_program` | `token_program` | |
| 9 | `system_program` | `associated_token_program` | |
| 10 | `withdrawal_state` w | `system_program` | |

`user_token_account` for `request_withdrawal` is assumed to be the wallet's associated token
account (the program only requires the right mint and owner). In the reverse path the adapter
sends the ATA program's `CreateIdempotent` (instruction byte `1`) in the same transaction as
`create_deposit_account`.

## PDAs (all under the bridge program)

| Account | Seeds |
| --- | --- |
| Config | `"config"` |
| Fee treasury | `"fee_treasury"` |
| Fee override | `"fee_override"`, user |
| Deposit record | `"deposit"`, user |
| Withdrawal record | `"withdrawal"`, user, nonce as u64 LE |
| Nonce watermark | `"withdrawal_state"`, user |
| Heartbeat root | `"heartbeat"` |
| Heartbeat page | `"heartbeat-page"`, one byte `generation % 2`, index as u16 LE |
| Audit record | `"audit"`, id as u64 LE |
| ProgramData (upgrade authority) | program id, under `BPFLoaderUpgradeab1e11111111111111111111111`; data = u32 tag 3, u64 slot, `Option<Pubkey>` |

## Account layouts (after the 8-byte discriminator)

| Account | Fields, in order |
| --- | --- |
| `BridgeConfig` | `authority: pubkey`, `wxmr_mint: pubkey`, `total_deposits: u64`, `total_withdrawals: u64`, `bump: u8`, `fee_bps: u16` (last; absent on a config created before the field, read as 0) |
| `FeeOverride` | `user: pubkey`, `fee_bps: u16`, `bump: u8` |
| `DepositRecord` | `owner: pubkey`, `xmr_deposit_address: String`, `total_deposited: u64` (gross), `status: enum`, `bump: u8`, `created_at: i64` |
| `WithdrawalRecord` | `user: pubkey`, `nonce: u64`, `amount: u64` (net), `xmr_address: String`, `exact_out: bool`, `status: enum`, `bump: u8`, `created_at: i64`, `fee: u64` |
| `UserWithdrawalState` | `user: pubkey`, `last_nonce: u64`, `bump: u8` |
| `Heartbeat` | `generation: u64`, `updated_at: i64`, `page_count: u16`, `digest: [u8; 32]` (58 bytes in all) |
| `HeartbeatPage` | `generation: u64`, `index: u16`, `data: Vec<u8>` (at most 700 bytes) |
| `AuditRecord` | `epoch: u64` (the id), `timestamp: i64`, `circulating_supply: u64`, `spendable_balance: u64`, `unconfirmed_balance: u64`, `data: String`, `bump: u8` |

| Enum | Variants, in order (one byte) |
| --- | --- |
| `DepositStatus` | `Pending`, `Active`, `Closed` |
| `WithdrawalStatus` | `Pending`, `Sending`, `Completed` |

## Events (in `Program data:` log lines, base64, after the 8-byte discriminator)

| Event | Fields, in order |
| --- | --- |
| `WithdrawCompletedEvent` | `withdrawal_pda: pubkey`, `user: pubkey`, `amount: u64`, `xmr_address: String`, `xmr_tx_hash: String`, `xmr_tx_key: String` |
| `WithdrawRevertedEvent` | `withdrawal_pda: pubkey`, `user: pubkey`, `amount: u64`, `fee: u64`, `reason: String` |

## Behaviour the adapter relies on

| Assumption | Used for |
| --- | --- |
| `nonce` must exceed `last_nonce`; the record PDA is seeded by `(user, nonce)` | Re-sending an unconfirmed request under the same nonce cannot create a second withdrawal |
| A closed record with the watermark at or past its nonce means the request did land | Deciding not to re-send |
| A closed record's outcome is in an event in the PDA's signature history (newest 20 signatures are scanned) | Reading the Monero txid and the amount paid, or a reversal |
| A user cancel emits no event this adapter needs; the adapter records its own cancel | Status after `cancel_withdrawal` |
| `cancel_withdrawal` re-mints the net amount to the owner's ATA; the fee stays | What `status` reports after a cancel |
| `total_deposited` grows by the gross XMR once a deposit is minted | Detecting the mint in the reverse path |
| Heartbeat payload: gzip of JSON `wxmr-heartbeat-v1` with `observedAt`, `moneroHeight`, `balanceAtomic`, `unlockedAtomic`, `latestReserve { account, id }`; root digest = SHA-256 of the concatenated compressed pages | Liveness and payout-capacity checks |
| Reserve record: JSON `wxmr-reserve-v1` in `AuditRecord.data`; `message` is exactly `JSON.stringify({format, id, address, monero, solana, scope})`; `proof` starts `ReserveProofV2` | The optional reserve-proof check, verified by the maker's own node |

## Not assumed, read at run time

The withdrawal fee, the config authority, and the program's upgrade authority
(`WxmrBridgeAdapter.authorities()`), which the daemon shows before first use: the config
authority can change the fee (up to 100%; the adapter refuses at 100%) and reverse pending
withdrawals.
