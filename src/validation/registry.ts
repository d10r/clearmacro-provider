import type { LoadedRegistry } from "../config/registry.js";

export type RegistryValidationInput = {
  chainId: number;
  kind: "clearMacroV1" | "permit2ClearMacroV1";
  forwarder: string;
  macro: string;
  provider: string;
  clientId: string;
  apiAuthEnabled: boolean;
};

export function validateRegistryPolicy(registry: LoadedRegistry, input: RegistryValidationInput): { ok: true; ozRelayerId: string; confirmations: number } | { ok: false; code: string; message: string } {
  const chain = registry.chainsById.get(input.chainId);
  if (!chain) {
    return { ok: false, code: "CHAIN_NOT_ALLOWED", message: "Unsupported chain." };
  }
  if (!chain.enabled) {
    return { ok: false, code: "CHAIN_NOT_ALLOWED", message: "Chain disabled." };
  }

  const expectedForwarder = chain.forwarders[input.kind];
  if (expectedForwarder.toLowerCase() !== input.forwarder.toLowerCase()) {
    return { ok: false, code: "VALIDATION_ERROR", message: "Forwarder mismatch." };
  }

  const macro = chain.macros.find((m) => m.address.toLowerCase() === input.macro.toLowerCase());
  if (!macro || !macro.enabled) {
    return { ok: false, code: "MACRO_NOT_ALLOWED", message: "Macro disabled." };
  }
  if (!macro.supportedKinds.includes(input.kind)) {
    return { ok: false, code: "UNSUPPORTED_RELAY_KIND", message: "Macro does not support kind." };
  }
  if (!chain.providers.includes(input.provider)) {
    return { ok: false, code: "PROVIDER_NOT_ALLOWED", message: "Provider disabled." };
  }

  if (input.apiAuthEnabled) {
    const client = registry.clientsById.get(input.clientId);
    if (!client || !client.enabled) {
      return { ok: false, code: "CLIENT_NOT_ALLOWED", message: "Client disabled or unknown." };
    }
    if (!client.allowedChains.includes(input.chainId)) {
      return { ok: false, code: "CLIENT_NOT_ALLOWED", message: "Client chain policy denied." };
    }
    if (!client.allowedProviders.includes(input.provider)) {
      return { ok: false, code: "CLIENT_NOT_ALLOWED", message: "Client provider policy denied." };
    }
    if (!client.allowedMacros.map((m) => m.toLowerCase()).includes(input.macro.toLowerCase())) {
      return { ok: false, code: "CLIENT_NOT_ALLOWED", message: "Client macro policy denied." };
    }
  }

  return { ok: true, ozRelayerId: chain.ozRelayerId, confirmations: chain.confirmations ?? 1 };
}

