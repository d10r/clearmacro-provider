// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin-v5/contracts/token/ERC20/IERC20.sol";
import { SignatureChecker } from "@openzeppelin-v5/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Minimal Permit2 stub for Anvil stack E2E (witness + implied-upgrade paths).
contract MockPermit2 {
    error InvalidSigner();
    error InvalidSignature();
    error InvalidNonce();

    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    bytes32 private constant _TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    string private constant _PERMIT_WITNESS_TRANSFER_FROM_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    mapping(address => mapping(uint256 => uint256)) private _nonceBitmap;

    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return keccak256("clearmacro-e2e-permit2-domain-separator");
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external {
        bytes32 digest = _permit2Digest(permit, msg.sender, witness, witnessTypeString);
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) {
            revert InvalidSignature();
        }

        if (_nonceBitmap[owner][permit.nonce] != 0) {
            revert InvalidNonce();
        }
        _nonceBitmap[owner][permit.nonce] = 1;

        uint256 amount = transferDetails.requestedAmount;
        if (amount > permit.permitted.amount) {
            revert InvalidSignature();
        }

        bool ok = IERC20(permit.permitted.token).transferFrom(owner, transferDetails.to, amount);
        if (!ok) {
            revert InvalidSignature();
        }
    }

    function _permit2Digest(
        PermitTransferFrom calldata permit,
        address spender,
        bytes32 witness,
        string calldata witnessTypeString
    ) internal pure returns (bytes32) {
        bytes32 typeHash = keccak256(abi.encodePacked(_PERMIT_WITNESS_TRANSFER_FROM_STUB, witnessTypeString));
        bytes32 tokenPermissionsHash = keccak256(abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 structHash = keccak256(
            abi.encode(typeHash, tokenPermissionsHash, spender, permit.nonce, permit.deadline, witness)
        );
        return keccak256(abi.encodePacked("\x19\x01", keccak256("clearmacro-e2e-permit2-domain-separator"), structHash));
    }
}
