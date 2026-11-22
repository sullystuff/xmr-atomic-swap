// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {XmrSwap} from "../../src/XmrSwap.sol";
import {SwapStore} from "../../src/lib/SwapStore.sol";
import {IXmrSwap} from "xmrswap-interfaces/ethereum/IXmrSwap.sol";

/// Test stand-in for USDC: 6 decimals, a blacklist and a pause switch, as the real token has.
/// It can also call back into a target during a transfer, to test reentrancy through a token.
contract MockUSDC {
    string public constant name = "USD Coin (mock)";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;
    bool public paused;
    /// Tokens skimmed from every transfer (to test `ShortTransfer`).
    uint256 public feeOnTransfer;
    address public hookTarget;
    bytes public hookData;
    bool public hookResult;
    bool public hookCalled;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlacklisted(address who, bool on) external {
        blacklisted[who] = on;
    }

    function setPaused(bool on) external {
        paused = on;
    }

    function setFeeOnTransfer(uint256 fee) external {
        feeOnTransfer = fee;
    }

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
        hookCalled = false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(!paused, "paused");
        require(!blacklisted[msg.sender] && !blacklisted[from] && !blacklisted[to], "blacklisted");
        require(balanceOf[from] >= amount, "balance");
        if (hookTarget != address(0)) {
            hookCalled = true;
            (hookResult,) = hookTarget.call(hookData);
        }
        balanceOf[from] -= amount;
        uint256 fee = feeOnTransfer > amount ? amount : feeOnTransfer;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount);
    }
}

/// A recipient whose behaviour on receiving ETH is switchable.
contract Receiver {
    enum Mode {
        Accept,
        Reject,
        BurnGas,
        Reenter
    }

    Mode public mode;
    address public target;
    bytes public data;
    bool public reentered;
    bool public reenterResult;
    bytes public reenterReturn;
    uint256 public sink;

    function set(Mode mode_, address target_, bytes calldata data_) external {
        mode = mode_;
        target = target_;
        data = data_;
    }

    function run(address to, bytes calldata callData) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call{value: msg.value}(callData);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        if (mode == Mode.Reject) revert("no ETH");
        if (mode == Mode.BurnGas) {
            while (true) sink += 1;
        }
        if (mode == Mode.Reenter) {
            reentered = true;
            (reenterResult, reenterReturn) = target.call(data);
        }
    }
}

/// Upgrade target used by the upgrade tests.
contract XmrSwapV2 is XmrSwap {
    function version() external view override returns (string memory) {
        address(this);
        return "2";
    }
}

/// Test-only: writes a whole interface struct into the packed storage record, field by field,
/// refusing what the record cannot hold. Production code never writes a swap this way; tests use
/// it to check that every field survives the packed form and comes back through `getSwap`.
library TestStore {
    function store(SwapStore.Record storage r, IXmrSwap.Swap memory v) internal {
        r.taker = v.taker;
        r.maker = v.maker;
        r.token = v.token;
        r.sessionKey = v.sessionKey;
        r.swapNonce = v.swapNonce;
        r.state = v.state;
        r.direction = v.direction;
        r.mode = v.mode;
        r.outcome = v.outcome;
        r.depositState = v.depositState;
        r.depth = v.depth;
        r.flags = v.flags;
        r.depBps = v.depBps;
        r.makerEncVersion = v.makerEncVersion;
        r.xmr = v.xmr;
        r.amount = SwapStore._u128(v.amount);
        r.deposit = SwapStore._u128(v.deposit);
        r.price = SwapStore._u128(v.price);
        r.noticeWindow = v.noticeWindow;
        r.claimDelay = v.claimDelay;
        r.claimWindow = v.claimWindow;
        r.takerKey = v.takerKey;
        r.takerKey2 = v.takerKey2;
        r.takerSpendPub = v.takerSpendPub;
        r.makerKey = v.makerKey;
        r.makerKey2 = v.makerKey2;
        r.makerSpendPub = v.makerSpendPub;
        r.lockerView = v.lockerView;
        r.takerEncKey = v.takerEncKey;
        r.makerEncKey = v.makerEncKey;
        r.noticeCommitment = v.noticeCommitment;
        r.noticeCiphertext = v.noticeCiphertext;
        r.evidenceTxid = v.evidenceTxid;
        r.evidenceView = v.evidenceView;
        r.keyLeaf = v.keyLeaf;
        r.openHash = v.openHash;
        r.revealed = v.revealed;
        r.tLock = v.tLock;
        r.tPendingDeadline = v.tPendingDeadline;
        r.tActive = v.tActive;
        r.tNoteDeadline = v.tNoteDeadline;
        r.tNotice = v.tNotice;
        r.tCut = v.tCut;
        r.tClaimOpen = v.tClaimOpen;
        r.tReady = v.tReady;
        r.tClaimDeadline = v.tClaimDeadline;
        r.tFinal = v.tFinal;
        r.tRefund = v.tRefund;
        r.tSettled = v.tSettled;
    }
}

/// Test-only implementation that can seed a maker record (the saturation sequence of
/// `transitions.json` starts with counters at their maxima). The proxy is upgraded to it, seeded,
/// and upgraded back, so the sequence itself runs on the real implementation.
contract XmrSwapSeeder is XmrSwap {
    function seedMaker(
        address maker,
        address token,
        uint32[40] calldata counters_,
        uint64 responseSecsSum,
        uint128 volume,
        uint128 withheldVolume
    ) external {
        SwapStore.Layout storage $ = SwapStore.layout();
        IXmrSwap.Maker storage m = $.makers[maker];
        m.counters = counters_;
        m.responseSecsSum = responseSecsSum;
        $.volume[maker][token] = volume;
        $.withheldVolume[maker][token] = withheldVolume;
    }

    /// Write a whole swap record (the packing tests).
    function seedSwap(bytes32 swapId, IXmrSwap.Swap calldata v) external {
        TestStore.store(SwapStore.layout().swaps[swapId], v);
    }
}

/// State variables of the namespaced types, so that `forge inspect StorageLayoutProbe
/// storage-layout` prints their packing (ethereum/STORAGE.md). The real contract reaches them
/// through the ERC-7201 slot and has no state variables of its own to inspect.
contract StorageLayoutProbe {
    SwapStore.Record internal record;
    IXmrSwap.Maker internal maker;
    SwapStore.Layout internal layout;
}
