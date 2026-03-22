import { expect } from "chai";
import { ethers } from "hardhat";
import { ContextRegistry, PluralityMemoryNFT } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ContextRegistry", function () {
  let nft: PluralityMemoryNFT;
  let registry: ContextRegistry;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const MINT_FEE = ethers.parseEther("0.01");
  const PROFILE_ID = "0x550e8400e29b41d4a716446655440000" as `0x${string}`;
  const CONTEXT_ID = "0x660e8400e29b41d4a716446655440001" as `0x${string}`;
  const CONTEXT_ID_2 = "0x770e8400e29b41d4a716446655440002" as `0x${string}`;
  const CONTENT_HASH = ethers.keccak256(ethers.toUtf8Bytes("Hello, this is my document content"));
  const CONTENT_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("Another document"));
  const METADATA_URI = "ipfs://QmContextMetadata123";
  const BUCKET_METADATA = "ipfs://QmBucketMetadata";

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy NFT contract first
    const NFTFactory = await ethers.getContractFactory("PluralityMemoryNFT");
    nft = await NFTFactory.deploy(owner.address, MINT_FEE, 500, 250);
    await nft.waitForDeployment();

    // Deploy Registry
    const RegistryFactory = await ethers.getContractFactory("ContextRegistry");
    registry = await RegistryFactory.deploy(await nft.getAddress());
    await registry.waitForDeployment();

    // Mint a bucket for testing
    await nft.connect(user1).mintBucket(PROFILE_ID, BUCKET_METADATA, { value: MINT_FEE });
  });

  describe("Deployment", function () {
    it("should set correct NFT address", async function () {
      expect(await registry.memoryNFT()).to.equal(await nft.getAddress());
    });

    it("should grant admin and registrar roles to deployer", async function () {
      const adminRole = await registry.DEFAULT_ADMIN_ROLE();
      const registrarRole = await registry.REGISTRAR_ROLE();
      expect(await registry.hasRole(adminRole, owner.address)).to.be.true;
      expect(await registry.hasRole(registrarRole, owner.address)).to.be.true;
    });
  });

  describe("Context Registration", function () {
    it("should register a context", async function () {
      await expect(
        registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI)
      )
        .to.emit(registry, "ContextRegistered")
        .withArgs(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI, owner.address, (v: any) => true);

      expect(await registry.totalRegistered()).to.equal(1);
    });

    it("should store correct context data", async function () {
      await registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI);

      const entry = await registry.getContext(CONTEXT_ID);
      expect(entry.contentHash).to.equal(CONTENT_HASH);
      expect(entry.metadataURI).to.equal(METADATA_URI);
      expect(entry.registeredBy).to.equal(owner.address);
      expect(entry.bucketTokenId).to.equal(1);
      expect(entry.sourceType).to.equal("file");
      expect(entry.revoked).to.be.false;
    });

    it("should add to bucket contexts", async function () {
      await registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI);
      await registry.registerContext(CONTEXT_ID_2, 1, CONTENT_HASH_2, "chat", "ipfs://other");

      const ids = await registry.getBucketContextIds(1);
      expect(ids.length).to.equal(2);
      expect(await registry.getBucketContextCount(1)).to.equal(2);
    });

    it("should revert if context already registered", async function () {
      await registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI);

      await expect(
        registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI)
      ).to.be.revertedWith("Context already registered");
    });

    it("should revert if empty content hash", async function () {
      await expect(
        registry.registerContext(CONTEXT_ID, 1, ethers.ZeroHash, "file", METADATA_URI)
      ).to.be.revertedWith("Empty content hash");
    });

    it("should revert if non-registrar tries to register", async function () {
      await expect(
        registry.connect(user1).registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI)
      ).to.be.reverted;
    });
  });

  describe("Verification", function () {
    beforeEach(async function () {
      await registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI);
    });

    it("should verify correct content hash", async function () {
      expect(await registry.verifyContent(CONTEXT_ID, CONTENT_HASH)).to.be.true;
    });

    it("should reject incorrect content hash", async function () {
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("tampered content"));
      expect(await registry.verifyContent(CONTEXT_ID, wrongHash)).to.be.false;
    });

    it("should reject verification of non-existent context", async function () {
      expect(await registry.verifyContent(CONTEXT_ID_2, CONTENT_HASH)).to.be.false;
    });

    it("should reject verification of revoked context", async function () {
      await registry.revokeContext(CONTEXT_ID);
      expect(await registry.verifyContent(CONTEXT_ID, CONTENT_HASH)).to.be.false;
    });
  });

  describe("Provenance Lookup", function () {
    it("should look up provenance by hash", async function () {
      await registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI);

      const [contextId, registeredAt, registeredBy, bucketTokenId] =
        await registry.getProvenanceByHash(CONTENT_HASH);

      expect(contextId).to.equal(CONTEXT_ID);
      expect(registeredBy).to.equal(owner.address);
      expect(bucketTokenId).to.equal(1);
      expect(registeredAt).to.be.greaterThan(0);
    });
  });

  describe("Revocation", function () {
    beforeEach(async function () {
      await registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI);
    });

    it("should revoke a context", async function () {
      await expect(registry.revokeContext(CONTEXT_ID))
        .to.emit(registry, "ContextRevoked")
        .withArgs(CONTEXT_ID, 1, owner.address, (v: any) => true);

      const entry = await registry.getContext(CONTEXT_ID);
      expect(entry.revoked).to.be.true;
    });

    it("should revert if already revoked", async function () {
      await registry.revokeContext(CONTEXT_ID);
      await expect(registry.revokeContext(CONTEXT_ID)).to.be.revertedWith("Already revoked");
    });

    it("should revert if context not found", async function () {
      await expect(registry.revokeContext(CONTEXT_ID_2)).to.be.revertedWith("Context not found");
    });
  });

  describe("Metadata Update", function () {
    beforeEach(async function () {
      await registry.registerContext(CONTEXT_ID, 1, CONTENT_HASH, "file", METADATA_URI);
    });

    it("should update metadata URI", async function () {
      const newURI = "ipfs://QmUpdatedMetadata";
      await expect(registry.updateContextMetadata(CONTEXT_ID, newURI))
        .to.emit(registry, "ContextMetadataUpdated")
        .withArgs(CONTEXT_ID, METADATA_URI, newURI, (v: any) => true);

      const entry = await registry.getContext(CONTEXT_ID);
      expect(entry.metadataURI).to.equal(newURI);
    });

    it("should revert update on revoked context", async function () {
      await registry.revokeContext(CONTEXT_ID);
      await expect(
        registry.updateContextMetadata(CONTEXT_ID, "ipfs://new")
      ).to.be.revertedWith("Context revoked");
    });
  });
});
