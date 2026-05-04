import { createPublicClient, http, type PublicClient } from "viem";
import type { LoadedRegistry } from "../config/registry.js";
import type { RegistryChain } from "../config/schema.js";
import type { OzRelayerClient } from "../relayer/client.js";
import { clearMacroForwarderV1Abi } from "../tx/builder.js";
import { validateEoaSignature } from "../validation/clearmacro.js";

const erc1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "_hash", type: "bytes32" },
      { name: "_signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

const ERC1271_MAGIC_VALUE = "0x1626ba7e";

function isRpcUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("econn") ||
    message.includes("eai_again") ||
    message.includes("network") ||
    message.includes("http request failed") ||
    /\b5\d\d\b/.test(message) ||
    message.includes("429")
  );
}

function rpcEntries(chain: RegistryChain): { name: string; url: string }[] {
  const urls = chain.rpcUrls ?? [];
  return urls.map((url, index) => ({ name: `rpc-${index}`, url }));
}

function createClients(chain: RegistryChain): { name: string; client: PublicClient }[] {
  return rpcEntries(chain).map((rpc) => ({
    name: rpc.name,
    client: createPublicClient({ transport: http(rpc.url) }),
  }));
}

export async function withRpcFallback<T>(chain: RegistryChain, fn: (client: PublicClient, rpcName: string) => Promise<T>): Promise<T> {
  const entries = createClients(chain);
  if (entries.length === 0) {
    throw new Error("No RPC endpoints configured for chain");
  }
  let lastError: Error | undefined;
  for (const entry of entries) {
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
  relayerSigner: string;
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
        account: input.relayerSigner as `0x${string}`,
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
  if (!chain) {
    return { ready: false, reasonCode: "PROVIDER_NOT_READY" };
  }
  const relayerId = input.registry.relayerIdByChainId.get(input.chainId);
  if (!relayerId) {
    return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
  }
  let relayerReady: boolean;
  try {
    relayerReady = await input.relayerClient.ready();
  } catch {
    return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
  }
  if (!relayerReady) {
    return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
  }
  let relayer: { address: string; paused: boolean; system_disabled: boolean; network?: string | null; network_type?: string | null };
  try {
    relayer = await input.relayerClient.getRelayer(relayerId);
  } catch {
    return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
  }
  if (relayer.paused || relayer.system_disabled) {
    return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
  }
  if (relayer.network_type && relayer.network) {
    try {
      await input.relayerClient.getNetwork(relayer.network_type, relayer.network);
    } catch {
      return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
    }
  }
  try {
    const balance = await withRpcFallback(chain, async (client) => client.getBalance({ address: relayer.address as `0x${string}` }));
    if (balance <= 0n) {
      return { ready: false, reasonCode: "PROVIDER_NOT_READY" };
    }
    return { ready: true };
  } catch {
    return { ready: false, reasonCode: "PROVIDER_NOT_READY" };
  }
}

export async function validateRelaySignature(input: {
  registry: LoadedRegistry;
  chainId: number;
  signer: string;
  digest: string;
  signature: string;
}): Promise<boolean> {
  const eoaValid = await validateEoaSignature({
    expectedSigner: input.signer.toLowerCase(),
    digest: input.digest,
    signature: input.signature,
  });
  if (eoaValid) {
    return true;
  }
  const chain = input.registry.chainsById.get(input.chainId);
  if (!chain) {
    return false;
  }
  let code: `0x${string}` | undefined;
  try {
    code = await withRpcFallback(chain, async (client) => client.getBytecode({ address: input.signer as `0x${string}` }));
  } catch (error) {
    throw new Error(`RPC unavailable during signature validation: ${error instanceof Error ? error.message : "unknown"}`, {
      cause: error,
    });
  }
  if (!code || code === "0x") {
    return false;
  }
  try {
    const value = await withRpcFallback(chain, async (client) =>
      client.readContract({
        address: input.signer as `0x${string}`,
        abi: erc1271Abi,
        functionName: "isValidSignature",
        args: [input.digest as `0x${string}`, input.signature as `0x${string}`],
      }),
    );
    return value.toLowerCase().startsWith(ERC1271_MAGIC_VALUE);
  } catch (error) {
    if (isRpcUnavailableError(error)) {
      throw new Error(`RPC unavailable during ERC-1271 validation: ${error instanceof Error ? error.message : "unknown"}`, {
        cause: error,
      });
    }
    return false;
  }
}
