# Storage layout of XmrSwap

Recorded by work package 3 after the swap record was packed (M1 follow-up 5). **This layout must not change once a proxy is deployed**: an upgrade keeps the proxy's storage, so a new implementation may only append fields at the end of `SwapStore.Layout`, or after the last field of a record that is reached through a mapping, and may never reorder, resize or remove one.

## Where the state lives

All of the contract's own state is one ERC-7201 namespaced struct, `SwapStore.Layout`, namespace `xmrswap.storage.v1`, at

```
S = keccak256(abi.encode(uint256(keccak256("xmrswap.storage.v1")) - 1)) & ~bytes32(uint256(0xff))
  = 0x72d7395cd54647fc1d07503abee35a2743d3fbf166f40f42b88abee6111c6600
```

`XmrSwap` and its two linked libraries reach it through `SwapStore.layout()`. The contract declares no state variables, so `forge inspect XmrSwap storage-layout` prints an empty table; that is expected and is itself part of the record (nothing may be added there). The OpenZeppelin bases keep their state in their own ERC-7201 namespaces (`Initializable`, `OwnableUpgradeable`, `Ownable2StepUpgradeable`, `EIP712Upgradeable`), the implementation address in the ERC-1967 slot, and the reentrancy guard in transient storage.

The tables below are the output of

```sh
forge inspect StorageLayoutProbe storage-layout
```

`StorageLayoutProbe` (`test/utils/Mocks.sol`) declares one state variable of each namespaced type so that the compiler prints their packing. Slots are relative to the start of each struct; offsets are bytes from the low end of the slot.

- A swap's record starts at `keccak256(abi.encode(swapId, uint256(S) + 1))`.
- A maker's record starts at `keccak256(abi.encode(maker, uint256(S)))`.

`test/Packing.t.sol` pins the swap record against raw storage slot by slot (`test_layout_isTheRecordedOne`), checks which slots `lock` and `take` write, and round-trips every field at its extremes through `getSwap`.

## The packed swap record

`getSwap` returns the frozen `IXmrSwap.Swap`; in storage the same fields are packed into 24 slots (the interface struct in its own order takes 28, plus the ciphertext). `lock` writes slots 0 to 16, 17 fresh slots instead of 22. `take` writes 12 and leaves 7, 11, 12 and 15 and the address halves of 6 for `fund`.

- `amount`, `deposit` and `price` are `uint128`. `lock` and `take` refuse anything above `2^128 − 1` with `AmountOutOfRange` (`SwapStore._u128`); nothing is truncated.
- Slot 2 is the status slot: every transition writes `state` there, and the transition that settles the swap writes `outcome` and `tSettled` in the same slot.
- Slot 17 is first written by the notice, slot 18 by a keyed refund, slots 19 and 20 (and the four data slots of the 104-byte ciphertext at `keccak256(slot 20)`) by the notice, 21 and 22 by evidence, 23 by the call that reveals a secret.

### Fields

| Slot | Offset | Bytes | Field | Type |
| --- | --- | --- | --- | --- |
| 0 | 0 | 20 | `taker` | `address` |
| 0 | 20 | 8 | `tLock` | `uint64` |
| 0 | 28 | 4 | `noticeWindow` | `uint32` |
| 1 | 0 | 20 | `maker` | `address` |
| 1 | 20 | 8 | `xmr` | `uint64` |
| 1 | 28 | 4 | `claimDelay` | `uint32` |
| 2 | 0 | 20 | `token` | `address` |
| 2 | 20 | 8 | `tSettled` | `uint64` |
| 2 | 28 | 1 | `state` | `uint8` |
| 2 | 29 | 1 | `outcome` | `uint8` |
| 2 | 30 | 1 | `depositState` | `uint8` |
| 2 | 31 | 1 | `flags` | `uint8` |
| 3 | 0 | 20 | `sessionKey` | `address` |
| 3 | 20 | 8 | `tFinal` | `uint64` |
| 3 | 28 | 4 | `claimWindow` | `uint32` |
| 4 | 0 | 20 | `takerKey` | `address` |
| 4 | 20 | 8 | `tPendingDeadline` | `uint64` |
| 4 | 28 | 4 | `makerEncVersion` | `uint32` |
| 5 | 0 | 20 | `takerKey2` | `address` |
| 5 | 20 | 8 | `tActive` | `uint64` |
| 5 | 28 | 1 | `direction` | `uint8` |
| 5 | 29 | 1 | `mode` | `uint8` |
| 5 | 30 | 1 | `depth` | `uint8` |
| 6 | 0 | 20 | `makerKey` | `address` |
| 6 | 20 | 8 | `tNoteDeadline` | `uint64` |
| 6 | 28 | 2 | `depBps` | `uint16` |
| 7 | 0 | 20 | `makerKey2` | `address` |
| 7 | 20 | 8 | `tClaimDeadline` | `uint64` |
| 8 | 0 | 16 | `amount` | `uint128` |
| 8 | 16 | 16 | `deposit` | `uint128` |
| 9 | 0 | 16 | `price` | `uint128` |
| 9 | 16 | 16 | `swapNonce` | `bytes16` |
| 10 | 0 | 32 | `takerSpendPub` | `bytes32` |
| 11 | 0 | 32 | `makerSpendPub` | `bytes32` |
| 12 | 0 | 32 | `lockerView` | `bytes32` |
| 13 | 0 | 32 | `takerEncKey` | `bytes32` |
| 14 | 0 | 32 | `makerEncKey` | `bytes32` |
| 15 | 0 | 32 | `keyLeaf` | `bytes32` |
| 16 | 0 | 32 | `openHash` | `bytes32` |
| 17 | 0 | 8 | `tNotice` | `uint64` |
| 17 | 8 | 8 | `tCut` | `uint64` |
| 17 | 16 | 8 | `tClaimOpen` | `uint64` |
| 17 | 24 | 8 | `tReady` | `uint64` |
| 18 | 0 | 8 | `tRefund` | `uint64` |
| 19 | 0 | 32 | `noticeCommitment` | `bytes32` |
| 20 | 0 | 32 | `noticeCiphertext` | `bytes` |
| 21 | 0 | 32 | `evidenceTxid` | `bytes32` |
| 22 | 0 | 32 | `evidenceView` | `bytes32` |
| 23 | 0 | 32 | `revealed` | `uint256` |

24 slots.

## The maker record (`IXmrSwap.Maker`, unchanged)

| Slot | Offset | Bytes | Field | Type |
| --- | --- | --- | --- | --- |
| 0 | 0 | 20 | `operator` | `address` |
| 1 | 0 | 20 | `payout` | `address` |
| 1 | 20 | 4 | `quoteEpoch` | `uint32` |
| 1 | 24 | 4 | `approvalEpoch` | `uint32` |
| 1 | 28 | 1 | `paused` | `bool` |
| 2 | 0 | 8 | `registeredAt` | `uint64` |
| 3 | 0 | 32 | `solanaOwner` | `bytes32` |
| 4 | 0 | 32 | `solanaOwnerNext` | `bytes32` |
| 5 | 0 | 8 | `solanaOwnerNextAt` | `uint64` |
| 5 | 8 | 2 | `openPending` | `uint16` |
| 5 | 10 | 8 | `responseSecsSum` | `uint64` |
| 6 | 0 | 160 | `counters` | `uint32[40]` |

11 slots.

## The namespaced root (`SwapStore.Layout`)

| Slot | Offset | Bytes | Field | Type |
| --- | --- | --- | --- | --- |
| 0 | 0 | 32 | `makers` | `mapping(address => struct IXmrSwap.Maker)` |
| 1 | 0 | 32 | `swaps` | `mapping(bytes32 => struct SwapStore.Record)` |
| 2 | 0 | 32 | `keyUsed` | `mapping(address => mapping(address => bool))` |
| 3 | 0 | 32 | `swapsByTaker` | `mapping(address => bytes32[])` |
| 4 | 0 | 32 | `quoteCancelled` | `mapping(address => mapping(uint64 => bool))` |
| 5 | 0 | 32 | `approvalRevoked` | `mapping(bytes32 => bool)` |
| 6 | 0 | 32 | `owed` | `mapping(address => mapping(address => uint256))` |
| 7 | 0 | 32 | `treasuryAccrued` | `mapping(address => uint256)` |
| 8 | 0 | 32 | `volume` | `mapping(address => mapping(address => uint128))` |
| 9 | 0 | 32 | `withheldVolume` | `mapping(address => mapping(address => uint128))` |
| 10 | 0 | 20 | `treasury` | `address` |
| 11 | 0 | 20 | `usdc` | `address` |
| 12 | 0 | 32 | `makerOfOperator` | `mapping(address => address)` |

13 slots.

`volume` and `withheldVolume` saturate at `2^128 − 1`. `makerOfOperator` is the operator index (DEVIATIONS.md, row 5).

## Gas, before and after the packing

A whole transaction (`forge test --isolate --match-contract GasTest -vv`), ETH / USDC.

| Call | Before | After |
| --- | --- | --- |
| `lock` (A) | 617,071 / 672,712 | 528,905 / 564,646 |
| `take` (B) | 499,142 / 554,771 | 432,390 / 468,119 |
| `approve` (A) | 93,424 | 98,293 |
| `fund` (B) | 193,832 / 220,511 | 176,819 / 203,498 |
| `postNotice` | 220,936 (A), 223,213 (B) | 220,717 (A), 220,980 (B) |
| `setReady` | 70,524 (A), 70,176 (B) | 67,854 (A), 67,887 (B) |
| `claim` (A) | 113,174 / 132,834 | 110,584 / 130,244 |
| `claim` (B) | 115,259 / 134,919 | 110,474 / 130,134 |
| `refund` (A, READY after T_cd) | 109,124 / 128,784 | 126,291 / 145,951 |
| `refund` (B, READY after T_cd) | 125,940 / 145,600 | 143,157 / 162,817 |

Two calls cost more than before. `approve` writes three already-used slots instead of two (about 5,000 gas). A keyed refund writes `tRefund` into a slot of its own (about 17,000 gas): the eight address slots have room for eight of the thirteen 64-bit fields, four more share slot 17, and the one left over is the refund time, which only the uncommon path writes. A happy path in direction A (lock, approve, notice, ready, claim) costs about 89,000 gas less than before with ETH and about 109,000 less with USDC.
