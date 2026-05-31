// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @title ReputationRegistry
 * @notice Spec-faithful implementation of ERC-8004's ReputationRegistry,
 *         adapted to the PluralityMemoryNFT (ERC-1155, supply-of-1 per token)
 *         that serves as this stack's IdentityRegistry.
 *
 * Conformance vs ERC-8004 Draft (created 2025-08-13):
 *   - giveFeedback / revokeFeedback / appendResponse interfaces match spec
 *     signatures, parameter names, and event schemas.
 *   - Multiple feedback entries per (agentId, client) pair are allowed and
 *     keyed by `feedbackIndex` per spec.
 *   - Stored fields are { value, valueDecimals, tag1, tag2, isRevoked,
 *     timestamp } per spec. endpoint / feedbackURI / feedbackHash are
 *     emitted but not stored.
 *   - readFeedback / readAllFeedback / getSummary / getResponseCount /
 *     getClients / getLastIndex / getIdentityRegistry match spec signatures.
 *   - The "feedback submitter MUST NOT be the agent owner" rule is enforced
 *     via ERC-1155 balanceOf instead of ERC-721 ownerOf (semantic equivalent).
 *   - The companion "MUST NOT be an approved operator" rule is documented as
 *     a known omission — ERC-1155 lacks an ownerOf() function so the registry
 *     cannot resolve the current holder address required to query
 *     isApprovedForAll. Approved-operator attacks remain possible at the
 *     contract layer but are not a meaningful risk in this marketplace
 *     (the only approved operator is the NFT contract itself, which is a
 *     contract, not an EOA leaving feedback).
 *   - Sybil resistance and complex aggregation are delegated to off-chain
 *     consumers per the spec's explicit design philosophy.
 */
contract ReputationRegistry {
    // ── Storage layout ──────────────────────────────────────

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
        uint64 timestamp;
    }

    /// Responses are stored by responder + timestamp only; URI/hash live in
    /// the event log per spec's "emitted-not-stored" pattern.
    struct ResponseRecord {
        address responder;
        uint64 timestamp;
    }

    IERC1155 private immutable _identityRegistry;

    // agentId => client => feedback[]  (multiple per pair, indexed by feedbackIndex)
    mapping(uint256 => mapping(address => Feedback[])) private _feedbacks;

    // agentId => client => feedbackIndex => responses[]
    mapping(uint256 => mapping(address => mapping(uint64 => ResponseRecord[])))
        private _responses;

    // agentId => clients[] (unique addresses that have left at least one feedback)
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _clientSeen;

    // ── Events (match ERC-8004 spec verbatim) ───────────────

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    event FeedbackRevoked(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 indexed feedbackIndex
    );

    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

    // ── Init ───────────────────────────────────────────────

    constructor(address identityRegistry_) {
        require(identityRegistry_ != address(0), "Invalid identity registry");
        _identityRegistry = IERC1155(identityRegistry_);
    }

    /// @notice Address of the IdentityRegistry-equivalent contract. Per spec.
    function getIdentityRegistry() external view returns (address) {
        return address(_identityRegistry);
    }

    // ══════════════════════════════════════════════
    //                    WRITE
    // ══════════════════════════════════════════════

    /// @notice Submit feedback about an agent. Anyone except the current
    ///         agent owner may call. Each call appends a new feedback row;
    ///         feedbackIndex returned for revoke/response references.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        // Spec MUST NOT: submitter cannot be the agent owner.
        // ERC-1155 equivalent of ERC-721 ownerOf: caller must not hold supply.
        require(
            _identityRegistry.balanceOf(msg.sender, agentId) == 0,
            "Submitter is the agent owner"
        );
        // Spec MUST: valueDecimals in [0, 18].
        require(valueDecimals <= 18, "valueDecimals must be 0-18");

        uint64 feedbackIndex = uint64(_feedbacks[agentId][msg.sender].length);

        _feedbacks[agentId][msg.sender].push(
            Feedback({
                value: value,
                valueDecimals: valueDecimals,
                tag1: tag1,
                tag2: tag2,
                isRevoked: false,
                timestamp: uint64(block.timestamp)
            })
        );

        if (!_clientSeen[agentId][msg.sender]) {
            _clientSeen[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }

        emit NewFeedback(
            agentId,
            msg.sender,
            feedbackIndex,
            value,
            valueDecimals,
            tag1,
            tag1,
            tag2,
            endpoint,
            feedbackURI,
            feedbackHash
        );
    }

    /// @notice Revoke your own feedback by index. The row stays on chain
    ///         marked isRevoked; readers filter by includeRevoked.
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex < _feedbacks[agentId][msg.sender].length, "No such feedback");
        Feedback storage fb = _feedbacks[agentId][msg.sender][feedbackIndex];
        require(!fb.isRevoked, "Already revoked");
        fb.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    /// @notice Attach a public response to a feedback row. Multiple responders
    ///         may respond to the same feedback (each call adds a row).
    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        require(
            feedbackIndex < _feedbacks[agentId][clientAddress].length,
            "No such feedback"
        );

        _responses[agentId][clientAddress][feedbackIndex].push(
            ResponseRecord({responder: msg.sender, timestamp: uint64(block.timestamp)})
        );

        emit ResponseAppended(
            agentId,
            clientAddress,
            feedbackIndex,
            msg.sender,
            responseURI,
            responseHash
        );
    }

    // ══════════════════════════════════════════════
    //                     READ
    // ══════════════════════════════════════════════

    /// @notice Read a single feedback row by (agent, client, index).
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (
            int128 value,
            uint8 valueDecimals,
            string memory tag1,
            string memory tag2,
            bool isRevoked
        )
    {
        require(
            feedbackIndex < _feedbacks[agentId][clientAddress].length,
            "No such feedback"
        );
        Feedback storage fb = _feedbacks[agentId][clientAddress][feedbackIndex];
        return (fb.value, fb.valueDecimals, fb.tag1, fb.tag2, fb.isRevoked);
    }

    /// @notice Bulk read with optional client/tag/revoked filters.
    ///         Empty clientAddresses[] = scan every client of the agent.
    ///         Empty tag string = no filter on that slot.
    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    )
        external
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimalsArr,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        )
    {
        address[] memory scan = clientAddresses.length > 0
            ? _copyAddresses(clientAddresses)
            : _clients[agentId];

        uint256 matchCount = _countMatches(agentId, scan, tag1, tag2, includeRevoked);

        clients = new address[](matchCount);
        feedbackIndexes = new uint64[](matchCount);
        values = new int128[](matchCount);
        valueDecimalsArr = new uint8[](matchCount);
        tag1s = new string[](matchCount);
        tag2s = new string[](matchCount);
        revokedStatuses = new bool[](matchCount);

        uint256 k;
        for (uint256 i; i < scan.length; ++i) {
            address c = scan[i];
            Feedback[] storage list = _feedbacks[agentId][c];
            for (uint64 j; j < list.length; ++j) {
                Feedback storage fb = list[j];
                if (!includeRevoked && fb.isRevoked) continue;
                if (!_tagMatches(fb.tag1, tag1)) continue;
                if (!_tagMatches(fb.tag2, tag2)) continue;
                clients[k] = c;
                feedbackIndexes[k] = j;
                values[k] = fb.value;
                valueDecimalsArr[k] = fb.valueDecimals;
                tag1s[k] = fb.tag1;
                tag2s[k] = fb.tag2;
                revokedStatuses[k] = fb.isRevoked;
                ++k;
            }
        }
    }

    /// @notice Aggregate (count + average) over active feedback matching the
    ///         optional client/tag filter. Values with different valueDecimals
    ///         are normalized to the max decimals seen before averaging.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    )
        external
        view
        returns (
            uint64 count,
            int128 summaryValue,
            uint8 summaryValueDecimals
        )
    {
        address[] memory scan = clientAddresses.length > 0
            ? _copyAddresses(clientAddresses)
            : _clients[agentId];

        // First pass: find max decimals among matches.
        uint8 maxDecimals;
        for (uint256 i; i < scan.length; ++i) {
            Feedback[] storage list = _feedbacks[agentId][scan[i]];
            for (uint64 j; j < list.length; ++j) {
                Feedback storage fb = list[j];
                if (fb.isRevoked) continue;
                if (!_tagMatches(fb.tag1, tag1)) continue;
                if (!_tagMatches(fb.tag2, tag2)) continue;
                if (fb.valueDecimals > maxDecimals) maxDecimals = fb.valueDecimals;
            }
        }

        // Second pass: sum normalized values + count.
        int256 scaledSum;
        uint64 cnt;
        for (uint256 i; i < scan.length; ++i) {
            Feedback[] storage list = _feedbacks[agentId][scan[i]];
            for (uint64 j; j < list.length; ++j) {
                Feedback storage fb = list[j];
                if (fb.isRevoked) continue;
                if (!_tagMatches(fb.tag1, tag1)) continue;
                if (!_tagMatches(fb.tag2, tag2)) continue;
                int256 scale = int256(10 ** uint256(maxDecimals - fb.valueDecimals));
                scaledSum += int256(fb.value) * scale;
                ++cnt;
            }
        }

        if (cnt == 0) return (0, 0, 0);
        int256 avg = scaledSum / int256(uint256(cnt));
        summaryValue = int128(avg);
        summaryValueDecimals = maxDecimals;
        count = cnt;
    }

    /// @notice Number of responses on a feedback row, optionally filtered by
    ///         a list of responders. Empty responders[] = count everything.
    function getResponseCount(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        address[] calldata responders
    ) external view returns (uint64) {
        ResponseRecord[] storage list = _responses[agentId][clientAddress][feedbackIndex];
        if (responders.length == 0) {
            return uint64(list.length);
        }
        uint64 cnt;
        for (uint256 i; i < list.length; ++i) {
            address r = list[i].responder;
            for (uint256 j; j < responders.length; ++j) {
                if (r == responders[j]) {
                    ++cnt;
                    break;
                }
            }
        }
        return cnt;
    }

    /// @notice Every unique client who has left at least one feedback on this agent.
    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    /// @notice Most recent feedbackIndex this client posted on this agent.
    ///         Returns 0 if the client has never posted (caller must
    ///         disambiguate using getClients or a separate hasReviewed check).
    function getLastIndex(uint256 agentId, address clientAddress)
        external
        view
        returns (uint64)
    {
        uint256 len = _feedbacks[agentId][clientAddress].length;
        if (len == 0) return 0;
        return uint64(len - 1);
    }

    // ── internal helpers ──────────────────────────────────

    function _tagMatches(string memory tag, string memory filter) private pure returns (bool) {
        if (bytes(filter).length == 0) return true;
        return keccak256(bytes(tag)) == keccak256(bytes(filter));
    }

    function _countMatches(
        uint256 agentId,
        address[] memory scan,
        string memory tag1,
        string memory tag2,
        bool includeRevoked
    ) private view returns (uint256 matchCount) {
        for (uint256 i; i < scan.length; ++i) {
            Feedback[] storage list = _feedbacks[agentId][scan[i]];
            for (uint64 j; j < list.length; ++j) {
                Feedback storage fb = list[j];
                if (!includeRevoked && fb.isRevoked) continue;
                if (!_tagMatches(fb.tag1, tag1)) continue;
                if (!_tagMatches(fb.tag2, tag2)) continue;
                ++matchCount;
            }
        }
    }

    function _copyAddresses(address[] calldata src)
        private
        pure
        returns (address[] memory out)
    {
        out = new address[](src.length);
        for (uint256 i; i < src.length; ++i) out[i] = src[i];
    }
}
