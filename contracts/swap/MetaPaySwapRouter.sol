// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapRouter} from "./ISwapRouter.sol";

/**
 * @title MetaPaySwapRouter
 * @notice Lightweight exact-output token swap router for Meta Pay cross-token settlement.
 */
contract MetaPaySwapRouter is ISwapRouter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 500; // 5% cap

    uint16 public swapFeeBps = 30; // 0.30%

    /// @notice Price of 1 whole token in USD scaled by 1e18.
    mapping(address => uint256) public tokenPriceUsdE18;
    mapping(address => uint8) public tokenDecimals;

    event TokenPriceUpdated(address indexed token, uint256 priceUsdE18, uint8 decimals);
    event SwapFeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event Swapped(
        address indexed sender,
        address indexed recipient,
        address indexed tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut
    );
    event LiquidityWithdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidDecimals(uint8 decimals);
    error UnsupportedToken(address token);
    error InvalidFeeBps(uint16 feeBps);
    error SlippageExceeded(uint256 amountIn, uint256 maxAmountIn);
    error InsufficientLiquidity(address token, uint256 available, uint256 required);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setTokenPrice(
        address token,
        uint256 priceUsdE18,
        uint8 decimals_
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (priceUsdE18 == 0) revert ZeroAmount();
        if (decimals_ > 18) revert InvalidDecimals(decimals_);

        tokenPriceUsdE18[token] = priceUsdE18;
        tokenDecimals[token] = decimals_;
        emit TokenPriceUpdated(token, priceUsdE18, decimals_);
    }

    function setSwapFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFeeBps(newFeeBps);
        uint16 oldFeeBps = swapFeeBps;
        swapFeeBps = newFeeBps;
        emit SwapFeeUpdated(oldFeeBps, newFeeBps);
    }

    /// @inheritdoc ISwapRouter
    function getAmountIn(
        address tokenIn,
        address tokenOut,
        uint256 amountOut
    ) public view override returns (uint256) {
        if (amountOut == 0) return 0;
        if (tokenIn == tokenOut) return amountOut;

        uint256 priceIn = tokenPriceUsdE18[tokenIn];
        uint256 priceOut = tokenPriceUsdE18[tokenOut];
        if (priceIn == 0) revert UnsupportedToken(tokenIn);
        if (priceOut == 0) revert UnsupportedToken(tokenOut);

        uint256 usdE18 = Math.mulDiv(
            amountOut,
            priceOut,
            10 ** tokenDecimals[tokenOut],
            Math.Rounding.Ceil
        );
        uint256 baseIn = Math.mulDiv(
            usdE18,
            10 ** tokenDecimals[tokenIn],
            priceIn,
            Math.Rounding.Ceil
        );
        return Math.mulDiv(baseIn, MAX_BPS, MAX_BPS - swapFeeBps, Math.Rounding.Ceil);
    }

    /// @inheritdoc ISwapRouter
    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 maxAmountIn,
        address recipient
    ) external override nonReentrant returns (uint256 amountInUsed) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountOut == 0) revert ZeroAmount();

        amountInUsed = getAmountIn(tokenIn, tokenOut, amountOut);
        if (amountInUsed > maxAmountIn) {
            revert SlippageExceeded(amountInUsed, maxAmountIn);
        }

        uint256 available = IERC20(tokenOut).balanceOf(address(this));
        if (available < amountOut) {
            revert InsufficientLiquidity(tokenOut, available, amountOut);
        }

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountInUsed);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);

        emit Swapped(msg.sender, recipient, tokenIn, amountInUsed, tokenOut, amountOut);
    }

    function withdrawLiquidity(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, amount);
        emit LiquidityWithdrawn(token, to, amount);
    }
}
