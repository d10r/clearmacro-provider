import { encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clearMacroPayloadAbiParameters } from "../../src/validation/clearmacro.js";

export const TEST_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f094538e7d0f90a33f6f8f6b4a9f4f8f8a8c5d20";

export function buildClearMacroParams(overrides?: {
  provider?: string;
  macroContract?: `0x${string}`;
  validAfter?: bigint;
  validBefore?: bigint;
  nonce?: bigint;
  actionParams?: `0x${string}`;
}) {
  return encodeAbiParameters(clearMacroPayloadAbiParameters, [
    {
      action: { params: overrides?.actionParams ?? "0x1234" },
      security: {
        domain: "test",
        macroContract: overrides?.macroContract ?? "0x0000000000000000000000000000000000000002",
        provider: overrides?.provider ?? "macros.superfluid.eth",
        validAfter: overrides?.validAfter ?? 0n,
        validBefore: overrides?.validBefore ?? 0n,
        nonce: overrides?.nonce ?? 1n,
      },
    },
  ]);
}

export async function buildRelayPayload(overrides?: {
  signer?: `0x${string}`;
  signature?: `0x${string}`;
  kind?: "clearMacroV1";
  payload?: `0x${string}`;
  chainId?: number;
  macroAddress?: `0x${string}`;
  signerAddress?: `0x${string}`;
  value?: string;
  forceExecuteAfterPreflightRevert?: boolean;
  clientRequestId?: string;
  metadata?: Record<string, string>;
}) {
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const digest = (`0x${"11".repeat(32)}`) as `0x${string}`;
  const signature = overrides?.signature ?? ((await account.sign({ hash: digest })) as `0x${string}`);
  return {
    kind: overrides?.kind ?? "clearMacroV1",
    chainId: overrides?.chainId ?? 1,
    macroAddress: overrides?.macroAddress ?? "0x0000000000000000000000000000000000000002",
    signerAddress: overrides?.signerAddress ?? overrides?.signer ?? account.address,
    payload: overrides?.payload ?? (buildClearMacroParams() as `0x${string}`),
    signature,
    value: overrides?.value,
    forceExecuteAfterPreflightRevert: overrides?.forceExecuteAfterPreflightRevert,
    clientRequestId: overrides?.clientRequestId,
    metadata: overrides?.metadata,
  };
}
