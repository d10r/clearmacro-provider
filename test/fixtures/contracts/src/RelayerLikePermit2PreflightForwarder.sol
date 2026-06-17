// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test fixture that mirrors relayer-relevant `runPermit2AndMacro` preflight checks.
contract RelayerLikePermit2PreflightForwarder {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct Permit2Context {
        PermitTransferFrom permit;
        address owner;
        bytes32 witness;
        string witnessTypeString;
        bytes signature;
        address spender;
        address upgradeSuperToken;
    }

    error UnauthorizedSender(address actual, address expected);
    error InvalidMacro(address actual, address expected);
    error InvalidOwner(address actual, address expected);
    error InvalidWitness(bytes32 actual, bytes32 expected);
    error InvalidWitnessTypeString(bytes32 actualHash, bytes32 expectedHash);
    error InvalidSignature(bytes32 actualHash, bytes32 expectedHash);
    error InvalidPayload(bytes32 actualHash, bytes32 expectedHash);
    error InvalidValue(uint256 actual, uint256 expected);

    address public immutable expectedMacro;
    address public immutable expectedSender;
    address public immutable expectedOwner;
    bytes32 public immutable expectedWitness;
    bytes32 public immutable expectedWitnessTypeStringHash;
    bytes32 public immutable expectedSignatureHash;
    bytes32 public immutable expectedPayloadHash;
    uint256 public immutable expectedMsgValue;

    constructor(
        address macro_,
        address sender_,
        address owner_,
        bytes32 witness_,
        bytes32 witnessTypeStringHash_,
        bytes32 signatureHash_,
        bytes32 payloadHash_,
        uint256 msgValue_
    ) {
        expectedMacro = macro_;
        expectedSender = sender_;
        expectedOwner = owner_;
        expectedWitness = witness_;
        expectedWitnessTypeStringHash = witnessTypeStringHash_;
        expectedSignatureHash = signatureHash_;
        expectedPayloadHash = payloadHash_;
        expectedMsgValue = msgValue_;
    }

    function runPermit2AndMacro(
        Permit2Context calldata permit2Context,
        address macro_,
        bytes calldata encodedPayload
    ) external payable returns (bool success) {
        if (msg.sender != expectedSender) {
            revert UnauthorizedSender(msg.sender, expectedSender);
        }
        if (macro_ != expectedMacro) {
            revert InvalidMacro(macro_, expectedMacro);
        }
        if (permit2Context.owner != expectedOwner) {
            revert InvalidOwner(permit2Context.owner, expectedOwner);
        }
        if (permit2Context.witness != expectedWitness) {
            revert InvalidWitness(permit2Context.witness, expectedWitness);
        }
        bytes32 witnessTypeHash = keccak256(bytes(permit2Context.witnessTypeString));
        if (witnessTypeHash != expectedWitnessTypeStringHash) {
            revert InvalidWitnessTypeString(witnessTypeHash, expectedWitnessTypeStringHash);
        }
        bytes32 actualSignatureHash = keccak256(permit2Context.signature);
        if (actualSignatureHash != expectedSignatureHash) {
            revert InvalidSignature(actualSignatureHash, expectedSignatureHash);
        }
        bytes32 payloadHash = keccak256(encodedPayload);
        if (payloadHash != expectedPayloadHash) {
            revert InvalidPayload(payloadHash, expectedPayloadHash);
        }
        if (msg.value != expectedMsgValue) {
            revert InvalidValue(msg.value, expectedMsgValue);
        }
        return true;
    }
}
