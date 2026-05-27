import { describe, expect, it } from "vitest";
import { estimateTxFundingBreakdown } from "../../src/chain/estimate-tx-funding.js";

describe("estimateTxFundingBreakdown", () => {
  it("returns execution-only fees for non-rollup chains", async () => {
    const breakdown = await estimateTxFundingBreakdown({
      client: { chain: { id: 56 } } as never,
      chainId: 56,
      to: "0x1111111111111111111111111111111111111111",
      data: "0x",
      gasLimit: 200_000n,
      maxFeePerGas: 5_000_000_000n,
      nonce: 0,
    });
    expect(breakdown.feeModel).toBe("execution-only");
    expect(breakdown.l1Wei).toBe(0n);
    expect(breakdown.l2Wei).toBe(200_000n * 5_000_000_000n);
    expect(breakdown.totalWei).toBe((breakdown.l2Wei * 11_000n) / 10_000n);
  });
});
