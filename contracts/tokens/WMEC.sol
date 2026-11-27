// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title WMEC
 * @notice Canonical Wrapped MEC token (1:1 with native MEC) for EVM cross-token swaps.
 */
contract WMEC is ERC20 {
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    error NativeTransferFailed();

    constructor() ERC20("Wrapped MEC", "WMEC") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit Withdrawal(msg.sender, amount);
    }
}
