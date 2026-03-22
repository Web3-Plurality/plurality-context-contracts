import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Configuration
  const feeRecipient = deployer.address; // Platform treasury (change for production)
  const mintFee = ethers.parseEther("0.01"); // 0.01 ROSE
  const royaltyBps = 500; // 5% royalty on secondary sales → platform
  const marketplaceFeeBps = 250; // 2.5% commission on built-in marketplace → platform

  // 1. Deploy PluralityMemoryNFT
  console.log("\n--- Deploying PluralityMemoryNFT ---");
  const MemoryNFT = await ethers.getContractFactory("PluralityMemoryNFT");
  const memoryNFT = await MemoryNFT.deploy(feeRecipient, mintFee, royaltyBps, marketplaceFeeBps);
  await memoryNFT.waitForDeployment();
  const memoryNFTAddress = await memoryNFT.getAddress();
  console.log("PluralityMemoryNFT deployed to:", memoryNFTAddress);

  // 2. Deploy ContextRegistry
  console.log("\n--- Deploying ContextRegistry ---");
  const Registry = await ethers.getContractFactory("ContextRegistry");
  const registry = await Registry.deploy(memoryNFTAddress);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("ContextRegistry deployed to:", registryAddress);

  // 3. Grant REGISTRAR_ROLE to deployer (backend hot wallet)
  // If your backend uses a different wallet, grant the role to that address:
  // const backendWallet = "0x...";
  // await registry.grantRole(await registry.REGISTRAR_ROLE(), backendWallet);
  console.log("\nRegistrar role already granted to deployer (default)");

  // 4. Export deployment info
  const deployment = {
    network: (await ethers.provider.getNetwork()).name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    contracts: {
      PluralityMemoryNFT: {
        address: memoryNFTAddress,
        mintFee: mintFee.toString(),
        feeRecipient,
        royaltyBps,
        marketplaceFeeBps,
      },
      ContextRegistry: {
        address: registryAddress,
        memoryNFT: memoryNFTAddress,
      },
    },
    deployedAt: new Date().toISOString(),
  };

  const outputPath = path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));
  console.log("\nDeployment info saved to:", outputPath);

  // 5. Copy ABIs to backend and frontend
  const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
  const backendAbiDir = path.join(__dirname, "..", "..", "plurality-backend-api", "src", "services", "blockchain-service", "abis");
  const frontendAbiDir = path.join(__dirname, "..", "..", "plurality-memory-studio", "src", "abis");

  for (const dir of [backendAbiDir, frontendAbiDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const contracts = ["PluralityMemoryNFT", "ContextRegistry"];
  for (const name of contracts) {
    const artifactPath = path.join(artifactsDir, `${name}.sol`, `${name}.json`);
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
      const abiJson = JSON.stringify(artifact.abi, null, 2);

      fs.writeFileSync(path.join(backendAbiDir, `${name}.json`), abiJson);
      fs.writeFileSync(path.join(frontendAbiDir, `${name}.json`), abiJson);
      console.log(`ABI for ${name} copied to backend and frontend`);
    }
  }

  console.log("\n--- Deployment complete! ---");
  console.log("PluralityMemoryNFT:", memoryNFTAddress);
  console.log("ContextRegistry:", registryAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
