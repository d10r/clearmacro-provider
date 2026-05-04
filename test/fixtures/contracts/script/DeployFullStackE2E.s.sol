// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import { IAccessControl } from "@openzeppelin-v5/contracts/access/IAccessControl.sol";
import { ERC1820RegistryCompiled } from "@superfluid-finance/ethereum-contracts/contracts/libs/ERC1820RegistryCompiled.sol";
import { ISuperfluid } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";
import { ClearMacroForwarderV1 } from "@superfluid-finance/ethereum-contracts/contracts/utils/ClearMacroForwarderV1.sol";
import { SuperfluidFrameworkDeployer } from "@superfluid-finance/ethereum-contracts/contracts/utils/SuperfluidFrameworkDeployer.t.sol";
import { StackE2EClearMacro } from "../src/StackE2EClearMacro.sol";

interface Vm {
    function etch(address target, bytes calldata code) external;
    function startBroadcast() external;
    function stopBroadcast() external;
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function envOr(string calldata name, address defaultValue) external returns (address value);
    function writeJson(string calldata json, string calldata path) external;
    function writeFile(string calldata path, string calldata data) external;
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
}

contract E2ESuperfluidFrameworkDeployer is SuperfluidFrameworkDeployer {
    function grantProviderRole(ISuperfluid host, string memory providerName, address account) external {
        IAccessControl(host.getSimpleACL()).grantRole(keccak256(bytes(providerName)), account);
    }
}

contract DeployFullStackE2E {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant JSON_OBJECT = "deploy";
    string internal constant PROVIDER_NAME = "macros.superfluid.eth";
    address internal constant DEFAULT_RELAYER_SIGNER = 0xa9F9Add7e644C15eA3596F8653c69d66Ff708dC7;

    function run() external {
        string memory outputPath = vm.envOr("E2E_DEPLOY_OUTPUT", string("deploy-output.json"));
        address relayerSigner = vm.envOr("E2E_RELAYER_SIGNER", DEFAULT_RELAYER_SIGNER);

        vm.etch(ERC1820RegistryCompiled.at, ERC1820RegistryCompiled.bin);

        vm.startBroadcast();

        E2ESuperfluidFrameworkDeployer deployer = new E2ESuperfluidFrameworkDeployer();
        deployer.deployTestFramework();
        SuperfluidFrameworkDeployer.Framework memory sf = deployer.getFramework();

        ClearMacroForwarderV1 forwarder = new ClearMacroForwarderV1(ISuperfluid(address(sf.host)));
        StackE2EClearMacro clearMacro = new StackE2EClearMacro();

        deployer.grantProviderRole(ISuperfluid(address(sf.host)), PROVIDER_NAME, relayerSigner);

        vm.stopBroadcast();

        string memory json = vm.serializeUint(JSON_OBJECT, "chainId", block.chainid);
        json = vm.serializeString(JSON_OBJECT, "providerName", PROVIDER_NAME);
        json = vm.serializeAddress(JSON_OBJECT, "host", address(sf.host));
        json = vm.serializeAddress(JSON_OBJECT, "simpleACL", address(sf.host.getSimpleACL()));
        json = vm.serializeAddress(JSON_OBJECT, "forwarderAddress", address(forwarder));
        json = vm.serializeAddress(JSON_OBJECT, "macroAddress", address(clearMacro));
        json = vm.serializeAddress(JSON_OBJECT, "relayerSigner", relayerSigner);
        vm.writeFile(outputPath, "{}");
        vm.writeJson(json, outputPath);
    }
}
