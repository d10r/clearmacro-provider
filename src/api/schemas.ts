import { Type } from "@sinclair/typebox";

const Address = Type.String({ pattern: "^0x[0-9a-fA-F]{40}$" });
const Bytes = Type.String({ pattern: "^0x([0-9a-fA-F]{2})*$" });
const UintString = Type.String({ pattern: "^[0-9]+$" });

export const RelayRequestSchema = Type.Object({
  kind: Type.Union([Type.Literal("clearMacroV1"), Type.Literal("permit2ClearMacroV1")]),
  chainId: Type.Integer({ minimum: 1 }),
  forwarder: Address,
  macro: Address,
  signer: Address,
  params: Bytes,
  signature: Bytes,
  msgValue: Type.Optional(UintString),
  clientRequestId: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const RelayAcceptedResponseSchema = Type.Object({
  requestId: Type.String(),
  status: Type.String(),
  chainId: Type.Integer({ minimum: 1 }),
  kind: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  statusUrl: Type.String(),
});

export const RequestStatusResponseSchema = Type.Object({
  request: Type.Object({
    id: Type.String(),
    state: Type.String(),
    terminal: Type.Boolean(),
    kind: Type.String(),
    chainId: Type.Integer(),
    forwarder: Address,
    macro: Address,
    signer: Address,
    provider: Type.String(),
    clearMacroNonce: UintString,
    validAfter: UintString,
    validBefore: UintString,
    msgValue: UintString,
    relayerId: Type.Optional(Type.String()),
    relayerTransactionId: Type.Optional(Type.String()),
    currentTxHash: Type.Optional(Type.String()),
    lastError: Type.Optional(Type.Any()),
    createdAt: Type.String(),
    updatedAt: Type.String(),
    terminalAt: Type.Optional(Type.String()),
  }),
  relayerTransaction: Type.Optional(
    Type.Object({
      relayerId: Type.String(),
      relayerTransactionId: Type.String(),
      status: Type.String(),
      statusReason: Type.Optional(Type.String()),
      txHash: Type.Optional(Type.String()),
      nonce: Type.Optional(UintString),
      gasLimit: Type.Optional(UintString),
      gasPrice: Type.Optional(UintString),
      maxFeePerGas: Type.Optional(UintString),
      maxPriorityFeePerGas: Type.Optional(UintString),
      submittedAt: Type.Optional(Type.String()),
      confirmedAt: Type.Optional(Type.String()),
      lastPolledAt: Type.Optional(Type.String()),
    }),
  ),
  events: Type.Optional(Type.Array(Type.Any())),
});

