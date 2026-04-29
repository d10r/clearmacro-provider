import { createPublicClient, http, type PublicClient } from "viem";
import type { LoadedRegistry } from "../config/registry.js";
import type { RegistryChain } from "../config/schema.js";
import type { OzRelayerClient } from "../relayer/client.js";
import { clearMacroForwarderV1Abi } from "../tx/builder.js";

function createClients(chain: RegistryChain): { name: string; client: PublicClient }[] {
  return chain.rpcs.map((rpc) => ({
    name: rpc.name,
    client: createPublicClient({ transport: http(rpc.url) }),
  }));
}

export async function withRpcFallback<T>(
  chain: RegistryChain,
  fn: (client: PublicClient, rpcName: string) => Promise<T>,
): Promise<T> {
  let lastError: Error | undefined;
  for (const entry of createClients(chain)) {
    try {
      return await fn(entry.client, entry.name);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("unknown rpc error");
    }
  }
  throw lastError ?? new Error("No RPC endpoints configured");
}

export async function getForwarderDigest(input: {
  registry: LoadedRegistry;
  chainId: number;
  forwarder: string;
  macro: string;
  params: string;
}): Promise<string> {
  const chain = input.registry.chainsById.get(input.chainId);
  if (!chain) {
    throw new Error("Chain not found");
  }
  return withRpcFallback(chain, async (client) => {
    const digest = await client.readContract({
      address: input.forwarder as `0x${string}`,
      abi: clearMacroForwarderV1Abi,
      functionName: "getDigest",
      args: [input.macro as `0x${string}`, input.params as `0x${string}`],
    });
    return digest;
  });
}

export async function preflightRunMacro(input: {
  chain: RegistryChain;
  forwarder: string;
  macro: string;
  params: string;
  signer: string;
  signature: string;
  msgValue: string;
}): Promise<"ok" | "deterministic_revert" | "rpc_unavailable"> {
  try {
    await withRpcFallback(input.chain, async (client) => {
      await client.simulateContract({
        address: input.forwarder as `0x${string}`,
        abi: clearMacroForwarderV1Abi,
        functionName: "runMacro",
        args: [input.macro as `0x${string}`, input.params as `0x${string}`, input.signer as `0x${string}`, input.signature as `0x${string}`],
        value: BigInt(input.msgValue),
      });
    });
    return "ok";
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("revert") || message.includes("execution reverted") || message.includes("receipt status: failed")) {
      return "deterministic_revert";
    }
    return "rpc_unavailable";
  }
}

export async function evaluateChainReadiness(input: {
  registry: LoadedRegistry;
  chainId: number;
  relayerClient: OzRelayerClient;
}): Promise<{ ready: boolean; reasonCode?: "PROVIDER_NOT_READY" | "RELAYER_UNAVAILABLE" }> {
  const chain = input.registry.chainsById.get(input.chainId);
  if (!chain || !chain.enabled) {
    return { ready: false, reasonCode: "PROVIDER_NOT_READY" };
  }
  try {
    const relayerReady = await input.relayerClient.ready();
    if (!relayerReady) {
      return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
    }
    const relayer = await input.relayerClient.getRelayer(chain.ozRelayerId);
    if (relayer.paused || relayer.system_disabled) {
      return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
    }
    const balance = await withRpcFallback(chain, async (client) => client.getBalance({ address: relayer.address as `0x${string}` }));
    if (balance <= 0n) {
      return { ready: false, reasonCode: "PROVIDER_NOT_READY" };
    }
    return { ready: true };
  } catch {
    return { ready: false, reasonCode: "PROVIDER_NOT_READY" };
  }
}

