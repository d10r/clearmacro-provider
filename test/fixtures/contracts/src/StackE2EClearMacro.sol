// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import { BatchOperation } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/Definitions.sol";
import { IClearMacro } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/utils/IClearMacro.sol";
import { ISuperToken } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperToken.sol";
import { ISuperfluid } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";

/// @notice Minimal ClearMacro used by the full local stack E2E.
contract StackE2EClearMacro is IClearMacro {
    string internal constant PRIMARY_TYPE_NAME = "StackE2E";
    string internal constant ACTION_TYPE = "Action(bytes32 salt)";
    bytes32 internal constant ACTION_TYPEHASH = keccak256(bytes(ACTION_TYPE));

    ISuperToken internal immutable _superToken;

    constructor(address superToken_) {
        _superToken = ISuperToken(superToken_);
    }

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

    /// @dev One harmless batch op so `host.forwardBatchCall` does not run with an empty list.
    function buildBatchOperations(ISuperfluid, bytes memory, address msgSender)
        external
        view
        returns (ISuperfluid.Operation[] memory operations)
    {
        operations = new ISuperfluid.Operation[](1);
        operations[0] = ISuperfluid.Operation(
            BatchOperation.OPERATION_TYPE_ERC20_APPROVE,
            address(_superToken),
            abi.encode(msgSender, uint256(0))
        );
    }

    function postCheck(ISuperfluid, bytes memory, address) external pure { }
}
