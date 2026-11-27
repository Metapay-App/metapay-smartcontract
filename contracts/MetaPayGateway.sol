// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapRouter} from "./swap/ISwapRouter.sol";

interface IWMEC is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * @title MetaPayGateway
 * @notice Cross-token payment gateway supporting:
 *         - Specified token received & specified recipient address
 *         - Time-fixed (expiresAt > 0) and no-limit (expiresAt == 0) invoices
 *         - Direct stateless settlement (payDirect) for HTTP 402 middleware
 *         - Multi-recipient payment splitting (basis points summing to 10,000)
 */
contract MetaPayGateway is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BPS = 10_000;
    uint8 public constant MAX_SPLITS = 10;

    struct Split {
        address recipient;
        uint16 bps;
    }

    struct Invoice {
        bytes32 id;
        address creator;
        address recipient;
        address targetToken;
        uint256 targetAmount;
        uint64 expiresAt; // 0 = no-limit time, > 0 = time-fixed unix timestamp
        bool paid;
        bool cancelled;
    }

    ISwapRouter public swapRouter;
    IWMEC public immutable wmec;

    mapping(bytes32 => Invoice) public invoices;
    mapping(bytes32 => Split[]) private _invoiceSplits;
    mapping(bytes32 => bool) public settledPayments;

    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event InvoiceCreated(
        bytes32 indexed id,
        address indexed creator,
        address indexed recipient,
        address targetToken,
        uint256 targetAmount,
        uint64 expiresAt
    );
    event InvoiceCancelled(bytes32 indexed id, address indexed creator);
    event PaymentSettled(
        bytes32 indexed refId,
        address indexed payer,
        address indexed recipient,
        address payToken,
        uint256 payAmount,
        address targetToken,
        uint256 targetAmount,
        uint64 paidAt,
        bool isSplit
    );
    event SplitDistributed(
        bytes32 indexed refId,
        address indexed recipient,
        address token,
        uint256 amount
    );

    error ZeroAddress();
    error ZeroAmount();
    error InvalidInvoiceId();
    error InvoiceAlreadyExists(bytes32 id);
    error InvoiceNotFound(bytes32 id);
    error InvoiceAlreadyPaid(bytes32 id);
    error InvoiceAlreadyCancelled(bytes32 id);
    error InvoiceExpired(bytes32 refId, uint64 expiresAt, uint256 currentTime);
    error InvalidExpiry(uint64 expiresAt);
    error Unauthorized(address caller);
    error PaymentAlreadySettled(bytes32 refId);
    error TooManySplits(uint256 count);
    error InvalidSplitBps(uint256 totalBps);
    error SlippageExceeded(uint256 requiredAmount, uint256 maxAmount);
    error InsufficientNativeValue(uint256 sent, uint256 required);
    error UnexpectedNativeValue();
    error NativeTransferFailed();

    constructor(
        address swapRouter_,
        address wmec_,
        address initialOwner
    ) Ownable(initialOwner) {
        if (swapRouter_ == address(0) || wmec_ == address(0)) revert ZeroAddress();
        swapRouter = ISwapRouter(swapRouter_);
        wmec = IWMEC(wmec_);
    }

    /// @notice Accepts unwrapped native MEC from WMEC.withdraw.
    receive() external payable {}

    function setSwapRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddress();
        address oldRouter = address(swapRouter);
        swapRouter = ISwapRouter(newRouter);
        emit SwapRouterUpdated(oldRouter, newRouter);
    }

    function createInvoice(
        bytes32 id,
        address recipient,
        address targetToken,
        uint256 targetAmount,
        uint64 expiresAt,
        Split[] calldata splits
    ) external {
        if (id == bytes32(0)) revert InvalidInvoiceId();
        if (invoices[id].creator != address(0) || settledPayments[id]) {
            revert InvoiceAlreadyExists(id);
        }
        if (recipient == address(0)) revert ZeroAddress();
        if (targetAmount == 0) revert ZeroAmount();
        if (expiresAt != 0 && expiresAt <= block.timestamp) {
            revert InvalidExpiry(expiresAt);
        }

        _validateSplits(splits);

        invoices[id] = Invoice({
            id: id,
            creator: msg.sender,
            recipient: recipient,
            targetToken: targetToken,
            targetAmount: targetAmount,
            expiresAt: expiresAt,
            paid: false,
            cancelled: false
        });

        for (uint256 i = 0; i < splits.length; i++) {
            _invoiceSplits[id].push(splits[i]);
        }

        emit InvoiceCreated(
            id,
            msg.sender,
            recipient,
            targetToken,
            targetAmount,
            expiresAt
        );
    }

    function cancelInvoice(bytes32 id) external {
        Invoice storage inv = invoices[id];
        if (inv.creator == address(0)) revert InvoiceNotFound(id);
        if (msg.sender != inv.creator && msg.sender != owner()) {
            revert Unauthorized(msg.sender);
        }
        if (inv.paid) revert InvoiceAlreadyPaid(id);
        if (inv.cancelled) revert InvoiceAlreadyCancelled(id);

        inv.cancelled = true;
        emit InvoiceCancelled(id, msg.sender);
    }

    function getInvoice(bytes32 id) external view returns (Invoice memory) {
        return invoices[id];
    }

    function getInvoiceSplits(bytes32 id) external view returns (Split[] memory) {
        return _invoiceSplits[id];
    }

    function quotePayment(
        address payToken,
        address targetToken,
        uint256 targetAmount
    ) public view returns (uint256) {
        if (targetAmount == 0) return 0;
        if (payToken == targetToken) return targetAmount;

        address effectiveIn = payToken == address(0) ? address(wmec) : payToken;
        address effectiveOut = targetToken == address(0) ? address(wmec) : targetToken;

        if (effectiveIn == effectiveOut) {
            return targetAmount;
        }

        return swapRouter.getAmountIn(effectiveIn, effectiveOut, targetAmount);
    }

    function payInvoice(
        bytes32 id,
        address payToken,
        uint256 maxPayAmount
    ) external payable nonReentrant {
        Invoice storage inv = invoices[id];
        if (inv.creator == address(0)) revert InvoiceNotFound(id);
        if (inv.paid || settledPayments[id]) revert InvoiceAlreadyPaid(id);
        if (inv.cancelled) revert InvoiceAlreadyCancelled(id);
        if (inv.expiresAt != 0 && block.timestamp > inv.expiresAt) {
            revert InvoiceExpired(id, inv.expiresAt, block.timestamp);
        }

        inv.paid = true;
        settledPayments[id] = true;

        Split[] memory splits = _invoiceSplits[id];
        _executePayment(
            id,
            inv.recipient,
            inv.targetToken,
            inv.targetAmount,
            splits,
            payToken,
            maxPayAmount
        );
    }

    function payDirect(
        bytes32 refId,
        address recipient,
        address targetToken,
        uint256 targetAmount,
        uint64 expiresAt,
        Split[] calldata splits,
        address payToken,
        uint256 maxPayAmount
    ) external payable nonReentrant {
        if (refId == bytes32(0)) revert InvalidInvoiceId();
        if (invoices[refId].creator != address(0) || settledPayments[refId]) {
            revert PaymentAlreadySettled(refId);
        }
        if (recipient == address(0)) revert ZeroAddress();
        if (targetAmount == 0) revert ZeroAmount();
        if (expiresAt != 0 && block.timestamp > expiresAt) {
            revert InvoiceExpired(refId, expiresAt, block.timestamp);
        }

        _validateSplits(splits);
        settledPayments[refId] = true;

        Split[] memory splitsMem = new Split[](splits.length);
        for (uint256 i = 0; i < splits.length; i++) {
            splitsMem[i] = splits[i];
        }

        _executePayment(
            refId,
            recipient,
            targetToken,
            targetAmount,
            splitsMem,
            payToken,
            maxPayAmount
        );
    }

    function _validateSplits(Split[] calldata splits) internal pure {
        if (splits.length == 0) return;
        if (splits.length > MAX_SPLITS) revert TooManySplits(splits.length);

        uint256 totalBps = 0;
        for (uint256 i = 0; i < splits.length; i++) {
            if (splits[i].recipient == address(0)) revert ZeroAddress();
            if (splits[i].bps == 0) revert InvalidSplitBps(0);
            totalBps += splits[i].bps;
        }
        if (totalBps != MAX_BPS) revert InvalidSplitBps(totalBps);
    }

    function _executePayment(
        bytes32 refId,
        address recipient,
        address targetToken,
        uint256 targetAmount,
        Split[] memory splits,
        address payToken,
        uint256 maxPayAmount
    ) internal {
        uint256 requiredPayAmount = quotePayment(payToken, targetToken, targetAmount);
        if (requiredPayAmount > maxPayAmount) {
            revert SlippageExceeded(requiredPayAmount, maxPayAmount);
        }

        if (payToken == address(0)) {
            if (msg.value < requiredPayAmount) {
                revert InsufficientNativeValue(msg.value, requiredPayAmount);
            }
            uint256 refund = msg.value - requiredPayAmount;
            if (refund > 0) {
                _sendNative(msg.sender, refund);
            }
        } else {
            if (msg.value != 0) revert UnexpectedNativeValue();
            IERC20(payToken).safeTransferFrom(msg.sender, address(this), requiredPayAmount);
        }

        if (payToken != targetToken) {
            address effectiveIn = payToken == address(0) ? address(wmec) : payToken;
            address effectiveOut = targetToken == address(0) ? address(wmec) : targetToken;

            if (payToken == address(0)) {
                wmec.deposit{value: requiredPayAmount}();
            }

            if (effectiveIn != effectiveOut) {
                IERC20(effectiveIn).forceApprove(address(swapRouter), requiredPayAmount);
                swapRouter.swapExactOutput(
                    effectiveIn,
                    effectiveOut,
                    targetAmount,
                    requiredPayAmount,
                    address(this)
                );
            }

            if (targetToken == address(0)) {
                wmec.withdraw(targetAmount);
            }
        }

        _distribute(refId, recipient, targetToken, targetAmount, splits);

        emit PaymentSettled(
            refId,
            msg.sender,
            recipient,
            payToken,
            requiredPayAmount,
            targetToken,
            targetAmount,
            uint64(block.timestamp),
            splits.length > 0
        );
    }

    function _distribute(
        bytes32 refId,
        address recipient,
        address targetToken,
        uint256 targetAmount,
        Split[] memory splits
    ) internal {
        if (splits.length == 0) {
            _sendFunds(targetToken, recipient, targetAmount);
            return;
        }

        uint256 distributed = 0;
        for (uint256 i = 0; i < splits.length; i++) {
            uint256 share = (i == splits.length - 1)
                ? (targetAmount - distributed)
                : (targetAmount * splits[i].bps) / MAX_BPS;
            distributed += share;

            if (share > 0) {
                _sendFunds(targetToken, splits[i].recipient, share);
            }
            emit SplitDistributed(refId, splits[i].recipient, targetToken, share);
        }
    }

    function _sendFunds(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            _sendNative(to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
