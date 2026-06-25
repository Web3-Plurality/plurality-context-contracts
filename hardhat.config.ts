import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // viaIR needed for ReputationRegistry.giveFeedback — its emit takes
      // many parameters (per ERC-8004 NewFeedback event schema) that overflow
      // the legacy stack-based pipeline.
      viaIR: true,
      // Oasis Sapphire's EVM does not implement Cancun opcodes (notably MCOPY,
      // which Solidity emits at evmVersion>=cancun for dynamic memory copies).
      // Cancun bytecode makes every `string`/`bytes`-returning view — incl.
      // ERC-1155 uri() and ReputationRegistry.readAllFeedback — revert on-chain
      // with "invalid opcode". Target Paris (Oasis-recommended) so no Cancun
      // opcode is emitted.
      evmVersion: "paris",
    },
  },
  networks: {
    oasisSapphireTestnet: {
      url: "https://testnet.sapphire.oasis.io",
      chainId: 23295,
      accounts: [DEPLOYER_PRIVATE_KEY],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: [DEPLOYER_PRIVATE_KEY],
    },
  },
  sourcify: {
    enabled: true,
  },
  etherscan: {
    enabled: false,
  },
};

export default config;
