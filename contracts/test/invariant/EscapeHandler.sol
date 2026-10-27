// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {CheatBase} from "../utils/TestBase.sol";
import {BalanceTree} from "../utils/BalanceTree.sol";
import {MockOpenToken} from "../../src/MockOpenToken.sol";
import {MayaHouseVault} from "../../src/MayaHouseVault.sol";
import {IMayaHouseVault} from "../../src/interfaces/IMayaHouseVault.sol";

/// @notice Honest house (ledger model + Merkle roots of what it owes each account) that may go silent, and
///         players who then use the escape hatch, including forged and repeated claims, while the owner recovers
///         the bankroll that no claim can reach (CS-M1).
contract EscapeHandler is CheatBase {
    uint256 internal constant ONE = 10 ** 18;
    uint256 internal constant N = 4;

    struct Voucher {
        uint256 actor;
        uint256 amount;
        uint256 nonce;
        uint256 expiry;
        bytes signature;
        bool open;
    }

    MayaHouseVault public vault;
    MockOpenToken public token;
    address public operator;
    address public signer;
    uint256 internal signerPk;
    address[N] internal actors;
    Voucher[] internal vouchers;

    // Ledger model: what the house owes each account (balance + its unredeemed vouchers).
    uint256[N] public balance;
    uint256[N] public outstanding;
    uint256 public houseEquity;

    // The latest root: leaves as attested, and the on-chain flows since (mined after its asOf).
    uint256[N] public leaf;
    uint256[N] public depositedSince;
    uint256[N] public withdrawnSince;
    uint64 public seq;

    // Escape bookkeeping.
    uint256[N] public entitlementAtTrigger;
    uint256[N] public paid;
    uint256 public obligationsAtTrigger;
    uint256 public assetsAtTrigger;
    bool public poolCoversEveryone;
    uint256 public recovered;

    // Violation counters: all must stay zero.
    uint256 public unexpected;
    uint256 public earlyTriggers;
    uint256 public overpaid;
    uint256 public shortPaid;
    /// @dev A recovery that left the vault holding less than the claims can still take.
    uint256 public recoveryBreaches;
    string public lastUnexpected;

    mapping(string kind => uint256 count) public hits;

    constructor(
        MayaHouseVault vault_,
        MockOpenToken token_,
        address operator_,
        uint256 signerPk_,
        address[N] memory actors_
    ) {
        vault = vault_;
        token = token_;
        operator = operator_;
        signerPk = signerPk_;
        signer = vm.addr(signerPk_);
        actors = actors_;
        houseEquity = vault_.houseFunded();
    }

    // ------------------------------------------------------------------ house and players while live

    function deposit(uint256 actorSeed, uint256 amount) external {
        uint256 i = actorSeed % N;
        amount = bound(amount, 1, 200_000 * ONE);
        if (token.balanceOf(actors[i]) < amount) return;
        bool escaped = vault.escapeMode();
        vm.prank(actors[i]);
        try vault.deposit(amount) {
            if (escaped) return _fail("deposit in escape mode");
            balance[i] += amount;
            depositedSince[i] += amount;
            hits["deposit"]++;
        } catch (bytes memory reason) {
            if (!escaped || _selector(reason) != IMayaHouseVault.EscapeModeActive.selector) {
                return _fail("deposit reverted");
            }
            hits["deposit:escaped"]++;
        }
    }

    function bet(uint256 actorSeed, uint256 stake, uint256 x100, bool win) external {
        if (vault.escapeMode()) return; // the house is gone
        uint256 i = actorSeed % N;
        if (balance[i] == 0) return;
        stake = bound(stake, 1, balance[i]);
        if (win) {
            uint256 profit = (stake * bound(x100, 101, 1_000)) / 100 - stake;
            if (profit > houseEquity) profit = houseEquity;
            balance[i] += profit;
            houseEquity -= profit;
        } else {
            balance[i] -= stake;
            houseEquity += stake;
        }
        hits["bet"]++;
    }

    function requestVoucher(uint256 actorSeed, uint256 amount, uint256 ttl) external {
        if (vault.escapeMode()) return;
        uint256 i = actorSeed % N;
        uint256 cap = balance[i] < vault.maxVoucherAmount() ? balance[i] : vault.maxVoucherAmount();
        if (cap == 0) return;
        amount = bound(amount, 1, cap);
        uint256 nonce = vouchers.length;
        uint256 expiry = block.timestamp + bound(ttl, 1 hours, 2 days);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, vault.hashWithdrawal(actors[i], amount, nonce, expiry));
        vouchers.push(
            Voucher({
                actor: i, amount: amount, nonce: nonce, expiry: expiry, signature: abi.encodePacked(r, s, v), open: true
            })
        );
        balance[i] -= amount;
        outstanding[i] += amount;
        hits["requestVoucher"]++;
    }

    function redeemVoucher(uint256 seed) external {
        if (vouchers.length == 0) return;
        Voucher storage voucher = vouchers[seed % vouchers.length];
        if (!voucher.open) return;
        uint256 i = voucher.actor;
        bool escaped = vault.escapeMode();
        bool expired = block.timestamp > voucher.expiry;
        uint256 day = block.timestamp / 1 days;
        bool globalCapped = vault.dailyOutflow(day) + voucher.amount > vault.dailyOutflowCap();
        bool capped =
            globalCapped || vault.accountDailyOutflow(day, actors[i]) + voucher.amount > vault.accountDailyOutflowCap();
        vm.prank(actors[i]);
        try vault.withdraw(voucher.amount, voucher.nonce, voucher.expiry, voucher.signature) {
            if (escaped || expired || capped) return _fail("withdraw should have reverted");
            voucher.open = false;
            outstanding[i] -= voucher.amount;
            withdrawnSince[i] += voucher.amount;
            hits["withdraw"]++;
        } catch (bytes memory reason) {
            bytes4 got = _selector(reason);
            bytes4 want = escaped
                ? IMayaHouseVault.EscapeModeActive.selector
                : expired
                    ? IMayaHouseVault.VoucherExpired.selector
                    : globalCapped
                        ? IMayaHouseVault.DailyOutflowCapExceeded.selector
                        : IMayaHouseVault.AccountDailyOutflowCapExceeded.selector;
            if (got != want || !(escaped || expired || capped)) return _fail("withdraw reverted");
            if (escaped) {
                hits["withdraw:escaped"]++;
            } else if (expired) {
                // The ledger re-credits an expired voucher; it stays owed either way.
                voucher.open = false;
                outstanding[i] -= voucher.amount;
                balance[i] += voucher.amount;
                hits["withdraw:expired"]++;
            }
        }
    }

    /// @dev Attests the model and a Merkle root of what each account is owed, as of this block; then moves
    ///      one second on, so every later flow is mined strictly after `asOf` (the root's cut).
    function attest() external {
        bool escaped = vault.escapeMode();
        (uint256[] memory owed, uint256 total) = _owed();
        BalanceTree.Tree memory tree = BalanceTree.build(_accounts(), owed);
        vm.prank(signer);
        try vault.attest(total, BalanceTree.root(tree), uint64(block.timestamp), seq + 1) {
            if (escaped) return _fail("attest in escape mode");
            seq += 1;
            for (uint256 i; i < N; ++i) {
                leaf[i] = owed[i];
                depositedSince[i] = 0;
                withdrawnSince[i] = 0;
            }
            hits["attest"]++;
        } catch (bytes memory reason) {
            if (!escaped || _selector(reason) != IMayaHouseVault.EscapeModeActive.selector) {
                return _fail("attest reverted");
            }
            hits["attest:escaped"]++;
        }
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
        vm.roll(block.number + 1);
        hits["warp"]++;
    }

    // ------------------------------------------------------------------ escape

    function triggerEscape(uint256 callerSeed) external {
        bool escaped = vault.escapeMode();
        bool due = block.timestamp >= vault.lastAttestationAt() + vault.escapeDelay();
        uint256 obligations = vault.attestedLiabilities() + vault.depositsSinceAttest();
        uint256 held = vault.assets();
        vm.prank(actors[callerSeed % N]);
        try vault.triggerEscape() {
            if (escaped) return _fail("second trigger");
            if (!due) {
                earlyTriggers++;
                return _fail("escape while attestations were fresh");
            }
            obligationsAtTrigger = obligations;
            assetsAtTrigger = held;
            uint256 sum;
            for (uint256 i; i < N; ++i) {
                uint256 owed = leaf[i] + depositedSince[i];
                entitlementAtTrigger[i] = owed > withdrawnSince[i] ? owed - withdrawnSince[i] : 0;
                sum += entitlementAtTrigger[i];
            }
            poolCoversEveryone = sum <= vault.escapePool();
            hits["trigger"]++;
        } catch (bytes memory reason) {
            bytes4 want =
                escaped ? IMayaHouseVault.EscapeModeActive.selector : IMayaHouseVault.EscapeNotYetAvailable.selector;
            if (_selector(reason) != want || (!escaped && due)) return _fail("trigger reverted");
            hits[escaped ? "trigger:again" : "trigger:early"]++;
        }
    }

    /// @param mode 0 = honest leaf and proof, 1 = inflated leaf, 2 = zero leaf (no proof), 3 = another's proof
    function claim(uint256 actorSeed, uint256 mode) external {
        uint256 i = actorSeed % N;
        mode = mode % 4;
        bool escaped = vault.escapeMode();
        uint256 claimed = mode == 0 ? leaf[i] : mode == 1 ? leaf[i] + 1 : mode == 2 ? 0 : leaf[(i + 1) % N];
        bytes32[] memory proof = mode == 3 ? _proof((i + 1) % N) : _proof(i);
        bytes4 want;
        uint256 expected;
        if (!escaped) {
            want = IMayaHouseVault.EscapeModeInactive.selector;
        } else if (claimed != 0 && mode != 0) {
            // an inflated leaf, or a leaf proven at another account's position, never verifies
            want = IMayaHouseVault.InvalidProof.selector;
        } else {
            uint256 base = mode == 2 || (mode == 3 && claimed == 0) ? 0 : leaf[i];
            uint256 owed = base + depositedSince[i];
            uint256 debits = withdrawnSince[i] + paid[i];
            uint256 entitlement = owed > debits ? owed - debits : 0;
            uint256 remaining = vault.escapePool() - vault.escapeClaimedTotal();
            if (entitlement == 0) want = IMayaHouseVault.NothingToClaim.selector;
            else if (remaining == 0) want = IMayaHouseVault.EscapePoolExhausted.selector;
            else expected = entitlement < remaining ? entitlement : remaining;
        }
        uint256 before = token.balanceOf(actors[i]);
        vm.prank(actors[i]);
        try vault.claimEscape(claimed, proof) returns (uint256 got) {
            if (want != bytes4(0) || got != expected) return _fail("claim paid the wrong amount");
            if (token.balanceOf(actors[i]) - before != got) return _fail("claim transfer mismatch");
            paid[i] += got;
            if (paid[i] > entitlementAtTrigger[i]) overpaid++;
            if (poolCoversEveryone && mode == 0 && paid[i] != entitlementAtTrigger[i]) shortPaid++;
            hits["claim"]++;
        } catch (bytes memory reason) {
            if (want == bytes4(0) || _selector(reason) != want) return _fail("claim reverted");
            hits["claim:refused"]++;
        }
    }

    /// @dev The owner takes back what no claim can reach; claims keep being paid exactly as before.
    function recover() external {
        bool escaped = vault.escapeMode();
        uint256 reserved = vault.escapePool() - vault.escapeClaimedTotal();
        uint256 held = vault.assets();
        uint256 expected = escaped && held > reserved ? held - reserved : 0;
        uint256 before = token.balanceOf(operator);
        vm.prank(operator);
        try vault.recoverEscapeSurplus(operator) returns (uint256 got) {
            if (!escaped || got != expected || got == 0) return _fail("recovered the wrong amount");
            if (token.balanceOf(operator) - before != got) return _fail("recovery transfer mismatch");
            if (vault.assets() != reserved) recoveryBreaches++;
            recovered += got;
            hits["recover"]++;
        } catch (bytes memory reason) {
            bytes4 want =
                !escaped ? IMayaHouseVault.EscapeModeInactive.selector : IMayaHouseVault.NothingToRecover.selector;
            if (_selector(reason) != want || expected != 0) return _fail("recovery reverted");
            hits[escaped ? "recover:nothing" : "recover:inactive"]++;
        }
    }

    // ------------------------------------------------------------------ internals

    function _owed() internal view returns (uint256[] memory owed, uint256 total) {
        owed = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            owed[i] = balance[i] + outstanding[i];
            total += owed[i];
        }
    }

    function _accounts() internal view returns (address[] memory list) {
        list = new address[](N);
        for (uint256 i; i < N; ++i) {
            list[i] = actors[i];
        }
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) {
        uint256[] memory leaves = new uint256[](N);
        for (uint256 k; k < N; ++k) {
            leaves[k] = leaf[k];
        }
        return BalanceTree.proof(BalanceTree.build(_accounts(), leaves), i);
    }

    function _fail(string memory reason) internal {
        unexpected++;
        lastUnexpected = reason;
    }

    function _selector(bytes memory reason) internal pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }
}
