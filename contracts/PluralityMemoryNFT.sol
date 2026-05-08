// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PluralityMemoryNFT
 * @notice ERC-1155 NFT contract for minting memory buckets (AI profiles).
 *         Each bucket maps to a unique token ID with supply of 1.
 *
 *         Fee system (ALL fees go to the platform):
 *           - Mint fee: paid in ROSE when minting a new bucket
 *           - ERC-2981 royalty: 5% on every secondary sale (reported to marketplaces)
 *           - Marketplace commission: 2.5% on sales through the built-in marketplace
 *
 *         Includes a built-in marketplace for listing/buying bucket NFTs,
 *         on-chain access control mirroring off-chain roles.
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

    // tokenId => creator (original minter)
    mapping(uint256 => address) public tokenCreator;

    // tokenId => metadata URI
    mapping(uint256 => string) private _tokenURIs;

    // tokenId => off-chain profileId (UUID as bytes16)
    mapping(uint256 => bytes16) public tokenToProfileId;

    // profileId hash => tokenIds (supports multiple mints per profile)
    mapping(bytes32 => uint256[]) public profileTokens;

    // On-chain access control: tokenId => address => role (0=none, 1=viewer, 2=editor)
    mapping(uint256 => mapping(address => uint8)) public bucketAccess;

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
        bytes16 profileId,
        string metadataURI,
        uint256 timestamp
    );

    event MetadataUpdated(
        uint256 indexed tokenId,
        string oldURI,
        string newURI,
        uint256 timestamp
    );

    event AccessGranted(
        uint256 indexed tokenId,
        address indexed grantedTo,
        uint8 role,
        uint256 timestamp
    );

    event AccessRevoked(
        uint256 indexed tokenId,
        address indexed revokedFrom,
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
        address _feeRecipient,
        uint256 _mintFee,
        uint96 _royaltyBps,
        uint96 _marketplaceFeeBps
    ) ERC1155("") {
        require(_feeRecipient != address(0), "Invalid fee recipient");
        require(_royaltyBps <= 10000, "Royalty too high");
        require(_marketplaceFeeBps <= 5000, "Marketplace fee too high"); // max 50%

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);

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

    /// @notice Mint a new memory bucket NFT. Mint fee goes to platform.
    function mintBucket(
        bytes16 profileId,
        string calldata metadataURI
    ) external payable whenNotPaused returns (uint256) {
        require(msg.value >= mintFee, "Insufficient mint fee");
        require(bytes(metadataURI).length > 0, "Empty metadata URI");

        bytes32 profileHash = keccak256(abi.encodePacked(profileId));

        uint256 tokenId = ++_nextTokenId;

        _mint(msg.sender, tokenId, 1, "");

        tokenCreator[tokenId] = msg.sender;
        _tokenURIs[tokenId] = metadataURI;
        tokenToProfileId[tokenId] = profileId;
        profileTokens[profileHash].push(tokenId);

        // ERC-2981: royalty on this token goes to PLATFORM (not creator)
        _setTokenRoyalty(tokenId, feeRecipient, royaltyBps);

        // Forward mint fee to platform
        if (msg.value > 0) {
            (bool sent, ) = feeRecipient.call{value: msg.value}("");
            require(sent, "Fee transfer failed");
        }

        emit BucketMinted(tokenId, msg.sender, profileId, metadataURI, block.timestamp);
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
    //              METADATA & ACCESS
    // ══════════════════════════════════════════════

    /// @notice Update metadata URI (only token holder)
    function updateMetadata(uint256 tokenId, string calldata newURI) external {
        require(balanceOf(msg.sender, tokenId) > 0, "Not token holder");
        require(bytes(newURI).length > 0, "Empty URI");

        string memory oldURI = _tokenURIs[tokenId];
        _tokenURIs[tokenId] = newURI;

        emit MetadataUpdated(tokenId, oldURI, newURI, block.timestamp);
    }

    /// @notice Grant on-chain access (mirrors off-chain sharing)
    function grantAccess(uint256 tokenId, address to, uint8 role) external {
        require(balanceOf(msg.sender, tokenId) > 0, "Not token holder");
        require(role == 1 || role == 2, "Invalid role");
        require(to != address(0), "Invalid address");
        require(to != msg.sender, "Cannot grant to self");

        bucketAccess[tokenId][to] = role;
        emit AccessGranted(tokenId, to, role, block.timestamp);
    }

    /// @notice Revoke on-chain access
    function revokeAccess(uint256 tokenId, address from) external {
        require(balanceOf(msg.sender, tokenId) > 0, "Not token holder");
        delete bucketAccess[tokenId][from];
        emit AccessRevoked(tokenId, from, block.timestamp);
    }

    /// @notice Check if address has access to a token
    /// @return role 0=none, 1=viewer, 2=editor, 3=owner
    function hasAccess(uint256 tokenId, address account) external view returns (uint8) {
        if (balanceOf(account, tokenId) > 0) return 3;
        return bucketAccess[tokenId][account];
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return _tokenURIs[tokenId];
    }

    // ══════════════════════════════════════════════
    //              MULTI-MINT VIEWS
    // ══════════════════════════════════════════════

    /// @notice Get all token IDs minted for a given profileId
    function getProfileTokens(bytes16 profileId) external view returns (uint256[] memory) {
        bytes32 profileHash = keccak256(abi.encodePacked(profileId));
        return profileTokens[profileHash];
    }

    /// @notice Get all token IDs owned by an address
    function getTokensByOwner(address owner) external view returns (uint256[] memory) {
        return _ownedTokens[owner];
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
