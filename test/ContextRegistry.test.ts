import { expect } from "chai";
import { ethers } from "hardhat";
import { ContextRegistry } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ContextRegistry — append-only, batch-only, registrant-claim", function () {
  let registry: ContextRegistry;
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;       // bucket creator
  let bob: SignerWithAddress;         // unrelated wallet

  const BUCKET_HASH = "0x550e8400e29b41d4a716446655440000550e8400e29b41d4a716446655440000" as `0x${string}`;
  const BUCKET_HASH_2 = "0x660e8400e29b41d4a716446655440000660e8400e29b41d4a716446655440000" as `0x${string}`;

  const CTX1 = "0x11111111111111111111111111111111" as `0x${string}`;
  const CTX2 = "0x22222222222222222222222222222222" as `0x${string}`;
  const CTX3 = "0x33333333333333333333333333333333" as `0x${string}`;

  const HASH1 = ethers.keccak256(ethers.toUtf8Bytes("doc one"));
  const HASH2 = ethers.keccak256(ethers.toUtf8Bytes("doc two"));
  const HASH3 = ethers.keccak256(ethers.toUtf8Bytes("doc three"));

  const URI1 = "ipfs://one";
  const URI2 = "ipfs://two";
  const URI3 = "ipfs://three";

  beforeEach(async function () {
    [admin, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ContextRegistry");
    registry = await Factory.deploy();
    await registry.waitForDeployment();
  });

  describe("Deployment", function () {
    it("starts with zero registrations", async function () {
      expect(await registry.totalRegistered()).to.equal(0);
    });

    it("returns zero address for an unclaimed bucketHash", async function () {
      expect(await registry.getBucketRegistrant(BUCKET_HASH)).to.equal(ethers.ZeroAddress);
    });

    it("exposes audit-set caps as public constants", async function () {
      expect(await registry.MAX_BATCH_SIZE()).to.equal(256n);
      expect(await registry.MAX_CONTEXTS_PER_BUCKET()).to.equal(1024n);
    });

    it("exposes the v5 version stamp", async function () {
      expect(await registry.VERSION()).to.equal("ContextRegistry/v5");
    });
  });

  describe("registerContextBatch — happy path", function () {
    it("registers contexts and claims the bucketHash", async function () {
      await expect(
        registry.connect(alice).registerContextBatch(
          BUCKET_HASH,
          [CTX1, CTX2],
          [HASH1, HASH2],
          [URI1, URI2],
          ["file", "chat"],
        ),
      )
        .to.emit(registry, "BucketRegistrantClaimed").withArgs(BUCKET_HASH, alice.address, (v: any) => true)
        .and.to.emit(registry, "ContextRegistered"); // fires twice

      expect(await registry.totalRegistered()).to.equal(2);
      expect(await registry.getBucketRegistrant(BUCKET_HASH)).to.equal(alice.address);
      expect(await registry.getBucketContextCount(BUCKET_HASH)).to.equal(2);
    });

    it("stores the correct entry fields", async function () {
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);

      const entry = await registry.getContext(CTX1);
      expect(entry.contentHash).to.equal(HASH1);
      expect(entry.bucketHash).to.equal(BUCKET_HASH);
      expect(entry.registeredBy).to.equal(alice.address);
      expect(entry.metadataURI).to.equal(URI1);
      expect(entry.sourceType).to.equal("file");
      expect(entry.registeredAt).to.be.greaterThan(0);
    });

    it("populates the bucketHash → contextIds list", async function () {
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1, CTX2], [HASH1, HASH2], [URI1, URI2], ["file", "chat"]);

      const ids = await registry.getContextsByBucketHash(BUCKET_HASH);
      expect(ids).to.deep.equal([CTX1, CTX2]);
    });

    it("lets the same registrant extend a bucket they already claimed", async function () {
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX2], [HASH2], [URI2], ["chat"]);

      expect(await registry.getBucketContextCount(BUCKET_HASH)).to.equal(2);
    });
  });

  describe("registerContextBatch — claim enforcement", function () {
    it("reverts when a different wallet tries to register under a claimed bucketHash", async function () {
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);

      await expect(
        registry
          .connect(bob)
          .registerContextBatch(BUCKET_HASH, [CTX2], [HASH2], [URI2], ["chat"]),
      ).to.be.revertedWith("Bucket claimed by another wallet");
    });

    it("allows different wallets to register under different bucketHashes", async function () {
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);
      await registry
        .connect(bob)
        .registerContextBatch(BUCKET_HASH_2, [CTX2], [HASH2], [URI2], ["chat"]);

      expect(await registry.getBucketRegistrant(BUCKET_HASH)).to.equal(alice.address);
      expect(await registry.getBucketRegistrant(BUCKET_HASH_2)).to.equal(bob.address);
    });
  });

  describe("registerContextBatch — input validation", function () {
    it("reverts on empty batch", async function () {
      await expect(
        registry.connect(alice).registerContextBatch(BUCKET_HASH, [], [], [], []),
      ).to.be.revertedWith("Empty batch");
    });

    it("reverts on zero bucketHash", async function () {
      await expect(
        registry
          .connect(alice)
          .registerContextBatch(ethers.ZeroHash, [CTX1], [HASH1], [URI1], ["file"]),
      ).to.be.revertedWith("Empty bucket hash");
    });

    it("reverts on length mismatch", async function () {
      await expect(
        registry
          .connect(alice)
          .registerContextBatch(BUCKET_HASH, [CTX1, CTX2], [HASH1], [URI1, URI2], ["file", "chat"]),
      ).to.be.revertedWith("Length mismatch");
    });

    it("reverts on duplicate contextId across calls (entire tx reverts)", async function () {
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);

      await expect(
        registry
          .connect(alice)
          .registerContextBatch(BUCKET_HASH, [CTX1], [HASH2], [URI2], ["chat"]),
      ).to.be.revertedWith("Context already registered");
    });

    it("reverts on zero contentHash", async function () {
      await expect(
        registry
          .connect(alice)
          .registerContextBatch(BUCKET_HASH, [CTX1], [ethers.ZeroHash], [URI1], ["file"]),
      ).to.be.revertedWith("Empty content hash");
    });

    it("is atomic — one bad entry reverts the whole batch", async function () {
      // Pre-register CTX1
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);
      expect(await registry.totalRegistered()).to.equal(1);

      // Try to register [CTX2 (new), CTX1 (duplicate)] — should revert
      // entirely; CTX2 must NOT end up registered.
      await expect(
        registry
          .connect(alice)
          .registerContextBatch(
            BUCKET_HASH,
            [CTX2, CTX1],
            [HASH2, HASH1],
            [URI2, URI1],
            ["chat", "file"],
          ),
      ).to.be.revertedWith("Context already registered");

      expect(await registry.totalRegistered()).to.equal(1);
      const entry = await registry.getContext(CTX2);
      expect(entry.registeredAt).to.equal(0);
    });
  });

  describe("Verification + provenance", function () {
    beforeEach(async function () {
      await registry
        .connect(alice)
        .registerContextBatch(
          BUCKET_HASH,
          [CTX1, CTX2, CTX3],
          [HASH1, HASH2, HASH3],
          [URI1, URI2, URI3],
          ["file", "chat", "text"],
        );
    });

    it("verifies registered content", async function () {
      expect(await registry.verifyContent(CTX1, HASH1)).to.be.true;
    });

    it("rejects wrong content for a registered context", async function () {
      const wrong = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
      expect(await registry.verifyContent(CTX1, wrong)).to.be.false;
    });

    it("returns provenance for a known content hash", async function () {
      const [contextId, registeredAt, registeredBy, bucketHash] =
        await registry.getProvenanceByHash(HASH2);
      expect(contextId).to.equal(CTX2);
      expect(registeredBy).to.equal(alice.address);
      expect(bucketHash).to.equal(BUCKET_HASH);
      expect(registeredAt).to.be.greaterThan(0);
    });

    it("returns the full context list for a bucketHash", async function () {
      const ids = await registry.getContextsByBucketHash(BUCKET_HASH);
      expect(ids).to.deep.equal([CTX1, CTX2, CTX3]);
    });
  });

  describe("Audit hardening — first-writer-wins on hashToContext (H-CR-2)", function () {
    it("preserves the original (contextId, registrant, bucket) for a contentHash", async function () {
      // Alice registers HASH1 under bucket BUCKET_HASH with context CTX1.
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);

      // Bob registers the SAME HASH1 under a different bucket + contextId.
      await registry
        .connect(bob)
        .registerContextBatch(BUCKET_HASH_2, [CTX2], [HASH1], [URI2], ["file"]);

      // Reverse lookup must still return Alice's original record, not Bob's.
      const [cid, , registeredBy, bucketHash] = await registry.getProvenanceByHash(HASH1);
      expect(cid).to.equal(CTX1);
      expect(registeredBy).to.equal(alice.address);
      expect(bucketHash).to.equal(BUCKET_HASH);
    });
  });

  describe("Audit hardening — input caps", function () {
    it("rejects a batch larger than MAX_BATCH_SIZE", async function () {
      const oversize = 257;
      const ids = new Array(oversize).fill(0).map((_, i) => {
        const hex = i.toString(16).padStart(32, "0");
        return ("0x" + hex) as `0x${string}`;
      });
      const hashes = new Array(oversize).fill(0).map((_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`payload-${i}`)),
      );
      const uris = new Array(oversize).fill("ipfs://x");
      const sources = new Array(oversize).fill("file");
      await expect(
        registry.connect(alice).registerContextBatch(BUCKET_HASH, ids, hashes, uris, sources),
      ).to.be.revertedWith("Batch too large");
    });

    it("rejects a metadataURI longer than the cap", async function () {
      const longUri = "x".repeat(1025);
      await expect(
        registry
          .connect(alice)
          .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [longUri], ["file"]),
      ).to.be.revertedWith("URI too long");
    });

    it("rejects a sourceType longer than the cap", async function () {
      const longSource = "x".repeat(33);
      await expect(
        registry
          .connect(alice)
          .registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], [longSource]),
      ).to.be.revertedWith("sourceType too long");
    });
  });

  describe("v4 hardening — NFT wiring + post-mint freeze (audit v3 H-5)", function () {
    it("only the deployer can wire setNftRegistry", async function () {
      // v5 — probe requires a real contract address. Use the registry's own
      // address as a stand-in (it doesn't expose bucketHashToTokenId, so the
      // probe will revert, but this test only exercises the "Only deployer"
      // guard which runs before the probe).
      await expect(registry.connect(alice).setNftRegistry(alice.address)).to.be.revertedWith(
        "Only deployer",
      );
    });

    it("rejects zero address in setNftRegistry", async function () {
      await expect(registry.setNftRegistry(ethers.ZeroAddress)).to.be.revertedWith(
        "Invalid address",
      );
    });

    it("rejects an EOA in setNftRegistry (v5 CR-H-2 probe)", async function () {
      // An EOA has no code; the probe must reject before persisting state.
      await expect(registry.setNftRegistry(alice.address)).to.be.revertedWith(
        "Not a contract",
      );
    });

    it("can only be wired once", async function () {
      // Deploy a real NFT so the probe passes the first time.
      const MINT_FEE = ethers.parseEther("0.01");
      const NFT = await ethers.getContractFactory("PluralityMemoryNFT");
      const nft = await NFT.deploy(
        await registry.getAddress(),
        admin.address,
        admin.address,
        MINT_FEE,
        500,
        250,
      );
      await nft.waitForDeployment();

      await registry.setNftRegistry(await nft.getAddress());
      await expect(registry.setNftRegistry(await nft.getAddress())).to.be.revertedWith(
        "Already set",
      );
    });

    it("rejects context appends to bucketHashes that are already minted", async function () {
      // Deploy the full stack so we can simulate a mint.
      const Registry = await ethers.getContractFactory("ContextRegistry");
      const r = await Registry.deploy();
      await r.waitForDeployment();

      const MINT_FEE = ethers.parseEther("0.01");
      const NFT = await ethers.getContractFactory("PluralityMemoryNFT");
      const nft = await NFT.deploy(
        await r.getAddress(),
        admin.address,         // v5 — explicit admin
        admin.address,
        MINT_FEE,
        500,
        250,
      );
      await nft.waitForDeployment();
      await r.setNftRegistry(await nft.getAddress());

      // Alice registers + mints.
      await r.connect(alice).registerContextBatch(BUCKET_HASH, [CTX1], [HASH1], [URI1], ["file"]);
      await nft
        .connect(alice)
        .mintBucket(BUCKET_HASH, "https://example.com/bucket/1", { value: MINT_FEE });

      // Alice attempts to append a new context to the SAME bucketHash post-mint.
      // The freeze must reject — preventing orphan-context drift after sale.
      await expect(
        r.connect(alice).registerContextBatch(BUCKET_HASH, [CTX2], [HASH2], [URI2], ["chat"]),
      ).to.be.revertedWith("Bucket already minted");

      // Different bucketHash still works.
      await expect(
        r.connect(alice).registerContextBatch(BUCKET_HASH_2, [CTX3], [HASH3], [URI3], ["text"]),
      ).to.emit(r, "ContextRegistered");
    });

    it("contentHash is indexed in ContextRegistered (audit v3 M-8)", async function () {
      // Filter logs by contentHash should return only matching events.
      await registry
        .connect(alice)
        .registerContextBatch(BUCKET_HASH, [CTX1, CTX2], [HASH1, HASH2], [URI1, URI2], [
          "file",
          "chat",
        ]);

      const filter = registry.filters.ContextRegistered(undefined, undefined, HASH1);
      const events = await registry.queryFilter(filter, 0, "latest");
      expect(events.length).to.equal(1);
      expect(events[0].args.contextId).to.equal(CTX1);
    });
  });
});
