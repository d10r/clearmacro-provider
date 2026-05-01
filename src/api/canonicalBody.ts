import { sha256HexUtf8 } from "../db/repositories.js";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = sortValue(record[key]);
    }
    return out;
  }
  return value;
}

export type CanonicalCreateBodyInput = {
  kind: "clearMacroV1";
  chainId: number;
  macroAddress: string;
  signerAddress: string;
  payload: string;
  signature: string;
  value?: string;
  forceExecuteAfterPreflightRevert?: boolean;
  clientRequestId?: string | null;
  metadata?: Record<string, string>;
};

export function canonicalCreateBodyJson(body: CanonicalCreateBodyInput): string {
  const normalized: Record<string, unknown> = {
    kind: body.kind,
    chainId: body.chainId,
    macroAddress: body.macroAddress.toLowerCase(),
    signerAddress: body.signerAddress.toLowerCase(),
    payload: body.payload,
    signature: body.signature,
    value: body.value ?? "0",
    forceExecuteAfterPreflightRevert: body.forceExecuteAfterPreflightRevert ?? false,
    clientRequestId: body.clientRequestId ?? null,
    metadata: sortValue(body.metadata ?? {}),
  };
  return JSON.stringify(sortValue(normalized));
}

export function hashCanonicalCreateBody(body: CanonicalCreateBodyInput): string {
  return sha256HexUtf8(canonicalCreateBodyJson(body));
}
