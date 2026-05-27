import { describe, expect, it } from "vitest";
import { referenceRunMacroCalldata } from "../../src/chain/relayer-funding.js";

describe("referenceRunMacroCalldata", () => {
  it("builds runMacro selector calldata for estimation", () => {
    const forwarder = "0x1111111111111111111111111111111111111111";
    const data = referenceRunMacroCalldata(forwarder);
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});
