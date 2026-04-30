import type { LoadedRegistry } from "../config/registry.js";

export function assertMacroAllowed(registry: LoadedRegistry, input: { chainId: number; domain: string; macroAddress: string }): { ok: true } | { ok: false; code: string; message: string } {
  const chain = registry.chainsById.get(input.chainId);
  if (!chain) {
    return { ok: false, code: "CHAIN_NOT_ALLOWED", message: "Unsupported chain." };
  }
  const allowed = chain.allowedMacros.some(
    (m) => m.domain === input.domain && m.address.toLowerCase() === input.macroAddress.toLowerCase(),
  );
  if (!allowed) {
    return { ok: false, code: "MACRO_NOT_ALLOWED", message: "Macro is not allowlisted for this chain." };
  }
  return { ok: true };
}
