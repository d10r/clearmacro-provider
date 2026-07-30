// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Minimal ERC-1271 mock for Safe message relay stack E2E.
contract MockErc1271Safe {
    bytes4 private constant MAGIC = 0x1626ba7e;

    mapping(bytes32 => bool) public authorizedDigests;

    function authorize(bytes32 digest) external {
        authorizedDigests[digest] = true;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length == 0 && authorizedDigests[hash]) {
            return MAGIC;
        }
        return bytes4(0xffffffff);
    }
}
