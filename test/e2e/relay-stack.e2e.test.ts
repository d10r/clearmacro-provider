import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { clearMacroForwarderV1Abi } from "../../src/tx/builder.js";
import { buildClearMacroParams, TEST_PRIVATE_KEY } from "../fixtures/relay-fixtures.js";
import {
  allocateHostPort,
  deployRelayerLikeForwarder,
  digestForRelayerLikeFixture,
  dockerComposeLogs,
  fundNativeBalance,
  getRepoRoot,
  makeStackWorkDir,
  RELAYER_SIGNER_PRIVATE_KEY,
  runDockerCompose,
  waitForHttpOk,
  waitForJsonRpcChainId,
  waitForOzRelayerReady,
  waitForReadyz,
  writeOzRelayerConfig,
  writeProviderRegistry,
  ensureAnvilKeystore,
} from "../fixtures/docker-stack.js";

const E2E_OZ_API_KEY = "local-e2e-oz-relayer-api-key-32chars!!";
const CHAIN_ID_HEX = "0x7a69" as Hex;
const MACRO: Address = "0x00000000000000000000000000000000000000aa";

const runStack = process.env.RUN_STACK_E2E === "1";
const describeStack = runStack ? describe : describe.skip;

describeStack("relay stack (Docker)", { timeout: 180_000 }, () => {
  it("capabilities, POST relay execution, worker submits via OZ, poll to succeeded", async () => {
    const repoRoot = getRepoRoot();
    const project = `cme2e${process.pid}${randomBytes(3).toString("hex")}`;
    const anvilPort = await allocateHostPort();
    const appPort = await allocateHostPort();
    const ozHostPort = await allocateHostPort();
    const stackDir = makeStackWorkDir();
    const anvilHostRpc = `http://127.0.0.1:${anvilPort}`;
    const appBase = `http://127.0.0.1:${appPort}`;
    const ozHostBase = `http://127.0.0.1:${ozHostPort}`;

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
      runDockerCompose(repoRoot, project, ["up", "-d", "anvil"], composeEnv());
      await waitForJsonRpcChainId(anvilHostRpc, CHAIN_ID_HEX, 45_000);

      const relayerSigner = privateKeyToAccount(RELAYER_SIGNER_PRIVATE_KEY);
      const requestSigner = privateKeyToAccount(TEST_PRIVATE_KEY as Hex);
      const payload = buildClearMacroParams({
        domain: "e2e",
        macroContract: MACRO,
        provider: "macros.superfluid.eth",
      }) as Hex;

      const digest = digestForRelayerLikeFixture(MACRO, payload);
      const signature = (await requestSigner.sign({ hash: digest })) as Hex;

      await fundNativeBalance(anvilHostRpc, relayerSigner.address, BigInt(100) * 10n ** 18n);

      const forwarder = await deployRelayerLikeForwarder({
        rpcUrl: anvilHostRpc,
        relayerSignerAddress: relayerSigner.address,
        requestSignerAddress: requestSigner.address,
        macro: MACRO,
        payload,
        signature,
      });

      const chain = {
        id: 31337,
        name: "anvil",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [anvilHostRpc] } },
      } as const;
      const pc = createPublicClient({ chain, transport: http(anvilHostRpc) });
      const onchainDigest = (await pc.readContract({
        address: forwarder,
        abi: clearMacroForwarderV1Abi,
        functionName: "getDigest",
        args: [MACRO, payload],
      })) as Hex;
      expect(onchainDigest.toLowerCase()).toBe(digest.toLowerCase());

      ensureAnvilKeystore(repoRoot, join(stackDir, "keys"));
      writeOzRelayerConfig(stackDir);
      writeProviderRegistry(stackDir, forwarder);

      runDockerCompose(repoRoot, project, ["up", "-d", "redis", "oz-relayer"], composeEnv());
      try {
        await waitForOzRelayerReady(ozHostBase, 90_000);
      } catch (error) {
        failWithLogs(`OZ relayer did not become ready: ${error instanceof Error ? error.message : String(error)}`);
      }
      runDockerCompose(repoRoot, project, ["up", "-d", "app"], composeEnv());

      await waitForHttpOk(`${appBase}/healthz`, 90_000);
      await waitForReadyz(appBase, 90_000);

      const cap = await fetch(`${appBase}/v1/capabilities`);
      expect(cap.status).toBe(200);
      const capBody = (await cap.json()) as {
        providerName: string;
        chains: Array<{ chainId: number; forwarderAddress: string }>;
      };
      expect(capBody.providerName).toBe("macros.superfluid.eth");
      expect(capBody.chains?.length).toBe(1);
      expect(capBody.chains?.[0]?.chainId).toBe(31337);
      expect(capBody.chains?.[0]?.forwarderAddress?.toLowerCase()).toBe(forwarder.toLowerCase());

      const createBody = {
        kind: "clearMacroV1" as const,
        chainId: 31337,
        macroAddress: MACRO,
        signerAddress: requestSigner.address,
        payload,
        signature,
      };
      const post = await fetch(`${appBase}/v1/relay-executions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createBody),
      });
      if (post.status !== 202) {
        const t = await post.text();
        failWithLogs(`POST expected 202, got ${post.status}: ${t}`);
      }
      const created = (await post.json()) as { id: string; state: string; forwarderAddress?: string; transaction?: unknown };
      expect(created.state).toBe("pending");
      expect(created.forwarderAddress?.toLowerCase()).toBe(forwarder.toLowerCase());
      expect(created.transaction).toBeUndefined();

      const deadline = Date.now() + 120_000;
      let last: { state?: string; transaction?: { hash?: string } } = {};
      while (Date.now() < deadline) {
        const g = await fetch(`${appBase}/v1/relay-executions/${created.id}`);
        if (!g.ok) {
          failWithLogs(`GET execution ${g.status}`);
        }
        last = (await g.json()) as typeof last;
        if (last.state === "succeeded" && last.transaction?.hash) {
          break;
        }
        if (last.state === "failed" || last.state === "reverted" || last.state === "rejected") {
          failWithLogs(`terminal state ${last.state}: ${JSON.stringify(last)}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(last.state).toBe("succeeded");
      expect(last.transaction?.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    } finally {
      try {
        runDockerCompose(repoRoot, project, ["down", "-v", "--remove-orphans"], composeEnv());
      } catch {
        // ignore teardown errors
      }
      try {
        rmSync(stackDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
