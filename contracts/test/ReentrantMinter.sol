// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IContextRegistryLike {
    function registerContextBatch(
        bytes32 bucketHash,
        bytes16[] calldata contextIds,
        bytes32[] calldata contentHashes,
        string[] calldata metadataURIs,
        string[] calldata sourceTypes
    ) external;
}

interface IMemoryNFTLike {
    function mintBucket(bytes32 bucketHash, string calldata metadataURI)
        external
        payable
        returns (uint256);
}

/**
 * @title ReentrantMinter
 * @notice Test-only attacker reproducing audit claim 2: a CONTRACT minter that,
 *         from inside the ERC-1155 `onERC1155Received` callback fired during
 *         `mintBucket`, tries to append an extra context to the bucket that is
 *         mid-mint. This exploits the window before `mintBucket` sets
 *         `bucketHashToTokenId`, which the ContextRegistry post-mint freeze
 *         gates on.
 *
 *         With the checks-effects-interactions fix (all state set BEFORE
 *         `_mint`), the freeze is already active during the callback, so the
 *         re-entrant `registerContextBatch` reverts "Bucket already minted" and
 *         takes the whole mint down with it. Pre-fix, the append would slip
 *         through and the minted bucket would end up with an extra context the
 *         buyer never saw.
 */
contract ReentrantMinter is IERC1155Receiver {
    IContextRegistryLike public immutable registry;
    IMemoryNFTLike public immutable nft;

    bool public attackArmed;
    bytes32 private _bucketHash;
    bytes16 private _extraCtxId;
    bytes32 private _extraHash;

    constructor(address registry_, address nft_) {
        registry = IContextRegistryLike(registry_);
        nft = IMemoryNFTLike(nft_);
    }

    /// Register the bucket's first context so THIS contract is the registrant
    /// (and therefore the only address allowed to mint the bucket).
    function claim(bytes32 bucketHash, bytes16 ctxId, bytes32 contentHash) external {
        registry.registerContextBatch(
            bucketHash,
            _one16(ctxId),
            _one32(contentHash),
            _oneStr("ipfs://ctx"),
            _oneStr("file")
        );
    }

    /// Arm the re-entrant append that fires during the next mint's callback.
    function arm(bytes32 bucketHash, bytes16 extraCtxId, bytes32 extraHash) external {
        attackArmed = true;
        _bucketHash = bucketHash;
        _extraCtxId = extraCtxId;
        _extraHash = extraHash;
    }

    /// Mint the bucket. If armed, `onERC1155Received` tries to sneak in a context.
    function mint(bytes32 bucketHash, string calldata uri) external payable {
        nft.mintBucket{value: msg.value}(bucketHash, uri);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external returns (bytes4) {
        if (attackArmed) {
            // The freeze-bypass attempt. Post-fix this reverts ("Bucket already
            // minted") because bucketHashToTokenId is set before _mint.
            registry.registerContextBatch(
                _bucketHash,
                _one16(_extraCtxId),
                _one32(_extraHash),
                _oneStr("ipfs://sneaky"),
                _oneStr("file")
            );
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IERC1155Receiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    receive() external payable {}

    // ── single-element array helpers ──
    function _one16(bytes16 v) private pure returns (bytes16[] memory a) {
        a = new bytes16[](1);
        a[0] = v;
    }

    function _one32(bytes32 v) private pure returns (bytes32[] memory a) {
        a = new bytes32[](1);
        a[0] = v;
    }

    function _oneStr(string memory v) private pure returns (string[] memory a) {
        a = new string[](1);
        a[0] = v;
    }
}
