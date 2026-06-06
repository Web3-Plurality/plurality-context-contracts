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
      owner.address,           // v5 — explicit admin
      platformWallet.address,
      MINT_FEE,
      ROYALTY_BPS,
      MARKETPLACE_FEE_BPS,
    );
    await nft.waitForDeployment();

    // CR↔NFT wiring (production uses DeployHelper to do this atomically).
    await registry.setNftRegistry(await nft.getAddress());

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

    it("rejects valueDecimals > 8 (v3 M-6: tightened from spec's 18)", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      await expect(
        reputation.connect(stranger).giveFeedback(tokenId, 1, 9, "", "", "", "", ethers.ZeroHash),
      ).to.be.revertedWith("valueDecimals must be 0-8");
      // Boundary accepted
      await expect(
        reputation.connect(stranger).giveFeedback(tokenId, 1, 8, "", "", "", "", ethers.ZeroHash),
      ).to.emit(reputation, "NewFeedback");
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

      const [last, exists] = await reputation.getLastIndex(tokenId, stranger.address);
      expect(last).to.equal(2n);
      expect(exists).to.equal(true);

      // Sanity: never-posted address returns (0, false).
      const [nonLast, nonExists] = await reputation.getLastIndex(tokenId, owner.address);
      expect(nonLast).to.equal(0n);
      expect(nonExists).to.equal(false);

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

  describe("v3 hardening — active feedback cap with revoke-slot reuse (audit M-REP-B)", function () {
    it("revoking frees a slot so a non-revoked client can post again", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);

      // Post 5 active feedback rows.
      for (let i = 0; i < 5; i++) {
        await reputation
          .connect(stranger)
          .giveFeedback(tokenId, i + 1, 0, "tag", "", "", "", ethers.ZeroHash);
      }
      expect(await reputation.getActiveFeedbackCount(tokenId, stranger.address)).to.equal(5n);

      // Revoke 3 of them.
      await reputation.connect(stranger).revokeFeedback(tokenId, 0);
      await reputation.connect(stranger).revokeFeedback(tokenId, 1);
      await reputation.connect(stranger).revokeFeedback(tokenId, 2);
      expect(await reputation.getActiveFeedbackCount(tokenId, stranger.address)).to.equal(2n);

      // Active count is back to 2; new feedback can be posted (the audit M-REP-B
      // fix — previous version would have rejected because length cap was on
      // total rows including revoked).
      await expect(
        reputation
          .connect(stranger)
          .giveFeedback(tokenId, 9, 0, "tag", "", "", "", ethers.ZeroHash),
      ).to.emit(reputation, "NewFeedback");

      expect(await reputation.getActiveFeedbackCount(tokenId, stranger.address)).to.equal(3n);
    });

    it("getLastIndex disambiguates 'never posted' from 'posted at index 0' (L-REP-A)", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);

      // Never posted → (0, false).
      const [idxA, existsA] = await reputation.getLastIndex(tokenId, stranger.address);
      expect(idxA).to.equal(0n);
      expect(existsA).to.equal(false);

      // Post one → (0, true).
      await transferViaMarketplace(creator, buyer, tokenId);
      await reputation
        .connect(stranger)
        .giveFeedback(tokenId, 1, 0, "", "", "", "", ethers.ZeroHash);
      const [idxB, existsB] = await reputation.getLastIndex(tokenId, stranger.address);
      expect(idxB).to.equal(0n);
      expect(existsB).to.equal(true);
    });

    it("public caps reflect the v4 values (audit H-4: client cap reverted to 1000)", async function () {
      expect(await reputation.MAX_CLIENTS_PER_AGENT()).to.equal(1000n);
      expect(await reputation.MAX_FEEDBACK_PER_PAIR()).to.equal(50n);
      expect(await reputation.MAX_FEEDBACK_HISTORY_PER_PAIR()).to.equal(200n);
      expect(await reputation.MAX_RESPONSES_PER_FEEDBACK()).to.equal(50n);
    });
  });

  describe("v4 hardening — agent owner bypasses response cap (audit v3 M-5)", function () {
    it("non-owner responses are capped, but the current NFT holder can still respond", async function () {
      const tokenId = await mintBucket(creator, BUCKET_HASH);
      await transferViaMarketplace(creator, buyer, tokenId);
      // stranger leaves a piece of feedback to respond to.
      await reputation
        .connect(stranger)
        .giveFeedback(tokenId, 4, 0, "tag", "", "", "", ethers.ZeroHash);

      // Fill the response cap (50) with non-owner responders. We use the same
      // non-owner address repeatedly here — the cap is on length, not unique
      // responders, so the effect is the same as a Sybil flood.
      for (let i = 0; i < 50; i++) {
        await reputation
          .connect(nextBuyer)
          .appendResponse(tokenId, stranger.address, 0, "ipfs://shill", ethers.ZeroHash);
      }

      // The next non-owner response is blocked.
      await expect(
        reputation
          .connect(nextBuyer)
          .appendResponse(tokenId, stranger.address, 0, "ipfs://blocked", ethers.ZeroHash),
      ).to.be.revertedWith("Response cap reached");

      // But the agent owner (buyer holds the NFT) can still respond — their
      // rebuttal right is preserved.
      await expect(
        reputation
          .connect(buyer)
          .appendResponse(tokenId, stranger.address, 0, "ipfs://owner-rebuttal", ethers.ZeroHash),
      ).to.emit(reputation, "ResponseAppended");
    });
  });

  describe("v5 hardening — VERSION + constructor probe", function () {
    it("exposes the v5 version stamp", async function () {
      expect(await reputation.VERSION()).to.equal("ReputationRegistry/v5");
    });

    it("rejects an EOA identity registry (probe)", async function () {
      const Reputation = await ethers.getContractFactory("ReputationRegistry");
      await expect(Reputation.deploy(stranger.address)).to.be.revertedWith(
        "Identity registry not a contract",
      );
    });
  });
});
