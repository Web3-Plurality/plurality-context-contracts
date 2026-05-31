/**
 * Incremental deployment script for ReputationRegistry only.
 *
 * Use this when you want to add ReputationRegistry to an existing market
 * stack WITHOUT redeploying ContextRegistry and PluralityMemoryNFT
 * (which would invalidate the addresses the backend's .env points at).
 *
 * The script reads the existing PluralityMemoryNFT address from
 * deployments.market.json, deploys ReputationRegistry pointing at it,
 * and merges the new address back into the same JSON file.
 *
 * For a full fresh deploy of all three contracts (e.g. Phase 12 wipe),
 * use scripts/deploy-market.ts instead.
 *
 * Usage:
 *   1. Make sure deployments.market.json has a valid PluralityMemoryNFT.address.
 *   2. Make sure DEPLOYER_PRIVATE_KEY in .env is funded with TEST ROSE.
 *   3. Run:
 *        npx hardhat run scripts/deploy-reputation.ts --network oasisSapphireTestnet
 *   4. After it finishes, copy the printed address into
 *      plurality-market-backend/.env:
 *        REPUTATION_REGISTRY_ADDRESS=...
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("[reputation deploy] Deployer:", deployer.address);
  console.log("[reputation deploy] Balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Read existing deployment record to find the NFT address we attach to.
  const recordPath = path.join(__dirname, "..", "deployments.market.json");
  if (!fs.existsSync(recordPath)) {
    throw new Error(`deployments.market.json not found at ${recordPath}. Run deploy-market.ts first.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
  const nftAddress: string | undefined = record?.contracts?.PluralityMemoryNFT?.address;
  if (!nftAddress) {
    throw new Error("PluralityMemoryNFT.address missing from deployments.market.json");
  }
  console.log("[reputation deploy] Attaching to existing PluralityMemoryNFT:", nftAddress);

  console.log("\n[reputation deploy] --- ReputationRegistry ---");
  const Reputation = await ethers.getContractFactory("ReputationRegistry");
  const reputation = await Reputation.deploy(nftAddress);
  await reputation.waitForDeployment();
  const reputationAddress = await reputation.getAddress();
  console.log("[reputation deploy] ReputationRegistry:", reputationAddress);

  // Merge into the existing JSON without touching the other entries.
  record.contracts = record.contracts || {};
  record.contracts.ReputationRegistry = {
    address: reputationAddress,
    nft: nftAddress,
  };
  record.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log("\n[reputation deploy] Updated:", recordPath);

  // Copy the fresh ABI into the two market repos that may consume it.
  const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
  const abiTargets = [
    path.join(__dirname, "..", "..", "plurality-market-backend", "src", "services", "blockchain-service", "abis"),
    path.join(__dirname, "..", "..", "plurality-market-place", "src", "abis"),
  ];

  const artifactPath = path.join(artifactsDir, "ReputationRegistry.sol", "ReputationRegistry.json");
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
    const abiJson = JSON.stringify(artifact.abi, null, 2);
    for (const dir of abiTargets) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(path.join(dir, "ReputationRegistry.json"), abiJson);
    }
    console.log(`[reputation deploy] ABI copied to ${abiTargets.length} market repo(s)`);
  }

  console.log("\n[reputation deploy] --- Done. Update plurality-market-backend/.env: ---");
  console.log(`  REPUTATION_REGISTRY_ADDRESS=${reputationAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
