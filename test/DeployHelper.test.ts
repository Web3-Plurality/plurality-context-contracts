import { expect } from "chai";
import { ethers } from "hardhat";
import {
  DeployHelper,
  ContextRegistry,
  PluralityMemoryNFT,
  ReputationRegistry,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("DeployHelper — atomic 3-contract deploy (audit v4 COMP-H-1)", function () {
  let admin: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let other: SignerWithAddress;

  const MINT_FEE = ethers.parseEther("0.01");
  const ROYALTY_BPS = 500;
  const MARKETPLACE_FEE_BPS = 250;

  beforeEach(async function () {
    [admin, feeRecipient, other] = await ethers.getSigners();
  });

  it("deploys CR + NFT + Rep atomically with valid cross-references", async function () {
    const Factory = await ethers.getContractFactory("DeployHelper");
    const helper = (await Factory.deploy(
      admin.address,
      feeRecipient.address,
      MINT_FEE,
      ROYALTY_BPS,
      MARKETPLACE_FEE_BPS,
    )) as DeployHelper;
    await helper.waitForDeployment();

    const crAddr = await helper.contextRegistry();
    const nftAddr = await helper.nft();
    const repAddr = await helper.reputation();

    expect(crAddr).to.not.equal(ethers.ZeroAddress);
    expect(nftAddr).to.not.equal(ethers.ZeroAddress);
    expect(repAddr).to.not.equal(ethers.ZeroAddress);

    const cr = (await ethers.getContractAt("ContextRegistry", crAddr)) as ContextRegistry;
    const nft = (await ethers.getContractAt("PluralityMemoryNFT", nftAddr)) as PluralityMemoryNFT;
    const rep = (await ethers.getContractAt("ReputationRegistry", repAddr)) as ReputationRegistry;

    // CR↔NFT wired.
    expect(await cr.nftRegistry()).to.equal(nftAddr);

    // NFT references CR.
    expect(await nft.registry()).to.equal(crAddr);

    // Rep references NFT.
    expect(await rep.getIdentityRegistry()).to.equal(nftAddr);

    // Helper relinquished privilege: even if someone impersonated the helper
    // address (which IS the CR's `deployer`), the one-shot flag would block
    // any re-wire attempt — "Already set" runs before the EOA-check probe.
    const helperAddr = await helper.getAddress();
    const helperAsSigner = await ethers.getImpersonatedSigner(helperAddr);
    await ethers.provider.send("hardhat_setBalance", [
      helperAddr,
      "0x" + ethers.parseEther("1").toString(16),
    ]);
    await expect(cr.connect(helperAsSigner).setNftRegistry(other.address)).to.be.revertedWith(
      "Already set",
    );
  });

  it("admin role on the NFT belongs to the supplied admin, NOT the helper", async function () {
    const Factory = await ethers.getContractFactory("DeployHelper");
    const helper = (await Factory.deploy(
      admin.address,
      feeRecipient.address,
      MINT_FEE,
      ROYALTY_BPS,
      MARKETPLACE_FEE_BPS,
    )) as DeployHelper;
    await helper.waitForDeployment();

    const nft = (await ethers.getContractAt(
      "PluralityMemoryNFT",
      await helper.nft(),
    )) as PluralityMemoryNFT;

    const ADMIN_ROLE = await nft.DEFAULT_ADMIN_ROLE();
    expect(await nft.hasRole(ADMIN_ROLE, admin.address)).to.equal(true);
    expect(await nft.hasRole(ADMIN_ROLE, await helper.getAddress())).to.equal(false);
  });

  it("post-deploy versions match v5", async function () {
    const Factory = await ethers.getContractFactory("DeployHelper");
    const helper = (await Factory.deploy(
      admin.address,
      feeRecipient.address,
      MINT_FEE,
      ROYALTY_BPS,
      MARKETPLACE_FEE_BPS,
    )) as DeployHelper;
    await helper.waitForDeployment();

    const cr = (await ethers.getContractAt(
      "ContextRegistry",
      await helper.contextRegistry(),
    )) as ContextRegistry;
    const nft = (await ethers.getContractAt(
      "PluralityMemoryNFT",
      await helper.nft(),
    )) as PluralityMemoryNFT;
    const rep = (await ethers.getContractAt(
      "ReputationRegistry",
      await helper.reputation(),
    )) as ReputationRegistry;

    expect(await cr.VERSION()).to.equal("ContextRegistry/v5");
    expect(await nft.VERSION()).to.equal("PluralityMemoryNFT/v5");
    expect(await rep.VERSION()).to.equal("ReputationRegistry/v5");
  });
});
