import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { clearMacroForwarderV1Abi } from "../../src/chain/clearMacroForwarderV1Abi.js";
import {
  referenceRelayCalldata,
  referenceRunMacroCalldata,
  referenceRunPermit2AndMacroCalldata,
} from "../../src/chain/relayer-funding.js";

describe("referenceRunMacroCalldata", () => {
  it("builds runMacro selector calldata for estimation", () => {
    const forwarder = "0x1111111111111111111111111111111111111111";
    const data = referenceRunMacroCalldata(forwarder);
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(10);
    const decoded = decodeFunctionData({ abi: clearMacroForwarderV1Abi, data });
    expect(decoded.functionName).toBe("runMacro");
  });
});

describe("referenceRunPermit2AndMacroCalldata", () => {
  it("builds runPermit2AndMacro selector calldata for estimation", () => {
    const forwarder = "0x1111111111111111111111111111111111111111";
    const data = referenceRunPermit2AndMacroCalldata(forwarder);
    const decoded = decodeFunctionData({ abi: clearMacroForwarderV1Abi, data });
    expect(decoded.functionName).toBe("runPermit2AndMacro");
  });
});

describe("referenceRelayCalldata", () => {
  it("prefers the larger Permit2 calldata for conservative funding", () => {
    const forwarder = "0x1111111111111111111111111111111111111111";
    const data = referenceRelayCalldata(forwarder);
    const decoded = decodeFunctionData({ abi: clearMacroForwarderV1Abi, data });
    expect(decoded.functionName).toBe("runPermit2AndMacro");
    expect(data.length).toBeGreaterThan(referenceRunMacroCalldata(forwarder).length);
  });
});
