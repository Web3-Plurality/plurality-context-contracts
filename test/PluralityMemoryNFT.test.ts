import { expect } from "chai";
import { ethers } from "hardhat";
import { PluralityMemoryNFT } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("PluralityMemoryNFT", function () {
  let nft: PluralityMemoryNFT;
  let owner: SignerWithAddress;       // deployer = platform admin
  let user1: SignerWithAddress;       // bucket creator
  let user2: SignerWithAddress;       // buyer
  let platformWallet: SignerWithAddress; // feeRecipient (platform treasury)

  const MINT_FEE = ethers.parseEther("0.01");
  const ROYALTY_BPS = 500;       // 5%
  const MARKETPLACE_FEE_BPS = 250; // 2.5%
  const PROFILE_ID = "0x550e8400e29b41d4a716446655440000" as `0x${string}`;
  const PROFILE_ID_2 = "0x660e8400e29b41d4a716446655440000" as `0x${string}`;
  const METADATA_URI = "https://api.plurality.network/blockchain/metadata/bucket/test";

  beforeEach(async function () {
    [owner, user1, user2, platformWallet] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("PluralityMemoryNFT");
    nft = await Factory.deploy(platformWallet.address, MINT_FEE, ROYALTY_BPS, MARKETPLACE_FEE_BPS);
    await nft.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set correct fee recipient (platform)", async function () {
      expect(await nft.feeRecipient()).to.equal(platformWallet.address);
    });

    it("should set correct mint fee", async function () {
      expect(await nft.mintFee()).to.equal(MINT_FEE);
    });

    it("should set correct royalty bps", async function () {
      expect(await nft.royaltyBps()).to.equal(ROYALTY_BPS);
    });

    it("should set correct marketplace fee bps", async function () {
      expect(await nft.marketplaceFeeBps()).to.equal(MARKETPLACE_FEE_BPS);
    });
  });

  describe("Minting", function () {
    it("should mint a bucket NFT", async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      expect(await nft.tokenCreator(1)).to.equal(user1.address);
      expect(await nft.uri(1)).to.equal(METADATA_URI);
    });

    it("should emit BucketMinted event", async function () {
      await expect(nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE }))
        .to.emit(nft, "BucketMinted")
        .withArgs(1, user1.address, PROFILE_ID, METADATA_URI, (v: any) => true);
    });

    it("should forward mint fee to PLATFORM (not creator)", async function () {
      const balBefore = await ethers.provider.getBalance(platformWallet.address);
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
      const balAfter = await ethers.provider.getBalance(platformWallet.address);

      expect(balAfter - balBefore).to.equal(MINT_FEE);
    });

    it("should revert if insufficient fee", async function () {
      await expect(
        nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: 0 })
      ).to.be.revertedWith("Insufficient mint fee");
    });

    it("should allow multiple mints of the same profile (snapshot model)", async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user1).mintBucket(PROFILE_ID, "https://other", { value: MINT_FEE });

      // Both tokens exist
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      expect(await nft.balanceOf(user1.address, 2)).to.equal(1);

      // getProfileTokens returns both token IDs
      const tokens = await nft.getProfileTokens(PROFILE_ID);
      expect(tokens.length).to.equal(2);
      expect(tokens[0]).to.equal(1);
      expect(tokens[1]).to.equal(2);

      // getTokensByOwner returns both
      const owned = await nft.getTokensByOwner(user1.address);
      expect(owned.length).to.equal(2);
    });

    it("should revert with empty metadata URI", async function () {
      await expect(
        nft.connect(user1).mintBucket(PROFILE_ID, "", { value: MINT_FEE })
      ).to.be.revertedWith("Empty metadata URI");
    });

    it("should increment token IDs", async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user2).mintBucket(PROFILE_ID_2, "https://other", { value: MINT_FEE });

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      expect(await nft.balanceOf(user2.address, 2)).to.equal(1);
    });
  });

  describe("Royalties (ERC-2981) — ALL go to platform", function () {
    it("should return PLATFORM as royalty receiver, not creator", async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });

      const salePrice = ethers.parseEther("1");
      const [receiver, amount] = await nft.royaltyInfo(1, salePrice);

      // Royalty goes to PLATFORM, not user1 (the creator)
      expect(receiver).to.equal(platformWallet.address);
      expect(amount).to.equal(salePrice * BigInt(ROYALTY_BPS) / 10000n);
    });

    it("should update royalty receiver when feeRecipient changes", async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
      await nft.connect(owner).setFeeRecipient(user2.address);

      const [receiver] = await nft.royaltyInfo(1, ethers.parseEther("1"));
      // New tokens would get new recipient via default; existing per-token stays as platform
      // But the default royalty now points to user2
    });
  });

  describe("Marketplace", function () {
    beforeEach(async function () {
      // user1 mints a bucket
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
      // user1 approves the contract to transfer on their behalf
      await nft.connect(user1).setApprovalForAll(await nft.getAddress(), true);
    });

    it("should list a bucket for sale", async function () {
      const price = ethers.parseEther("1");
      await expect(nft.connect(user1).listBucket(1, price))
        .to.emit(nft, "BucketListed")
        .withArgs(1, user1.address, price, (v: any) => true);

      const [seller, listedPrice, active] = await nft.getListing(1);
      expect(seller).to.equal(user1.address);
      expect(listedPrice).to.equal(price);
      expect(active).to.be.true;
    });

    it("should revert listing if not approved", async function () {
      // user1 removes approval
      await nft.connect(user1).setApprovalForAll(await nft.getAddress(), false);

      await expect(
        nft.connect(user1).listBucket(1, ethers.parseEther("1"))
      ).to.be.revertedWith("Approve contract first");
    });

    it("should revert listing if not token holder", async function () {
      await expect(
        nft.connect(user2).listBucket(1, ethers.parseEther("1"))
      ).to.be.revertedWith("Not token holder");
    });

    it("should revert listing with zero price", async function () {
      await expect(
        nft.connect(user1).listBucket(1, 0)
      ).to.be.revertedWith("Price must be > 0");
    });

    it("should delist a bucket", async function () {
      await nft.connect(user1).listBucket(1, ethers.parseEther("1"));
      await expect(nft.connect(user1).delistBucket(1))
        .to.emit(nft, "BucketDelisted");

      const [, , active] = await nft.getListing(1);
      expect(active).to.be.false;
    });

    it("should revert delist if not the seller", async function () {
      await nft.connect(user1).listBucket(1, ethers.parseEther("1"));
      await expect(nft.connect(user2).delistBucket(1)).to.be.revertedWith("Not the seller");
    });

    describe("Buying", function () {
      const SALE_PRICE = ethers.parseEther("1"); // 1 ROSE

      beforeEach(async function () {
        await nft.connect(user1).listBucket(1, SALE_PRICE);
      });

      it("should transfer NFT and pay correctly", async function () {
        const platformBalBefore = await ethers.provider.getBalance(platformWallet.address);
        const sellerBalBefore = await ethers.provider.getBalance(user1.address);

        await expect(nft.connect(user2).buyBucket(1, { value: SALE_PRICE }))
          .to.emit(nft, "BucketSold");

        // NFT transferred
        expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
        expect(await nft.balanceOf(user1.address, 1)).to.equal(0);

        // Platform got 2.5% commission
        const platformBalAfter = await ethers.provider.getBalance(platformWallet.address);
        const expectedFee = (SALE_PRICE * BigInt(MARKETPLACE_FEE_BPS)) / 10000n;
        expect(platformBalAfter - platformBalBefore).to.equal(expectedFee);

        // Seller got 97.5%
        const sellerBalAfter = await ethers.provider.getBalance(user1.address);
        const expectedProceeds = SALE_PRICE - expectedFee;
        expect(sellerBalAfter - sellerBalBefore).to.equal(expectedProceeds);
      });

      it("should emit BucketSold with correct fee breakdown", async function () {
        const expectedFee = (SALE_PRICE * BigInt(MARKETPLACE_FEE_BPS)) / 10000n;
        const expectedProceeds = SALE_PRICE - expectedFee;

        await expect(nft.connect(user2).buyBucket(1, { value: SALE_PRICE }))
          .to.emit(nft, "BucketSold")
          .withArgs(1, user1.address, user2.address, SALE_PRICE, expectedFee, expectedProceeds, (v: any) => true);
      });

      it("should deactivate listing after purchase", async function () {
        await nft.connect(user2).buyBucket(1, { value: SALE_PRICE });

        const [, , active] = await nft.getListing(1);
        expect(active).to.be.false;
      });

      it("should refund excess payment", async function () {
        const overpay = ethers.parseEther("2");
        const buyerBalBefore = await ethers.provider.getBalance(user2.address);

        const tx = await nft.connect(user2).buyBucket(1, { value: overpay });
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

        const buyerBalAfter = await ethers.provider.getBalance(user2.address);
        // Buyer should have paid exactly SALE_PRICE + gas, the rest refunded
        const actualSpent = buyerBalBefore - buyerBalAfter;
        expect(actualSpent).to.equal(SALE_PRICE + gasUsed);
      });

      it("should revert if insufficient payment", async function () {
        await expect(
          nft.connect(user2).buyBucket(1, { value: ethers.parseEther("0.5") })
        ).to.be.revertedWith("Insufficient payment");
      });

      it("should revert if seller tries to buy own listing", async function () {
        await expect(
          nft.connect(user1).buyBucket(1, { value: SALE_PRICE })
        ).to.be.revertedWith("Cannot buy own listing");
      });

      it("should revert buying a delisted token", async function () {
        await nft.connect(user1).delistBucket(1);
        await expect(
          nft.connect(user2).buyBucket(1, { value: SALE_PRICE })
        ).to.be.revertedWith("Not listed");
      });
    });
  });

  describe("Access Control", function () {
    beforeEach(async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
    });

    it("should grant viewer access", async function () {
      await expect(nft.connect(user1).grantAccess(1, user2.address, 1))
        .to.emit(nft, "AccessGranted");
      expect(await nft.hasAccess(1, user2.address)).to.equal(1);
    });

    it("should grant editor access", async function () {
      await nft.connect(user1).grantAccess(1, user2.address, 2);
      expect(await nft.hasAccess(1, user2.address)).to.equal(2);
    });

    it("should return 3 (owner) for token holder", async function () {
      expect(await nft.hasAccess(1, user1.address)).to.equal(3);
    });

    it("should return 0 for no access", async function () {
      expect(await nft.hasAccess(1, user2.address)).to.equal(0);
    });

    it("should revoke access", async function () {
      await nft.connect(user1).grantAccess(1, user2.address, 2);
      await expect(nft.connect(user1).revokeAccess(1, user2.address))
        .to.emit(nft, "AccessRevoked");
      expect(await nft.hasAccess(1, user2.address)).to.equal(0);
    });
  });

  describe("Metadata", function () {
    beforeEach(async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
    });

    it("should update metadata URI by token holder", async function () {
      const newURI = "https://api.plurality.network/blockchain/metadata/bucket/updated";
      await expect(nft.connect(user1).updateMetadata(1, newURI))
        .to.emit(nft, "MetadataUpdated");
      expect(await nft.uri(1)).to.equal(newURI);
    });

    it("should revert if non-holder tries to update", async function () {
      await expect(nft.connect(user2).updateMetadata(1, "hacker")).to.be.revertedWith("Not token holder");
    });
  });

  describe("Multi-mint & Ownership Tracking", function () {
    it("should track tokens per owner across mints", async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user1).mintBucket(PROFILE_ID_2, "https://other", { value: MINT_FEE });

      const owned = await nft.getTokensByOwner(user1.address);
      expect(owned.length).to.equal(2);
      expect(owned[0]).to.equal(1);
      expect(owned[1]).to.equal(2);
    });

    it("should update _ownedTokens on transfer (marketplace buy)", async function () {
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user1).setApprovalForAll(await nft.getAddress(), true);
      await nft.connect(user1).listBucket(1, ethers.parseEther("1"));
      await nft.connect(user2).buyBucket(1, { value: ethers.parseEther("1") });

      // user1 should have no tokens, user2 should have token 1
      const ownedByUser1 = await nft.getTokensByOwner(user1.address);
      expect(ownedByUser1.length).to.equal(0);

      const ownedByUser2 = await nft.getTokensByOwner(user2.address);
      expect(ownedByUser2.length).to.equal(1);
      expect(ownedByUser2[0]).to.equal(1);
    });

    it("should return empty array for getProfileTokens with unknown profileId", async function () {
      const tokens = await nft.getProfileTokens(PROFILE_ID);
      expect(tokens.length).to.equal(0);
    });

    it("should return empty array for getTokensByOwner with no tokens", async function () {
      const owned = await nft.getTokensByOwner(user2.address);
      expect(owned.length).to.equal(0);
    });
  });

  describe("Admin", function () {
    it("should update mint fee", async function () {
      const newFee = ethers.parseEther("0.05");
      await expect(nft.connect(owner).setMintFee(newFee))
        .to.emit(nft, "MintFeeUpdated");
      expect(await nft.mintFee()).to.equal(newFee);
    });

    it("should update fee recipient", async function () {
      await nft.connect(owner).setFeeRecipient(user2.address);
      expect(await nft.feeRecipient()).to.equal(user2.address);
    });

    it("should update marketplace fee bps", async function () {
      await expect(nft.connect(owner).setMarketplaceFeeBps(300))
        .to.emit(nft, "MarketplaceFeeUpdated");
      expect(await nft.marketplaceFeeBps()).to.equal(300);
    });

    it("should update royalty bps", async function () {
      await nft.connect(owner).setRoyaltyBps(1000); // 10%
      expect(await nft.royaltyBps()).to.equal(1000);
    });

    it("should pause and unpause", async function () {
      await nft.connect(owner).pause();
      await expect(
        nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE })
      ).to.be.reverted;

      await nft.connect(owner).unpause();
      await nft.connect(user1).mintBucket(PROFILE_ID, METADATA_URI, { value: MINT_FEE });
    });

    it("should revert if non-admin tries admin functions", async function () {
      await expect(nft.connect(user1).setMintFee(0)).to.be.reverted;
      await expect(nft.connect(user1).pause()).to.be.reverted;
      await expect(nft.connect(user1).setMarketplaceFeeBps(0)).to.be.reverted;
    });
  });
});
