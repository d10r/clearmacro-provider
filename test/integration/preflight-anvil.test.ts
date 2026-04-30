import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { preflightRunMacro } from "../../src/chain/readiness.js";
import fixtureArtifact from "../../out/RelayerLikePreflightForwarder.sol/RelayerLikePreflightForwarder.json" with { type: "json" };

const describeAnvil = process.env.RUN_ANVIL_TESTS === "1" ? describe : describe.skip;
const rpcUrl = "http://127.0.0.1:18545";
const chain = {
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
} as const;

let anvil: ChildProcess | undefined;

async function waitForAnvilReady(client: ReturnType<typeof createPublicClient>) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("Anvil did not become ready in time");
}

describeAnvil("preflight contract-backed integration", () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", "18545", "--chain-id", "31337"], {
      stdio: "ignore",
      detached: true,
    });
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    await waitForAnvilReady(client);
  });

  afterAll(() => {
    if (anvil?.pid) {
      process.kill(-anvil.pid, "SIGTERM");
    }
  });

  it("matches relayer-relevant revert conditions and succeeds for valid input", async () => {
    const relayerSigner = privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const requestSigner = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20",
    );
    const other = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103ca4d0907782f6f1b8b9e7a87cf6b315f9f9c4f4",
    );
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account: relayerSigner });

    const macro = "0x00000000000000000000000000000000000000aa" as Address;
    const params = "0x1234";
    const signature = "0x1234";
    const msgValue = 0n;

    const deployHash = await walletClient.deployContract({
      abi: fixtureArtifact.abi,
      bytecode: fixtureArtifact.bytecode.object as `0x${string}`,
      args: [macro, relayerSigner.address, requestSigner.address, keccak256(signature), msgValue],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const forwarder = receipt.contractAddress as Address;

    // The relayer preflight path should classify any call revert as deterministic.
    const deterministic = await preflightRunMacro({
      chain: {
        chainId: 31337,
        forwarderAddress: forwarder,
        rpcUrls: [rpcUrl],
        allowedMacros: [{ domain: "anvil-test", address: macro }],
      },
      forwarder,
      macro,
      params,
      signer: requestSigner.address,
      relayerSigner: relayerSigner.address,
      signature,
      msgValue: msgValue.toString(),
    });
    expect(deterministic).toBe("ok");

    const wrongSignature = await preflightRunMacro({
      chain: {
        chainId: 31337,
        forwarderAddress: forwarder,
        rpcUrls: [rpcUrl],
        allowedMacros: [{ domain: "anvil-test", address: macro }],
      },
      forwarder,
      macro,
      params,
      signer: requestSigner.address,
      relayerSigner: relayerSigner.address,
      signature: "0x9999",
      msgValue: msgValue.toString(),
    });
    expect(wrongSignature).toBe("deterministic_revert");

    // Explicitly assert the contract emits the intended auth error condition.
    await expect(
      publicClient.simulateContract({
        address: forwarder,
        abi: fixtureArtifact.abi,
        functionName: "runMacro",
        args: [macro, params as `0x${string}`, requestSigner.address, signature as `0x${string}`],
        value: msgValue,
        account: other.address,
      }),
    ).rejects.toThrow(/UnauthorizedSender|execution reverted/i);
  });
});
