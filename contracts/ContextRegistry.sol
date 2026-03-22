// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ContextRegistry
 * @notice ERC-8004-inspired decentralized content registry.
 *         Registers individual contexts (documents, chats, text) within
 *         minted memory buckets, storing content hashes for tamper-proof
 *         provenance verification.
 */
contract ContextRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct ContextEntry {
        bytes32 contentHash;       // SHA-256 of the original content
        string metadataURI;        // IPFS URI to context metadata JSON
        address registeredBy;      // Who registered it
        uint256 registeredAt;      // Block timestamp
        uint256 bucketTokenId;     // Reference to PluralityMemoryNFT tokenId
        string sourceType;         // "file" | "chat" | "text"
        bool revoked;              // Soft-delete flag
    }

    // contextId (UUID as bytes16) => ContextEntry
    mapping(bytes16 => ContextEntry) public contexts;

    // bucketTokenId => array of contextIds
    mapping(uint256 => bytes16[]) public bucketContexts;

    // contentHash => contextId (reverse lookup for verification)
    mapping(bytes32 => bytes16) public hashToContext;

    // Reference to the NFT contract
    address public memoryNFT;

    // Stats
    uint256 public totalRegistered;

    event ContextRegistered(
        bytes16 indexed contextId,
        uint256 indexed bucketTokenId,
        bytes32 contentHash,
        string sourceType,
        string metadataURI,
        address registeredBy,
        uint256 timestamp
    );

    event ContextRevoked(
        bytes16 indexed contextId,
        uint256 indexed bucketTokenId,
        address revokedBy,
        uint256 timestamp
    );

    event ContextMetadataUpdated(
        bytes16 indexed contextId,
        string oldURI,
        string newURI,
        uint256 timestamp
    );

    constructor(address _memoryNFT) {
        require(_memoryNFT != address(0), "Invalid NFT address");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REGISTRAR_ROLE, msg.sender);
        memoryNFT = _memoryNFT;
    }

    /// @notice Register a context entry within a minted bucket
    /// @param contextId Off-chain UUID as bytes16
    /// @param bucketTokenId The NFT token ID of the parent bucket
    /// @param contentHash SHA-256 hash of the original context content
    /// @param sourceType "file", "chat", or "text"
    /// @param metadataURI IPFS URI pointing to full context metadata
    function registerContext(
        bytes16 contextId,
        uint256 bucketTokenId,
        bytes32 contentHash,
        string calldata sourceType,
        string calldata metadataURI
    ) external onlyRole(REGISTRAR_ROLE) {
        require(contexts[contextId].registeredAt == 0, "Context already registered");
        require(contentHash != bytes32(0), "Empty content hash");
        require(bucketTokenId > 0, "Invalid bucket token ID");

        contexts[contextId] = ContextEntry({
            contentHash: contentHash,
            metadataURI: metadataURI,
            registeredBy: msg.sender,
            registeredAt: block.timestamp,
            bucketTokenId: bucketTokenId,
            sourceType: sourceType,
            revoked: false
        });

        bucketContexts[bucketTokenId].push(contextId);
        hashToContext[contentHash] = contextId;
        totalRegistered++;

        emit ContextRegistered(
            contextId,
            bucketTokenId,
            contentHash,
            sourceType,
            metadataURI,
            msg.sender,
            block.timestamp
        );
    }

    /// @notice Verify that content matches a registered hash
    /// @param contextId The context UUID as bytes16
    /// @param contentHash The hash to verify against
    /// @return True if content matches and context is not revoked
    function verifyContent(
        bytes16 contextId,
        bytes32 contentHash
    ) external view returns (bool) {
        ContextEntry memory entry = contexts[contextId];
        return entry.registeredAt > 0 && !entry.revoked && entry.contentHash == contentHash;
    }

    /// @notice Look up when a content hash was first registered
    function getProvenanceByHash(
        bytes32 contentHash
    ) external view returns (
        bytes16 contextId,
        uint256 registeredAt,
        address registeredBy,
        uint256 bucketTokenId
    ) {
        bytes16 cid = hashToContext[contentHash];
        ContextEntry memory entry = contexts[cid];
        return (cid, entry.registeredAt, entry.registeredBy, entry.bucketTokenId);
    }

    /// @notice Get full context entry
    function getContext(
        bytes16 contextId
    ) external view returns (ContextEntry memory) {
        return contexts[contextId];
    }

    /// @notice Soft-delete a context (preserves provenance history)
    function revokeContext(
        bytes16 contextId
    ) external onlyRole(REGISTRAR_ROLE) {
        ContextEntry storage entry = contexts[contextId];
        require(entry.registeredAt > 0, "Context not found");
        require(!entry.revoked, "Already revoked");

        entry.revoked = true;

        emit ContextRevoked(contextId, entry.bucketTokenId, msg.sender, block.timestamp);
    }

    /// @notice Update context metadata URI
    function updateContextMetadata(
        bytes16 contextId,
        string calldata newURI
    ) external onlyRole(REGISTRAR_ROLE) {
        ContextEntry storage entry = contexts[contextId];
        require(entry.registeredAt > 0, "Context not found");
        require(!entry.revoked, "Context revoked");

        string memory oldURI = entry.metadataURI;
        entry.metadataURI = newURI;

        emit ContextMetadataUpdated(contextId, oldURI, newURI, block.timestamp);
    }

    /// @notice Get all context IDs for a bucket
    function getBucketContextIds(
        uint256 bucketTokenId
    ) external view returns (bytes16[] memory) {
        return bucketContexts[bucketTokenId];
    }

    /// @notice Get count of contexts in a bucket
    function getBucketContextCount(
        uint256 bucketTokenId
    ) external view returns (uint256) {
        return bucketContexts[bucketTokenId].length;
    }
}
