// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Minimal interface the NFT needs from ContextRegistry to enforce
/// "register-before-mint" on-chain.
interface IContextRegistry {
    function getBucketRegistrant(bytes32 bucketHash) external view returns (address);
    function getBucketContextCount(bytes32 bucketHash) external view returns (uint256);
}

/**
 * @title PluralityMemoryNFT
 * @notice ERC-1155 NFT contract for minting memory buckets (AI profiles).
 *         Each bucket maps to a unique token ID with supply of 1.
 *
 *         Register-first model: before minting, the creator must register
 *         the bucket's contexts in ContextRegistry (one tx). Then they mint
 *         the NFT (second tx). `mintBucket` requires that `msg.sender` is
 *         the registrant of the bucketHash — this makes the chain itself
 *         enforce the link between provenance and ownership.
 *
 *         The NFT *is* the access token: holding the NFT for a given
 *         `bucketHash` is the sole proof of bucket read access. Backends
 *         resolve permission by reading on-chain ownership.
 *
 *         Fee system (ALL fees go to the platform):
 *           - Mint fee: paid in ROSE when minting a new bucket
 *           - ERC-2981 royalty: 5% on every secondary sale (reported to marketplaces)
 *           - Marketplace commission: 2.5% on sales through the built-in marketplace
 *
 *         Hybrid payment model: marketplace proceeds and mint-fee remittances
 *         are FIRST attempted as a direct transfer to the recipient; if that
 *         transfer reverts or runs out of gas, the amount is credited to
 *         `pendingWithdrawals` and claimable via `withdraw()`. This preserves
 *         the simple "buy → seller is paid" UX in the common case where the
 *         recipient is an EOA or a well-behaved contract, while still
 *         eliminating the DoS vector where a reverting seller blocks all
 *         buys (audit H-NFT-2). The NFT transfer is the LAST step so the
 *         buyer's `onERC1155Received` callback runs after all value/state
 *         changes are committed.
 */
contract PluralityMemoryNFT is ERC1155, ERC2981, AccessControl, Pausable, ReentrancyGuard {
    /// @notice Identifier surfaced for off-chain ABI / deployment-drift checks.
    string public constant VERSION = "PluralityMemoryNFT/v5";

    /// @notice Hard cap on royaltyBps (10%). Protects sellers on external
    ///         marketplaces from a 100%-royalty rug by the admin (audit M-NFT-3).
    uint96 public constant MAX_ROYALTY_BPS = 1000;
    uint96 public constant MAX_MARKETPLACE_FEE_BPS = 1000; // 10% — also tightened (was 50%)
    /// @notice Cap on a single `migratePerTokenRoyalty` batch. Keeps the tx
    ///         well within Sapphire's block gas limit and bounds admin gas
    ///         per call (audit v4 NFT-M-3).
    uint256 public constant MAX_ROYALTY_MIGRATION_BATCH = 500;

    // ──── Fee system (all fees go to platform) ────
    uint256 public mintFee;
    address public feeRecipient;          // Platform treasury
    uint96 public royaltyBps;             // ERC-2981 royalty (default 500 = 5%)
    uint96 public marketplaceFeeBps;      // Built-in marketplace commission (default 250 = 2.5%)

    // Token ID counter
    uint256 private _nextTokenId;

    // ContextRegistry — read at mintBucket() to enforce register-first.
    IContextRegistry public immutable registry;

    // tokenId => creator (original minter)
    mapping(uint256 => address) public tokenCreator;

    // tokenId => metadata URI
    mapping(uint256 => string) private _tokenURIs;

    // tokenId => SHA-256 bucket hash (Merkle of contextHashes, ordered createdAt ASC, contextId ASC)
    mapping(uint256 => bytes32) public tokenToBucketHash;

    /// @notice Reverse lookup: bucketHash → tokenId (0 = not minted).
    ///         Prevents duplicate mints for the same bucketHash (audit M-NFT-6).
    mapping(bytes32 => uint256) public bucketHashToTokenId;

    // Track tokens per owner for enumeration
    mapping(address => uint256[]) private _ownedTokens;

    /// @notice Fallback balances. Sellers, the treasury, or over-paying
    ///         buyers are credited here only when the direct push payment
    ///         from `buyBucket` or `mintBucket` fails (recipient reverts or
    ///         runs out of gas). The hot path is direct push; pendingWithdrawals
    ///         is a safety net (audit H-NFT-2).
    mapping(address => uint256) public pendingWithdrawals;

    /// @notice Gas forwarded to recipients during the push-payment leg.
    ///         150,000 is enough for Gnosis Safe 1.3+ / Safe{Core} / ERC-4337
    ///         smart accounts (which often consume 40–80k just for proxied
    ///         receive + guard checks), while still bounding griefing well
    ///         below the typical buy-tx budget (~250k+). Empirically chosen
    ///         after the audit-v2 review flagged 50k as too tight for the
    ///         common smart-wallet cohort.
    uint256 private constant PUSH_GAS_LIMIT = 150000;

    // ──── Marketplace ────
    struct Listing {
        address seller;
        uint256 price;                  // in wei (ROSE)
        uint96 marketplaceFeeBpsAtList; // snapshot of fee at list time (audit M-NFT-4)
        bool active;
    }
    mapping(uint256 => Listing) public listings;

    // ──── Events ────
    event BucketMinted(
        uint256 indexed tokenId,
        address indexed creator,
        bytes32 indexed bucketHash,
        string metadataURI,
        uint256 timestamp
    );

    event MetadataUpdated(
        uint256 indexed tokenId,
        string oldURI,
        string newURI,
        uint256 timestamp
    );

    event MintFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event MarketplaceFeeUpdated(uint96 oldBps, uint96 newBps);
    event RoyaltyBpsUpdated(uint96 oldBps, uint96 newBps);

    // Marketplace events
    event BucketListed(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price,
        uint96 marketplaceFeeBpsAtList,
        uint256 timestamp
    );

    event BucketDelisted(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 timestamp
    );

    /// @notice Emitted when the `_update` hook auto-clears a stale listing
    ///         because the listed seller transferred the NFT outside the
    ///         built-in marketplace. Distinct from `BucketDelisted` (which
    ///         is the explicit user-initiated path).
    event BucketListingAutoCleared(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed transferredTo,
        uint256 timestamp
    );

    /// @notice Emitted by `migratePerTokenRoyalty` after an admin batch
    ///         re-stamps per-token royalty overrides to the current
    ///         `feeRecipient` + `royaltyBps`.
    event PerTokenRoyaltyMigrated(
        uint256 indexed tokenCount,
        address indexed newRecipient,
        uint96 newBps
    );

    event BucketSold(
        uint256 indexed tokenId,
        address indexed seller,
        address indexed buyer,
        uint256 price,
        uint256 platformFee,
        uint256 sellerProceeds,
        uint256 timestamp
    );

    event Withdrawn(address indexed account, uint256 amount);

    constructor(
        address _registry,
        address _admin,
        address _feeRecipient,
        uint256 _mintFee,
        uint96 _royaltyBps,
        uint96 _marketplaceFeeBps
    ) ERC1155("") {
        require(_registry != address(0), "Invalid registry");
        require(_admin != address(0), "Invalid admin");
        require(_feeRecipient != address(0), "Invalid fee recipient");
        require(_royaltyBps <= MAX_ROYALTY_BPS, "Royalty too high");
        require(_marketplaceFeeBps <= MAX_MARKETPLACE_FEE_BPS, "Marketplace fee too high");

        // Sanity-probe the registry address (audit v4 COMP-H-2). A wrong /
        // malicious registry that doesn't expose `getBucketContextCount` would
        // revert this constructor call, blocking deploys that wired the NFT
        // to anything other than a real ContextRegistry.
        require(_registry.code.length > 0, "Registry not a contract");
        IContextRegistry(_registry).getBucketContextCount(bytes32(0));

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);

        registry = IContextRegistry(_registry);
        feeRecipient = _feeRecipient;
        mintFee = _mintFee;
        royaltyBps = _royaltyBps;
        marketplaceFeeBps = _marketplaceFeeBps;

        // ERC-2981: ALL royalties go to the platform, not the creator
        _setDefaultRoyalty(_feeRecipient, _royaltyBps);
    }

    // ══════════════════════════════════════════════
    //                   MINTING
    // ══════════════════════════════════════════════

    /// @notice Mint a memory bucket NFT. The caller must have already registered
    ///         the bucket's contexts in ContextRegistry — `getBucketRegistrant(
    ///         bucketHash)` must equal `msg.sender`. Mint fee is credited to the
    ///         platform treasury via pull-payment; any overpayment is refunded
    ///         to the minter via the same mechanism.
    function mintBucket(
        bytes32 bucketHash,
        string calldata metadataURI
    ) external payable nonReentrant whenNotPaused returns (uint256) {
        require(msg.value >= mintFee, "Insufficient mint fee");
        require(bucketHash != bytes32(0), "Empty bucket hash");
        require(bytes(metadataURI).length > 0, "Empty metadata URI");
        // Audit M-NFT-6: prevent duplicate mints for the same bucketHash.
        require(bucketHashToTokenId[bucketHash] == 0, "Bucket already minted");

        // Enforce register-first: the bucketHash must be claimed by the caller
        // in the registry. This is what makes "the NFT covers exactly the
        // contexts you registered" a trustless on-chain property.
        require(
            registry.getBucketRegistrant(bucketHash) == msg.sender,
            "Register contexts first"
        );

        uint256 tokenId = ++_nextTokenId;

        // Checks-effects-interactions: commit ALL state BEFORE _mint. _mint
        // invokes onERC1155Received on a contract minter, and that callback
        // can re-enter ContextRegistry.registerContextBatch. The registry's
        // post-mint freeze gates on bucketHashToTokenId(bucketHash) != 0, so
        // if we set it AFTER _mint the freeze is not yet active during the
        // callback and the minter could append contexts to a bucket that is
        // mid-mint. Setting it first makes the freeze effective before any
        // external call. (mintBucket's own nonReentrant does NOT help here —
        // the callback targets a different contract.)
        tokenCreator[tokenId] = msg.sender;
        _tokenURIs[tokenId] = metadataURI;
        tokenToBucketHash[tokenId] = bucketHash;
        bucketHashToTokenId[bucketHash] = tokenId;

        // ERC-2981: royalty on this token goes to PLATFORM (not creator)
        _setTokenRoyalty(tokenId, feeRecipient, royaltyBps);

        _mint(msg.sender, tokenId, 1, "");

        // Audit M-NFT-1 + H-NFT-3: forward exact mintFee to treasury, refund
        // any overpayment to minter. Hybrid hot-path push; on push failure
        // the amount lands in pendingWithdrawals (audit H-NFT-2).
        if (mintFee > 0) {
            _payOrCredit(feeRecipient, mintFee);
        }
        uint256 excess = msg.value - mintFee;
        if (excess > 0) {
            _payOrCredit(msg.sender, excess);
        }

        emit BucketMinted(tokenId, msg.sender, bucketHash, metadataURI, block.timestamp);
        return tokenId;
    }

    // ══════════════════════════════════════════════
    //                 MARKETPLACE
    // ══════════════════════════════════════════════

    /// @notice List a bucket NFT for sale. The current `marketplaceFeeBps` is
    ///         snapshot into the listing so an admin fee change cannot rug
    ///         the seller mid-flow (audit M-NFT-4). Note the symmetric
    ///         consequence: an admin *lowering* the fee after a listing was
    ///         created does NOT cut the snapshot — the seller continues to
    ///         pay the old (higher) rate until they delist + relist.
    ///         Frontends should read `getListing(...).feeBps` to display the
    ///         actual rate that will apply at sale.
    function listBucket(uint256 tokenId, uint256 price) external whenNotPaused {
        require(balanceOf(msg.sender, tokenId) > 0, "Not token holder");
        require(price > 0, "Price must be > 0");
        // Cap price at 2^128 - 1 to prevent `price * marketplaceFeeBps` from
        // overflowing under any conceivable bps value (audit v3 M-2). At
        // current ROSE economics, 2^128 wei is ~3.4 × 10^20 ROSE — galactic.
        require(price <= type(uint128).max, "Price too high");
        require(!listings[tokenId].active, "Already listed");

        // Seller must approve this contract to transfer on their behalf
        require(isApprovedForAll(msg.sender, address(this)), "Approve contract first");

        uint96 feeSnapshot = marketplaceFeeBps;
        listings[tokenId] = Listing({
            seller: msg.sender,
            price: price,
            marketplaceFeeBpsAtList: feeSnapshot,
            active: true
        });

        emit BucketListed(tokenId, msg.sender, price, feeSnapshot, block.timestamp);
    }

    /// @notice Remove a listing
    function delistBucket(uint256 tokenId) external {
        Listing storage listing = listings[tokenId];
        require(listing.active, "Not listed");
        require(listing.seller == msg.sender, "Not the seller");

        listing.active = false;

        emit BucketDelisted(tokenId, msg.sender, block.timestamp);
    }

    /// @notice Buy a listed bucket NFT.
    /// @dev Hybrid payment: seller proceeds, platform fee, and any buyer
    ///      refund are pushed via gas-limited `.call`. If the recipient
    ///      reverts or runs out of gas, the amount is credited to
    ///      `pendingWithdrawals` for later `withdraw()`. A reverting
    ///      recipient therefore inconveniences only themselves; the buy
    ///      itself always settles (audit H-NFT-2).
    ///      State effects (listing.active = false) are committed BEFORE the
    ///      NFT transfer, and the NFT transfer is the LAST external call,
    ///      so the buyer's `onERC1155Received` callback sees a fully-settled
    ///      contract state.
    function buyBucket(uint256 tokenId) external payable nonReentrant whenNotPaused {
        Listing memory listing = listings[tokenId];
        require(listing.active, "Not listed");
        require(msg.value >= listing.price, "Insufficient payment");
        require(msg.sender != listing.seller, "Cannot buy own listing");

        address seller = listing.seller;
        uint256 price = listing.price;
        uint96 feeBps = listing.marketplaceFeeBpsAtList;

        // Fail-fast before pushing any value: if the seller revoked the
        // contract's approval (or transferred the token out without auto-
        // clear firing for whatever reason), the trailing `_safeTransferFrom`
        // would revert AFTER `_payOrCredit` already moved funds. Solidity
        // 0.8 rolls back the whole tx in that case so funds are safe, but
        // the buyer wastes gas. Cheap upfront check protects them. Audit v4
        // NFT-M-1.
        require(balanceOf(seller, tokenId) > 0, "Seller no longer holds token");
        require(
            isApprovedForAll(seller, address(this)),
            "Seller revoked marketplace approval"
        );

        // Effects: deactivate listing before any external interaction.
        listings[tokenId].active = false;

        uint256 platformFee = (price * feeBps) / 10000;
        uint256 sellerProceeds = price - platformFee;

        // Hybrid payment: try direct send, fall back to pendingWithdrawals.
        _payOrCredit(seller, sellerProceeds);
        if (platformFee > 0) {
            _payOrCredit(feeRecipient, platformFee);
        }
        if (msg.value > price) {
            _payOrCredit(msg.sender, msg.value - price);
        }

        // Interaction: transfer NFT. The buyer's onERC1155Received runs here
        // with all value flows + state changes already committed, and
        // `nonReentrant` blocks re-entry into mint/list/buy/withdraw.
        _safeTransferFrom(seller, msg.sender, tokenId, 1, "");

        emit BucketSold(tokenId, seller, msg.sender, price, platformFee, sellerProceeds, block.timestamp);
    }

    /// @dev Hybrid hot-path push: send `amount` to `recipient` with a
    ///      gas-limited `.call`. On failure (revert, OOG, missing receive)
    ///      credit the amount to `pendingWithdrawals[recipient]` instead.
    ///      Internal only — never invoked outside the buy/mint paths above.
    function _payOrCredit(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool sent, ) = recipient.call{value: amount, gas: PUSH_GAS_LIMIT}("");
        if (!sent) {
            pendingWithdrawals[recipient] += amount;
        }
    }

    /// @notice Withdraw your accumulated marketplace proceeds, mint-fee
    ///         remittances, or buyer refunds.
    /// @dev Intentionally NOT gated by `whenNotPaused`. If the platform pauses
    ///      the contract in response to an active incident, users must always
    ///      retain the ability to recover funds the contract has already
    ///      credited to them. Pausing freezes the buy/mint/list write paths
    ///      while leaving this exit open is the safer policy.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Get listing info
    function getListing(uint256 tokenId)
        external
        view
        returns (address seller, uint256 price, uint96 feeBps, bool active)
    {
        Listing memory l = listings[tokenId];
        return (l.seller, l.price, l.marketplaceFeeBpsAtList, l.active);
    }

    // ══════════════════════════════════════════════
    //                  METADATA
    // ══════════════════════════════════════════════

    /// @notice Update metadata URI (only token holder). Gated by `whenNotPaused`
    ///         per audit v3 M-1: pause must freeze all writable state.
    function updateMetadata(uint256 tokenId, string calldata newURI)
        external
        whenNotPaused
    {
        require(balanceOf(msg.sender, tokenId) > 0, "Not token holder");
        require(bytes(newURI).length > 0, "Empty URI");

        string memory oldURI = _tokenURIs[tokenId];
        _tokenURIs[tokenId] = newURI;

        emit MetadataUpdated(tokenId, oldURI, newURI, block.timestamp);
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return _tokenURIs[tokenId];
    }

    // ══════════════════════════════════════════════
    //              ENUMERATION VIEWS
    // ══════════════════════════════════════════════

    /// @notice Get all token IDs owned by an address
    function getTokensByOwner(address owner) external view returns (uint256[] memory) {
        return _ownedTokens[owner];
    }

    /// @notice Get bucketHashes for every token an address currently holds.
    ///         Backends use this as the canonical "what can this wallet access?" query.
    /// @dev For large holders or wallets that have received many incoming
    ///      transfers, prefer the paginated variant below — an unbounded
    ///      caller is a potential off-chain DoS vector when the array grows
    ///      past the RPC's `eth_call` gas ceiling.
    function getBucketHashesByOwner(address owner) external view returns (bytes32[] memory) {
        uint256[] memory tokens = _ownedTokens[owner];
        bytes32[] memory hashes = new bytes32[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            hashes[i] = tokenToBucketHash[tokens[i]];
        }
        return hashes;
    }

    /// @notice Paginated variant of `getBucketHashesByOwner` that bounds
    ///         per-call iteration cost. Backends should iterate with
    ///         `start = nextStart` until `nextStart == 0`.
    /// @param  start   Index into `_ownedTokens[owner]` to start at.
    /// @param  limit   Maximum number of bucketHashes to return.
    /// @return hashes      The slice of bucketHashes (length ≤ limit).
    /// @return nextStart   Next index to query, or 0 if iteration is complete.
    function getBucketHashesByOwnerPaginated(
        address owner,
        uint256 start,
        uint256 limit
    ) external view returns (bytes32[] memory hashes, uint256 nextStart) {
        uint256[] memory tokens = _ownedTokens[owner];
        uint256 len = tokens.length;
        if (start >= len || limit == 0) {
            return (new bytes32[](0), 0);
        }
        uint256 end = start + limit;
        if (end > len) end = len;
        uint256 outLen = end - start;
        hashes = new bytes32[](outLen);
        for (uint256 i = 0; i < outLen; i++) {
            hashes[i] = tokenToBucketHash[tokens[start + i]];
        }
        nextStart = end < len ? end : 0;
    }

    /// @notice How many tokens `owner` currently holds. Cheap helper so
    ///         paginating callers can size their loops without fetching
    ///         the full token array.
    function ownedTokenCount(address owner) external view returns (uint256) {
        return _ownedTokens[owner].length;
    }

    // ══════════════════════════════════════════════
    //            ERC1155 OVERRIDE
    // ══════════════════════════════════════════════

    /// @notice Pause-gated override of ERC-1155 single transfer (audit v4
    ///         NFT-H-1). The inherited `_update` hook does NOT honor pause
    ///         by default; gating the public transfer surface here ensures
    ///         the "pause freezes the access-token" invariant the NatSpec
    ///         promises actually holds.
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) public override whenNotPaused {
        super.safeTransferFrom(from, to, id, value, data);
    }

    /// @notice Pause-gated override of ERC-1155 batch transfer (audit v4
    ///         NFT-H-1).
    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) public override whenNotPaused {
        super.safeBatchTransferFrom(from, to, ids, values, data);
    }

    /// @dev Override _update to maintain `_ownedTokens` enumeration AND to
    ///      auto-clear stale marketplace listings when the listed seller
    ///      transfers the token outside the built-in marketplace (audit H-NFT-1).
    ///      Without this, listing.active stays true forever, bricking the
    ///      tokenId's marketplace presence.
    ///
    ///      Important: ERC-1155 `safeBatchTransferFrom` permits the same
    ///      `tokenId` to appear multiple times in `ids[]` with mixed values
    ///      (including zero). Without the `values[i] == 0` short-circuit
    ///      below, an attacker could call
    ///      `safeBatchTransferFrom(self, victim, [tid, tid, tid], [1, 0, 0], "")`
    ///      and the recipient's `_ownedTokens` array would gain three copies
    ///      of `tid` even though their actual balance is 1, permanently
    ///      corrupting `getTokensByOwner`/`getBucketHashesByOwner` for that
    ///      victim. The `BucketListingAutoCleared` event would also fire
    ///      multiple times for one logical transfer. Audit v3 H-1 fix.
    ///
    ///      The `from == to` short-circuit prevents a listed seller from
    ///      silently delisting via a self-transfer that fires an auto-clear
    ///      event indexers may not track (audit v4 NFT-H-2).
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        super._update(from, to, ids, values);

        // Self-transfers are logical no-ops for enumeration + listing state.
        // Returning early avoids transient remove/re-push churn and
        // suppresses spurious `BucketListingAutoCleared` events that would
        // desync indexers tracking only `BucketDelisted`. (Audit v4 NFT-H-2.)
        if (from == to) return;

        for (uint256 i = 0; i < ids.length; i++) {
            // Skip zero-value transfers — they don't move supply, and
            // processing them on a duplicate `tokenId` in a batch would
            // corrupt our enumeration array (see NatSpec above).
            if (values[i] == 0) continue;

            uint256 tokenId = ids[i];

            if (from != address(0)) {
                _removeTokenFromOwner(from, tokenId);

                // Auto-clear listing if the listed seller is the one losing
                // the token. The `buyBucket` path already clears the listing
                // before _update fires (active == false), so this only triggers
                // when the seller transfers outside the marketplace. The
                // dedicated `BucketListingAutoCleared` event lets indexers
                // distinguish auto-clears from explicit user delists.
                Listing storage listing = listings[tokenId];
                if (listing.active && listing.seller == from) {
                    listing.active = false;
                    emit BucketListingAutoCleared(tokenId, from, to, block.timestamp);
                }
            }

            if (to != address(0)) {
                _ownedTokens[to].push(tokenId);
            }
        }
    }

    /// @dev Remove a tokenId from the owner's _ownedTokens array (swap-and-pop).
    function _removeTokenFromOwner(address owner, uint256 tokenId) private {
        uint256[] storage tokens = _ownedTokens[owner];
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == tokenId) {
                tokens[i] = tokens[tokens.length - 1];
                tokens.pop();
                return;
            }
        }
    }

    // ══════════════════════════════════════════════
    //                   ADMIN
    // ══════════════════════════════════════════════

    function setMintFee(uint256 _mintFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 oldFee = mintFee;
        mintFee = _mintFee;
        emit MintFeeUpdated(oldFee, _mintFee);
    }

    function setFeeRecipient(address _feeRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_feeRecipient != address(0), "Invalid address");
        address oldRecipient = feeRecipient;
        feeRecipient = _feeRecipient;
        // Update ERC-2981 default royalty. Per-token overrides set at mint
        // time still reference the OLD recipient; call `migratePerTokenRoyalty`
        // below to re-stamp them in batches.
        _setDefaultRoyalty(_feeRecipient, royaltyBps);
        emit FeeRecipientUpdated(oldRecipient, _feeRecipient);
    }

    /// @notice Re-stamp per-token ERC-2981 royalty overrides to the current
    ///         `feeRecipient` + `royaltyBps`. `_setTokenRoyalty` is called
    ///         per-token in `mintBucket`, so a `setFeeRecipient` alone does
    ///         NOT route royalties for already-minted tokens to the new
    ///         recipient. Call this in batches after rotating the treasury
    ///         (compromise rotation, multisig migration, custody change).
    /// @param  tokenIds  Token IDs whose royalty override should be refreshed.
    function migratePerTokenRoyalty(uint256[] calldata tokenIds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(
            tokenIds.length <= MAX_ROYALTY_MIGRATION_BATCH,
            "Batch too large"
        );
        address recipient = feeRecipient;
        uint96 bps = royaltyBps;
        uint256 nextId = _nextTokenId;
        uint256 count = 0;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tid = tokenIds[i];
            // Skip impossible IDs (0 is the unused sentinel; > _nextTokenId
            // is unminted). The `tokenCreator != 0` check then ensures we
            // never touch a burned/cleared row (audit v3 M-3).
            if (tid == 0 || tid > nextId) continue;
            if (tokenCreator[tid] != address(0)) {
                _setTokenRoyalty(tid, recipient, bps);
                count++;
            }
        }
        emit PerTokenRoyaltyMigrated(count, recipient, bps);
    }

    function setMarketplaceFeeBps(uint96 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_bps <= MAX_MARKETPLACE_FEE_BPS, "Fee too high");
        uint96 oldBps = marketplaceFeeBps;
        marketplaceFeeBps = _bps;
        emit MarketplaceFeeUpdated(oldBps, _bps);
    }

    /// @notice Update the default royalty bps. Same trade-off as
    ///         `setFeeRecipient`: per-token overrides set at mint time still
    ///         reference the OLD value. Call `migratePerTokenRoyalty` in
    ///         batches afterward to re-stamp them (audit v3 M-4).
    function setRoyaltyBps(uint96 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_bps <= MAX_ROYALTY_BPS, "Royalty too high");
        uint96 oldBps = royaltyBps;
        royaltyBps = _bps;
        _setDefaultRoyalty(feeRecipient, _bps);
        emit RoyaltyBpsUpdated(oldBps, _bps);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ──── Required overrides ────

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC1155, ERC2981, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
