import { describe, expect, it } from "vitest";
import { normalizeOzReceipt } from "../../src/relayer/receiptNormalize.js";

describe("normalizeOzReceipt", () => {
  it.each([
    ["0", "reverted"],
    ["0x0", "reverted"],
    [0, "reverted"],
    ["1", "success"],
    ["0x1", "success"],
    [1, "success"],
    ["success", "success"],
    ["succeeded", "success"],
    ["reverted", "reverted"],
    ["failed", "reverted"],
  ] as const)("maps status %s to %s", (status, expected) => {
    const r = normalizeOzReceipt({
      transactionHash: "0x" + "ab".repeat(32),
      blockNumber: "0x10",
      status,
    });
    expect(r.status).toBe(expected);
    expect(r.blockNumber).toBe("16");
  });

  it("converts gasUsed hex to decimal string", () => {
    const r = normalizeOzReceipt({
      transactionHash: "0x" + "ab".repeat(32),
      blockNumber: 5,
      status: "1",
      gasUsed: "0x5208",
    });
    expect(r.gasUsed).toBe("21000");
  });

  it("treats unknown numeric status as reverted", () => {
    const r = normalizeOzReceipt({
      transactionHash: "0x" + "ab".repeat(32),
      blockNumber: "1",
      status: "99",
    });
    expect(r.status).toBe("reverted");
  });

  it("includes blockHash when present", () => {
    const r = normalizeOzReceipt({
      transactionHash: "0x" + "ab".repeat(32),
      blockNumber: "1",
      blockHash: "0x" + "cc".repeat(32),
      status: "1",
    });
    expect(r.blockHash).toBe(`0x${"cc".repeat(32)}`);
  });
});
