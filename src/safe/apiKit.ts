import SafeApiKitImport from "@safe-global/api-kit";
import type { SafeApiKitConfig, SafeInfoResponse, SafeMessage } from "@safe-global/api-kit";

export type { SafeInfoResponse, SafeMessage };

export type SafeApiKit = {
  getMessage: (messageHash: string) => Promise<SafeMessage>;
  getSafeInfo: (safeAddress: string) => Promise<SafeInfoResponse>;
};

type SafeApiKitConstructor = new (config: SafeApiKitConfig) => SafeApiKit;

// api-kit's default export is constructable at runtime but not typed as such with verbatimModuleSyntax.
export const SafeApiKit = SafeApiKitImport as unknown as SafeApiKitConstructor;

const supportedChainIds = new Set<string>();

function supportCacheKey(chainId: number, txServiceUrl?: string | null): string {
  return txServiceUrl ? `${chainId}:${txServiceUrl}` : String(chainId);
}

export function isSafeApiKitChainSupported(
  chainId: number,
  txServiceUrl?: string | null,
): boolean {
  const cacheKey = supportCacheKey(chainId, txServiceUrl);
  if (supportedChainIds.has(cacheKey)) {
    return true;
  }
  try {
    new SafeApiKit({
      chainId: BigInt(chainId),
      ...(txServiceUrl
        ? { txServiceUrl }
        : { apiKey: "probe" }),
    });
    supportedChainIds.add(cacheKey);
    return true;
  } catch {
    return false;
  }
}
