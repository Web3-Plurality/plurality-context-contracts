/**
 * Deployment script for the MARKET stack (Studio + C2C + BYOK Agent).
 *
 * Uses DeployHelper to deploy ContextRegistry + PluralityMemoryNFT +
 * ReputationRegistry ATOMICALLY in a single transaction (audit v4 COMP-H-1).
 * Without DeployHelper the three deploys + the CR.setNftRegistry call land
 * in separate blocks, leaving a mempool window where an attacker could
 * race the setter and permanently corrupt the post-mint freeze invariant.
 * With DeployHelper, everything lands in one tx — no window.
 *
 *  - Writes the resulting addresses to deployments.market.json (the canonical
 *    deployment record).
 *  - Copies the fresh ABIs to plurality-market-backend + plurality-market-place
 *    so both stay in sync with the deployed bytecode.
 *
 * Usage:
 *   1. Make sure DEPLOYER_PRIVATE_KEY in .env is funded with TEST ROSE on
 *      Sapphire testnet (https://faucet.testnet.oasis.io/).
 *   2. Run:
 *        npx hardhat run scripts/deploy-market.ts --network oasisSapphireTestnet
 *   3. After it finishes, copy the printed addresses into
 *      plurality-market-backend/.env:
 *        MEMORY_NFT_CONTRACT_ADDRESS=...
 *        CONTEXT_REGISTRY_ADDRESS=...
 *        REPUTATION_REGISTRY_ADDRESS=...
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("[market deploy] Deployer:", deployer.address);
  console.log("[market deploy] Balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Economic parameters: 0.01 ROSE mint fee, 5% royalty, 2.5% marketplace fee.
  const admin = deployer.address;
  const feeRecipient = deployer.address;
  const mintFee = ethers.parseEther("0.01");
  const royaltyBps = 500;
  const marketplaceFeeBps = 250;

  console.log("\n[market deploy] --- DeployHelper (atomic 3-contract deploy) ---");
  const Helper = await ethers.getContractFactory("DeployHelper");
  const helper = await Helper.deploy(
    admin,
    feeRecipient,
    mintFee,
    royaltyBps,
    marketplaceFeeBps,
  );
  await helper.waitForDeployment();
  console.log("[market deploy] DeployHelper:", await helper.getAddress());

  // Read the three deployed addresses straight off the helper's immutable
  // state — they were set inside the helper's constructor, so they're
  // already available now.
  const registryAddress = await helper.contextRegistry();
  const memoryNFTAddress = await helper.nft();
  const reputationAddress = await helper.reputation();

  console.log("[market deploy] ContextRegistry:    ", registryAddress);
  console.log("[market deploy] PluralityMemoryNFT: ", memoryNFTAddress);
  console.log("[market deploy] ReputationRegistry: ", reputationAddress);

  // Sanity-check post-deploy invariants (cheap; catches a borked helper before
  // anyone trusts these addresses).
  const cr = await ethers.getContractAt("ContextRegistry", registryAddress);
  const nft = await ethers.getContractAt("PluralityMemoryNFT", memoryNFTAddress);
  const rep = await ethers.getContractAt("ReputationRegistry", reputationAddress);

  const wiredNft = await cr.nftRegistry();
  if (wiredNft.toLowerCase() !== memoryNFTAddress.toLowerCase()) {
    throw new Error(`CR.nftRegistry mismatch: ${wiredNft} vs ${memoryNFTAddress}`);
  }
  const adminRoleHolder = await nft.hasRole(await nft.DEFAULT_ADMIN_ROLE(), admin);
  if (!adminRoleHolder) {
    throw new Error(`NFT admin role not granted to ${admin}`);
  }
  console.log("[market deploy] Post-deploy invariants OK (CR↔NFT wired, NFT admin = deployer)");

  // Version stamps — informational. Wrapped because Sapphire view-calls
  // can return a transient "invalid code" error right after deploy as the
  // node propagates the bytecode; the addresses + invariants above are
  // what matters and have already been confirmed.
  const safeVersion = async (label: string, fn: () => Promise<string>) => {
    try {
      console.log(`  ${label}:`, await fn());
    } catch (e: any) {
      console.log(`  ${label}: <view call deferred — ${e?.shortMessage || e?.message || "rpc"}>`);
    }
  };
  console.log("[market deploy] Versions:");
  await safeVersion("CR.VERSION ", () => cr.VERSION());
  await safeVersion("NFT.VERSION", () => nft.VERSION());
  await safeVersion("Rep.VERSION", () => rep.VERSION());

  const safeVersionStr = async (fn: () => Promise<string>): Promise<string> => {
    try { return await fn(); } catch { return "<deferred>"; }
  };

  const deployment = {
    stack: "market",
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    helper: await helper.getAddress(),
    contracts: {
      ContextRegistry: {
        address: registryAddress,
        version: await safeVersionStr(() => cr.VERSION()),
      },
      PluralityMemoryNFT: {
        address: memoryNFTAddress,
        version: await safeVersionStr(() => nft.VERSION()),
        registry: registryAddress,
        admin,
        mintFee: mintFee.toString(),
        feeRecipient,
        royaltyBps,
        marketplaceFeeBps,
      },
      ReputationRegistry: {
        address: reputationAddress,
        version: await safeVersionStr(() => rep.VERSION()),
        nft: memoryNFTAddress,
      },
    },
    deployedAt: new Date().toISOString(),
  };

  // Canonical deployment record for the market stack.
  const outputPath = path.join(__dirname, "..", "deployments.market.json");
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));
  console.log("\n[market deploy] Saved:", outputPath);

  // Copy fresh ABIs into the two market repos that talk to these contracts.
  const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
  const abiTargets = [
    path.join(__dirname, "..", "..", "plurality-market-backend", "src", "services", "blockchain-service", "abis"),
    path.join(__dirname, "..", "..", "plurality-market-place", "src", "abis"),
  ];

  for (const dir of abiTargets) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const contracts = ["PluralityMemoryNFT", "ContextRegistry", "ReputationRegistry"];
  for (const name of contracts) {
    const artifactPath = path.join(artifactsDir, `${name}.sol`, `${name}.json`);
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
      const abiJson = JSON.stringify(artifact.abi, null, 2);

      for (const dir of abiTargets) {
        fs.writeFileSync(path.join(dir, `${name}.json`), abiJson);
      }
      console.log(`[market deploy] ABI for ${name} copied to ${abiTargets.length} market repo(s)`);
    }
  }

  console.log("\n[market deploy] --- Done. Update plurality-market-backend/.env: ---");
  console.log(`  MEMORY_NFT_CONTRACT_ADDRESS=${memoryNFTAddress}`);
  console.log(`  CONTEXT_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`  REPUTATION_REGISTRY_ADDRESS=${reputationAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
