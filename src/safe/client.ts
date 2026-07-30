import { SafeApiKit, isSafeApiKitChainSupported, type SafeApiKit as SafeApiKitInstance } from "./apiKit.js";
import type { LoadedRegistry } from "../config/registry.js";
import { withRpcFallback } from "../chain/readiness.js";
import { SafeApiError, SafeMessageUnsupportedError, classifySafeApiError } from "./errors.js";
import { hashSafeMessageDigest } from "./messageValidation.js";

export type SafeMessageRecord = {
  safe: string;
  messageHash: string;
  preparedSignature: string | null;
  messageDigest: string;
};

export type SafeClient = {
  getMessage: (input: {
    chainId: number;
    safeMessageHash: string;
    expectedSafe: string;
    expectedDigest: string;
  }) => Promise<SafeMessageRecord>;
  assertEoaOwners: (safeAddress: string, chainId: number) => Promise<void>;
  isChainSupported: (chainId: number) => boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoffMs(attemptIndex: number, baseDelayMs: number): number {
  const exp = baseDelayMs * 2 ** attemptIndex;
  const jitter = Math.floor(Math.random() * Math.min(250, baseDelayMs));
  return exp + jitter;
}

export function computeAuthorizationPollDelayMs(
  attempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const delay = baseDelayMs * 2 ** Math.min(attempts, 6);
  return Math.min(maxDelayMs, delay + Math.floor(Math.random() * 250));
}

export function createSafeClient(input: {
  apiKey: string;
  registry: LoadedRegistry;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  txServiceUrl?: string | null;
}): SafeClient {
  const kits = new Map<number, SafeApiKitInstance>();
  const txServiceUrl = input.txServiceUrl?.trim() || null;

  function kitFor(chainId: number): SafeApiKitInstance {
    const existing = kits.get(chainId);
    if (existing) {
      return existing;
    }
    if (!isSafeApiKitChainSupported(chainId, txServiceUrl)) {
      throw new SafeApiError(
        `Safe Transaction Service is not available for chain ${chainId}.`,
        400,
        false,
        "SAFE_CHAIN_UNSUPPORTED",
      );
    }
    const kit = new SafeApiKit({
      chainId: BigInt(chainId),
      apiKey: input.apiKey,
      ...(txServiceUrl ? { txServiceUrl } : {}),
    });
    kits.set(chainId, kit);
    return kit;
  }

  async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: SafeApiError | undefined;
    for (let attempt = 0; attempt < input.retryMaxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof SafeMessageUnsupportedError) {
          throw error;
        }
        if (error instanceof SafeApiError) {
          if (!error.retryable || attempt >= input.retryMaxAttempts - 1) {
            throw error;
          }
          lastError = error;
          await sleep(jitteredBackoffMs(attempt, input.retryBaseDelayMs));
          continue;
        }
        const classified = classifySafeApiError(error);
        if (!classified.retryable || attempt >= input.retryMaxAttempts - 1) {
          throw classified;
        }
        lastError = classified;
        await sleep(jitteredBackoffMs(attempt, input.retryBaseDelayMs));
      }
    }
    throw lastError ?? new SafeApiError("Safe API request failed.", 502, true, "SAFE_API_ERROR");
  }

  return {
    async getMessage({ chainId, safeMessageHash, expectedSafe, expectedDigest }) {
      const response = await withRetries(() => kitFor(chainId).getMessage(safeMessageHash));
      const safe = String(response.safe ?? "").toLowerCase();
      if (!safe || safe !== expectedSafe.toLowerCase()) {
        throw new SafeMessageUnsupportedError("Safe message safe address does not match signer.");
      }
      const messageDigest = hashSafeMessageDigest(response.message);
      if (messageDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
        throw new SafeMessageUnsupportedError(
          "Safe message EIP-712 digest does not match ClearMacro digest.",
        );
      }
      const preparedSignature =
        typeof response.preparedSignature === "string" && response.preparedSignature.length > 0
          ? response.preparedSignature
          : null;
      return {
        safe,
        messageHash: String(response.messageHash ?? safeMessageHash),
        preparedSignature,
        messageDigest,
      };
    },

    async assertEoaOwners(safeAddress: string, chainId: number): Promise<void> {
      const chain = input.registry.chainsById.get(chainId);
      if (!chain) {
        throw new SafeApiError("Chain not configured.", 400, false, "SAFE_CHAIN_UNSUPPORTED");
      }
      const safeInfo = await withRetries(() => kitFor(chainId).getSafeInfo(safeAddress));
      for (const owner of safeInfo.owners ?? []) {
        const code = await withRpcFallback(chain, async (client) =>
          client.getBytecode({ address: owner as `0x${string}` }),
        );
        if (code && code !== "0x") {
          throw new SafeMessageUnsupportedError(
            "Nested or contract Safe owners are not supported in safeMessageV1.",
          );
        }
      }
    },

    isChainSupported(chainId: number) {
      return isSafeApiKitChainSupported(chainId, txServiceUrl);
    },
  };
}
