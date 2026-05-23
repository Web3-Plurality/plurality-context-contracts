// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ContextRegistry
 * @notice ERC-8004-style append-only provenance registry for memory bucket
 *         contexts. Each entry records (contentHash, bucketHash, registeredBy,
 *         metadataURI, registeredAt, sourceType).
 *
 *         Flow: register-first, then mint. The user signs `registerContextBatch`
 *         (tx1) to publish all contexts of a bucket on-chain. The first
 *         registrant of a `bucketHash` claims it — only that wallet can later
 *         mint the NFT (the NFT contract enforces this via `getBucketRegistrant`).
 *
 *         Pure append-only: no revoke, no metadata update. Provenance, once
 *         recorded, is permanent. AccessControl is kept (DEFAULT_ADMIN_ROLE)
 *         as a forward hook in case admin functions need to be added later.
 */
contract ContextRegistry is AccessControl {
    struct ContextEntry {
        bytes32 contentHash;    // SHA-256 of the original content (provenance anchor)
        bytes32 bucketHash;     // Memory bucket this context belongs to
        address registeredBy;   // Wallet that signed the tx (creator at register time)
        string  metadataURI;    // URI to context metadata JSON (off-chain)
        uint256 registeredAt;   // Block timestamp
        string  sourceType;     // "file" | "chat" | "text"
    }

    // contextId (UUID as bytes16) => ContextEntry
    mapping(bytes16 => ContextEntry) public contexts;

    // bucketHash => contextIds[] registered under it
    mapping(bytes32 => bytes16[]) public bucketContexts;

    // contentHash => contextId (reverse lookup for verifyContent + provenance)
    mapping(bytes32 => bytes16) public hashToContext;

    // bucketHash => the wallet that first registered contexts under it.
    // The NFT contract reads this to enforce "only the registrant can mint".
    mapping(bytes32 => address) public bucketRegistrant;

    // Stats
    uint256 public totalRegistered;

    event ContextRegistered(
        bytes16 indexed contextId,
        bytes32 indexed bucketHash,
        bytes32 contentHash,
        string sourceType,
        string metadataURI,
        address registeredBy,
        uint256 timestamp
    );

    event BucketRegistrantClaimed(
        bytes32 indexed bucketHash,
        address indexed registrant,
        uint256 timestamp
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ══════════════════════════════════════════════
    //                  REGISTER (batch-only)
    // ══════════════════════════════════════════════

    /// @notice Register multiple contexts of a single bucket on-chain in one tx.
    /// @dev Permissionless. First caller to use a given bucketHash claims it;
    ///      subsequent calls for the same bucketHash must come from the same
    ///      address. This lets the NFT contract enforce "only the registrant
    ///      can mint this bucket".
    ///
    /// @param bucketHash      SHA-256 Merkle of the contextHashes (computed off-chain)
    /// @param contextIds      Per-context UUID (bytes16) — backend correlation key
    /// @param contentHashes   Per-context SHA-256 of the raw content
    /// @param metadataURIs    Per-context metadata URI
    /// @param sourceTypes     Per-context source type ("file" | "chat" | "text")
    function registerContextBatch(
        bytes32 bucketHash,
        bytes16[] calldata contextIds,
        bytes32[] calldata contentHashes,
        string[] calldata metadataURIs,
        string[] calldata sourceTypes
    ) external {
        uint256 n = contextIds.length;
        require(n > 0, "Empty batch");
        require(bucketHash != bytes32(0), "Empty bucket hash");
        require(
            contentHashes.length == n && metadataURIs.length == n && sourceTypes.length == n,
            "Length mismatch"
        );

        // First registrant of a bucketHash claims it. Same address can extend
        // (rare but supported); a different address would be rejected.
        address existingRegistrant = bucketRegistrant[bucketHash];
        if (existingRegistrant == address(0)) {
            bucketRegistrant[bucketHash] = msg.sender;
            emit BucketRegistrantClaimed(bucketHash, msg.sender, block.timestamp);
        } else {
            require(existingRegistrant == msg.sender, "Bucket claimed by another wallet");
        }

        for (uint256 i = 0; i < n; i++) {
            bytes16 cid = contextIds[i];
            bytes32 chash = contentHashes[i];

            require(contexts[cid].registeredAt == 0, "Context already registered");
            require(chash != bytes32(0), "Empty content hash");

            contexts[cid] = ContextEntry({
                contentHash:  chash,
                bucketHash:   bucketHash,
                registeredBy: msg.sender,
                metadataURI:  metadataURIs[i],
                registeredAt: block.timestamp,
                sourceType:   sourceTypes[i]
            });

            bucketContexts[bucketHash].push(cid);
            hashToContext[chash] = cid;

            emit ContextRegistered(
                cid,
                bucketHash,
                chash,
                sourceTypes[i],
                metadataURIs[i],
                msg.sender,
                block.timestamp
            );
        }

        totalRegistered += n;
    }

    // ══════════════════════════════════════════════
    //                   VIEWS
    // ══════════════════════════════════════════════

    /// @notice Verify a piece of content matches what was registered for `contextId`.
    function verifyContent(bytes16 contextId, bytes32 contentHash) external view returns (bool) {
        ContextEntry memory entry = contexts[contextId];
        return entry.registeredAt > 0 && entry.contentHash == contentHash;
    }

    /// @notice Look up provenance from a content hash.
    function getProvenanceByHash(bytes32 contentHash)
        external
        view
        returns (
            bytes16 contextId,
            uint256 registeredAt,
            address registeredBy,
            bytes32 bucketHash
        )
    {
        bytes16 cid = hashToContext[contentHash];
        ContextEntry memory entry = contexts[cid];
        return (cid, entry.registeredAt, entry.registeredBy, entry.bucketHash);
    }

    /// @notice Full context entry.
    function getContext(bytes16 contextId) external view returns (ContextEntry memory) {
        return contexts[contextId];
    }

    /// @notice All contextIds registered under a given bucketHash.
    function getContextsByBucketHash(bytes32 bucketHash) external view returns (bytes16[] memory) {
        return bucketContexts[bucketHash];
    }

    /// @notice How many contexts a bucketHash has on-chain.
    function getBucketContextCount(bytes32 bucketHash) external view returns (uint256) {
        return bucketContexts[bucketHash].length;
    }

    /// @notice The wallet that first registered contexts under this bucketHash.
    ///         The NFT contract reads this to gate `mintBucket` — only the
    ///         registrant can mint.
    function getBucketRegistrant(bytes32 bucketHash) external view returns (address) {
        return bucketRegistrant[bucketHash];
    }
}
