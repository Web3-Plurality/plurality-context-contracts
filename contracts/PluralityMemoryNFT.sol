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
 */
contract PluralityMemoryNFT is ERC1155, ERC2981, AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

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

    // Track tokens per owner for enumeration
    mapping(address => uint256[]) private _ownedTokens;

    // ──── Marketplace ────
    struct Listing {
        address seller;
        uint256 price;       // in wei (ROSE)
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

    // Marketplace events
    event BucketListed(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price,
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

    constructor(
        address _registry,
        address _feeRecipient,
        uint256 _mintFee,
        uint96 _royaltyBps,
        uint96 _marketplaceFeeBps
    ) ERC1155("") {
        require(_registry != address(0), "Invalid registry");
        require(_feeRecipient != address(0), "Invalid fee recipient");
        require(_royaltyBps <= 10000, "Royalty too high");
        require(_marketplaceFeeBps <= 5000, "Marketplace fee too high"); // max 50%

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
    ///         the bucket's contexts in ContextRegistry — `registry.bucketRegistrant[
    ///         bucketHash]` must equal `msg.sender`. Mint fee goes to platform.
    /// @param bucketHash  SHA-256 Merkle of the bucket's context hashes (off-chain).
    /// @param metadataURI URI pointing to bucket metadata JSON.
    function mintBucket(
        bytes32 bucketHash,
        string calldata metadataURI
    ) external payable whenNotPaused returns (uint256) {
        require(msg.value >= mintFee, "Insufficient mint fee");
        require(bucketHash != bytes32(0), "Empty bucket hash");
        require(bytes(metadataURI).length > 0, "Empty metadata URI");

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

        // ERC-2981: royalty on this token goes to PLATFORM (not creator)
        _setTokenRoyalty(tokenId, feeRecipient, royaltyBps);

        // Forward mint fee to platform
        if (msg.value > 0) {
            (bool sent, ) = feeRecipient.call{value: msg.value}("");
            require(sent, "Fee transfer failed");
        }

        emit BucketMinted(tokenId, msg.sender, bucketHash, metadataURI, block.timestamp);
        return tokenId;
    }

    // ══════════════════════════════════════════════
    //                 MARKETPLACE
    // ══════════════════════════════════════════════

    /// @notice List a bucket NFT for sale
    /// @param tokenId The token to list
    /// @param price Sale price in wei (ROSE)
    function listBucket(uint256 tokenId, uint256 price) external whenNotPaused {
        require(balanceOf(msg.sender, tokenId) > 0, "Not token holder");
        require(price > 0, "Price must be > 0");
        require(!listings[tokenId].active, "Already listed");

        // Seller must approve this contract to transfer on their behalf
        require(isApprovedForAll(msg.sender, address(this)), "Approve contract first");

        listings[tokenId] = Listing({
            seller: msg.sender,
            price: price,
            active: true
        });

        emit BucketListed(tokenId, msg.sender, price, block.timestamp);
    }

    /// @notice Remove a listing
    function delistBucket(uint256 tokenId) external {
        Listing storage listing = listings[tokenId];
        require(listing.active, "Not listed");
        require(listing.seller == msg.sender, "Not the seller");

        listing.active = false;

        emit BucketDelisted(tokenId, msg.sender, block.timestamp);
    }

    /// @notice Buy a listed bucket NFT. Platform takes marketplace commission.
    function buyBucket(uint256 tokenId) external payable nonReentrant whenNotPaused {
        Listing storage listing = listings[tokenId];
        require(listing.active, "Not listed");
        require(msg.value >= listing.price, "Insufficient payment");
        require(msg.sender != listing.seller, "Cannot buy own listing");

        address seller = listing.seller;
        uint256 price = listing.price;

        // Deactivate listing before transfers (reentrancy protection)
        listing.active = false;

        // Calculate platform fee
        uint256 platformFee = (price * marketplaceFeeBps) / 10000;
        uint256 sellerProceeds = price - platformFee;

        // Transfer NFT from seller to buyer
        _safeTransferFrom(seller, msg.sender, tokenId, 1, "");

        // Pay seller
        (bool sellerPaid, ) = seller.call{value: sellerProceeds}("");
        require(sellerPaid, "Seller payment failed");

        // Pay platform commission
        if (platformFee > 0) {
            (bool feePaid, ) = feeRecipient.call{value: platformFee}("");
            require(feePaid, "Fee payment failed");
        }

        // Refund excess payment
        if (msg.value > price) {
            (bool refunded, ) = msg.sender.call{value: msg.value - price}("");
            require(refunded, "Refund failed");
        }

        emit BucketSold(tokenId, seller, msg.sender, price, platformFee, sellerProceeds, block.timestamp);
    }

    /// @notice Get listing info
    function getListing(uint256 tokenId) external view returns (address seller, uint256 price, bool active) {
        Listing memory l = listings[tokenId];
        return (l.seller, l.price, l.active);
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

    /// @dev Override _update to maintain _ownedTokens index on every transfer/mint/burn.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        super._update(from, to, ids, values);

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];

            // Remove from sender (not applicable on mint where from == address(0))
            if (from != address(0)) {
                _removeTokenFromOwner(from, tokenId);
            }

            // Add to receiver (not applicable on burn where to == address(0))
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
        // Update ERC-2981 royalty recipient too
        _setDefaultRoyalty(_feeRecipient, royaltyBps);
        emit FeeRecipientUpdated(oldRecipient, _feeRecipient);
    }

    function setMarketplaceFeeBps(uint96 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_bps <= 5000, "Fee too high");
        uint96 oldBps = marketplaceFeeBps;
        marketplaceFeeBps = _bps;
        emit MarketplaceFeeUpdated(oldBps, _bps);
    }

    function setRoyaltyBps(uint96 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_bps <= 10000, "Royalty too high");
        royaltyBps = _bps;
        _setDefaultRoyalty(feeRecipient, _bps);
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
