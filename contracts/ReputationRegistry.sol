// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

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
 *   - The companion "MUST NOT be an approved operator" rule is NOT enforced
 *     at the contract layer. Resolving "approved operator of the current
 *     holder" requires `ownerOf` to call `isApprovedForAll(owner, sender)`,
 *     which ERC-1155 alone cannot do without an explicit enumeration mapping
 *     on the NFT contract. Approved operators (whoever they may be — EOAs
 *     are eligible, not just contracts) can therefore submit feedback. This
 *     is documented as a known deviation from the spec, narrowly scoped to
 *     the ERC-1155 ↔ ERC-721 gap.
 *   - Sybil resistance and complex aggregation are delegated to off-chain
 *     consumers per the spec's explicit design philosophy. On-chain caps
 *     (below) provide a basic floor against view-function DoS.
 */
contract ReputationRegistry {
    /// @notice Identifier surfaced for off-chain ABI / deployment-drift checks.
    string public constant VERSION = "ReputationRegistry/v5";

    // ── Hardening caps (audit H-REP-1/2 + M-REP-A/B) ───────
    /// @notice Max distinct clients that may post feedback on a single agent.
    ///         Bounds the iteration cost of `getSummary` / `readAllFeedback`
    ///         / `getClients`. Set to 1000 — large enough that legitimate
    ///         marketplaces don't hit it in normal operation, small enough
    ///         that view aggregates stay callable from RPCs at full bucket.
    ///         (Audit v3 H-4: the prior 10000 value enabled cheap Sybil
    ///         stuffing under Sapphire's sub-cent gas economics.)
    uint64 public constant MAX_CLIENTS_PER_AGENT = 1000;
    /// @notice Max ACTIVE (non-revoked) feedback rows per (agent, client).
    ///         A revoke frees a slot, so honest reviewers who want to update
    ///         their position over time are not permanently locked out.
    uint64 public constant MAX_FEEDBACK_PER_PAIR = 50;
    /// @notice Hard storage cap on total lifetime rows per (agent, client),
    ///         including revoked. Prevents an attacker from churning
    ///         post→revoke→post infinitely to bloat the row history that
    ///         `readAllFeedback` iterates with `includeRevoked = true`.
    uint64 public constant MAX_FEEDBACK_HISTORY_PER_PAIR = 200;
    /// @notice Max responses per feedback row (any responder).
    uint64 public constant MAX_RESPONSES_PER_FEEDBACK = 50;

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

    // (agentId, client) => number of currently-active (non-revoked) feedback rows.
    // Maintained on every `giveFeedback` (+1) and `revokeFeedback` (-1) so the
    // active cap can be enforced without scanning the full row history.
    mapping(uint256 => mapping(address => uint64)) private _activeFeedbackCount;

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
        // Sanity-probe (audit v4 COMP-H-2). Refuse to wire to an EOA or to a
        // contract that doesn't expose ERC-1155's `balanceOf`. The probe
        // itself is the cheap balanceOf call below — reverts if the callee
        // isn't a contract or lacks the function selector.
        require(identityRegistry_.code.length > 0, "Identity registry not a contract");
        IERC1155(identityRegistry_).balanceOf(address(0), 0);
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
        // Spec MUST: valueDecimals in [0, 18]. Tightened to [0, 8] to bound
        // the rescale factor in `getSummary` (10^(maxΔ) ≤ 10^8) and prevent
        // decimal-bomb griefing where a single high-decimals outlier forces
        // every other row through a 10^18 rescale, risking unchecked
        // narrowing on the final `int256 → int128`. (Audit v3 M-6 — documented
        // deviation from the literal spec range; ratings/reputation values
        // never need more than 8 decimal places of precision.)
        require(valueDecimals <= 8, "valueDecimals must be 0-8");

        // Hardening: two-tier feedback cap (audit M-REP-B).
        //   • Active cap: max simultaneous non-revoked rows. Revoking frees
        //     a slot — honest reviewers can update their position over time.
        //   • History cap: hard ceiling on total lifetime rows including
        //     revoked. Stops post→revoke→post churn from bloating storage.
        require(
            _activeFeedbackCount[agentId][msg.sender] < MAX_FEEDBACK_PER_PAIR,
            "Active feedback cap reached"
        );
        require(
            _feedbacks[agentId][msg.sender].length < MAX_FEEDBACK_HISTORY_PER_PAIR,
            "Feedback history cap reached"
        );
        // Cap distinct clients per agent to bound the outer loop. Once an
        // address has posted at least once it remains eligible to extend
        // without re-counting toward the cap.
        if (!_clientSeen[agentId][msg.sender]) {
            require(
                _clients[agentId].length < MAX_CLIENTS_PER_AGENT,
                "Client cap reached for this agent"
            );
        }

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

        // Increment the active count after the row is stored, before emit.
        ++_activeFeedbackCount[agentId][msg.sender];

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
    ///         marked isRevoked; readers filter by includeRevoked. The
    ///         caller's active-feedback count is decremented so the
    ///         freed slot can be used for a future `giveFeedback` call.
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex < _feedbacks[agentId][msg.sender].length, "No such feedback");
        Feedback storage fb = _feedbacks[agentId][msg.sender][feedbackIndex];
        require(!fb.isRevoked, "Already revoked");
        fb.isRevoked = true;
        --_activeFeedbackCount[agentId][msg.sender];
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

        // Hardening: cap responses per feedback row to bound storage growth
        // (audit H-REP-2). Agent owners (current NFT holders) bypass the cap
        // so adversaries can't silence the rebuttal right by stuffing the
        // 50-slot quota with shill responses from burner wallets (audit v3
        // M-5). The cap still applies to non-owner responders, preserving
        // protection against general response-flood DoS.
        if (_identityRegistry.balanceOf(msg.sender, agentId) == 0) {
            require(
                _responses[agentId][clientAddress][feedbackIndex].length < MAX_RESPONSES_PER_FEEDBACK,
                "Response cap reached"
            );
        }

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

        bool tag1Empty = bytes(tag1).length == 0;
        bool tag2Empty = bytes(tag2).length == 0;
        bytes32 tag1Hash = tag1Empty ? bytes32(0) : keccak256(bytes(tag1));
        bytes32 tag2Hash = tag2Empty ? bytes32(0) : keccak256(bytes(tag2));

        uint256 k;
        for (uint256 i; i < scan.length; ++i) {
            address c = scan[i];
            Feedback[] storage list = _feedbacks[agentId][c];
            for (uint64 j; j < list.length; ++j) {
                Feedback storage fb = list[j];
                if (!includeRevoked && fb.isRevoked) continue;
                if (!_tagMatchesHashed(fb.tag1, tag1Hash, tag1Empty)) continue;
                if (!_tagMatchesHashed(fb.tag2, tag2Hash, tag2Empty)) continue;
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

        bool tag1Empty = bytes(tag1).length == 0;
        bool tag2Empty = bytes(tag2).length == 0;
        bytes32 tag1Hash = tag1Empty ? bytes32(0) : keccak256(bytes(tag1));
        bytes32 tag2Hash = tag2Empty ? bytes32(0) : keccak256(bytes(tag2));

        // First pass: find max decimals among matches.
        uint8 maxDecimals;
        for (uint256 i; i < scan.length; ++i) {
            Feedback[] storage list = _feedbacks[agentId][scan[i]];
            for (uint64 j; j < list.length; ++j) {
                Feedback storage fb = list[j];
                if (fb.isRevoked) continue;
                if (!_tagMatchesHashed(fb.tag1, tag1Hash, tag1Empty)) continue;
                if (!_tagMatchesHashed(fb.tag2, tag2Hash, tag2Empty)) continue;
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
                if (!_tagMatchesHashed(fb.tag1, tag1Hash, tag1Empty)) continue;
                if (!_tagMatchesHashed(fb.tag2, tag2Hash, tag2Empty)) continue;
                int256 scale = int256(10 ** uint256(maxDecimals - fb.valueDecimals));
                scaledSum += int256(fb.value) * scale;
                ++cnt;
            }
        }

        if (cnt == 0) return (0, 0, 0);
        int256 avg = scaledSum / int256(uint256(cnt));
        // SafeCast reverts on out-of-range narrowing rather than silently
        // wrapping (audit v3 H-2: Solidity 0.8 does NOT check narrowing
        // conversions, only arithmetic). The valueDecimals ≤ 8 cap above
        // makes overflow unreachable from normal use, but SafeCast is the
        // structural defense.
        summaryValue = SafeCast.toInt128(avg);
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
    ///         The companion `exists` flag disambiguates "never posted"
    ///         (returns `(0, false)`) from "posted exactly one row at
    ///         index 0" (returns `(0, true)`).
    function getLastIndex(uint256 agentId, address clientAddress)
        external
        view
        returns (uint64 lastIndex, bool exists)
    {
        uint256 len = _feedbacks[agentId][clientAddress].length;
        if (len == 0) return (0, false);
        return (uint64(len - 1), true);
    }

    /// @notice Active (non-revoked) feedback count for a (agent, client) pair.
    function getActiveFeedbackCount(uint256 agentId, address clientAddress)
        external
        view
        returns (uint64)
    {
        return _activeFeedbackCount[agentId][clientAddress];
    }

    // ── internal helpers ──────────────────────────────────

    /// @dev Tag match using pre-hashed filters. An empty filter (hashed to
    ///      the empty-string keccak) is treated as "any tag accepted".
    ///      Hoisting the keccak out of the inner loop avoids recomputing it
    ///      thousands of times per call.
    function _tagMatchesHashed(string memory tag, bytes32 filterHash, bool filterIsEmpty)
        private
        pure
        returns (bool)
    {
        if (filterIsEmpty) return true;
        return keccak256(bytes(tag)) == filterHash;
    }

    function _countMatches(
        uint256 agentId,
        address[] memory scan,
        string memory tag1,
        string memory tag2,
        bool includeRevoked
    ) private view returns (uint256 matchCount) {
        bool tag1Empty = bytes(tag1).length == 0;
        bool tag2Empty = bytes(tag2).length == 0;
        bytes32 tag1Hash = tag1Empty ? bytes32(0) : keccak256(bytes(tag1));
        bytes32 tag2Hash = tag2Empty ? bytes32(0) : keccak256(bytes(tag2));
        for (uint256 i; i < scan.length; ++i) {
            Feedback[] storage list = _feedbacks[agentId][scan[i]];
            for (uint64 j; j < list.length; ++j) {
                Feedback storage fb = list[j];
                if (!includeRevoked && fb.isRevoked) continue;
                if (!_tagMatchesHashed(fb.tag1, tag1Hash, tag1Empty)) continue;
                if (!_tagMatchesHashed(fb.tag2, tag2Hash, tag2Empty)) continue;
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
