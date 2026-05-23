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

    it("forwards mint fee to platform", async function () {
      await registerOne(user1, BUCKET_HASH);

      const before = await ethers.provider.getBalance(platformWallet.address);
      await nft.connect(user1).mintBucket(BUCKET_HASH, METADATA_URI, { value: MINT_FEE });
      const after = await ethers.provider.getBalance(platformWallet.address);

      expect(after - before).to.equal(MINT_FEE);
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

    it("lists a bucket for sale", async function () {
      const price = ethers.parseEther("1");
      await expect(nft.connect(user1).listBucket(1, price))
        .to.emit(nft, "BucketListed")
        .withArgs(1, user1.address, price, (v: any) => true);
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

      it("transfers NFT and pays seller minus platform fee", async function () {
        const platformBefore = await ethers.provider.getBalance(platformWallet.address);
        const sellerBefore = await ethers.provider.getBalance(user1.address);

        await nft.connect(user2).buyBucket(1, { value: SALE_PRICE });

        expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
        expect(await nft.balanceOf(user1.address, 1)).to.equal(0);

        const platformAfter = await ethers.provider.getBalance(platformWallet.address);
        const sellerAfter = await ethers.provider.getBalance(user1.address);

        const expectedFee = (SALE_PRICE * BigInt(MARKETPLACE_FEE_BPS)) / 10000n;
        expect(platformAfter - platformBefore).to.equal(expectedFee);
        expect(sellerAfter - sellerBefore).to.equal(SALE_PRICE - expectedFee);
      });

      it("reverts if seller tries to buy own listing", async function () {
        await expect(
          nft.connect(user1).buyBucket(1, { value: SALE_PRICE }),
        ).to.be.revertedWith("Cannot buy own listing");
      });

      it("refunds excess payment", async function () {
        const overpay = ethers.parseEther("2");
        const buyerBefore = await ethers.provider.getBalance(user2.address);

        const tx = await nft.connect(user2).buyBucket(1, { value: overpay });
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

        const buyerAfter = await ethers.provider.getBalance(user2.address);
        expect(buyerBefore - buyerAfter).to.equal(SALE_PRICE + gasUsed);
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
