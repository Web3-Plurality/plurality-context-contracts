# Plurality Context Contracts

On-chain provenance, ownership, and reputation layer for the Plurality memory marketplace. Three contracts on the Oasis Sapphire Testnet provide tamper-proof context provenance, ERC-1155 memory-bucket NFTs that double as access tokens, a built-in marketplace with platform-fee economics, and ERC-8004-inspired reputation feedback per bucket.


## Deployed addresses (Oasis Sapphire Testnet, chainId `23295`)

| Contract | Address | Explorer |
|---|---|---|
| ContextRegistry | `0x9A374905B2B286344fCac6f754dCF40F3cb427d5` | [view](https://explorer.oasis.io/testnet/sapphire/address/0x9A374905B2B286344fCac6f754dCF40F3cb427d5) |
| PluralityMemoryNFT | `0xDe5dB30AE86e27F1E7EeC0AD353d910C4Ca93D08` | [view](https://explorer.oasis.io/testnet/sapphire/address/0xDe5dB30AE86e27F1E7EeC0AD353d910C4Ca93D08) |
| ReputationRegistry | `0x8D0027e715943FB2f215c884369B744861331E3E` | [view](https://explorer.oasis.io/testnet/sapphire/address/0x8D0027e715943FB2f215c884369B744861331E3E) |

Deployer / fee recipient: `0x49B330af2e9B16189a55d45bcf808d2D92bce1f6`
Atomic deploy via DeployHelper: `0xefC7d00794DE1882001a386D0FF40DD1D1c7BB87`
Deployed at: `2026-06-06T00:00Z` (v5 deployment — fourth-pass audit remediations, mainnet-ready)
Full deployment record: [`deployments.market.json`](deployments.market.json)

## Architecture

### Register-first model (two transactions, one bucket)

```
┌──────────────────────────┐      ┌──────────────────────────┐
│  tx1: registerContextBatch│ ───> │ tx2: mintBucket          │
│  ContextRegistry         │      │ PluralityMemoryNFT       │
│                          │      │                          │
│  • claim bucketHash      │      │  • verify caller is the  │
│  • anchor each context's │      │    bucketHash registrant │
│    contentHash on-chain  │      │  • mint ERC-1155 token   │
│  • emit ContextRegistered│      │  • emit BucketMinted     │
└──────────────────────────┘      └──────────────────────────┘
```

The user must register their bucket's contexts (tx1) before they can mint (tx2). `mintBucket` reverts unless `registry.getBucketRegistrant(bucketHash) == msg.sender`. This makes the link between provenance and ownership a trustless on-chain property: nobody can mint over someone else's registered contexts.

### NFT-as-access-token

Each `tokenId` stores a `bucketHash`. Holding the NFT for a given `bucketHash` is the sole proof of bucket read access — backends resolve permission by reading on-chain ownership via `getBucketHashesByOwner(wallet)`. Sell the NFT, lose the access. Buy the NFT, gain it.

### Append-only provenance

ContextRegistry has no revoke and no update path. Once a `contentHash` is registered for a `contextId`, the record is permanent — a `verifyContent(contextId, contentHash)` call answers "is this the original content?" indefinitely.

## Contracts

The three contracts together follow the registry pattern in ERC-8004 (Trustless Agents): each is single-purpose, append-only, and queryable on its own. `PluralityMemoryNFT` carries identity and ownership, `ReputationRegistry` carries social signal, and `ContextRegistry` carries content provenance — the last one being a category ERC-8004 itself doesn't define, but which fits the same shape.

```
┌──────────────────────────┐         ┌──────────────────────────┐
│  PluralityMemoryNFT      │         │  ContextRegistry         │
│                          │ ──────► │                          │
│  • one tokenId =         │ linked  │  • content hash anchored │
│    one memory bucket     │   by    │  • per-context provenance│
│  • holder = controller   │ bucket  │  • append-only           │
│  • metadataURI off-chain │  Hash   │                          │
└──────────────────────────┘         └──────────────────────────┘
            │
            │ scored by
            ▼
┌──────────────────────────┐
│  ReputationRegistry      │
│                          │
│  • typed feedback        │
│  • current owner can't   │
│    rate own bucket       │
│  • revoke / respond      │
│  • aggregate by tag      │
└──────────────────────────┘
```


### [ContextRegistry.sol](contracts/ContextRegistry.sol)

Permissionless, append-only provenance registry. Records `(contentHash, bucketHash, registeredBy, metadataURI, registeredAt, sourceType)` per context, keyed by a UUID (`bytes16`).

Entry points:
- `registerContextBatch(bucketHash, contextIds[], contentHashes[], metadataURIs[], sourceTypes[])` — permissionless. First caller per `bucketHash` claims it.
- `verifyContent(contextId, contentHash) → bool` — does this content match what was registered?
- `getProvenanceByHash(contentHash) → (contextId, registeredAt, registeredBy, bucketHash)` — reverse lookup
- `getBucketRegistrant(bucketHash) → address` — the wallet that claimed this bucketHash; read by the NFT contract to gate minting
- `getContextsByBucketHash(bucketHash) → bytes16[]` — all contexts under a bucket

### [PluralityMemoryNFT.sol](contracts/PluralityMemoryNFT.sol)

ERC-1155 with supply-of-1 per token. Each token represents one memory bucket. The token URI points to off-chain metadata; holding the token equals owning the bucket. The contract embeds a marketplace — list, buy, delist — with platform-level fees routed to a configurable treasury.

Entry points:
- `mintBucket(bucketHash, metadataURI) payable → tokenId` — register-first enforced via the registry. Requires `msg.value >= mintFee`.
- `listBucket(tokenId, price)` / `delistBucket(tokenId)` / `buyBucket(tokenId) payable` — built-in marketplace
- `updateMetadata(tokenId, newURI)` — current holder may update the off-chain metadata pointer
- `getBucketHashesByOwner(owner) → bytes32[]` — canonical "what can this wallet access?" query used by backends
- Admin: `setMintFee`, `setFeeRecipient`, `setMarketplaceFeeBps`, `setRoyaltyBps`, `pause`, `unpause`

Extends: `ERC1155`, `ERC2981` (royalties), `AccessControl`, `Pausable`, `ReentrancyGuard` (on `buyBucket`).

### [ReputationRegistry.sol](contracts/ReputationRegistry.sol)

Typed feedback on each bucket, with the data model and entry points from ERC-8004's ReputationRegistry: per-agent feedback with value + decimals + two tags + endpoint + optional content URI, multiple entries per (agent, client) pair, revocable, with multi-responder responses and tag/client-filterable aggregates.

Entry points:
- `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)` — `int128 value`, `uint8 valueDecimals` ∈ [0, 8] (spec allows [0, 18] but we tightened to bound the rescale factor in `getSummary`). Caller must not currently hold the bucket NFT. Each call appends a row; emits `NewFeedback` with the new `feedbackIndex`.
- `revokeFeedback(agentId, feedbackIndex)` — soft revoke. The row stays marked `isRevoked` for transparency.
- `appendResponse(agentId, clientAddress, feedbackIndex, responseURI, responseHash)` — open to any caller; multiple responders per feedback row.
- `getSummary(agentId, clientAddresses[], tag1, tag2) → (count, summaryValue, summaryValueDecimals)` — filtered aggregate. Mixed `valueDecimals` are normalized to the max seen before averaging.
- `readFeedback`, `readAllFeedback`, `getResponseCount`, `getClients`, `getLastIndex`, `getIdentityRegistry` — the read surface.

Only depends on `IERC1155.balanceOf` from the NFT contract; the rest is self-contained.

## Fee model

All fees flow to the platform treasury (`feeRecipient`):

| Fee | Default | Configurable by | Cap | Notes |
|---|---|---|---|---|
| Mint fee | `0.01 ROSE` (10⁻²) | `DEFAULT_ADMIN_ROLE` | — | Charged on every `mintBucket`; pushed to treasury synchronously |
| ERC-2981 royalty | 500 bps (5%) | `DEFAULT_ADMIN_ROLE` | `MAX_ROYALTY_BPS` = 1000 bps (10%) | Reported to external marketplaces via ERC-2981 |
| Built-in marketplace commission | 250 bps (2.5%) | `DEFAULT_ADMIN_ROLE` | `MAX_MARKETPLACE_FEE_BPS` = 1000 bps (10%) | Deducted from sale price in `buyBucket`; snapshot at list time so an admin fee change can't rug a live listing |

The ERC-2981 royalty recipient is the platform, not the creator. This is a deliberate platform-fee design rather than the conventional creator-royalty default.

All value flows (seller proceeds, platform commission, buyer refunds, mint-fee remittance) use a hybrid payment pattern: the contract first attempts a direct push with a 150,000-gas limit (enough headroom for Gnosis Safe / ERC-4337 smart-wallet receive paths); if the recipient reverts or runs out of gas, the amount is credited to `pendingWithdrawals[recipient]` and claimable via `withdraw()`. In the common EOA case the recipient is paid synchronously; the fallback only triggers when the recipient is a contract that rejects ROSE.

## Quick start

```bash
# Install
npm install

# Compile
npx hardhat compile

# Fresh deploy of all three contracts to Oasis Sapphire Testnet
# (e.g. for a new stack). Requires DEPLOYER_PRIVATE_KEY in .env.
npm run deploy:sapphire-testnet

# Incremental: deploy ONLY ReputationRegistry, pointing at the existing
# PluralityMemoryNFT address from deployments.market.json. Use this when
# the NFT/ContextRegistry addresses must be preserved (backends already
# point at them).
npm run deploy:reputation:sapphire-testnet
```

### Environment variables

| Var | Used by | Required for |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | `hardhat.config.ts` | Deploying to any non-local network |
| `SEPOLIA_RPC_URL` | `hardhat.config.ts` | Deploying to Sepolia (optional) |

## Repository layout

```
contracts/
  ContextRegistry.sol         # ERC-8004-aligned provenance registry
  PluralityMemoryNFT.sol      # ERC-1155 memory-bucket NFT + marketplace
  ReputationRegistry.sol      # ERC-8004-inspired reputation, per tokenId
  DeployHelper.sol            # v5: atomic 3-contract deploy + wiring
scripts/
  deploy-market.ts            # Fresh deploy via DeployHelper (atomic)
  deploy-reputation.ts        # Incremental deploy of ReputationRegistry only,
                              # attaches to the existing NFT address
deployments.market.json       # Live testnet addresses + constructor params
hardhat.config.ts             # Networks: oasisSapphireTestnet, sepolia
```

## Toolchain

- Solidity `0.8.27`, EVM target `cancun`, optimizer `runs=200`, `viaIR=true` (needed for `ReputationRegistry.giveFeedback`'s spec-mandated 8-parameter event)
- Hardhat `^2.22.0` with `@nomicfoundation/hardhat-toolbox`
- OpenZeppelin Contracts `^5.1.0`

## License

MIT (per the SPDX headers in each contract).
