import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Hex } from "viem";
import {
  allocateHostPort,
  deployFullStackE2EContractsOnAnvil,
  dockerComposeLogs,
  ensureAnvilKeystore,
  forgeBuildFullStackFixtures,
  getRepoRoot,
  makeStackWorkDir,
  RELAYER_SIGNER_PRIVATE_KEY,
  runDockerCompose,
  setERC1820RegistryCode,
  waitForJsonRpcChainId,
  writeOzRelayerConfig,
  writeProviderRegistry,
} from "../fixtures/docker-stack.js";

const E2E_OZ_API_KEY = "local-e2e-oz-relayer-api-key-32chars!!";
const CHAIN_ID_HEX = "0x7a69" as Hex;

const runStack = process.env.RUN_STACK_E2E === "1";
const describeStack = runStack ? describe : describe.skip;

describeStack("relay stack harness smoke", { timeout: 180_000 }, () => {
  it("starts Anvil, deploys real fixtures, and generates stack config", async () => {
    const repoRoot = getRepoRoot();
    const project = `cme2e${process.pid}${randomBytes(3).toString("hex")}`;
    const anvilPort = await allocateHostPort();
    const appPort = await allocateHostPort();
    const ozHostPort = await allocateHostPort();
    const stackDir = makeStackWorkDir();
    const deployOutputPath = join(stackDir, "deploy-output.json");
    const anvilHostRpc = `http://127.0.0.1:${anvilPort}`;
    const chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvilHostRpc] } },
    } as const;

    const composeEnv = (): Record<string, string> => ({
      E2E_ANVIL_PORT: String(anvilPort),
      E2E_APP_PORT: String(appPort),
      E2E_OZ_HOST_PORT: String(ozHostPort),
      E2E_STACK_CONFIG_DIR: stackDir,
      E2E_OZ_RELAYER_API_KEY: E2E_OZ_API_KEY,
      OZ_KEYSTORE_PASSPHRASE: process.env.OZ_KEYSTORE_PASSPHRASE ?? "change-me",
      OZ_STORAGE_ENCRYPTION_KEY: process.env.OZ_STORAGE_ENCRYPTION_KEY ?? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    });

    const failWithLogs = (msg: string): never => {
      let logs = "(could not fetch logs)";
      try {
        logs = dockerComposeLogs(repoRoot, project, composeEnv());
      } catch {
        // keep fallback
      }
      throw new Error(`${msg}\n--- docker compose logs ---\n${logs}`);
    };

    try {
      forgeBuildFullStackFixtures(repoRoot);

      runDockerCompose(repoRoot, project, ["up", "-d", "anvil"], composeEnv());
      await waitForJsonRpcChainId(anvilHostRpc, CHAIN_ID_HEX, 45_000);
      await setERC1820RegistryCode({ repoRoot, rpcUrl: anvilHostRpc });

      const relayerSigner = privateKeyToAccount(RELAYER_SIGNER_PRIVATE_KEY);
      const deployed = await deployFullStackE2EContractsOnAnvil({
        repoRoot,
        relayerSigner: relayerSigner.address,
        rpcUrl: anvilHostRpc,
      });

      expect(deployed.chainId).toBe(31337);
      expect(deployed.providerName).toBe("macros.superfluid.eth");
      expect(deployed.relayerSigner.toLowerCase()).toBe(relayerSigner.address.toLowerCase());
      expect(deployed.host).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(deployed.simpleACL).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(deployed.forwarderAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(deployed.macroAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);

      const publicClient = createPublicClient({ chain, transport: http(anvilHostRpc) });
      await expect(publicClient.getBytecode({ address: deployed.host })).resolves.toMatch(/^0x[0-9a-fA-F]+$/);
      await expect(publicClient.getBytecode({ address: deployed.simpleACL })).resolves.toMatch(/^0x[0-9a-fA-F]+$/);
      await expect(publicClient.getBytecode({ address: deployed.forwarderAddress })).resolves.toMatch(/^0x[0-9a-fA-F]+$/);
      await expect(publicClient.getBytecode({ address: deployed.macroAddress })).resolves.toMatch(/^0x[0-9a-fA-F]+$/);

      ensureAnvilKeystore(repoRoot, join(stackDir, "keys"));
      writeOzRelayerConfig(stackDir);
      writeProviderRegistry(stackDir, deployed.forwarderAddress, deployed.macroAddress);

      expect(existsSync(join(stackDir, "keys", "anvil-relayer.json"))).toBe(true);
      expect(existsSync(join(stackDir, "config.json"))).toBe(true);
      expect(existsSync(join(stackDir, "networks", "evm.json"))).toBe(true);
      expect(existsSync(join(stackDir, "registry.json"))).toBe(true);

      const registry = JSON.parse(readFileSync(join(stackDir, "registry.json"), "utf8")) as {
        chains: Array<{ chainId: number; forwarderAddress: string; allowedMacros: Array<{ domain: string; address: string }> }>;
      };
      expect(registry.chains).toHaveLength(1);
      expect(registry.chains[0]?.chainId).toBe(31337);
      expect(registry.chains[0]?.forwarderAddress.toLowerCase()).toBe(deployed.forwarderAddress.toLowerCase());
      expect(registry.chains[0]?.allowedMacros).toEqual([
        { domain: "e2e", address: deployed.macroAddress },
      ]);
      expect(existsSync(deployOutputPath)).toBe(false);
    } catch (error) {
      failWithLogs(error instanceof Error ? error.message : String(error));
    } finally {
      try {
        runDockerCompose(repoRoot, project, ["down", "-v", "--remove-orphans"], composeEnv());
      } catch {
        // ignore teardown errors
      }
      try {
        rmSync(stackDir, { recursive: true, force: true });
      } catch {
        // ignore temp cleanup errors
      }
    }
  });
});
