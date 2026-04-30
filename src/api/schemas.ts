import { Type } from "@sinclair/typebox";

const Address = Type.String({ pattern: "^0x[0-9a-fA-F]{40}$" });
const Bytes = Type.String({ pattern: "^0x([0-9a-fA-F]{2})*$" });
const UintString = Type.String({ pattern: "^[0-9]+$" });
const Bytes32 = Type.String({ pattern: "^0x[0-9a-fA-F]{64}$" });

export const CreateRelayExecutionRequestSchema = Type.Object({
  kind: Type.Literal("clearMacroV1"),
  chainId: Type.Integer({ minimum: 1 }),
  macroAddress: Address,
  signerAddress: Address,
  payload: Bytes,
  signature: Bytes,
  value: Type.Optional(UintString),
  forceExecuteAfterPreflightRevert: Type.Optional(Type.Boolean()),
  clientRequestId: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const RelayExecutionErrorSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  category: Type.Union([
    Type.Literal("user"),
    Type.Literal("provider"),
    Type.Literal("chain"),
    Type.Literal("relayer"),
    Type.Literal("unknown"),
  ]),
  retryable: Type.Boolean(),
});

const RelayExecutionReceiptSchema = Type.Object({
  transactionHash: Bytes32,
  blockNumber: UintString,
  blockHash: Type.Optional(Bytes32),
  status: Type.Union([Type.Literal("success"), Type.Literal("reverted")]),
  gasUsed: Type.Optional(UintString),
});

const RelayExecutionTransactionSchema = Type.Object({
  hash: Bytes32,
  from: Type.Optional(Address),
  to: Address,
  submittedAt: Type.Optional(Type.String()),
});

export const RelayExecutionResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  terminal: Type.Boolean(),
  kind: Type.Literal("clearMacroV1"),
  chainId: Type.Integer({ minimum: 1 }),
  clientRequestId: Type.Optional(Type.String()),
  metadata: Type.Record(Type.String(), Type.String()),
  forwarderAddress: Address,
  macroAddress: Address,
  signerAddress: Address,
  nonce: UintString,
  validity: Type.Object({
    validAfter: UintString,
    validBefore: UintString,
  }),
  value: UintString,
  transaction: Type.Optional(RelayExecutionTransactionSchema),
  receipt: Type.Optional(RelayExecutionReceiptSchema),
  error: Type.Optional(RelayExecutionErrorSchema),
  timestamps: Type.Object({
    createdAt: Type.String(),
    updatedAt: Type.String(),
    terminalAt: Type.Optional(Type.String()),
  }),
  links: Type.Object({
    self: Type.String(),
  }),
});

export const RelayExecutionEventsResponseSchema = Type.Intersect([
  RelayExecutionResponseSchema,
  Type.Object({ events: Type.Optional(Type.Array(Type.Any())) }),
]);

export const CapabilitiesResponseSchema = Type.Object({
  providerName: Type.String(),
  chains: Type.Array(
    Type.Object({
      chainId: Type.Integer({ minimum: 1 }),
      forwarderAddress: Address,
    }),
  ),
});

export const ErrorBodySchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    category: Type.Union([
      Type.Literal("user"),
      Type.Literal("provider"),
      Type.Literal("chain"),
      Type.Literal("relayer"),
      Type.Literal("auth"),
      Type.Literal("validation"),
      Type.Literal("unknown"),
    ]),
    retryable: Type.Boolean(),
    executionId: Type.Union([Type.String(), Type.Null()]),
    details: Type.Record(Type.String(), Type.Any()),
  }),
});
