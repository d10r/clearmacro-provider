import metadata from "@superfluid-finance/metadata";

/** Canonical Superfluid network slug for a chain id, falling back to the numeric id. */
export function networkName(chainId: number): string {
  return metadata.getNetworkByChainId(chainId)?.name ?? String(chainId);
}
