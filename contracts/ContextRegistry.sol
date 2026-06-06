// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// Minimal interface the registry needs from PluralityMemoryNFT to enforce
/// "post-mint freeze" on bucket context appends.
interface IBucketMintLookup {
    function bucketHashToTokenId(bytes32 bucketHash) external view returns (uint256);
}

/**
 * @title ContextRegistry
 * @notice Append-only provenance registry for memory bucket contexts. Each
 *         entry records (contentHash, bucketHash, registeredBy, metadataURI,
 *         registeredAt, sourceType).
 *
 *         Flow: register-first, then mint. The user signs `registerContextBatch`
 *         (tx1) to publish all contexts of a bucket on-chain. The first
 *         registrant of a `bucketHash` claims it — only that wallet can later
 *         mint the NFT (the NFT contract enforces this via `getBucketRegistrant`).
 *
 *         Pure append-only: no revoke, no metadata update. Provenance, once
 *         recorded, is permanent.
 *
 *         Post-mint freeze: once a bucketHash has been minted as an NFT, no
 *         further context appends are accepted for it (audit v3 H-5). This
 *         keeps the on-chain "what the NFT covers" set immutable from the
 *         buyer's perspective and prevents an original registrant from
 *         silently adding contexts under a bucket they've already sold.
 *         The freeze is wired via a one-time `setNftRegistry` call by the
 *         deployer immediately after the NFT contract is deployed; this is
 *         the only function with privileged access, and it can only succeed
 *         once.
 */
contract ContextRegistry {
    /// @notice Identifier surfaced for off-chain ABI / deployment-drift checks.
    string public constant VERSION = "ContextRegistry/v5";

    // ── Hardening caps (per audit M-CR-1/2/4) ──────────────
    uint256 public constant MAX_BATCH_SIZE = 256;
    uint256 public constant MAX_CONTEXTS_PER_BUCKET = 1024;
    uint256 public constant MAX_METADATA_URI_LENGTH = 1024;
    uint256 public constant MAX_SOURCE_TYPE_LENGTH = 32;

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

    // contentHash => contextId — FIRST-WRITER-WINS (per audit H-CR-2).
    // A second registration of the same contentHash leaves this mapping
    // unchanged, preventing provenance spoofing via the reverse lookup.
    mapping(bytes32 => bytes16) public hashToContext;

    // bucketHash => the wallet that first registered contexts under it.
    // The NFT contract reads this to enforce "only the registrant can mint".
    mapping(bytes32 => address) public bucketRegistrant;

    // Deployer + one-time NFT wiring (post-mint freeze plumbing, audit v3 H-5).
    address public immutable deployer;
    IBucketMintLookup public nftRegistry;

    // Stats
    uint256 public totalRegistered;

    /// @notice Emitted on every successful context registration. `contentHash`
    ///         is indexed so off-chain consumers can filter provenance by
    ///         content (audit v3 M-8).
    event ContextRegistered(
        bytes16 indexed contextId,
        bytes32 indexed bucketHash,
        bytes32 indexed contentHash,
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

    event NftRegistryLinked(address indexed nftRegistry);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-time wiring of the NFT contract address. Callable only by
    ///         the deployer, and only when `nftRegistry` has not yet been
    ///         set. After this call, `registerContextBatch` rejects any
    ///         append against a bucketHash that has already been minted as
    ///         an NFT, locking the registered context set from the buyer's
    ///         perspective.
    ///
    ///         The deployer holds no other privileges. There is no setter
    ///         for any registered data, no admin role, no upgrade path.
    function setNftRegistry(address nftAddress) external {
        require(msg.sender == deployer, "Only deployer");
        require(address(nftRegistry) == address(0), "Already set");
        require(nftAddress != address(0), "Invalid address");
        // Sanity-probe (audit v4 CR-H-2): refuse to wire to an EOA or to a
        // contract that doesn't implement the lookup. Without this check a
        // fat-fingered deploy permanently breaks every future
        // `registerContextBatch` (one-shot setter — no recovery path).
        require(nftAddress.code.length > 0, "Not a contract");
        IBucketMintLookup(nftAddress).bucketHashToTokenId(bytes32(0));
        nftRegistry = IBucketMintLookup(nftAddress);
        emit NftRegistryLinked(nftAddress);
    }

    // ══════════════════════════════════════════════
    //                  REGISTER (batch-only)
    // ══════════════════════════════════════════════

    /// @notice Register multiple contexts of a single bucket on-chain in one tx.
    /// @dev Permissionless. First caller to use a given bucketHash claims it;
    ///      subsequent calls for the same bucketHash must come from the same
    ///      address. This lets the NFT contract enforce "only the registrant
    ///      can mint this bucket".
    function registerContextBatch(
        bytes32 bucketHash,
        bytes16[] calldata contextIds,
        bytes32[] calldata contentHashes,
        string[] calldata metadataURIs,
        string[] calldata sourceTypes
    ) external {
        uint256 n = contextIds.length;
        require(n > 0, "Empty batch");
        require(n <= MAX_BATCH_SIZE, "Batch too large");
        require(bucketHash != bytes32(0), "Empty bucket hash");
        require(
            contentHashes.length == n && metadataURIs.length == n && sourceTypes.length == n,
            "Length mismatch"
        );
        require(
            bucketContexts[bucketHash].length + n <= MAX_CONTEXTS_PER_BUCKET,
            "Bucket context cap exceeded"
        );

        // Post-mint freeze (audit v3 H-5). Once `setNftRegistry` is wired and
        // an NFT has been minted for this bucketHash, no further appends are
        // allowed — the registered set the NFT represents is locked from the
        // buyer's perspective. Reverting here is more useful than relying on
        // off-chain enforcement: a confused front-end can't accidentally
        // mutate the bucket post-sale.
        if (address(nftRegistry) != address(0)) {
            require(
                nftRegistry.bucketHashToTokenId(bucketHash) == 0,
                "Bucket already minted"
            );
        }

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
            require(bytes(metadataURIs[i]).length <= MAX_METADATA_URI_LENGTH, "URI too long");
            require(bytes(sourceTypes[i]).length <= MAX_SOURCE_TYPE_LENGTH, "sourceType too long");

            contexts[cid] = ContextEntry({
                contentHash:  chash,
                bucketHash:   bucketHash,
                registeredBy: msg.sender,
                metadataURI:  metadataURIs[i],
                registeredAt: block.timestamp,
                sourceType:   sourceTypes[i]
            });

            bucketContexts[bucketHash].push(cid);

            // First-writer-wins on reverse lookup. Preserves the original
            // provenance record when the same contentHash is registered again
            // (intentionally or maliciously) under any other bucket or context.
            if (hashToContext[chash] == bytes16(0)) {
                hashToContext[chash] = cid;
            }

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

    /// @notice Look up provenance from a content hash. Returns the FIRST
    ///         registration of this contentHash (first-writer-wins).
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
