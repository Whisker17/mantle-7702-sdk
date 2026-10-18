// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IHook} from "calibur/interfaces/IHook.sol";

/// @notice Parameter rule applied to a permitted call. Each fixed-ABI rule is bound to one selector.
enum RuleKind {
    NONE,
    ERC20_APPROVE,
    LAUNCHPAD_BUY,
    LAUNCHPAD_SELL
}

/// @notice A total cap and a fixed-window period cap for one quote asset, in its native units.
///         `periodCap` applies only when the policy's `periodLength > 0`.
///         For `Policy.mntLimit`, `token` must be `address(0)`.
struct QuoteLimit {
    address token;
    uint256 totalCap;
    uint256 periodCap;
}

struct CallPermission {
    address target;
    bytes4 selector;
    RuleKind ruleKind;
}

/// @notice A session key's policy as supplied by the account. The window anchor is not part of
///         the input: the hook writes it on `setPolicy` and never changes it.
struct Policy {
    uint256 maxValuePerCall;
    QuoteLimit mntLimit;
    QuoteLimit[] quoteLimits;
    uint32 periodLength;
    CallPermission[] permissions;
    address[] trustedSpenders;
    uint32 maxDeadlineWindow;
}

/// @notice The only state read during validation (ERC-7562 associated storage of the account).
struct Summary {
    bool initialized;
    bool active;
    bool revoked;
}

/// @notice Usage counters of one asset for one key. `window` is the index of the window
///         `period` belongs to.
struct Spent {
    uint256 total;
    uint256 period;
    uint256 window;
}

interface IAgentPolicyHook is IHook {
    // Execution-time rejections
    error Reentrancy();
    error NotInExecution();
    error SessionInactive();
    error TargetIsHook();
    error CallNotPermitted(address to, bytes4 selector);
    error ValueExceeded(uint256 value, uint256 maxValuePerCall);
    error LimitExceeded(address token);
    error NotQuoteAsset(address token);
    error UntrustedSpender(address spender);
    error RecipientNotAccount(address recipient);
    error DeadlineOutOfRange(uint256 deadline);
    error QuoteAssetNotTradable(address token);
    error InventoryExceeded(address token, uint256 held);
    error AttributionGap(address token);
    error CallFailed();
    error PartialFill(address token);

    // Validation-time rejections
    error WrongPaymaster();
    error WrongCallData();
    error SessionKeySignatureRejected();

    // Management rejections
    error SessionExists();
    error SessionRevoked();
    error TooManySessions();
    error TooManyQuoteLimits();
    error TooManySpenders();
    error TooManyPermissions();
    error InvalidQuoteAsset(address token);
    error DuplicateQuoteAsset(address token);
    error InvalidMntLimit();
    error MntLimitMissing();
    error RuleSelectorMismatch(address target, bytes4 selector, RuleKind ruleKind);
    error ApproveTargetNotQuote(address target);
    error QuoteAssetPermissionNotApprove(address target, bytes4 selector);
    error LaunchpadQuoteNotLimited(address launchpad, address quoteToken);
    error QuoteAssetHasInventory(address token);
    error PeriodLengthChanged();
    error QuoteAssetRemoved(address token);
    error CapRaised(address token);
    error ZeroPaymaster();
    error HookAddressFlags();

    event PolicySet(address indexed account, bytes32 indexed keyHash, uint40 anchor);
    event PolicyUpdated(address indexed account, bytes32 indexed keyHash);
    event Revoked(address indexed account, bytes32 indexed keyHash);
    event InventoryReleased(
        address indexed account, bytes32 indexed keyHash, address indexed token, uint256 amount
    );

    function setPolicy(bytes32 keyHash, Policy calldata policy) external;
    function updatePolicy(bytes32 keyHash, Policy calldata policy) external;
    function revoke(bytes32 keyHash) external;
    function releaseInventory(bytes32 keyHash, address token, uint256 amount) external;

    function PAYMASTER() external view returns (address);
    function getSummary(bytes32 keyHash, address account) external view returns (Summary memory);
    function getPolicy(bytes32 keyHash, address account)
        external
        view
        returns (Policy memory policy, uint40 anchor);
    function getSpent(bytes32 keyHash, address account, address token)
        external
        view
        returns (Spent memory);
    function remainingLimit(bytes32 keyHash, address account, address token)
        external
        view
        returns (uint256);
    function inventory(bytes32 keyHash, address account, address token)
        external
        view
        returns (uint256);
    function reserved(address account, address token) external view returns (uint256);
    function activeSessions(address account) external view returns (uint256);
}
