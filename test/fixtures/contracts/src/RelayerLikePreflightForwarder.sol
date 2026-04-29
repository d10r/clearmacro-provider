// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test fixture that mirrors relayer-relevant runMacro preflight checks.
contract RelayerLikePreflightForwarder {
    error UnauthorizedSender(address actual, address expected);
    error InvalidMacro(address actual, address expected);
    error InvalidSigner(address actual, address expected);
    error InvalidSignature(bytes32 actualHash, bytes32 expectedHash);
    error InvalidValue(uint256 actual, uint256 expected);

    address public immutable expectedMacro;
    address public immutable expectedSender;
    address public immutable expectedSigner;
    bytes32 public immutable expectedSignatureHash;
    uint256 public immutable expectedMsgValue;

    constructor(
        address macro_,
        address sender_,
        address signer_,
        bytes32 signatureHash_,
        uint256 msgValue_
    ) {
        expectedMacro = macro_;
        expectedSender = sender_;
        expectedSigner = signer_;
        expectedSignatureHash = signatureHash_;
        expectedMsgValue = msgValue_;
    }

    function runMacro(
        address macro_,
        bytes calldata,
        address signer,
        bytes calldata signature
    ) external payable returns (bool success) {
        if (msg.sender != expectedSender) {
            revert UnauthorizedSender(msg.sender, expectedSender);
        }
        if (macro_ != expectedMacro) {
            revert InvalidMacro(macro_, expectedMacro);
        }
        if (signer != expectedSigner) {
            revert InvalidSigner(signer, expectedSigner);
        }
        bytes32 actualHash = keccak256(signature);
        if (actualHash != expectedSignatureHash) {
            revert InvalidSignature(actualHash, expectedSignatureHash);
        }
        if (msg.value != expectedMsgValue) {
            revert InvalidValue(msg.value, expectedMsgValue);
        }
        return true;
    }

    function getDigest(address macro_, bytes calldata params) external pure returns (bytes32 digest) {
        return keccak256(abi.encode(macro_, params));
    }
}
