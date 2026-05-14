import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clearMacroForwarderV1Abi } from "../../src/tx/builder.js";
import { clearMacroPayloadAbiParameters } from "../../src/validation/clearmacro.js";
import {
  allocateHostPort,
  chmodStackTree,
  deployFullStackE2EContractsOnAnvil,
  dockerComposeLogs,
  ensureAnvilKeystore,
  forgeBuildFullStackFixtures,
  fundNativeBalance,
  getRepoRoot,
  makeStackWorkDir,
  RELAYER_SIGNER_PRIVATE_KEY,
  runDockerCompose,
  setERC1820RegistryCode,
  waitForHttpOk,
  waitForJsonRpcChainId,
  waitForOzRelayerReady,
  waitForReadyz,
  writeOzRelayerConfig,
  writeProviderRegistry,
} from "../fixtures/docker-stack.js";

const E2E_OZ_API_KEY = "local-e2e-oz-relayer-api-key-32chars!!";
const CHAIN_ID_HEX = "0x7a69" as Hex;

/** Anvil default account #2 — distinct from relayer signer (OZ keystore). */
const E2E_REQUEST_SIGNER_PK =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;

const runStack = process.env.RUN_STACK_E2E === "1";
const describeStack = runStack ? describe : describe.skip;

type RelayPollBody = {
  state: string;
  terminal: boolean;
  transaction?: { hash: string };
  receipt?: { status: string; transactionHash: string };
};

/** GET /v1/relay-executions/:id once terminal `succeeded` includes a success `receipt` (not only tx hash). */
type RelaySucceededWithReceipt = RelayPollBody & {
  state: "succeeded";
  terminal: true;
  transaction: { hash: string };
  receipt: { status: "success"; transactionHash: string };
};

async function pollUntilSucceededWithReceipt(
  getUrl: string,
  timeoutMs: number,
): Promise<RelaySucceededWithReceipt> {
  const started = Date.now();
  let last: RelayPollBody | undefined;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(getUrl);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as RelayPollBody;
    last = body;
    if (
      body.state === "succeeded" &&
      body.terminal === true &&
      typeof body.transaction?.hash === "string" &&
      body.receipt?.status === "success"
    ) {
      return body as RelaySucceededWithReceipt;
    }
    if (
      body.state === "failed" ||
      body.state === "canceled" ||
      body.state === "expired" ||
      body.state === "rejected" ||
      body.state === "reverted"
    ) {
      throw new Error(`Relay terminal state ${body.state}: ${JSON.stringify(body)}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`Relay did not reach succeeded + success receipt within ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
}

describeStack("relay stack (Docker + ClearMacro)", { timeout: 360_000 }, () => {
  it("full local path: SF + forwarder on Anvil, OZ + app, POST relay, poll to succeeded with success receipt", async () => {
    const repoRoot = getRepoRoot();
    const project = `cme2e${process.pid}${randomBytes(3).toString("hex")}`;
    const anvilPort = await allocateHostPort();
    const appPort = await allocateHostPort();
    const ozHostPort = await allocateHostPort();
    const stackDir = makeStackWorkDir();
    const anvilHostRpc = `http://127.0.0.1:${anvilPort}`;
    const appBase = `http://127.0.0.1:${appPort}`;
    const ozHostBase = `http://127.0.0.1:${ozHostPort}`;

    const chain = {
      id: 31337,
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvilHostRpc] } },
    } as const;

    const composeEnv = (): Record<string, string> => ({
      E2E_ANVIL_HOST_PORT: String(anvilPort),
      E2E_APP_HOST_PORT: String(appPort),
      E2E_OZ_HOST_PORT: String(ozHostPort),
      E2E_STACK_CONFIG_DIR: stackDir,
      E2E_OZ_RELAYER_API_KEY: E2E_OZ_API_KEY,
      OZ_KEYSTORE_PASSPHRASE: process.env.OZ_KEYSTORE_PASSPHRASE ?? "change-me",
      OZ_STORAGE_ENCRYPTION_KEY: process.env.OZ_STORAGE_ENCRYPTION_KEY ?? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      OZ_RELAYER_UID: String(typeof process.getuid === "function" ? process.getuid() : 1000),
      OZ_RELAYER_GID: String(typeof process.getgid === "function" ? process.getgid() : 1000),
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

    const publicClient = createPublicClient({ chain, transport: http(anvilHostRpc) });

    try {
      forgeBuildFullStackFixtures(repoRoot);

      runDockerCompose(repoRoot, project, ["up", "-d", "anvil"], composeEnv());
      await waitForJsonRpcChainId(anvilHostRpc, CHAIN_ID_HEX, 45_000);
      await setERC1820RegistryCode({ repoRoot, rpcUrl: anvilHostRpc });

      const relayerSigner = privateKeyToAccount(RELAYER_SIGNER_PRIVATE_KEY);
      const requestSigner = privateKeyToAccount(E2E_REQUEST_SIGNER_PK);

      const deployed = await deployFullStackE2EContractsOnAnvil({
        repoRoot,
        relayerSigner: relayerSigner.address,
        rpcUrl: anvilHostRpc,
      });

      expect(deployed.chainId).toBe(31337);
      expect(deployed.providerName).toBe("macros.superfluid.eth");
      expect(deployed.relayerSigner.toLowerCase()).toBe(relayerSigner.address.toLowerCase());

      await fundNativeBalance(anvilHostRpc, deployed.relayerSigner, 50n * 10n ** 18n);
      await fundNativeBalance(anvilHostRpc, requestSigner.address, 10n * 10n ** 18n);

      await expect(publicClient.getBytecode({ address: deployed.host })).resolves.toMatch(/^0x[0-9a-fA-F]+$/);
      await expect(publicClient.getBytecode({ address: deployed.forwarderAddress })).resolves.toMatch(/^0x[0-9a-fA-F]+$/);

      ensureAnvilKeystore(repoRoot, join(stackDir, "keys"));
      writeOzRelayerConfig(stackDir);
      writeProviderRegistry(stackDir, deployed.forwarderAddress, deployed.macroAddress);
      chmodStackTree(stackDir);

      runDockerCompose(repoRoot, project, ["up", "-d", "redis"], composeEnv());
      runDockerCompose(repoRoot, project, ["up", "-d", "oz-relayer"], composeEnv());
      await waitForOzRelayerReady(ozHostBase, 120_000);
      runDockerCompose(repoRoot, project, ["up", "-d", "app"], composeEnv());

      await waitForHttpOk(`${appBase}/healthz`, 120_000);
      await waitForReadyz(appBase, 120_000);

      const capRes = await fetch(`${appBase}/v1/capabilities`);
      expect(capRes.ok).toBe(true);
      const caps = (await capRes.json()) as {
        providerName: string;
        chains: Array<{
          chainId: number;
          forwarderAddress: string;
          macroPolicy: { mode: "allowlist"; allowedMacros: Array<{ domain: string; address: string }> };
        }>;
      };
      expect(caps.providerName).toBe("macros.superfluid.eth");
      expect(caps.chains).toHaveLength(1);
      expect(caps.chains[0]?.chainId).toBe(31337);
      expect(caps.chains[0]?.forwarderAddress.toLowerCase()).toBe(deployed.forwarderAddress.toLowerCase());
      expect(caps.chains[0]?.macroPolicy).toEqual({
        mode: "allowlist",
        allowedMacros: [{ domain: "e2e", address: deployed.macroAddress.toLowerCase() }],
      });

      const salt = randomBytes(32);
      const nonce = await publicClient.readContract({
        address: deployed.forwarderAddress,
        abi: clearMacroForwarderV1Abi,
        functionName: "getNonce",
        args: [requestSigner.address, 0n],
      });

      const actionParams = encodeAbiParameters([{ type: "bytes32", name: "salt" }], [`0x${salt.toString("hex")}` as Hex]);
      const payload = encodeAbiParameters(clearMacroPayloadAbiParameters, [
        {
          action: { params: actionParams },
          security: {
            domain: "e2e",
            macroContract: deployed.macroAddress,
            provider: "macros.superfluid.eth",
            validAfter: 0n,
            validBefore: 0n,
            nonce,
          },
        },
      ]) as Hex;

      const digest = (await publicClient.readContract({
        address: deployed.forwarderAddress,
        abi: clearMacroForwarderV1Abi,
        functionName: "getDigest",
        args: [deployed.macroAddress as Address, payload],
      })) as Hex;

      const signature = await requestSigner.sign({ hash: digest });

      const postRes = await fetch(`${appBase}/v1/relay-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "clearMacroV1",
          chainId: 31337,
          macroAddress: deployed.macroAddress,
          signerAddress: requestSigner.address,
          payload,
          signature,
          value: "0",
        }),
      });
      expect(postRes.status).toBe(202);
      const created = (await postRes.json()) as {
        state: string;
        terminal: boolean;
        forwarderAddress: string;
        macroAddress: string;
        links: { self: string };
      };
      expect(created.state).toBe("pending");
      expect(created.terminal).toBe(false);
      expect(created.forwarderAddress.toLowerCase()).toBe(deployed.forwarderAddress.toLowerCase());
      expect(created.macroAddress.toLowerCase()).toBe(deployed.macroAddress.toLowerCase());

      const selfUrl = `${appBase}${created.links.self}`;
      const final = await pollUntilSucceededWithReceipt(selfUrl, 180_000);
      expect(final.transaction.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(final.receipt.status).toBe("success");
      expect(final.receipt.transactionHash.toLowerCase()).toBe(final.transaction.hash.toLowerCase());
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
