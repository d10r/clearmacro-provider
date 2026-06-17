import { describe, expect, it } from "vitest";
import { projectRelayerState } from "../../src/relayer/mapper.js";

describe("projectRelayerState", () => {
  it("maps submitted without hash to pending", () => {
    expect(
      projectRelayerState({
        status: "submitted",
        statusReason: null,
        hash: null,
        confirmedAt: null,
        requiredConfirmations: 1,
      }).state,
    ).toBe("pending");
  });

  it("maps hash-presence statuses to submitted", () => {
    expect(
      projectRelayerState({
        status: "pending",
        statusReason: null,
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: null,
        requiredConfirmations: 1,
      }).state,
    ).toBe("submitted");
  });

  it("keeps confirmed without receipt in submitted until receipt is available", () => {
    expect(
      projectRelayerState({
        status: "confirmed",
        statusReason: null,
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: new Date().toISOString(),
        requiredConfirmations: 1,
      }).state,
    ).toBe("submitted");
  });

  it("maps confirmed with success receipt to succeeded", () => {
    expect(
      projectRelayerState({
        status: "confirmed",
        statusReason: null,
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: new Date().toISOString(),
        receipt: {
          transactionHash: `0x${"ab".repeat(32)}`,
          blockNumber: "1",
          status: "success",
        },
        requiredConfirmations: 1,
      }).state,
    ).toBe("succeeded");
  });

  it("maps revert-like failed to reverted", () => {
    expect(
      projectRelayerState({
        status: "failed",
        statusReason: "execution reverted",
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: null,
        requiredConfirmations: 1,
      }).state,
    ).toBe("reverted");
  });

  it("maps generic failed to failed", () => {
    expect(
      projectRelayerState({
        status: "failed",
        statusReason: "rpc unavailable",
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: null,
        requiredConfirmations: 1,
      }).state,
    ).toBe("failed");
  });

  it("maps receipt status reverted to reverted", () => {
    expect(
      projectRelayerState({
        status: "mined",
        statusReason: null,
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: null,
        receipt: {
          transactionHash: `0x${"ab".repeat(32)}`,
          blockNumber: "1",
          status: "reverted",
        },
        requiredConfirmations: 1,
      }).state,
    ).toBe("reverted");
  });

  it("keeps submitted until confirmations finalize", () => {
    expect(
      projectRelayerState({
        status: "mined",
        statusReason: null,
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: null,
        receipt: {
          transactionHash: `0x${"ab".repeat(32)}`,
          blockNumber: "1",
          status: "success",
        },
        requiredConfirmations: 3,
      }).state,
    ).toBe("submitted");
  });

  it("succeeds once confirmations are satisfied", () => {
    expect(
      projectRelayerState({
        status: "mined",
        statusReason: null,
        hash: `0x${"ab".repeat(32)}`,
        confirmedAt: new Date().toISOString(),
        receipt: {
          transactionHash: `0x${"ab".repeat(32)}`,
          blockNumber: "1",
          status: "success",
        },
        requiredConfirmations: 3,
      }).state,
    ).toBe("succeeded");
  });
});

