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
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Hard cap on royaltyBps (10%). Protects sellers on external
    ///         marketplaces from a 100%-royalty rug by the admin (audit M-NFT-3).
    uint96 public constant MAX_ROYALTY_BPS = 1000;
    uint96 public constant MAX_MARKETPLACE_FEE_BPS = 1000; // 10% — also tightened (was 50%)

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
    ///         50,000 is generous enough for any reasonable EOA / contract
    ///         wallet receive hook, tight enough to bound griefing.
    uint256 private constant PUSH_GAS_LIMIT = 50000;

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
        bytes32 bucketHash,
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
        address _feeRecipient,
        uint256 _mintFee,
        uint96 _royaltyBps,
        uint96 _marketplaceFeeBps
    ) ERC1155("") {
        require(_registry != address(0), "Invalid registry");
        require(_feeRecipient != address(0), "Invalid fee recipient");
        require(_royaltyBps <= MAX_ROYALTY_BPS, "Royalty too high");
        require(_marketplaceFeeBps <= MAX_MARKETPLACE_FEE_BPS, "Marketplace fee too high");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);

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

        _mint(msg.sender, tokenId, 1, "");

        tokenCreator[tokenId] = msg.sender;
        _tokenURIs[tokenId] = metadataURI;
        tokenToBucketHash[tokenId] = bucketHash;
        bucketHashToTokenId[bucketHash] = tokenId;

        // ERC-2981: royalty on this token goes to PLATFORM (not creator)
        _setTokenRoyalty(tokenId, feeRecipient, royaltyBps);

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
    ///         the seller mid-flow (audit M-NFT-4).
    function listBucket(uint256 tokenId, uint256 price) external whenNotPaused {
        require(balanceOf(msg.sender, tokenId) > 0, "Not token holder");
        require(price > 0, "Price must be > 0");
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

    /// @notice Update metadata URI (only token holder)
    function updateMetadata(uint256 tokenId, string calldata newURI) external {
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
    function getBucketHashesByOwner(address owner) external view returns (bytes32[] memory) {
        uint256[] memory tokens = _ownedTokens[owner];
        bytes32[] memory hashes = new bytes32[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            hashes[i] = tokenToBucketHash[tokens[i]];
        }
        return hashes;
    }

    // ══════════════════════════════════════════════
    //            ERC1155 OVERRIDE
    // ══════════════════════════════════════════════

    /// @dev Override _update to maintain `_ownedTokens` enumeration AND to
    ///      auto-clear stale marketplace listings when the listed seller
    ///      transfers the token outside the built-in marketplace (audit H-NFT-1).
    ///      Without this, listing.active stays true forever, bricking the
    ///      tokenId's marketplace presence.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        super._update(from, to, ids, values);

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];

            if (from != address(0)) {
                _removeTokenFromOwner(from, tokenId);

                // Auto-clear listing if the listed seller is the one losing
                // the token. The `buyBucket` path already clears the listing
                // before _update fires (active == false), so this only triggers
                // when the seller transfers outside the marketplace.
                Listing storage listing = listings[tokenId];
                if (listing.active && listing.seller == from) {
                    listing.active = false;
                    emit BucketDelisted(tokenId, from, block.timestamp);
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
        // Update ERC-2981 default royalty recipient. Note: per-token royalties
        // set at mint time still reference the OLD recipient; rotate at deploy-
        // time only or accept this trade-off (audit M-NFT-2 documented).
        _setDefaultRoyalty(_feeRecipient, royaltyBps);
        emit FeeRecipientUpdated(oldRecipient, _feeRecipient);
    }

    function setMarketplaceFeeBps(uint96 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_bps <= MAX_MARKETPLACE_FEE_BPS, "Fee too high");
        uint96 oldBps = marketplaceFeeBps;
        marketplaceFeeBps = _bps;
        emit MarketplaceFeeUpdated(oldBps, _bps);
    }

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
