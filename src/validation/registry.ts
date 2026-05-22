import type { LoadedRegistry } from "../config/registry.js";

export function assertMacroAllowed(
  registry: LoadedRegistry,
  input: { chainId: number; domain: string; macroAddress: string },
): { ok: true } | { ok: false; code: string; message: string } {
  const chain = registry.chainsById.get(input.chainId);
  if (!chain) {
    return { ok: false, code: "CHAIN_NOT_ALLOWED", message: "Unsupported chain." };
  }
  if (chain.macroPolicy.mode === "open") {
    return { ok: true };
  }
  const normalizedDomain = input.domain.trim();
  const normalizedAddress = input.macroAddress.toLowerCase();
  const allowed = chain.macroPolicy.allowedMacros.some(
    (m) => m.domain === normalizedDomain && m.address.toLowerCase() === normalizedAddress,
  );
  if (!allowed) {
    return { ok: false, code: "MACRO_NOT_ALLOWED", message: "Macro is not allowlisted for this chain." };
  }
  return { ok: true };
}
