// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockERC20
 * @notice Mintable ERC-20 test token with a public faucet for Meta Earth Testnet demos.
 */
contract MockERC20 is ERC20, Ownable {
    uint8 private immutable _customDecimals;
    uint256 public faucetAmount;

    event FaucetClaimed(address indexed account, uint256 amount);
    event FaucetAmountUpdated(uint256 oldAmount, uint256 newAmount);

    error ZeroAmount();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 faucetAmount_,
        address initialOwner
    ) ERC20(name_, symbol_) Ownable(initialOwner) {
        if (faucetAmount_ == 0) revert ZeroAmount();
        _customDecimals = decimals_;
        faucetAmount = faucetAmount_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    /// @notice Mints a fixed faucet allowance to the caller.
    function faucet() external {
        _mint(msg.sender, faucetAmount);
        emit FaucetClaimed(msg.sender, faucetAmount);
    }

    /// @notice Owner-only mint used for seeding swap router liquidity.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function setFaucetAmount(uint256 newAmount) external onlyOwner {
        if (newAmount == 0) revert ZeroAmount();
        uint256 oldAmount = faucetAmount;
        faucetAmount = newAmount;
        emit FaucetAmountUpdated(oldAmount, newAmount);
    }
}
