/**
 * Deployment script for the MARKET stack (Studio + C2C + BYOK Agent).
 * Deploys ContextRegistry + PluralityMemoryNFT + ReputationRegistry to the
 * target network.
 *
 *  - Writes the resulting addresses to deployments.market.json (the canonical
 *    deployment record).
 *  - Copies the fresh ABIs to plurality-market-backend + plurality-market-place
 *    so both stay in sync with the deployed bytecode.
 *
 * Usage:
 *   1. Make sure DEPLOYER_PRIVATE_KEY in .env is funded with TEST ROSE on
 *      Sapphire testnet (https://faucet.testnet.oasis.io/).
 *   2. Optionally set BACKEND_WALLET_ADDRESS in .env so the new market
 *      backend's signer wallet receives REGISTRAR_ROLE on the new
 *      ContextRegistry. Defaults to the deployer.
 *   3. Run:
 *        npx hardhat run scripts/deploy-market.ts --network oasisSapphireTestnet
 *   4. After it finishes, copy the printed addresses into
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
  const feeRecipient = deployer.address;
  const mintFee = ethers.parseEther("0.01");
  const royaltyBps = 500;
  const marketplaceFeeBps = 250;

  // Registry must be deployed FIRST — the NFT constructor takes its address
  // to enforce register-before-mint on-chain. Registry no longer needs the
  // NFT reference (registration is permissionless / registrant-claimed).
  console.log("\n[market deploy] --- ContextRegistry ---");
  const Registry = await ethers.getContractFactory("ContextRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("[market deploy] ContextRegistry:", registryAddress);

  console.log("\n[market deploy] --- PluralityMemoryNFT ---");
  const MemoryNFT = await ethers.getContractFactory("PluralityMemoryNFT");
  const memoryNFT = await MemoryNFT.deploy(
    registryAddress,
    feeRecipient,
    mintFee,
    royaltyBps,
    marketplaceFeeBps,
  );
  await memoryNFT.waitForDeployment();
  const memoryNFTAddress = await memoryNFT.getAddress();
  console.log("[market deploy] PluralityMemoryNFT:", memoryNFTAddress);

  // ReputationRegistry references the NFT (each tokenId is the agent identity
  // it scores). Deploy AFTER the NFT.
  console.log("\n[market deploy] --- ReputationRegistry ---");
  const Reputation = await ethers.getContractFactory("ReputationRegistry");
  const reputation = await Reputation.deploy(memoryNFTAddress);
  await reputation.waitForDeployment();
  const reputationAddress = await reputation.getAddress();
  console.log("[market deploy] ReputationRegistry:", reputationAddress);

  const deployment = {
    stack: "market",
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    contracts: {
      ContextRegistry: {
        address: registryAddress,
      },
      PluralityMemoryNFT: {
        address: memoryNFTAddress,
        registry: registryAddress,
        mintFee: mintFee.toString(),
        feeRecipient,
        royaltyBps,
        marketplaceFeeBps,
      },
      ReputationRegistry: {
        address: reputationAddress,
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
