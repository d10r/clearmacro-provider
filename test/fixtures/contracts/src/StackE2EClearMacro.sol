// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import { IClearMacro } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/utils/IClearMacro.sol";
import { ISuperfluid } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";

/// @notice Minimal ClearMacro used by the full local stack E2E.
contract StackE2EClearMacro is IClearMacro {
    string internal constant PRIMARY_TYPE_NAME = "StackE2E";
    string internal constant ACTION_TYPE = "Action(bytes32 salt)";
    bytes32 internal constant ACTION_TYPEHASH = keccak256(bytes(ACTION_TYPE));

    function encodeAction(bytes32 salt) external pure returns (bytes memory) {
        return abi.encode(salt);
    }

    function getPrimaryTypeName(bytes memory) external pure returns (string memory) {
        return PRIMARY_TYPE_NAME;
    }

    function getActionTypeDefinition(bytes memory) external pure returns (string memory) {
        return ACTION_TYPE;
    }

    function getActionStructHash(bytes memory params) external pure returns (bytes32) {
        bytes32 salt = abi.decode(params, (bytes32));
        return keccak256(abi.encode(ACTION_TYPEHASH, salt));
    }

    function buildBatchOperations(ISuperfluid, bytes memory, address)
        external
        pure
        returns (ISuperfluid.Operation[] memory operations)
    {
        operations = new ISuperfluid.Operation[](0);
    }

    function postCheck(ISuperfluid, bytes memory, address) external pure { }
}
