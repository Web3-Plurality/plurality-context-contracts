import { expect } from "chai";
import { ethers } from "hardhat";
import { PluralityMemoryNFT, ContextRegistry, ReputationRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ReputationRegistry — ERC-8004-faithful (multi-feedback, decimals, tags)", function () {
  let nft: PluralityMemoryNFT;
  let registry: ContextRegistry;
  let reputation: ReputationRegistry;
  let owner: SignerWithAddress;
  let creator: SignerWithAddress;
  let buyer: SignerWithAddress;
  let nextBuyer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let platformWallet: SignerWithAddress;

  const MINT_FEE = ethers.parseEther("0.01");
  const ROYALTY_BPS = 500;
  const MARKETPLACE_FEE_BPS = 250;
  const LIST_PRICE = ethers.parseEther("0.5");

  const BUCKET_HASH = "0x550e8400e29b41d4a716446655440000550e8400e29b41d4a716446655440000" as `0x${string}`;
  const CTX1 = "0x11111111111111111111111111111111" as `0x${string}`;
  const HASH1 = ethers.keccak256(ethers.toUtf8Bytes("doc one"));
  const METADATA_URI = "https://example.com/bucket/1";

  async function mintBucket(signer: SignerWithAddress, bucketHash: `0x${string}`): Promise<bigint> {
    await registry
      .connect(signer)
      .registerContextBatch(bucketHash, [CTX1], [HASH1], ["ipfs://a"], ["file"]);
    const tx = await nft.connect(signer).mintBucket(bucketHash, METADATA_URI, { value: MINT_FEE });
    const receipt = await tx.wait();
    const minted = receipt!.logs
      .map((log) => {
        try {
          return nft.interface.parseLog(log as never);
        } catch {
          return null;
        }
      })
      .find((p) => p?.name === "BucketMinted");
    return minted!.args.tokenId as bigint;
  }

  async function transferViaMarketplace(
    seller: SignerWithAddress,
    buyerSigner: SignerWithAddress,
    tokenId: bigint,
  ) {
    await nft.connect(seller).setApprovalForAll(await nft.getAddress(), true);
    await nft.connect(seller).listBucket(tokenId, LIST_PRICE);
    await nft.connect(buyerSigner).buyBucket(tokenId, { value: LIST_PRICE });
  }

  beforeEach(async function () {
    [owner, creator, buyer, nextBuyer, stranger, platformWallet] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ContextRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    const NFT = await ethers.getContractFactory("PluralityMemoryNFT");
    nft = await NFT.deploy(
      await registry.getAddress(),
      platformWallet.address,
      MINT_FEE,
      ROYALTY_BPS,
      MARKETPLACE_FEE_BPS,
    );
    await nft.waitForDeployment();

    const Reputation = await ethers.getContractFactory("ReputationRegistry");
    reputation = await Reputation.deploy(await nft.getAddress());
    await reputation.waitForDeployment();
  });

  describe("Deployment + getIdentityRegistry", function () {
    it("stores the IdentityRegistry address", async function () {
      expect(await reputation.getIdentityRegistry()).to.equal(await nft.getAddress());
    });

    it("rejects zero identity registry address", async function () {
      const Reputation = await ethers.getContractFactory("ReputationRegistry");
      await expect(Reputation.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "Invalid identity registry",
      );
    });
  });

  describe("giveFeedback — owner restriction", function () {
    it("reverts when the current NFT holder tries to submit feedback", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      // creator currently holds the NFT
      await expect(
        reputation
          .connect(creator)
          .giveFeedback(tokenId, 5, 0, "quality", "", "", "", ethers.ZeroHash),
      ).to.be.revertedWith("Submitter is the agent owner");
    });

    it("reverts when the current buyer tries to submit feedback", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      // buyer is now the current holder
      await expect(
        reputation.connect(buyer).giveFeedback(tokenId, 5, 0, "", "", "", "", ethers.ZeroHash),
      ).to.be.revertedWith("Submitter is the agent owner");
    });

    it("allows a non-holder (creator after sale) to submit feedback", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      // creator no longer holds — per spec they are now eligible to leave feedback
      await expect(
        reputation
          .connect(creator)
          .giveFeedback(tokenId, 4, 1, "tag-a", "tag-b", "http://x", "ipfs://r", ethers.ZeroHash),
      )
        .to.emit(reputation, "NewFeedback")
        .withArgs(
          tokenId,
          creator.address,
          0,
          4,
          1,
          (val: string) => true, // indexed hashed tag1 — predicate accepts any
          "tag-a",
          "tag-b",
          "http://x",
          "ipfs://r",
          ethers.ZeroHash,
        );
    });

    it("allows a stranger who has never held the NFT to submit feedback", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await expect(
        reputation.connect(stranger).giveFeedback(tokenId, -2, 0, "", "", "", "", ethers.ZeroHash),
      ).to.emit(reputation, "NewFeedback");
    });

    it("rejects valueDecimals > 18", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await expect(
        reputation.connect(stranger).giveFeedback(tokenId, 1, 19, "", "", "", "", ethers.ZeroHash),
      ).to.be.revertedWith("valueDecimals must be 0-18");
    });
  });

  describe("Multiple feedback per (agent, client) — feedbackIndex semantics", function () {
    it("appends feedback rows; each call returns a new feedbackIndex via the event", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);

      // stranger leaves 3 separate feedback entries
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "a", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).giveFeedback(tokenId, 2, 0, "b", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).giveFeedback(tokenId, 3, 0, "c", "", "", "", ethers.ZeroHash);

      const last = await reputation.getLastIndex(tokenId, stranger.address);
      expect(last).to.equal(2n);

      const fb0 = await reputation.readFeedback(tokenId, stranger.address, 0);
      const fb1 = await reputation.readFeedback(tokenId, stranger.address, 1);
      const fb2 = await reputation.readFeedback(tokenId, stranger.address, 2);
      expect(fb0.value).to.equal(1);
      expect(fb0.tag1).to.equal("a");
      expect(fb1.value).to.equal(2);
      expect(fb1.tag1).to.equal("b");
      expect(fb2.value).to.equal(3);
      expect(fb2.tag1).to.equal("c");
    });

    it("readFeedback reverts on out-of-bounds index", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await expect(reputation.readFeedback(tokenId, stranger.address, 0)).to.be.revertedWith(
        "No such feedback",
      );
    });

    it("getClients returns each unique client once even after multiple feedback", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).giveFeedback(tokenId, 2, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 3, 0, "", "", "", "", ethers.ZeroHash);

      const clients = await reputation.getClients(tokenId);
      expect(clients).to.have.lengthOf(2);
      expect(clients).to.include(stranger.address);
      expect(clients).to.include(creator.address);
    });
  });

  describe("revokeFeedback", function () {
    it("client can revoke their own feedback by index", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).giveFeedback(tokenId, 2, 0, "", "", "", "", ethers.ZeroHash);

      await expect(reputation.connect(stranger).revokeFeedback(tokenId, 0))
        .to.emit(reputation, "FeedbackRevoked")
        .withArgs(tokenId, stranger.address, 0);

      const fb0 = await reputation.readFeedback(tokenId, stranger.address, 0);
      const fb1 = await reputation.readFeedback(tokenId, stranger.address, 1);
      expect(fb0.isRevoked).to.equal(true);
      expect(fb1.isRevoked).to.equal(false);
    });

    it("reverts when revoking non-existent index", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await expect(reputation.connect(stranger).revokeFeedback(tokenId, 0)).to.be.revertedWith(
        "No such feedback",
      );
    });

    it("reverts on double revoke", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).revokeFeedback(tokenId, 0);
      await expect(reputation.connect(stranger).revokeFeedback(tokenId, 0)).to.be.revertedWith(
        "Already revoked",
      );
    });
  });

  describe("appendResponse — multiple responders per feedback row", function () {
    it("emits ResponseAppended with the responder, URI, hash", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 3, 0, "", "", "", "", ethers.ZeroHash);

      const respHash = ethers.keccak256(ethers.toUtf8Bytes("reply"));
      await expect(
        reputation.connect(buyer).appendResponse(tokenId, stranger.address, 0, "ipfs://resp", respHash),
      )
        .to.emit(reputation, "ResponseAppended")
        .withArgs(tokenId, stranger.address, 0, buyer.address, "ipfs://resp", respHash);
    });

    it("getResponseCount counts every response when responders[] is empty", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(buyer).appendResponse(tokenId, stranger.address, 0, "u1", ethers.ZeroHash);
      await reputation.connect(creator).appendResponse(tokenId, stranger.address, 0, "u2", ethers.ZeroHash);
      await reputation.connect(nextBuyer).appendResponse(tokenId, stranger.address, 0, "u3", ethers.ZeroHash);

      expect(await reputation.getResponseCount(tokenId, stranger.address, 0, [])).to.equal(3n);
    });

    it("getResponseCount filters by responders[] when provided", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(buyer).appendResponse(tokenId, stranger.address, 0, "u1", ethers.ZeroHash);
      await reputation.connect(creator).appendResponse(tokenId, stranger.address, 0, "u2", ethers.ZeroHash);

      expect(
        await reputation.getResponseCount(tokenId, stranger.address, 0, [buyer.address]),
      ).to.equal(1n);
      expect(
        await reputation.getResponseCount(tokenId, stranger.address, 0, [buyer.address, creator.address]),
      ).to.equal(2n);
      expect(
        await reputation.getResponseCount(tokenId, stranger.address, 0, [nextBuyer.address]),
      ).to.equal(0n);
    });

    it("reverts when responding to non-existent feedback", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await expect(
        reputation.connect(buyer).appendResponse(tokenId, stranger.address, 0, "u", ethers.ZeroHash),
      ).to.be.revertedWith("No such feedback");
    });
  });

  describe("getSummary — client + tag filtering, decimal normalization", function () {
    it("returns (0, 0, 0) when no matching feedback exists", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      const [count, value, decimals] = await reputation.getSummary(tokenId, [], "", "");
      expect(count).to.equal(0n);
      expect(value).to.equal(0n);
      expect(decimals).to.equal(0);
    });

    it("aggregates with no filter (clients=[], tags=)", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 4, 0, "a", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 6, 0, "a", "", "", "", ethers.ZeroHash);

      const [count, value, decimals] = await reputation.getSummary(tokenId, [], "", "");
      expect(count).to.equal(2n);
      expect(value).to.equal(5n); // (4+6)/2
      expect(decimals).to.equal(0);
    });

    it("filters by tag1", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 10, 0, "speed", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 2, 0, "quality", "", "", "", ethers.ZeroHash);

      const [countS, valS] = await reputation.getSummary(tokenId, [], "speed", "");
      expect(countS).to.equal(1n);
      expect(valS).to.equal(10n);

      const [countQ, valQ] = await reputation.getSummary(tokenId, [], "quality", "");
      expect(countQ).to.equal(1n);
      expect(valQ).to.equal(2n);
    });

    it("filters by clientAddresses[]", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 9, 0, "", "", "", "", ethers.ZeroHash);

      const [count, value] = await reputation.getSummary(tokenId, [stranger.address], "", "");
      expect(count).to.equal(1n);
      expect(value).to.equal(1n);
    });

    it("normalizes mixed valueDecimals to the max seen", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      // 4.2 expressed as (42, 1) and 5.0 expressed as (5, 0); avg should be 4.6 = (46, 1)
      await reputation.connect(stranger).giveFeedback(tokenId, 42, 1, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 5, 0, "", "", "", "", ethers.ZeroHash);

      const [count, value, decimals] = await reputation.getSummary(tokenId, [], "", "");
      expect(count).to.equal(2n);
      expect(decimals).to.equal(1);
      expect(value).to.equal(46n); // (42 + 5*10) / 2 = 46
    });

    it("excludes revoked feedback from the aggregate", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 10, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 2, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).revokeFeedback(tokenId, 0);

      const [count, value] = await reputation.getSummary(tokenId, [], "", "");
      expect(count).to.equal(1n);
      expect(value).to.equal(2n);
    });
  });

  describe("readAllFeedback", function () {
    it("returns every active feedback across clients when filters are empty", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "tA", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 2, 0, "tB", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).giveFeedback(tokenId, 3, 0, "tA", "", "", "", ethers.ZeroHash);

      const [clients, , values] = await reputation.readAllFeedback(tokenId, [], "", "", false);
      expect(clients).to.have.lengthOf(3);
      const valArr = [Number(values[0]), Number(values[1]), Number(values[2])].sort();
      expect(valArr).to.deep.equal([1, 2, 3]);
    });

    it("filters by tag1", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "tA", "", "", "", ethers.ZeroHash);
      await reputation.connect(creator).giveFeedback(tokenId, 2, 0, "tB", "", "", "", ethers.ZeroHash);

      const [clients, , values] = await reputation.readAllFeedback(tokenId, [], "tA", "", false);
      expect(clients).to.have.lengthOf(1);
      expect(values[0]).to.equal(1n);
    });

    it("respects includeRevoked", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation.connect(stranger).giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      await reputation.connect(stranger).revokeFeedback(tokenId, 0);

      const [clientsEx] = await reputation.readAllFeedback(tokenId, [], "", "", false);
      expect(clientsEx).to.have.lengthOf(0);

      const [clientsIn, , , , , , revokedStatuses] = await reputation.readAllFeedback(
        tokenId,
        [],
        "",
        "",
        true,
      );
      expect(clientsIn).to.have.lengthOf(1);
      expect(revokedStatuses[0]).to.equal(true);
    });
  });
});
