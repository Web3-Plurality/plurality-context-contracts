import { expect } from "chai";
import { ethers } from "hardhat";
import { PluralityMemoryNFT, ContextRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("PluralityMemoryNFT — register-first mint", function () {
  let nft: PluralityMemoryNFT;
  let registry: ContextRegistry;
  let owner: SignerWithAddress;       // deployer = platform admin
  let user1: SignerWithAddress;       // bucket creator
  let user2: SignerWithAddress;       // buyer / other
  let platformWallet: SignerWithAddress; // feeRecipient

  const MINT_FEE = ethers.parseEther("0.01");
  const ROYALTY_BPS = 500;
  const MARKETPLACE_FEE_BPS = 250;

  const BUCKET_HASH = "0x550e8400e29b41d4a716446655440000550e8400e29b41d4a716446655440000" as `0x${string}`;
  const BUCKET_HASH_2 = "0x660e8400e29b41d4a716446655440000660e8400e29b41d4a716446655440000" as `0x${string}`;

  const CTX1 = "0x11111111111111111111111111111111" as `0x${string}`;
  const CTX2 = "0x22222222222222222222222222222222" as `0x${string}`;
  const HASH1 = ethers.keccak256(ethers.toUtf8Bytes("doc one"));
  const HASH2 = ethers.keccak256(ethers.toUtf8Bytes("doc two"));

  const METADATA_URI = "https://api.plurality.network/blockchain/metadata/bucket/test";

  // Helper — register a fresh bucketHash for a given signer so mint can succeed.
  async function registerOne(
    signer: SignerWithAddress,
    bucketHash: `0x${string}`,
    ctx: `0x${string}` = CTX1,
    hash: `0x${string}` | string = HASH1,
  ) {
    await registry
      .connect(signer)
      .registerContextBatch(bucketHash, [ctx], [hash], ["ipfs://a"], ["file"]);
  }

  beforeEach(async function () {
    [owner, user1, user2, platformWallet] = await ethers.getSigners();

    // Registry must exist before the NFT can reference it.
    const Registry = await ethers.getContractFactory("ContextRegistry");
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    const Factory = await ethers.getContractFactory("PluralityMemoryNFT");
    nft = await Factory.deploy(
      await registry.getAddress(),
      platformWallet.address,
      MINT_FEE,
      ROYALTY_BPS,
      MARKETPLACE_FEE_BPS,
    );
    await nft.waitForDeployment();
  });

  describe("Deployment", function () {
    it("stores the registry address", async function () {
      expect(await nft.registry()).to.equal(await registry.getAddress());
    });

    it("sets the fee recipient", async function () {
      expect(await nft.feeRecipient()).to.equal(platformWallet.address);
    });

    it("sets the mint fee", async function () {
      expect(await nft.mintFee()).to.equal(MINT_FEE);
    });
  });

  describe("mintBucket — register-first enforcement", function () {
    it("mints when caller has registered contexts under the bucketHash", async function () {
      await registerOne(user1, BUCKET_HASH);

      await expect(
        nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE }),
      )
        .to.emit(nft, "BucketMinted")
        .withArgs(1, user1.address, BUCKET_HASH, METADATA_URI, (v: any) => true);

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      expect(await nft.tokenToBucketHash(1)).to.equal(BUCKET_HASH);
    });

    it("reverts when no one has registered the bucketHash", async function () {
      await expect(
        nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE }),
      ).to.be.revertedWith("Register contexts first");
    });

    it("reverts when a different wallet registered the bucketHash", async function () {
      await registerOne(user2, BUCKET_HASH);

      await expect(
        nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE }),
      ).to.be.revertedWith("Register contexts first");
    });

    it("reverts on insufficient mint fee even after registration", async function () {
      await registerOne(user1, BUCKET_HASH);

      await expect(
        nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: 0 }),
      ).to.be.revertedWith("Insufficient mint fee");
    });

    it("reverts on empty bucketHash (caught before registry check)", async function () {
      await expect(
        nft.connect(user1).mintBucket(ethers.ZeroHash, METADATA_URI, { value: MINT_FEE }),
      ).to.be.revertedWith("Empty bucket hash");
    });

    it("reverts on empty metadataURI", async function () {
      await registerOne(user1, BUCKET_HASH);

      await expect(
        nft.connect(user1).mintBucket(BUCKET_HASH, "", { value: MINT_FEE }),
      ).to.be.revertedWith("Empty metadata URI");
    });

    it("forwards mint fee to platform directly (hot-path push)", async function () {
      await registerOne(user1, BUCKET_HASH);

      const before = await ethers.provider.getBalance(platformWallet.address);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
      const after = await ethers.provider.getBalance(platformWallet.address);

      expect(after - before).to.equal(MINT_FEE);
      // Hybrid: hot-path success leaves nothing in pendingWithdrawals.
      expect(await nft.pendingWithdrawals(platformWallet.address)).to.equal(0n);
    });

    it("refunds mint-fee overpayment to the minter directly", async function () {
      await registerOne(user1, BUCKET_HASH);
      const overpay = MINT_FEE * 3n;

      const before = await ethers.provider.getBalance(user1.address);
      const tx = await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: overpay });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(user1.address);

      // Minter spent: gas + mintFee (the excess is refunded immediately).
      expect(before - after).to.equal(MINT_FEE + gas);
      expect(await nft.pendingWithdrawals(user1.address)).to.equal(0n);
    });

    it("rejects a second mint of the same bucketHash (audit M-NFT-6)", async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
      await expect(
        nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE }),
      ).to.be.revertedWith("Bucket already minted");
    });

    it("increments token IDs across mints", async function () {
      await registerOne(user1, BUCKET_HASH, CTX1, HASH1);
      await registerOne(user2, BUCKET_HASH_2, CTX2, HASH2);

      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user2).mintBucket(BUCKET_HASH_2, "https://other", { value: MINT_FEE });

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      expect(await nft.balanceOf(user2.address, 2)).to.equal(1);
      expect(await nft.tokenToBucketHash(1)).to.equal(BUCKET_HASH);
      expect(await nft.tokenToBucketHash(2)).to.equal(BUCKET_HASH_2);
    });
  });

  describe("Royalties (ERC-2981) — to platform", function () {
    it("returns the platform as royalty receiver", async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });

      const salePrice = ethers.parseEther("1");
      const [receiver, amount] = await nft.royaltyInfo(1, salePrice);
      expect(receiver).to.equal(platformWallet.address);
      expect(amount).to.equal((salePrice * BigInt(ROYALTY_BPS)) / 10000n);
    });
  });

  describe("Marketplace", function () {
    beforeEach(async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user1).setApprovalForAll(await nft.getAddress(), true);
    });

    it("lists a bucket for sale and snapshots the current marketplace fee", async function () {
      const price = ethers.parseEther("1");
      await expect(nft.connect(user1).listBucket(1, price))
        .to.emit(nft, "BucketListed")
        .withArgs(1, user1.address, price, MARKETPLACE_FEE_BPS, (v: any) => true);

      const [seller, listedPrice, feeBpsAtList, active] = await nft.getListing(1);
      expect(seller).to.equal(user1.address);
      expect(listedPrice).to.equal(price);
      expect(feeBpsAtList).to.equal(MARKETPLACE_FEE_BPS);
      expect(active).to.equal(true);
    });

    it("uses the snapshot fee even if the admin changes marketplaceFeeBps after listing (audit M-NFT-4)", async function () {
      const price = ethers.parseEther("1");
      await nft.connect(user1).listBucket(1, price);

      // Admin doubles the marketplace fee after the listing was created.
      await nft.connect(owner).setMarketplaceFeeBps(MARKETPLACE_FEE_BPS * 2);

      const oldFee = (price * BigInt(MARKETPLACE_FEE_BPS)) / 10000n;
      const expectedSellerProceeds = price - oldFee;

      const sellerBefore = await ethers.provider.getBalance(user1.address);
      const platformBefore = await ethers.provider.getBalance(platformWallet.address);
      await nft.connect(user2).buyBucket(1, { value: price });
      const sellerAfter = await ethers.provider.getBalance(user1.address);
      const platformAfter = await ethers.provider.getBalance(platformWallet.address);

      // Both push payments succeed in the EOA case — settle using the
      // snapshot fee, not the new (higher) admin value.
      expect(sellerAfter - sellerBefore).to.equal(expectedSellerProceeds);
      expect(platformAfter - platformBefore).to.equal(oldFee);
    });

    it("falls back to pendingWithdrawals when the seller rejects the direct push (audit H-NFT-2)", async function () {
      // Deploy a contract that holds NFTs but reverts on ROSE receive.
      const Reverting = await ethers.getContractFactory("RevertingReceiver");
      const seller = await Reverting.deploy();
      await seller.waitForDeployment();
      const sellerAddr = await seller.getAddress();

      // user1 already minted tokenId=1 in the parent beforeEach + approved.
      // Transfer the NFT to the reverting contract, then approve + list from it.
      await nft.connect(user1).safeTransferFrom(user1.address, sellerAddr, 1, 1, "0x");

      const approveData = nft.interface.encodeFunctionData("setApprovalForAll", [
        await nft.getAddress(),
        true,
      ]);
      await seller.execute(await nft.getAddress(), approveData);

      const listData = nft.interface.encodeFunctionData("listBucket", [
        1,
        ethers.parseEther("1"),
      ]);
      await seller.execute(await nft.getAddress(), listData);

      // Buyer purchases — direct push to the reverting seller must fail and
      // credit pendingWithdrawals instead.
      const sellerProceeds =
        ethers.parseEther("1") - (ethers.parseEther("1") * BigInt(MARKETPLACE_FEE_BPS)) / 10000n;

      await nft.connect(user2).buyBucket(1, { value: ethers.parseEther("1") });

      // The NFT moved to the buyer despite the push failure.
      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
      expect(await nft.balanceOf(sellerAddr, 1)).to.equal(0);

      // Seller proceeds landed in pendingWithdrawals (push fallback).
      expect(await nft.pendingWithdrawals(sellerAddr)).to.equal(sellerProceeds);
    });

    it("auto-clears a listing when seller transfers the NFT off-marketplace (audit H-NFT-1)", async function () {
      await nft.connect(user1).listBucket(1, ethers.parseEther("1"));

      // Seller transfers directly, bypassing buyBucket.
      await nft.connect(user1).safeTransferFrom(user1.address, user2.address, 1, 1, "0x");

      const [, , , active] = await nft.getListing(1);
      expect(active).to.equal(false);

      // The new holder can list it themselves now.
      await nft.connect(user2).setApprovalForAll(await nft.getAddress(), true);
      await expect(nft.connect(user2).listBucket(1, ethers.parseEther("2"))).to.emit(
        nft,
        "BucketListed",
      );
    });

    it("reverts list when caller doesn't hold the token", async function () {
      await expect(
        nft.connect(user2).listBucket(1, ethers.parseEther("1")),
      ).to.be.revertedWith("Not token holder");
    });

    it("delists by seller", async function () {
      await nft.connect(user1).listBucket(1, ethers.parseEther("1"));
      await expect(nft.connect(user1).delistBucket(1)).to.emit(nft, "BucketDelisted");
    });

    describe("Buying", function () {
      const SALE_PRICE = ethers.parseEther("1");

      beforeEach(async function () {
        await nft.connect(user1).listBucket(1, SALE_PRICE);
      });

      it("transfers NFT and pays seller minus platform fee (hot-path push)", async function () {
        const expectedFee = (SALE_PRICE * BigInt(MARKETPLACE_FEE_BPS)) / 10000n;
        const expectedSellerProceeds = SALE_PRICE - expectedFee;

        const sellerBefore = await ethers.provider.getBalance(user1.address);
        const platformBefore = await ethers.provider.getBalance(platformWallet.address);

        await nft.connect(user2).buyBucket(1, { value: SALE_PRICE });

        // NFT transferred
        expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
        expect(await nft.balanceOf(user1.address, 1)).to.equal(0);

        // Direct send succeeded for EOAs — funds land in their wallets immediately.
        expect(await ethers.provider.getBalance(user1.address) - sellerBefore).to.equal(expectedSellerProceeds);
        expect(await ethers.provider.getBalance(platformWallet.address) - platformBefore).to.equal(expectedFee);

        // No pull-payment balances need claiming.
        expect(await nft.pendingWithdrawals(user1.address)).to.equal(0n);
      });

      it("reverts if seller tries to buy own listing", async function () {
        await expect(
          nft.connect(user1).buyBucket(1, { value: SALE_PRICE }),
        ).to.be.revertedWith("Cannot buy own listing");
      });

      it("refunds excess payment to buyer immediately (hot-path push)", async function () {
        const overpay = ethers.parseEther("2");
        const buyerBefore = await ethers.provider.getBalance(user2.address);

        const tx = await nft.connect(user2).buyBucket(1, { value: overpay });
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

        const buyerAfter = await ethers.provider.getBalance(user2.address);
        // Net buyer cost = SALE_PRICE + gas (excess was refunded synchronously).
        expect(buyerBefore - buyerAfter).to.equal(SALE_PRICE + gasUsed);
        expect(await nft.pendingWithdrawals(user2.address)).to.equal(0n);
      });
    });
  });

  describe("Owner enumeration views — backend permission anchor", function () {
    it("getTokensByOwner reflects mints + transfers", async function () {
      await registerOne(user1, BUCKET_HASH, CTX1, HASH1);
      await registerOne(user1, BUCKET_HASH_2, CTX2, HASH2);

      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user1).mintBucket(BUCKET_HASH_2, "https://other", { value: MINT_FEE });

      const owned = await nft.getTokensByOwner(user1.address);
      expect(owned.length).to.equal(2);
    });

    it("getBucketHashesByOwner is the canonical access query", async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });

      const hashes = await nft.getBucketHashesByOwner(user1.address);
      expect(hashes).to.deep.equal([BUCKET_HASH]);
    });

    it("buyer gains the bucketHash, seller loses it", async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
      await nft.connect(user1).setApprovalForAll(await nft.getAddress(), true);
      await nft.connect(user1).listBucket(1, ethers.parseEther("1"));
      await nft.connect(user2).buyBucket(1, { value: ethers.parseEther("1") });

      expect((await nft.getBucketHashesByOwner(user1.address)).length).to.equal(0);
      const u2 = await nft.getBucketHashesByOwner(user2.address);
      expect(u2).to.deep.equal([BUCKET_HASH]);
    });
  });

  describe("Metadata", function () {
    it("token holder updates metadata", async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });

      const newURI = "https://api.plurality.network/blockchain/metadata/bucket/updated";
      await expect(nft.connect(user1).updateMetadata(1, newURI)).to.emit(nft, "MetadataUpdated");
      expect(await nft.uri(1)).to.equal(newURI);
    });

    it("reverts if non-holder tries to update", async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });

      await expect(
        nft.connect(user2).updateMetadata(1, "hacker"),
      ).to.be.revertedWith("Not token holder");
    });
  });

  describe("Admin", function () {
    it("admin updates mint fee", async function () {
      const newFee = ethers.parseEther("0.05");
      await expect(nft.connect(owner).setMintFee(newFee)).to.emit(nft, "MintFeeUpdated");
      expect(await nft.mintFee()).to.equal(newFee);
    });

    it("admin pauses + unpauses minting", async function () {
      await registerOne(user1, BUCKET_HASH);
      await nft.connect(owner).pause();
      await expect(
        nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE }),
      ).to.be.reverted;
      await nft.connect(owner).unpause();
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
    });

    it("non-admin can't call admin functions", async function () {
      await expect(nft.connect(user1).setMintFee(0)).to.be.reverted;
      await expect(nft.connect(user1).pause()).to.be.reverted;
    });
  });
});
