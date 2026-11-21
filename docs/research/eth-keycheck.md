# Ethereum side: key-share check, cross-curve proof, signed quotes, finality, USDC, upgrades

2026-11-21. Research for `docs/DESIGN.md` (the Decisions table there wins over anything here).

Everything marked **RAN** was executed on this machine; **READ** means taken from source code or
documentation without running it. Prototypes live in `.scratch/eth-keycheck/` (gitignored):

| Path | What it is |
| --- | --- |
| `.scratch/eth-keycheck/evm/src/Secp256k1KeyCheck.sol` | the on-chain key check (library) |
| `.scratch/eth-keycheck/evm/src/SwapEscrowProto.sol` | prototype escrow: EIP-712 quotes and approvals, ETH + ERC-20, UUPS |
| `.scratch/eth-keycheck/evm/test/*.t.sol` | 32 forge tests, all passing |
| `.scratch/eth-keycheck/evm/test/quote.json`, `quote.sig` | typed-data JSON and a signature made outside Solidity with `cast` |
| `.scratch/eth-keycheck/dleq-proto/` | Rust crate: two cross-curve DLEQ libraries, native bench + raw wasm32 build, `run-wasm.mjs` |

Re-run: `cd .scratch/eth-keycheck/evm && forge test -vv`;
`cd .scratch/eth-keycheck/dleq-proto && cargo run --release --bin bench && cargo build --release --lib --target wasm32-unknown-unknown && node run-wasm.mjs target/wasm32-unknown-unknown/release/dleq_proto.wasm`.
Build output (`target/`, `out/`, `cache/`) was deleted; `evm/lib/` (7.5 MB, pinned tags) was kept.

Exact versions used: forge 1.7.1, solc 0.8.31 (`evm_version = "osaka"`; also passes on `cancun`),
forge-std 1.17.0, OpenZeppelin Contracts and Contracts-Upgradeable **v5.7.0** (tags, commits `cab19933`
and `14f52c54`), rustc 1.94, node 22.21.

## Summary of answers

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Cheapest sound key check | `ecrecover` as a scalar-multiplication oracle, with a `0 < s < 2^252` range check. About 3.6k gas; 7.3k with a second commitment that lifts the collision bound from 2^80 to 2^160. | RAN |
| 2 | Cross-curve DLEQ library | `sigma_fun` 0.9.0 (`CrossCurveDLEQ`), the one eigenwallet runs in production. 56.6 kB proof; native 65 ms prove / 63 ms verify; wasm 190 / 197 ms. serai's `dleq` 0.4.1 also works (48.8 kB) but labels itself experimental. | RAN (both, native and wasm32) |
| 3 | Quote and advance-approval verification | EIP-712 typed data signed by the operator key in the maker's Ethereum record; domain binds chainId and contract; expiry, epoch, id, cumulative caps, one-time key pool root. | RAN |
| 4 | Finality | Still 12 s slots, 32-slot epochs; `finalized` trails the head by 64 to 95 slots, so a transaction is final 12.8 to 19.2 minutes after inclusion. Maker waits for `finalized`. | RAN (measured against mainnet, read-only) |
| 5 | USDC, proxy, one contract | SafeERC20 with balance-delta check on the way in and a never-reverting payout on the way out; UUPS + Ownable2Step, frozen by `renounceOwnership()`; ETH and ERC-20 in one contract with `token == address(0)` for ETH. | RAN (mock USDC); live USDC facts read from mainnet |

Three findings change the design, not just fill it in:

1. **The proofs are about 50 kB each and cannot ride the Solana board or Ethereum events.** They need Tor,
   the relay, or a plain HTTPS fetch of a content-addressed blob. See section 2.
2. **A claim transaction must never revert.** The secret is public as soon as the transaction is
   broadcast, so a payout failure (USDC blacklist, a recipient that rejects ETH) must park the funds
   instead of reverting. See section 5.
3. **The 10-minute lock-notice deadline cannot hold on Ethereum** if the maker waits for finality first.
   It needs to be about 30 minutes there. See section 4.

---

## 1. On-chain check that a revealed scalar matches a committed secp256k1 key

### The trick

`ecrecover(m, v, r, s)` returns `address(r⁻¹ · (s·R − m·G))`, where `R` is the curve point with
x-coordinate `r`. Set `m = 0`, `R = G` (so `r = Gx`, and `v = 27` because `Gy` is even) and pass
`s·Gx mod n` as the signature's `s`. The result is `address(secret · G)`: the last 20 bytes of
`keccak256(X ‖ Y)` of the public key. One precompile call replaces a full scalar multiplication.

The commitment stored in the swap is therefore an **Ethereum address**, 20 bytes, derived from the
secp256k1 twin key.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library Secp256k1KeyCheck {
    uint256 internal constant N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // secp256k1 order
    uint256 internal constant L  = 0x1000000000000000000000000000000014DEF9DEA2F79CD65812631A5CF5D3ED; // ed25519 order
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant MAX_SECRET_EXCLUSIVE = 1 << 252;      // 2^252 < L < N
    uint256 internal constant T2 = uint256(keccak256("xmr-atomic-swap/twin-key/2")) % N;

    function mulVerify(uint256 s, address commitment) internal pure returns (bool) {
        if (s == 0 || s >= MAX_SECRET_EXCLUSIVE) return false;
        if (commitment == address(0)) return false;   // ecrecover's failure value must never match
        address q = ecrecover(bytes32(0), 27, bytes32(GX), bytes32(mulmod(s, GX, N)));
        return q == commitment;
    }

    /// 320-bit variant: also checks address((T2·s)·G) against a second commitment.
    function mulVerify2(uint256 s, address commitment, address commitment2) internal pure returns (bool) {
        if (!mulVerify(s, commitment)) return false;
        if (commitment2 == address(0)) return false;
        address q2 = ecrecover(bytes32(0), 27, bytes32(GX), bytes32(mulmod(mulmod(s, T2, N), GX, N)));
        return q2 == commitment2;
    }
}
```

### Gas (RAN, `test_gas`)

| Check | Gas | Notes |
| --- | --- | --- |
| `mulVerify` inlined | about 3,600 | 3,000 of it is the precompile |
| `mulVerify2` inlined | about 7,300 | two precompile calls |
| whole `claim()` in the prototype, ETH | about 85,000 | includes two payouts and state write, via proxy |
| whole `claim()` in the prototype, USDC | about 71,000 | |

For comparison (READ, not measured): ed25519 scalar multiplication in pure Solidity costs on the order of
a million gas, and mainnet has no ed25519 precompile. Fusaka added a P-256 precompile, which does not
help.

### Edge cases (RAN, `KeyCheck.t.sol`)

| Case | Raw precompile behaviour | What the guard does |
| --- | --- | --- |
| `s = 0` | returns `address(0)` | rejected; a zero commitment is also rejected, so the failure value can never match |
| `s = n` | behaves like 0, returns `address(0)` | rejected by the range check |
| `s ≥ n` | aliases: `s` and `s + n` give the same address | rejected by the range check |
| `2^252 ≤ s < n` | works on secp256k1 | rejected: not a valid cross-curve secret (`s = l` would be zero on ed25519) |
| signature `s` above `n/2` | accepted: the precompile has no low-s rule, unlike OpenZeppelin's `ECDSA.recover` | nothing needed; the trick works for every secret in range. Do **not** route this through OZ `ECDSA`. |
| wrong parity / wrong base point | returns a different address | fails the comparison |
| fuzz against forge's own secp256k1 (`vm.addr`), 256 runs | matches | passes |
| scalar taken from the Rust DLEQ prototype | matches the address the proof verifies to | passes (`test_rustDleqVector`) |

**Why `< 2^252` and not `< l`.** Both DLEQ libraries prove equality of a 252-bit integer, so every honest
secret is below 2^252. That bound is below both group orders, which makes the revealed integer usable
as-is as a Monero scalar and removes the `s` / `s + n` ambiguity. Sampling a key share is therefore
"252 random bits", not "random mod l".

### The 160-bit commitment and the second check

The precompile only returns 160 bits. A party that commits to its own key could search for two scalars
whose public keys hash to the same address (a birthday search, about 2^80 curve operations), prove
equality for one and reveal the other. The counterparty would then hold a scalar that does not open the
Monero key. 2^80 curve operations is not practical today, and AthanorLabs' contract ran with the single
check, but one found collision could be used against every swap open at that moment.

`mulVerify2` closes this for 3.7k more gas. The second commitment is `address(T2 · P)` where `P` is the
twin public key and `T2` a public constant, so the counterparty computes it from `P` after verifying the
DLEQ proof; no extra proof is needed. Breaking it needs a simultaneous collision on both addresses,
about 2^160 work. **This two-address construction is my own, not from the literature. I recommend it, and
it should be on the audit list.**

---

## 2. Cross-curve DLEQ library for the maker daemon (Rust) and the browser (WASM)

### Candidates

| Library | Status (checked 2026-11-21) | Verdict |
| --- | --- | --- |
| `sigma_fun` 0.9.0, module `ext::dl_secp256k1_ed25519_eq` ([LLFourn/secp256kfun](https://github.com/LLFourn/secp256kfun)) | Released 2025-11-19; repository pushed 2026-11-09. eigenwallet/core depends on `sigma_fun` (pinned 0.7 in its workspace) for its Bitcoin-Monero swaps. | **Pick this.** RAN native and wasm. |
| `dleq` 0.4.1, feature `experimental` ([serai-dex/serai](https://github.com/serai-dex/serai/tree/develop/crypto/dleq)) | Released 2023-08-08; the directory still exists and saw maintenance commits in 2025. Its README says the cross-group proof is "highly experimental", has "no formal proofs", was excluded from the 2023 Cypher Stack audit, and that "none are recommended". | Works; keep as the fallback. RAN native and wasm. |
| `noot/dleq-rs` | Last push 2022-11. README: "not production-ready, I wrote this for learning purposes only". | Rejected. READ. |
| `AthanorLabs/go-dleq` | Go; last push 2023-03. The swap project that used it, AthanorLabs/atomic-swap, is archived (last push 2023-12). | Rejected: wrong language for both targets, unmaintained. READ. |

I found no independent audit of either Rust implementation's cross-curve proof. Both follow MRL-0010
(per-bit commitments on both curves plus ring/OR proofs).

### Measurements (RAN; AMD EPYC 9274F, release build, 20 native runs, 10 wasm runs in node 22 / V8)

| | Proof size | Native prove | Native verify | wasm32 prove | wasm32 verify |
| --- | --- | --- | --- | --- | --- |
| `sigma_fun` 0.9.0 `CrossCurveDLEQ` | 56,613 bytes (bincode) | 65 ms | 63 ms | 190 ms | 197 ms |
| `dleq` 0.4.1 `CompromiseLinearDLEq` | 48,765 bytes | 149 ms | 76 ms | 444 ms | 227 ms |

The wasm module with both libraries linked is 506 kB (182 kB gzipped). Negative tests pass for both: a
flipped bit, a proof checked against another key, and (serai) a different transcript context or a
trailing byte are all rejected. An end-to-end vector ties the pieces together: the scalar the Rust prover
used, the secp256k1 point the proof verifies to, `cast wallet address` on that scalar, and Solidity
`mulVerify` all agree, and the ed25519 point was recomputed with a second curve library.

### Dependencies

```toml
[dependencies]
sigma_fun = { version = "=0.9.0", default-features = false, features = ["alloc", "secp256k1", "ed25519", "serde", "bincode"] }
curve25519-dalek-ng = "4"          # 4.1.1; the ed25519 types sigma_fun uses
bincode = { version = "2", features = ["serde"] }   # 2.0.1
sha2 = "0.10"                      # 0.10.9
rand_core = "0.6"                  # 0.6.4
rand_chacha = { version = "0.3", default-features = false }   # 0.3.1
sha3 = "0.10"                      # keccak for the Ethereum address
# resolved transitively: secp256kfun 0.12.1

# fallback candidate
dleq = { version = "=0.4.1", features = ["experimental", "serialize"] }
k256 = { version = "=0.13.4", default-features = false, features = ["std", "arithmetic", "bits"] }
dalek-ff-group = "0.4"             # 0.4.6
flexible-transcript = { version = "0.3", features = ["recommended"] }   # 0.3.4
blake2 = "0.10"

[target.'cfg(target_arch = "wasm32")'.dependencies]
getrandom = { version = "0.2", features = ["js"] }   # see the wasm note below
```

`dleq` 0.4.1 needs the `ff`/`group` 0.13 generation, so `k256` must stay on 0.13.x (0.14 exists) and
`dalek-ff-group` on 0.4.x (0.5 exists).

### Working snippet (sigma_fun)

```rust
use curve25519_dalek_ng::{edwards::CompressedEdwardsY, scalar::Scalar as ScalarQ};
use rand_chacha::ChaCha20Rng;
use sha2::Sha256;
use sigma_fun::{
  ext::dl_secp256k1_ed25519_eq::{CrossCurveDLEQ, CrossCurveDLEQProof},
  secp256k1::fun::Point as PointP,
  HashTranscript,
};

type T = HashTranscript<Sha256, ChaCha20Rng>;

/// Second generators with no known discrete log: the BIP-341 NUMS point and Monero's H.
pub fn system() -> CrossCurveDLEQ<T> {
  let mut k = [0u8; 33];
  hex::decode_to_slice("0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0", &mut k).unwrap();
  let mut e = [0u8; 32];
  hex::decode_to_slice("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94", &mut e).unwrap();
  CrossCurveDLEQ::<T>::new(PointP::from_bytes(k).unwrap(), CompressedEdwardsY(e).decompress().unwrap())
}

/// `secret_le`: 32 bytes little-endian, top four bits clear (< 2^252). `prove` panics otherwise.
pub fn prove(sys: &CrossCurveDLEQ<T>, rng: &mut ChaCha20Rng, secret_le: [u8; 32])
  -> (Vec<u8>, [u8; 65], [u8; 32])
{
  let s = ScalarQ::from_canonical_bytes(secret_le).unwrap();
  let (proof, (secp, ed)) = sys.prove(&s, rng);
  let bytes = bincode::encode_to_vec(bincode::serde::Compat(&proof), bincode::config::standard()).unwrap();
  (bytes, secp.to_bytes_uncompressed(), ed.compress().to_bytes())
}

/// Also rejects an ed25519 point outside the prime-order subgroup (checked inside `verify`).
pub fn verify(sys: &CrossCurveDLEQ<T>, proof: &[u8], secp_compressed: [u8; 33], ed: [u8; 32]) -> bool {
  let Ok((proof, _)) = bincode::decode_from_slice::<bincode::serde::Compat<CrossCurveDLEQProof>, _>(
    proof, bincode::config::standard()) else { return false };
  let (Some(p), Some(q)) = (PointP::from_bytes(secp_compressed), CompressedEdwardsY(ed).decompress())
    else { return false };
  sys.verify(&proof.0, (p, q))
}

pub fn eth_address(uncompressed: &[u8; 65]) -> [u8; 20] {
  use sha3::{Digest, Keccak256};
  Keccak256::digest(&uncompressed[1..])[12..].try_into().unwrap()
}
```

The verifier then computes the two on-chain commitments itself: `address(P)` and `address(T2 · P)`.

### Notes for the build

- **wasm.** Both libraries compile to `wasm32-unknown-unknown` unchanged. A transitive dependency enables
  `rand_core/getrandom`, so the build fails until `getrandom` 0.2 gets a wasm backend. The prototype used
  the `custom` feature with a handler that always errors and took all randomness from a seed supplied by
  the host (`crypto.getRandomValues`), through a raw `extern "C"` interface with no wasm-bindgen. The
  product build should use `features = ["js"]` with wasm-bindgen; that path was **not run** here.
- **Wire format.** The 56.6 kB figure is bincode 2 "standard" config over serde. Fix that encoding in the
  protocol spec, check the decoded length equals the input length, and cap accepted proof size.
- **Context binding.** `sigma_fun`'s proof has no caller-supplied context. That is acceptable because key
  shares are one-time and the maker's are committed in a Merkle root inside the signed quote; a proof
  replayed elsewhere proves the same true statement. serai's version takes a transcript, and the
  prototype shows a context string binding there.
- **Curve types.** `sigma_fun` uses `curve25519-dalek-ng`, a fork that sees little maintenance, and
  `secp256kfun`. Convert to the Monero and Ethereum libraries through the 32/33-byte encodings.
- **Never reuse a key share.** Each swap publishes its secret.

### Consequence: where the proofs travel

Each one-time key share needs its own proof, from both sides: the maker's claim reveals its share, and a
taker refund reveals the taker's.

| Channel | 57 kB proof |
| --- | --- |
| Solana board | A transaction carries about 1.2 kB, so one proof is roughly 50 transactions. Not usable per swap. |
| Ethereum event or calldata | Roughly 2 million gas at the calldata floor price. Not usable, even as a fallback. |
| Tor / relay / HTTPS fetch | Fine. |

Recommendation: the signed quote carries only the Merkle root of the maker's key pool. Each leaf is
`(index, keyAddr, keyAddr2)`, and should also include the ed25519 point so the operator signature covers
the pairing. Proofs are served as content-addressed blobs over the relay or the maker's onion service
and verified in the browser (about 0.2 s each). The taker's proof goes to the maker the same way before
the maker locks XMR. This means Ethereum-leg swaps cannot fall back to on-chain-only messaging the way
Solana legs can; DESIGN.md's "Ethereum events are the fallback" holds for notices and approvals but not
for proofs.

---

## 3. Signed quotes and advance approvals

### Scheme

The maker's Ethereum record stores an **operator address** (the daemon's hot secp256k1 key). Quotes and
approvals are EIP-712 typed data signed by that key. The same 65-byte signature is posted on the Solana
board as opaque bytes; the Solana program does not need to check it. The taker's browser verifies it
before locking, and the Ethereum contract verifies it inside `lock`.

```solidity
struct Quote {
    address maker;      // maker's registered address on this contract
    address token;      // address(0) = ETH
    uint256 price;      // opaque to the contract; recorded with the swap
    uint256 minAmount;
    uint256 maxAmount;  // per lock
    uint256 maxTotal;   // cumulative, tracked per quote digest
    uint64  validUntil; // unix seconds, compared with block.timestamp
    uint64  epoch;      // must equal the maker's current quoteEpoch
    uint32  claimDelay;
    uint16  depositBps;
    uint8   approvalMode;   // 0 auto, 1 window, 2 advance approval required
    bytes32 keyRoot;    // Merkle root of the one-time twin-key pool
    bytes32 quoteId;    // random; cancel handle
}

struct Approval {
    address maker;
    address taker;      // must equal msg.sender of lock()
    address token;
    uint256 maxTotal;   // cumulative size limit, tracked per approval digest
    uint64  validUntil;
    uint64  epoch;      // must equal the maker's current approvalEpoch
    bytes32 approvalId;
}

bytes32 constant QUOTE_TYPEHASH = keccak256(
  "Quote(address maker,address token,uint256 price,uint256 minAmount,uint256 maxAmount,uint256 maxTotal,uint64 validUntil,uint64 epoch,uint32 claimDelay,uint16 depositBps,uint8 approvalMode,bytes32 keyRoot,bytes32 quoteId)");
bytes32 constant APPROVAL_TYPEHASH = keccak256(
  "Approval(address maker,address taker,address token,uint256 maxTotal,uint64 validUntil,uint64 epoch,bytes32 approvalId)");

// domain: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//         name "XmrAtomicSwap", version "1", verifyingContract = the proxy address

function _useQuote(Quote calldata q, bytes calldata sig, uint256 amount, address operator) private {
    bytes32 qd = hashQuote(q);                                   // _hashTypedDataV4(structHash)
    if (ECDSA.recoverCalldata(qd, sig) != operator) revert BadSigner();
    if (block.timestamp > q.validUntil) revert Expired();
    if (q.epoch != makers[q.maker].quoteEpoch) revert StaleEpoch();
    if (quoteCancelled[keccak256(abi.encode(q.maker, q.quoteId))]) revert Cancelled();
    if (amount < q.minAmount || amount > q.maxAmount) revert AmountOutOfRange();
    uint256 filled = quoteFilled[qd] + amount;
    if (filled > q.maxTotal) revert CapExceeded();
    quoteFilled[qd] = filled;
}
```

The full contract, including `_useApproval` and the Merkle-pool key check, is in
`.scratch/eth-keycheck/evm/src/SwapEscrowProto.sol`.

### Replay protection, and the test that proves each line (RAN, `SwapEscrow.t.sol`)

| Threat | Defence | Test |
| --- | --- | --- |
| Signature from another key | recovered address must equal the registered operator | `test_quote_wrongSigner` |
| Taker edits a field (price, limits) | any change alters the digest | `test_quote_tampered` |
| Replay on another chain or fork | `chainId` in the domain, rebuilt from `block.chainid` on each call | `test_quote_otherChain` |
| Replay on another deployment | `verifyingContract` in the domain | `test_quote_otherContract` |
| Stale quote | `validUntil` | `test_quote_expired` |
| Maker wants one quote gone | `cancelQuote(quoteId)` | `test_quote_cancelled_...` |
| Maker wants everything gone (pause switch) | `bumpEpochs()`: one transaction | same test |
| Hot key leaked | re-register a new operator; all old signatures die | same test |
| Quote drained beyond intent | `maxAmount` per lock, `maxTotal` cumulative | `test_quote_limits_...`, `test_quote_cumulativeCap_twoLeafPool` |
| One-time key reused or invented | Merkle proof against `keyRoot`, used-leaf map | same two tests |
| Approval used by someone else | `taker == msg.sender` | `test_advanceApproval` |
| Approval over its size limit, expired, revoked | cumulative counter, `validUntil`, `revokeApproval`, epoch | `test_advanceApproval`, `test_advanceApproval_expiry_revoke_epoch` |
| Signature malleability | OZ `ECDSA` rejects high-s and bad `v` | library behaviour (READ) |
| Encoding differs between Solidity and clients | signature made by `cast wallet sign --data --from-file quote.json` (alloy's EIP-712 code) is accepted by the contract | `test_quote_signedByCast_typedDataJson` |

A quote is deliberately reusable until it expires: it is an offer, not a one-shot voucher. What is
one-shot is the key share.

### Points to carry into the build

- **Quote lifetime.** `validUntil` is compared with the block timestamp, and a transaction can wait a few
  12-second slots. A 60-second quote (the Solana default) will often expire in flight. Use 120 to 180
  seconds on Ethereum and have the UI refuse to submit with under about 36 seconds left.
- **Use `EIP712Upgradeable`**, not `EIP712`, behind the proxy. v5.7.0's non-upgradeable `EIP712` keeps the
  domain in immutables. The domain separator survives an upgrade (tested in `test_upgrade_then_renounce`).
- **EOA operator only.** `ECDSA.recover` is enough; ERC-1271 contract signers add an external call for no
  benefit here.
- **Approval size limit.** The prototype treats it as cumulative. If "per swap" was meant, drop the counter.
- **Client side** (not run; the cast-signed vector covers the encoding): viem's
  `walletClient.signTypedData({ domain, types: { Quote: [...] }, primaryType: 'Quote', message })` and
  `verifyTypedData` take the same JSON as `test/quote.json`. In Rust, alloy's `sol!` macro with
  `eip712_signing_hash`.

---

## 4. Ethereum finality and timeouts

### Measured (RAN, read-only JSON-RPC against mainnet, no key involved)

| Tag | Block | Timestamp gap to `latest` |
| --- | --- | --- |
| `latest` | 26,466,080 | 0 |
| `safe` | 26,466,048 | 384 s = 32 slots |
| `finalized` | 26,466,016 | 768 s = 64 slots = 12.8 min |

Slots are still 12 seconds and epochs 32 slots. The six-second-slot proposal (EIP-7782) is not live.

"2 epochs, 12.8 minutes" is the **minimum**. `finalized` moves once per epoch, so it trails the head by
64 to 95 slots, and a transaction waits between 12.8 and 19.2 minutes depending on where in its epoch it
landed; about 16 minutes on average. DESIGN.md's "roughly 13 to 15 minutes" should read "13 to 19
minutes, longer if finality stalls". Finality has stalled for around an hour before (May 2023).

### What the maker waits for

- **Before locking XMR:** the taker's lock transaction is in a block at or below `finalized`
  (`eth_getBlockByNumber("finalized")`), and the receipt's block hash is still canonical. Not a
  confirmation count.
- **Before broadcasting `claim`:** the taker's `ready` is likewise finalized. `claim` publishes the
  maker's key half; if a reorg dropped `ready` and the taker got a refund in instead, the maker would
  have revealed its key for nothing.
- A maker may offer `safe` (justified, 6.4 to 12.8 minutes) for small swaps as a risk setting. Default
  to `finalized`.
- The taker needs no Ethereum finality wait: once it sees the secret anywhere, it can sweep.

### Timeout values for the Ethereum deployment

| Deadline | Solana value in DESIGN.md | Recommended on Ethereum | Why |
| --- | --- | --- | --- |
| Quote validity | 60 s | 120 to 180 s | inclusion delay |
| Lock notice, from approval | 10 min | **30 min** | 19.2 min worst-case normal finality, plus the same 10 min |
| Automatic refund cutoff | confirmation time + 15 min | unchanged, counted from the notice | the wait is on Monero |
| Maker claim, from `ready` | (not fixed) | 45 min | finality of `ready` plus margin |
| Claim without `ready`, floor | 60 min | **120 min from approval** | 30 min notice + about 20 to 35 min for 10 Monero confirmations + 15 min + inclusion |
| Final deadline | 7 days | 7 days | |

A finality stall makes an honest maker miss the lock-notice deadline. The contract cannot see finality
cheaply, so that miss is still recorded; clients can annotate it from beacon-chain data.

---

## 5. USDC, the proxy pattern, ETH and ERC-20 in one contract

### USDC on Ethereum (live read-only calls, RAN; behaviour of the token READ)

| Fact | Value |
| --- | --- |
| Token | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 6 decimals, `version()` = "2", not paused today |
| It is itself an upgradable proxy | implementation `0x43506849…02dd`, admin `0x807a9628…95d2` |
| Roles | blacklister `0x0A06BE16…78F9`, pauser `0x4914f61d…8566`, owner `0xFcb19e6a…AE3a` |
| Blacklist effect | `transfer`/`transferFrom` revert if the sender, the recipient or the caller is blacklisted |
| Pause effect | all transfers revert |

Risks and what the contract does about each:

| Event | Effect | Handling |
| --- | --- | --- |
| Recipient (maker, taker or treasury) blacklisted | a plain `safeTransfer` would revert the whole claim or refund | `trySafeTransfer`; on failure credit `owed[token][recipient]` and emit an event; the recipient pulls later. Tested: `test_usdc_blacklistedMaker_claimStillSucceeds`. |
| The escrow contract blacklisted, or USDC paused | every USDC swap is stuck until Circle acts | cannot be fixed in code. State stays consistent and the Monero leg still completes (`test_usdc_blacklistedEscrow_freezesEverything`). Disclose it in the UI, as DESIGN.md already says. |
| Token upgraded to take a fee or change semantics | credited amount differs from received | balance-delta check on the way in (`ShortTransfer`) |
| Taker blacklisted before locking | lock reverts | nothing lost |

**Why a claim must not revert.** A claim reveals the maker's key half in calldata. If the payout reverts,
the secret is public, the taker can take the XMR, and the escrow is still refundable. So in `claim` and
`refund`: verify the secret, write the state, emit the event, then pay with a call that cannot revert.
The same applies to ETH sent to a contract that rejects it (`test_eth_recipientRejectsEth_...`). Anyone
may submit a claim; funds always go to the maker's registered address, so copying the secret from the
mempool gains nothing (`test_eth_lock_claim`).

Use OpenZeppelin `SafeERC20` (`safeTransferFrom` in, `trySafeTransfer` out, both in v5.7.0). Whitelist
the token addresses (ETH and the one USDC address) rather than accepting arbitrary ERC-20s.

### Proxy pattern: UUPS, not transparent

| | UUPS (`ERC1967Proxy` + `UUPSUpgradeable`) | Transparent (`TransparentUpgradeableProxy` + `ProxyAdmin`) |
| --- | --- | --- |
| Upgrade logic lives in | the implementation | the proxy, driven by a separate ProxyAdmin contract |
| Per-call overhead | none beyond the delegatecall | an admin check on every call |
| How it becomes immutable | `renounceOwnership()` on the contract itself: `_authorizeUpgrade` is `onlyOwner`, the owner becomes `address(0)` | renounce ownership of the ProxyAdmin (a second contract users must inspect) |
| Main risk | an upgrade to an implementation without `upgradeToAndCall` bricks upgradability (which is the end state wanted anyway); OZ checks `proxiableUUID` to prevent accidents | more moving parts |

Recommendation, all from OpenZeppelin v5.7.0 and all exercised in the prototype:

```solidity
contract SwapEscrow is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable,
                       EIP712Upgradeable, ReentrancyGuardTransient {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address owner_, address treasury_) external initializer {
        __Ownable_init(owner_);
        __EIP712_init("XmrAtomicSwap", "1");
        treasury = treasury_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
// deploy: new ERC1967Proxy(address(new SwapEscrow()), abi.encodeCall(SwapEscrow.initialize, (owner, treasury)))
// freeze: owner calls renounceOwnership()
```

Tested in `test_upgrade_then_renounce` and `test_implementation_cannot_be_initialized`: a non-owner
cannot upgrade; the owner can, and swap state plus the EIP-712 domain survive; after
`renounceOwnership()` the former owner's upgrade reverts; the implementation and the proxy cannot be
re-initialised.

- **Ownable2Step** guards the hand-over to a multisig against a mistyped address. `renounceOwnership()`
  is still a single call.
- **Keep the owner's powers to upgrading only.** If the owner also sets the treasury or a token list,
  renouncing freezes those too, which matches "keep parameters in the offer".
- **A harmless quirk:** once the owner is `address(0)`, a simulated call with `from = 0x0` passes
  `onlyOwner` (shown in the test). No real transaction can come from that address.
- **Storage layout:** the prototype uses ordinary state variables. The production contract should put its
  state in one ERC-7201 namespaced struct, as the OZ upgradeable contracts do.
- **`ReentrancyGuardTransient`** needs no initializer and no storage slot, so it is safe behind a proxy.
  It needs transient storage (Cancun or later).
- **Compiler:** v5.7.0 builds with solc 0.8.24 or later; the prototype used 0.8.31. OpenZeppelin's
  unreleased master already requires 0.8.31 and the Osaka EVM, so pin the tag.
- `foundry.toml` remappings: `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/` and
  `@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/`. Install with
  `forge install OpenZeppelin/openzeppelin-contracts@v5.7.0 OpenZeppelin/openzeppelin-contracts-upgradeable@v5.7.0`.

### ETH and ERC-20 in one contract

`token == address(0)` means ETH. `lock` is `payable`; for ETH it requires `msg.value == amount`, for a
token it requires `msg.value == 0` and pulls with `safeTransferFrom`. One `_payout(token, to, amount)`
handles both and parks failures. ETH is pushed with a 30,000 gas stipend so a recipient cannot grief the
claim; `nonReentrant` covers every entry point that moves funds.

Prototype gas, unoptimised and measured inside the test through the proxy (RAN): `lock` about 284k
(ETH) and 339k (USDC), `claim` about 85k and 71k. The swap record takes seven storage slots; packing it
and dropping the per-quote fill counter where unused would cut `lock` substantially.

---

## Not done / open

- The wasm-bindgen + `getrandom/js` browser build and a viem signing round-trip were not run.
- No anvil deployment: every Solidity result is from forge's in-process EVM.
- The mock USDC imitates the blacklist; the real token was only read, not forked.
- Approval windows, anti-spam deposits, `ready`, fault counters and the identity link are not in the prototype.
- The cross-curve proof (either library) and the two-address commitment have no audit.
