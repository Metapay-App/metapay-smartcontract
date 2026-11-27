// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ISwapRouter
 * @notice Minimal exact-output swap interface so MetaPayGateway can target
 *         MetaPaySwapRouter on testnet or an external DEX adapter on mainnet.
 */
interface ISwapRouter {
    function getAmountIn(
        address tokenIn,
        address tokenOut,
        uint256 amountOut
    ) external view returns (uint256 amountIn);

    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 maxAmountIn,
        address recipient
    ) external returns (uint256 amountInUsed);
}
