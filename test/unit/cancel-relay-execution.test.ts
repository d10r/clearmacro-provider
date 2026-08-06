import { describe, expect, it } from "vitest";
import { isClientCancelable } from "../../src/api/cancelRelayExecution.js";
import type { RelayExecutionRow } from "../../src/db/repositories.js";

function row(overrides: Partial<RelayExecutionRow>): RelayExecutionRow {
  return {
    id: "exec-1",
    clientId: "anonymous",
    clientRequestId: null,
    requestBodyHash: "hash",
    digest: `0x${"11".repeat(32)}`,
    domain: "test",
    kind: "clearMacroV1",
    state: "pending",
    terminal: 0,
    chainId: 1,
    ozRelayerId: "relayer-main",
    ozTransactionId: null,
    forwarderAddress: "0x0000000000000000000000000000000000000001",
    macroAddress: "0x0000000000000000000000000000000000000002",
    signerAddress: "0x0000000000000000000000000000000000000003",
    nonce: "1",
    validAfter: "0",
    validBefore: "9999999999",
    value: "0",
    payload: "0x",
    signature: null,
    permit2Json: null,
    metadataJson: "{}",
    forceAfterPreflightRevert: 0,
    authorizationType: null,
    safeMessageHash: null,
    signatureSource: null,
    authorizationPollAt: null,
    authorizationPollAttempts: 0,
    authorizationLastErrorJson: null,
    currentTransactionHash: null,
    transactionHashesJson: "[]",
    receiptJson: null,
    requiredConfirmations: null,
    lastErrorJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    terminalAt: null,
    ...overrides,
  };
}

describe("isClientCancelable", () => {
  it("allows awaiting_authorization and pre-submit pending", () => {
    expect(isClientCancelable(row({ state: "awaiting_authorization" }))).toBe(true);
    expect(isClientCancelable(row({ state: "pending", ozTransactionId: null }))).toBe(true);
  });

  it("rejects submitted, claimed, post-submit pending, and terminals", () => {
    expect(isClientCancelable(row({ state: "pending", ozTransactionId: "oz-1" }))).toBe(false);
    expect(isClientCancelable(row({ state: "pending", ozTransactionId: "claim:abc" }))).toBe(false);
    expect(isClientCancelable(row({ state: "submitted", ozTransactionId: "oz-1" }))).toBe(false);
    expect(isClientCancelable(row({ state: "canceled", terminal: 1 }))).toBe(false);
    expect(isClientCancelable(row({ state: "succeeded", terminal: 1 }))).toBe(false);
  });
});
