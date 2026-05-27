import { describe, expect, it } from "vitest";
import { computeFundingTxCountsFromActivity } from "../../scripts/lib/funding-tx-counts.js";

describe("computeFundingTxCountsFromActivity", () => {
  it("scales relative to median activity with min/max bounds", () => {
    const activity = new Map<number, number>([
      [1, 100],
      [2, 300],
      [3, 10],
    ]);
    const counts = computeFundingTxCountsFromActivity(activity, {
      baseTxCount: 30,
      minTxCount: 10,
      maxTxCount: 500,
    });
    expect(counts.get(2)).toBe(90);
    expect(counts.get(1)).toBe(30);
    expect(counts.get(3)).toBe(10);
  });

  it("uses min for zero-activity chains", () => {
    const activity = new Map<number, number>([
      [1, 0],
      [2, 100],
    ]);
    const counts = computeFundingTxCountsFromActivity(activity, {
      baseTxCount: 30,
      minTxCount: 10,
      maxTxCount: 500,
    });
    expect(counts.get(1)).toBe(10);
    expect(counts.get(2)).toBe(30);
  });
});
