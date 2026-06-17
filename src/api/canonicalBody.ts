import { sha256HexUtf8 } from "../db/repositories.js";
import {
  normalizePermit2Request,
  type Permit2RequestInput,
} from "../chain/permit2.js";

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

const sharedFields = (body: {
  chainId: number;
  macroAddress: string;
  signerAddress: string;
  payload: string;
  value?: string;
  forceExecuteAfterPreflightRevert?: boolean;
  clientRequestId?: string | null;
  metadata?: Record<string, string>;
}) => ({
  chainId: body.chainId,
  macroAddress: body.macroAddress.toLowerCase(),
  signerAddress: body.signerAddress.toLowerCase(),
  payload: body.payload,
  value: body.value ?? "0",
  forceExecuteAfterPreflightRevert: body.forceExecuteAfterPreflightRevert ?? false,
  clientRequestId: body.clientRequestId ?? null,
  metadata: sortValue(body.metadata ?? {}),
});

export type ClearMacroV1CreateBodyInput = {
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

export type ClearMacroPermit2V1CreateBodyInput = {
  kind: "clearMacroPermit2V1";
  chainId: number;
  macroAddress: string;
  signerAddress: string;
  payload: string;
  permit2: Permit2RequestInput;
  value?: string;
  forceExecuteAfterPreflightRevert?: boolean;
  clientRequestId?: string | null;
  metadata?: Record<string, string>;
};

export type CanonicalCreateBodyInput =
  | ClearMacroV1CreateBodyInput
  | ClearMacroPermit2V1CreateBodyInput;

export function canonicalCreateBodyJson(body: CanonicalCreateBodyInput): string {
  const normalized =
    body.kind === "clearMacroV1"
      ? {
          kind: body.kind,
          ...sharedFields(body),
          signature: body.signature,
        }
      : {
          kind: body.kind,
          ...sharedFields(body),
          permit2: normalizePermit2Request(body.permit2),
        };
  return JSON.stringify(sortValue(normalized));
}

export function hashCanonicalCreateBody(body: CanonicalCreateBodyInput): string {
  return sha256HexUtf8(canonicalCreateBodyJson(body));
}
