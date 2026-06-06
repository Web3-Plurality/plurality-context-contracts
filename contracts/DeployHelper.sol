// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "./ContextRegistry.sol";
import "./PluralityMemoryNFT.sol";
import "./ReputationRegistry.sol";

/**
 * @title DeployHelper
 * @notice Deploys the full market stack (ContextRegistry, PluralityMemoryNFT,
 *         ReputationRegistry) atomically in a single transaction and wires
 *         them together before relinquishing privilege.
 *
 *         Audit v4 COMP-H-1: an attacker who watches the mempool between
 *         `deploy(CR)`, `deploy(NFT)`, and `CR.setNftRegistry(NFT)` could
 *         interleave a malicious `setNftRegistry` call before the legitimate
 *         one lands, permanently corrupting the freeze invariant. By doing
 *         all three deploys + the wiring inside this helper's constructor,
 *         the entire stack lands atomically in one block with no window for
 *         interleaving.
 *
 *         After construction, the helper holds no privileges over any of
 *         the three deployed contracts:
 *           - CR's deployer is THIS contract, but the only deployer-gated
 *             function (`setNftRegistry`) has already been called and the
 *             one-shot flag is permanently set.
 *           - NFT's `DEFAULT_ADMIN_ROLE` is granted directly to the `admin`
 *             argument (typically the user's EOA) via NFT's constructor —
 *             this helper never holds NFT admin.
 *           - Reputation has no admin.
 *
 *         The deployed addresses are exposed as immutable public state so
 *         the off-chain deploy script can read them once `tx.wait()` returns.
 */
contract DeployHelper {
    ContextRegistry public immutable contextRegistry;
    PluralityMemoryNFT public immutable nft;
    ReputationRegistry public immutable reputation;

    constructor(
        address admin,
        address feeRecipient,
        uint256 mintFee,
        uint96 royaltyBps,
        uint96 marketplaceFeeBps
    ) {
        // 1) Deploy ContextRegistry. The helper becomes its deployer (the
        //    only address allowed to call `setNftRegistry`).
        ContextRegistry cr = new ContextRegistry();

        // 2) Deploy PluralityMemoryNFT pointing at the just-deployed CR.
        //    The NFT constructor probes the registry, so a wrong address
        //    would revert this step.
        PluralityMemoryNFT nftInstance = new PluralityMemoryNFT(
            address(cr),
            admin,
            feeRecipient,
            mintFee,
            royaltyBps,
            marketplaceFeeBps
        );

        // 3) Wire CR → NFT. The setter probes the NFT (audit v4 CR-H-2), so
        //    a wrong address would revert here.
        cr.setNftRegistry(address(nftInstance));

        // 4) Deploy ReputationRegistry pointing at the NFT (the agent
        //    identity registry). The Reputation constructor also probes
        //    the address.
        ReputationRegistry rep = new ReputationRegistry(address(nftInstance));

        // Publish addresses for the off-chain deploy script to read.
        contextRegistry = cr;
        nft = nftInstance;
        reputation = rep;
    }
}
