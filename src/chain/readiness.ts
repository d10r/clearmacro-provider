import { createPublicClient, http, type PublicClient } from "viem";
import type { LoadedRegistry } from "../config/registry.js";
import type { RegistryChain } from "../config/schema.js";
import type { OzRelayerClient } from "../relayer/client.js";
import { OzRelayerRateLimitError } from "../relayer/errors.js";
import { clearMacroForwarderV1Abi } from "./clearMacroForwarderV1Abi.js";
import {
  buildPermit2Context,
  PERMIT2_ADDRESS,
  type Permit2Context,
  type StoredPermit2Json,
} from "./permit2.js";
import { validateEoaSignature } from "../validation/clearmacro.js";

const permit2Abi = [
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

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

/** Shared forwarder/macro/payload triple (HTTP: `forwarderAddress`, `macroAddress`, `payload`). */
export type ClearMacroForwarderPayload = {
  forwarder: string;
  macro: string;
  encodedPayload: string;
};

/** Args for `runMacro` / preflight (adds `signer`). */
export type ClearMacroForwarderCall = ClearMacroForwarderPayload & {
  signer: string;
};

export async function getForwarderDigest(
  input: ClearMacroForwarderPayload & {
    registry: LoadedRegistry;
    chainId: number;
  },
): Promise<string> {
  const chain = input.registry.chainsById.get(input.chainId);
  if (!chain) {
    throw new Error("Chain not found");
  }
  return withRpcFallback(chain, async (client) => {
    const digest = await client.readContract({
      address: input.forwarder as `0x${string}`,
      abi: clearMacroForwarderV1Abi,
      functionName: "getDigest",
      args: [input.macro as `0x${string}`, input.encodedPayload as `0x${string}`],
    });
    return digest;
  });
}

export async function getPermit2WitnessStructHash(
  input: ClearMacroForwarderPayload & {
    registry: LoadedRegistry;
    chainId: number;
    upgradeSuperToken: string;
  },
): Promise<`0x${string}`> {
  const chain = input.registry.chainsById.get(input.chainId);
  if (!chain) {
    throw new Error("Chain not found");
  }
  return withRpcFallback(chain, async (client) =>
    client.readContract({
      address: input.forwarder as `0x${string}`,
      abi: clearMacroForwarderV1Abi,
      functionName: "getPermit2WitnessStructHash",
      args: [
        input.macro as `0x${string}`,
        input.encodedPayload as `0x${string}`,
        input.upgradeSuperToken as `0x${string}`,
      ],
    }),
  );
}

export async function getPermit2WitnessTypeString(
  input: ClearMacroForwarderPayload & {
    registry: LoadedRegistry;
    chainId: number;
  },
): Promise<string> {
  const chain = input.registry.chainsById.get(input.chainId);
  if (!chain) {
    throw new Error("Chain not found");
  }
  return withRpcFallback(chain, async (client) =>
    client.readContract({
      address: input.forwarder as `0x${string}`,
      abi: clearMacroForwarderV1Abi,
      functionName: "getPermit2WitnessTypeString",
      args: [input.macro as `0x${string}`, input.encodedPayload as `0x${string}`],
    }),
  );
}

export async function getPermit2DomainSeparator(
  chain: RegistryChain,
): Promise<`0x${string}`> {
  return withRpcFallback(chain, async (client) =>
    client.readContract({
      address: PERMIT2_ADDRESS,
      abi: permit2Abi,
      functionName: "DOMAIN_SEPARATOR",
    }),
  );
}

export async function resolvePermit2Context(input: {
  chain: RegistryChain;
  forwarder: string;
  macro: string;
  encodedPayload: string;
  owner: string;
  permit2: StoredPermit2Json;
}): Promise<Permit2Context> {
  const [witness, witnessTypeString] = await Promise.all([
    withRpcFallback(input.chain, async (client) =>
      client.readContract({
        address: input.forwarder as `0x${string}`,
        abi: clearMacroForwarderV1Abi,
        functionName: "getPermit2WitnessStructHash",
        args: [
          input.macro as `0x${string}`,
          input.encodedPayload as `0x${string}`,
          input.permit2.upgradeSuperToken as `0x${string}`,
        ],
      }),
    ),
    withRpcFallback(input.chain, async (client) =>
      client.readContract({
        address: input.forwarder as `0x${string}`,
        abi: clearMacroForwarderV1Abi,
        functionName: "getPermit2WitnessTypeString",
        args: [
          input.macro as `0x${string}`,
          input.encodedPayload as `0x${string}`,
        ],
      }),
    ),
  ]);
  return buildPermit2Context({
    permit2: input.permit2,
    owner: input.owner,
    witness,
    witnessTypeString,
  });
}

export type ChainReadinessReasonCode = "PROVIDER_NOT_READY" | "RELAYER_UNAVAILABLE" | "RELAYER_RATE_LIMITED";

export type ChainReadinessResult = { ready: boolean; reasonCode?: ChainReadinessReasonCode };

export type ReadinessOzRetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoffMs(attemptIndex: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** attemptIndex;
  const jitter = Math.floor(Math.random() * Math.min(250, baseDelayMs));
  return exp + jitter;
}

/** Retries only on `OzRelayerRateLimitError`; other errors propagate immediately. */
export async function withOzRateLimitRetries<T>(fn: () => Promise<T>, opts: ReadinessOzRetryOptions | undefined): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (e instanceof OzRelayerRateLimitError && attempt < maxAttempts - 1) {
        const fromServer = e.retryAfterMs;
        const delay =
          fromServer !== undefined && fromServer > 0
            ? Math.min(5000, fromServer + Math.floor(Math.random() * 50))
            : jitteredBackoffMs(attempt, baseDelayMs);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

function classifyOzReadinessFailure(error: unknown): ChainReadinessReasonCode {
  if (error instanceof OzRelayerRateLimitError) {
    return "RELAYER_RATE_LIMITED";
  }
  return "RELAYER_UNAVAILABLE";
}

export async function preflightRunMacro(
  input: ClearMacroForwarderCall & {
    chain: RegistryChain;
    relayerSigner: string;
    signature: string;
    msgValue: string;
  },
): Promise<"ok" | "deterministic_revert" | "rpc_unavailable"> {
  try {
    await withRpcFallback(input.chain, async (client) => {
      await client.simulateContract({
        address: input.forwarder as `0x${string}`,
        abi: clearMacroForwarderV1Abi,
        functionName: "runMacro",
        args: [
          input.macro as `0x${string}`,
          input.encodedPayload as `0x${string}`,
          input.signer as `0x${string}`,
          input.signature as `0x${string}`,
        ],
        account: input.relayerSigner as `0x${string}`,
        value: BigInt(input.msgValue),
      });
    });
    return "ok";
  } catch (error) {
    return classifyPreflightError(error);
  }
}

export async function preflightRunPermit2AndMacro(
  input: ClearMacroForwarderPayload & {
    chain: RegistryChain;
    relayerSigner: string;
    permit2Context: Permit2Context;
    msgValue: string;
  },
): Promise<"ok" | "deterministic_revert" | "rpc_unavailable"> {
  try {
    await withRpcFallback(input.chain, async (client) => {
      await client.simulateContract({
        address: input.forwarder as `0x${string}`,
        abi: clearMacroForwarderV1Abi,
        functionName: "runPermit2AndMacro",
        args: [
          input.permit2Context,
          input.macro as `0x${string}`,
          input.encodedPayload as `0x${string}`,
        ],
        account: input.relayerSigner as `0x${string}`,
        value: BigInt(input.msgValue),
      });
    });
    return "ok";
  } catch (error) {
    return classifyPreflightError(error);
  }
}

function classifyPreflightError(
  error: unknown,
): "deterministic_revert" | "rpc_unavailable" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("revert") ||
    message.includes("execution reverted") ||
    message.includes("receipt status: failed")
  ) {
    return "deterministic_revert";
  }
  return "rpc_unavailable";
}

export async function evaluateChainReadiness(input: {
  registry: LoadedRegistry;
  chainId: number;
  relayerClient: OzRelayerClient;
  ozRetry?: ReadinessOzRetryOptions;
}): Promise<ChainReadinessResult> {
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
    relayerReady = await withOzRateLimitRetries(() => input.relayerClient.ready(), input.ozRetry);
  } catch (error) {
    return { ready: false, reasonCode: classifyOzReadinessFailure(error) };
  }
  if (!relayerReady) {
    return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
  }
  let relayer: { address: string; paused: boolean; system_disabled: boolean; network?: string | null; network_type?: string | null };
  try {
    relayer = await withOzRateLimitRetries(() => input.relayerClient.getRelayer(relayerId), input.ozRetry);
  } catch (error) {
    return { ready: false, reasonCode: classifyOzReadinessFailure(error) };
  }
  if (relayer.paused || relayer.system_disabled) {
    return { ready: false, reasonCode: "RELAYER_UNAVAILABLE" };
  }
  if (relayer.network_type && relayer.network) {
    const nt = relayer.network_type;
    const nn = relayer.network;
    try {
      await withOzRateLimitRetries(() => input.relayerClient.getNetwork(nt, nn), input.ozRetry);
    } catch (error) {
      return { ready: false, reasonCode: classifyOzReadinessFailure(error) };
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
