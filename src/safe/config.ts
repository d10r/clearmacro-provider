/** EIP-155 shortNames used by app.safe.global deep links (`safe=<shortName>:<address>`). */
const SAFE_APP_CHAIN_PREFIX_BY_CHAIN_ID: Readonly<Record<number, string>> = {
  1: "eth",
  10: "oeth",
  8453: "base",
  42161: "arb1",
  84532: "basesep",
  11155111: "sep",
  11155420: "opsep",
};

export function buildSafeMessageLink(input: {
  chainId: number;
  safeAddress: string;
  safeMessageHash: string;
}): string | null {
  const prefix = SAFE_APP_CHAIN_PREFIX_BY_CHAIN_ID[input.chainId];
  if (!prefix) {
    return null;
  }
  const safe = `${prefix}:${input.safeAddress.toLowerCase()}`;
  return `https://app.safe.global/transactions/msg?safe=${encodeURIComponent(safe)}&messageHash=${encodeURIComponent(input.safeMessageHash)}`;
}
