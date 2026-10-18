// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IExecutionHook} from "calibur/interfaces/IExecutionHook.sol";
// Calibur compiles against its own account-abstraction copy; use the same struct type.
import {IValidationHook, PackedUserOperation} from "calibur/interfaces/IValidationHook.sol";
import {HooksLib} from "calibur/libraries/HooksLib.sol";
import {
    CallPermission,
    IAgentPolicyHook,
    Policy,
    QuoteLimit,
    RuleKind,
    Spent,
    Summary
} from "./interfaces/IAgentPolicyHook.sol";
import {ILaunchpad} from "./interfaces/ILaunchpad.sol";

/// @title AgentPolicyHook
/// @notice Calibur v1.1.0 hook enforcing per-session-key policy for every account that uses it.
///         All state is keyed by `msg.sender` (the account): an account can only configure and
///         spend its own sessions. Session keys reach the management functions only through the
///         account, and the account refuses `to == hook` for them.
/// @dev Validation callbacks read only `summaries[keyHash][msg.sender]` (ERC-7562 associated
///      storage) plus calldata and the immutable paymaster. Execution data is unconstrained.
///      Not upgradeable; a revoked keyHash is tombstoned forever.
contract AgentPolicyHook is IAgentPolicyHook {
    uint256 public constant MAX_SESSIONS = 8;
    uint256 public constant MAX_QUOTE_LIMITS = 4;
    uint256 public constant MAX_TRUSTED_SPENDERS = 4;
    uint256 public constant MAX_PERMISSIONS = 16;

    bytes4 public constant APPROVE_SELECTOR = IERC20.approve.selector;
    bytes4 public constant INCREASE_ALLOWANCE_SELECTOR =
        bytes4(keccak256("increaseAllowance(address,uint256)"));
    bytes4 public constant BUY_SELECTOR = ILaunchpad.buy.selector;
    bytes4 public constant SELL_SELECTOR = ILaunchpad.sell.selector;

    /// @notice The only paymaster a session UserOp may use. Immutable (bytecode, not storage) so
    ///         validation reads no unassociated storage.
    address public immutable PAYMASTER;

    /// @dev Base of the per-account transient re-entrancy lock slot.
    bytes32 private constant LOCK_BASE = keccak256("AgentPolicyHook.lock");

    /// @dev `beforeExecuteData`: the rule applied, the BUY/SELL token and amount, the token
    ///      balance and the quote-asset balances (in `quoteLimits` order) before the call.
    struct Context {
        RuleKind kind;
        address token;
        uint256 amount;
        uint256 tokenBefore;
        uint256[] balances;
    }

    struct PolicyState {
        Policy policy;
        uint40 anchor;
    }

    mapping(bytes32 keyHash => mapping(address account => Summary)) internal summaries;
    mapping(bytes32 keyHash => mapping(address account => PolicyState)) internal policies;
    /// @dev Usage counters keyed by token; MNT uses `token = address(0)`.
    mapping(bytes32 keyHash => mapping(address account => mapping(address token => Spent))) internal
        spent;
    /// @notice Meme quantity attributed to a session key.
    mapping(bytes32 keyHash => mapping(address account => mapping(address token => uint256))) public
        inventory;
    /// @notice Sum of `inventory` over all keys of an account.
    mapping(address account => mapping(address token => uint256)) public reserved;
    mapping(address account => uint256) public activeSessions;

    constructor(address paymaster) {
        if (paymaster == address(0)) revert ZeroPaymaster();
        if (uint160(address(this)) & HooksLib.ALL_FLAGS != HooksLib.ALL_FLAGS) {
            revert HookAddressFlags();
        }
        PAYMASTER = paymaster;
    }

    // ---------------------------------------------------------------------------------------
    // Execution hooks (msg.sender = account)
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc IExecutionHook
    function beforeExecute(bytes32 keyHash, address to, uint256 value, bytes calldata data)
        external
        returns (bytes4, bytes memory)
    {
        address account = msg.sender;
        bytes32 lock = _lockSlot(account);
        if (_tload(lock) != 0) revert Reentrancy();
        _tstore(lock, 1);

        if (!summaries[keyHash][account].active) revert SessionInactive();
        if (to == address(this)) revert TargetIsHook();

        PolicyState storage ps = policies[keyHash][account];
        Policy storage p = ps.policy;
        Context memory ctx;
        // A selector is the first 4 bytes; shorter calldata pads with zeros (selector 0x00000000).
        // forge-lint: disable-next-line(unsafe-typecast)
        ctx.kind = _permittedRule(p.permissions, to, bytes4(data));

        if (value > p.maxValuePerCall) revert ValueExceeded(value, p.maxValuePerCall);
        if (value != 0) {
            _charge(ps, spent[keyHash][account][address(0)], p.mntLimit, address(0), value);
        }

        if (ctx.kind == RuleKind.ERC20_APPROVE) {
            _checkApprove(keyHash, account, to, data);
        } else if (ctx.kind != RuleKind.NONE) {
            _checkTrade(keyHash, account, data, ctx);
        }

        QuoteLimit[] storage limits = p.quoteLimits;
        ctx.balances = new uint256[](limits.length);
        for (uint256 i; i < limits.length; ++i) {
            ctx.balances[i] = IERC20(limits[i].token).balanceOf(account);
        }
        return (IExecutionHook.beforeExecute.selector, abi.encode(ctx));
    }

    /// @inheritdoc IExecutionHook
    function afterExecute(bytes32 keyHash, bool success, bytes calldata, bytes calldata context)
        external
        returns (bytes4)
    {
        address account = msg.sender;
        bytes32 lock = _lockSlot(account);
        if (_tload(lock) == 0) revert NotInExecution();
        if (!success) revert CallFailed();

        Context memory ctx = abi.decode(context, (Context));
        _meterQuoteOutflow(keyHash, account, ctx.balances);

        if (ctx.kind == RuleKind.LAUNCHPAD_BUY) {
            uint256 tokenAfter = IERC20(ctx.token).balanceOf(account);
            if (tokenAfter > ctx.tokenBefore) {
                uint256 delta = tokenAfter - ctx.tokenBefore;
                inventory[keyHash][account][ctx.token] += delta;
                reserved[account][ctx.token] += delta;
            }
        } else if (ctx.kind == RuleKind.LAUNCHPAD_SELL) {
            uint256 tokenAfter = IERC20(ctx.token).balanceOf(account);
            if (tokenAfter > ctx.tokenBefore || ctx.tokenBefore - tokenAfter != ctx.amount) {
                revert PartialFill(ctx.token);
            }
            inventory[keyHash][account][ctx.token] -= ctx.amount;
            reserved[account][ctx.token] -= ctx.amount;
        }

        _tstore(lock, 0);
        return IExecutionHook.afterExecute.selector;
    }

    // ---------------------------------------------------------------------------------------
    // Validation hooks (view; read only the Summary and calldata)
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc IValidationHook
    function afterValidateUserOp(
        bytes32 keyHash,
        PackedUserOperation calldata userOp,
        bytes32,
        uint256,
        bytes calldata
    ) external view returns (bytes4) {
        _requireLive(keyHash);
        bytes calldata pmd = userOp.paymasterAndData;
        if (pmd.length < 20 || address(bytes20(pmd[:20])) != PAYMASTER) revert WrongPaymaster();
        bytes calldata callData = userOp.callData;
        if (callData.length < 4 || bytes4(callData[:4]) != IAccountExecute.executeUserOp.selector) {
            revert WrongCallData();
        }
        return IValidationHook.afterValidateUserOp.selector;
    }

    /// @inheritdoc IValidationHook
    function afterVerifySignature(bytes32 keyHash, bytes32, bytes calldata)
        external
        view
        returns (bytes4)
    {
        _requireLive(keyHash);
        return IValidationHook.afterVerifySignature.selector;
    }

    /// @inheritdoc IValidationHook
    /// @dev Session keys never produce ERC-1271 signatures (no Permit / Permit2 / off-chain orders).
    function afterIsValidSignature(bytes32, bytes32, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert SessionKeySignatureRejected();
    }

    // ---------------------------------------------------------------------------------------
    // Management (msg.sender = account; the root reaches these, session keys cannot)
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc IAgentPolicyHook
    function setPolicy(bytes32 keyHash, Policy calldata policy) external {
        address account = _requireNotExecuting();
        Summary storage summary = summaries[keyHash][account];
        if (summary.revoked) revert SessionRevoked();
        if (summary.initialized) revert SessionExists();
        if (activeSessions[account] >= MAX_SESSIONS) revert TooManySessions();
        _validate(keyHash, account, policy);

        PolicyState storage ps = policies[keyHash][account];
        ps.policy = policy;
        uint40 anchor = uint40(block.timestamp);
        ps.anchor = anchor;
        summary.initialized = true;
        summary.active = true;
        ++activeSessions[account];
        emit PolicySet(account, keyHash, anchor);
    }

    /// @inheritdoc IAgentPolicyHook
    /// @dev Keeps `anchor`, `periodLength` and every counter; every existing quote asset stays and
    ///      its caps (and the MNT caps) may only be lowered.
    function updatePolicy(bytes32 keyHash, Policy calldata policy) external {
        address account = _requireNotExecuting();
        if (!summaries[keyHash][account].active) revert SessionInactive();
        _validate(keyHash, account, policy);

        Policy storage old = policies[keyHash][account].policy;
        if (policy.periodLength != old.periodLength) revert PeriodLengthChanged();
        _requireNotRaised(old.mntLimit, policy.mntLimit);
        for (uint256 i; i < old.quoteLimits.length; ++i) {
            QuoteLimit storage oldLimit = old.quoteLimits[i];
            (bool kept, uint256 j) = _quoteIndexCd(policy.quoteLimits, oldLimit.token);
            if (!kept) revert QuoteAssetRemoved(oldLimit.token);
            _requireNotRaised(oldLimit, policy.quoteLimits[j]);
        }

        policies[keyHash][account].policy = policy;
        emit PolicyUpdated(account, keyHash);
    }

    /// @inheritdoc IAgentPolicyHook
    /// @dev O(1) tombstone; never reverts outside execution, so a panic batch cannot be blocked by a
    ///      key whose grant never completed. Inventory stays frozen until `releaseInventory`.
    function revoke(bytes32 keyHash) external {
        address account = _requireNotExecuting();
        Summary storage summary = summaries[keyHash][account];
        if (summary.active) {
            summary.active = false;
            --activeSessions[account];
        }
        summary.revoked = true;
        emit Revoked(account, keyHash);
    }

    /// @inheritdoc IAgentPolicyHook
    function releaseInventory(bytes32 keyHash, address token, uint256 amount) external {
        address account = _requireNotExecuting();
        uint256 held = inventory[keyHash][account][token];
        if (amount > held) revert InventoryExceeded(token, held);
        inventory[keyHash][account][token] = held - amount;
        reserved[account][token] -= amount;
        emit InventoryReleased(account, keyHash, token, amount);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function getSummary(bytes32 keyHash, address account) external view returns (Summary memory) {
        return summaries[keyHash][account];
    }

    function getPolicy(bytes32 keyHash, address account)
        external
        view
        returns (Policy memory, uint40)
    {
        PolicyState storage ps = policies[keyHash][account];
        return (ps.policy, ps.anchor);
    }

    function getSpent(bytes32 keyHash, address account, address token)
        external
        view
        returns (Spent memory)
    {
        return spent[keyHash][account][token];
    }

    /// @notice Remaining spendable amount (min of total and current-window remainder);
    ///         `token = address(0)` for MNT; 0 for an asset without a limit.
    function remainingLimit(bytes32 keyHash, address account, address token)
        external
        view
        returns (uint256)
    {
        PolicyState storage ps = policies[keyHash][account];
        if (token == address(0)) {
            return _remaining(ps, spent[keyHash][account][token], ps.policy.mntLimit);
        }
        (bool isQuote, uint256 index) = _quoteIndex(ps.policy.quoteLimits, token);
        if (!isQuote) return 0;
        return _remaining(ps, spent[keyHash][account][token], ps.policy.quoteLimits[index]);
    }

    // ---------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------

    function _requireLive(bytes32 keyHash) private view {
        Summary memory summary = summaries[keyHash][msg.sender];
        if (!summary.active || summary.revoked) revert SessionInactive();
    }

    /// @dev Management must not interleave with an execution (it would change the policy or the
    ///      ledger between the snapshots of `beforeExecute` and `afterExecute`).
    function _requireNotExecuting() private view returns (address account) {
        account = msg.sender;
        if (_tload(_lockSlot(account)) != 0) revert Reentrancy();
    }

    /// @dev Policy validity checks (fail closed), shared by `setPolicy` and `updatePolicy`.
    function _validate(bytes32 keyHash, address account, Policy calldata p) private view {
        if (p.quoteLimits.length > MAX_QUOTE_LIMITS) revert TooManyQuoteLimits();
        if (p.trustedSpenders.length > MAX_TRUSTED_SPENDERS) revert TooManySpenders();
        if (p.permissions.length > MAX_PERMISSIONS) revert TooManyPermissions();
        if (p.mntLimit.token != address(0)) revert InvalidMntLimit();
        if (p.maxValuePerCall != 0 && p.mntLimit.totalCap == 0) revert MntLimitMissing();

        for (uint256 i; i < p.quoteLimits.length; ++i) {
            address token = p.quoteLimits[i].token;
            if (token == address(0)) revert InvalidQuoteAsset(token);
            for (uint256 j; j < i; ++j) {
                if (p.quoteLimits[j].token == token) revert DuplicateQuoteAsset(token);
            }
            // A quote asset can never be a SELL token; refuse to strand attributed inventory.
            if (inventory[keyHash][account][token] != 0) revert QuoteAssetHasInventory(token);
        }

        for (uint256 i; i < p.permissions.length; ++i) {
            CallPermission calldata perm = p.permissions[i];
            bytes4 sel = perm.selector;
            RuleKind expected = sel == APPROVE_SELECTOR
                ? RuleKind.ERC20_APPROVE
                : sel == BUY_SELECTOR
                    ? RuleKind.LAUNCHPAD_BUY
                    : sel == SELL_SELECTOR ? RuleKind.LAUNCHPAD_SELL : RuleKind.NONE;
            if (sel == INCREASE_ALLOWANCE_SELECTOR || perm.ruleKind != expected) {
                revert RuleSelectorMismatch(perm.target, sel, perm.ruleKind);
            }
            if (expected == RuleKind.ERC20_APPROVE) {
                (bool isQuote,) = _quoteIndexCd(p.quoteLimits, perm.target);
                if (!isQuote) revert ApproveTargetNotQuote(perm.target);
            } else if (expected == RuleKind.LAUNCHPAD_BUY) {
                address quote = ILaunchpad(perm.target).quoteToken();
                (bool isQuote,) = _quoteIndexCd(p.quoteLimits, quote);
                if (!isQuote) revert LaunchpadQuoteNotLimited(perm.target, quote);
            }
        }
    }

    function _requireNotRaised(QuoteLimit storage oldLimit, QuoteLimit calldata newLimit)
        private
        view
    {
        if (newLimit.totalCap > oldLimit.totalCap || newLimit.periodCap > oldLimit.periodCap) {
            revert CapRaised(oldLimit.token);
        }
    }

    function _permittedRule(CallPermission[] storage permissions, address to, bytes4 selector)
        private
        view
        returns (RuleKind)
    {
        for (uint256 i; i < permissions.length; ++i) {
            CallPermission storage perm = permissions[i];
            if (perm.target == to && perm.selector == selector) return perm.ruleKind;
        }
        revert CallNotPermitted(to, selector);
    }

    /// @dev ERC20_APPROVE(spender, amount): `to` is a quote asset, `spender` is trusted and
    ///      `amount` is within the asset's remaining limit.
    function _checkApprove(bytes32 keyHash, address account, address to, bytes calldata data)
        private
        view
    {
        (address spender, uint256 amount) = abi.decode(data[4:], (address, uint256));
        PolicyState storage ps = policies[keyHash][account];
        (bool isQuote, uint256 index) = _quoteIndex(ps.policy.quoteLimits, to);
        if (!isQuote) revert NotQuoteAsset(to);
        if (!_contains(ps.policy.trustedSpenders, spender)) revert UntrustedSpender(spender);
        if (amount > _remaining(ps, spent[keyHash][account][to], ps.policy.quoteLimits[index])) {
            revert LimitExceeded(to);
        }
    }

    /// @dev LAUNCHPAD_BUY / LAUNCHPAD_SELL(token, amount, minOut, deadline, recipient):
    ///      `recipient == account`, `now <= deadline <= now + maxDeadlineWindow`, `token` is not a
    ///      quote asset; SELL also needs `amount <= inventory` and `balanceOf >= reserved`.
    function _checkTrade(bytes32 keyHash, address account, bytes calldata data, Context memory ctx)
        private
        view
    {
        (address token, uint256 amount,, uint256 deadline, address recipient) =
            abi.decode(data[4:], (address, uint256, uint256, uint256, address));
        Policy storage p = policies[keyHash][account].policy;
        if (recipient != account) revert RecipientNotAccount(recipient);
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline < block.timestamp || deadline > block.timestamp + p.maxDeadlineWindow) {
            revert DeadlineOutOfRange(deadline);
        }
        (bool isQuote,) = _quoteIndex(p.quoteLimits, token);
        if (isQuote) revert QuoteAssetNotTradable(token);
        uint256 balance = IERC20(token).balanceOf(account);
        if (ctx.kind == RuleKind.LAUNCHPAD_SELL) {
            uint256 held = inventory[keyHash][account][token];
            if (amount > held) revert InventoryExceeded(token, held);
            if (balance < reserved[account][token]) revert AttributionGap(token);
        }
        ctx.token = token;
        ctx.amount = amount;
        ctx.tokenBefore = balance;
    }

    /// @dev Charges each quote asset's balance decrease; inflows never restore usage. The policy
    ///      cannot change between the two hooks (management refuses while the lock is held), so
    ///      `quoteLimits` is the list that was snapshotted.
    function _meterQuoteOutflow(bytes32 keyHash, address account, uint256[] memory before) private {
        PolicyState storage ps = policies[keyHash][account];
        QuoteLimit[] storage limits = ps.policy.quoteLimits;
        for (uint256 i; i < limits.length; ++i) {
            QuoteLimit storage limit = limits[i];
            uint256 balanceAfter = IERC20(limit.token).balanceOf(account);
            if (balanceAfter < before[i]) {
                _charge(
                    ps,
                    spent[keyHash][account][limit.token],
                    limit,
                    limit.token,
                    before[i] - balanceAfter
                );
            }
        }
    }

    function _currentWindow(PolicyState storage ps) private view returns (uint256) {
        uint32 periodLength = ps.policy.periodLength;
        return periodLength == 0 ? 0 : (block.timestamp - ps.anchor) / periodLength;
    }

    /// @dev Adds `amount` to the total and the current-window counters; reverts over either cap.
    function _charge(
        PolicyState storage ps,
        Spent storage s,
        QuoteLimit storage limit,
        address token,
        uint256 amount
    ) private {
        uint256 total = s.total + amount;
        if (total > limit.totalCap) revert LimitExceeded(token);
        s.total = total;
        if (ps.policy.periodLength != 0) {
            uint256 window = _currentWindow(ps);
            uint256 period = (s.window == window ? s.period : 0) + amount;
            if (period > limit.periodCap) revert LimitExceeded(token);
            s.period = period;
            s.window = window;
        }
    }

    function _remaining(PolicyState storage ps, Spent storage s, QuoteLimit storage limit)
        private
        view
        returns (uint256 left)
    {
        left = limit.totalCap > s.total ? limit.totalCap - s.total : 0;
        if (ps.policy.periodLength != 0) {
            uint256 period = s.window == _currentWindow(ps) ? s.period : 0;
            uint256 periodLeft = limit.periodCap > period ? limit.periodCap - period : 0;
            if (periodLeft < left) left = periodLeft;
        }
    }

    function _quoteIndex(QuoteLimit[] storage limits, address token)
        private
        view
        returns (bool, uint256)
    {
        for (uint256 i; i < limits.length; ++i) {
            if (limits[i].token == token) return (true, i);
        }
        return (false, 0);
    }

    function _quoteIndexCd(QuoteLimit[] calldata limits, address token)
        private
        pure
        returns (bool, uint256)
    {
        for (uint256 i; i < limits.length; ++i) {
            if (limits[i].token == token) return (true, i);
        }
        return (false, 0);
    }

    function _contains(address[] storage list, address item) private view returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == item) return true;
        }
        return false;
    }

    function _lockSlot(address account) private pure returns (bytes32) {
        return keccak256(abi.encode(LOCK_BASE, account));
    }

    function _tload(bytes32 slot) private view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _tstore(bytes32 slot, uint256 v) private {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }
}
