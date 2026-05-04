// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import { IAccessControl } from "@openzeppelin-v5/contracts/access/IAccessControl.sol";
import { ISuperfluid } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";
import { ISETH } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/tokens/ISETH.sol";
import { ISuperfluidToken } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluidToken.sol";
import { ClearMacroForwarderV1 } from "@superfluid-finance/ethereum-contracts/contracts/utils/ClearMacroForwarderV1.sol";
import { SuperfluidFrameworkDeployer } from "@superfluid-finance/ethereum-contracts/contracts/utils/SuperfluidFrameworkDeployer.t.sol";
import { StackE2EClearMacro } from "./StackE2EClearMacro.sol";

contract FullStackE2EDeployer is SuperfluidFrameworkDeployer {
    string internal constant PROVIDER_NAME = "macros.superfluid.eth";

    struct Deployment {
        uint256 chainId;
        string providerName;
        address host;
        address simpleACL;
        address forwarderAddress;
        address macroAddress;
        address relayerSigner;
    }

    Deployment internal _deployment;
    bool public deployed;

    event FullStackDeployed(
        uint256 indexed chainId,
        address indexed forwarderAddress,
        address indexed macroAddress,
        address host,
        address simpleACL,
        address relayerSigner
    );

    function deployFullStack(address relayerSigner) external returns (Deployment memory deployment) {
        require(!deployed, "already deployed");
        require(relayerSigner != address(0), "relayer signer required");

        for (uint8 i = 0; i < getNumSteps(); ++i) {
            executeStep(i);
        }

        SuperfluidFrameworkDeployer.Framework memory sf = this.getFramework();
        ISETH nativeSuperToken = this.deployNativeAssetSuperToken("Ether", "ETHx");
        ClearMacroForwarderV1 forwarder = new ClearMacroForwarderV1(ISuperfluid(address(sf.host)));
        StackE2EClearMacro clearMacro = new StackE2EClearMacro(address(nativeSuperToken));

        sf.governance.enableTrustedForwarder(sf.host, ISuperfluidToken(address(0)), address(forwarder));
        IAccessControl(sf.host.getSimpleACL()).grantRole(keccak256(bytes(PROVIDER_NAME)), relayerSigner);

        deployment = Deployment({
            chainId: block.chainid,
            providerName: PROVIDER_NAME,
            host: address(sf.host),
            simpleACL: address(sf.host.getSimpleACL()),
            forwarderAddress: address(forwarder),
            macroAddress: address(clearMacro),
            relayerSigner: relayerSigner
        });
        _deployment = deployment;
        deployed = true;

        emit FullStackDeployed(
            deployment.chainId,
            deployment.forwarderAddress,
            deployment.macroAddress,
            deployment.host,
            deployment.simpleACL,
            deployment.relayerSigner
        );
    }

    function getDeployment() external view returns (Deployment memory) {
        return _deployment;
    }
}
