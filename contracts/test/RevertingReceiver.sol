// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/// @notice Test helper. Holds ERC-1155 tokens fine, but reverts on any direct
///         ROSE transfer. Used in PluralityMemoryNFT tests to exercise the
///         hybrid push-fallback-to-pull path: when this contract is the
///         seller, the direct push must fail and `pendingWithdrawals` must
///         absorb the seller proceeds (audit H-NFT-2 verification).
contract RevertingReceiver is ERC1155Holder {
    receive() external payable {
        revert("RevertingReceiver: no ROSE accepted");
    }

    /// @notice Pass-through to call any function on a target contract from
    ///         this contract's address (used to make this contract the
    ///         msg.sender for registry / NFT calls).
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "execute failed");
        return ret;
    }
}
