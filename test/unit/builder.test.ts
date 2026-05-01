import { describe, expect, it } from "vitest";
import { buildRunMacroCalldata, clearMacroForwarderV1Abi } from "../../src/tx/builder.js";
import { decodeFunctionData } from "viem";

describe("buildRunMacroCalldata", () => {
  it("encodes runMacro with macro, params, signer, signature", () => {
    const data = buildRunMacroCalldata({
      macro: "0x00000000000000000000000000000000000000aa",
      params: "0xabcd",
      signer: "0x00000000000000000000000000000000000000bb",
      signature: "0xdeadbeef",
    });
    const decoded = decodeFunctionData({
      abi: clearMacroForwarderV1Abi,
      data: data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("runMacro");
    expect(String(decoded.args[0]).toLowerCase()).toBe("0x00000000000000000000000000000000000000aa");
    expect(decoded.args[1]).toBe("0xabcd");
    expect(String(decoded.args[2]).toLowerCase()).toBe("0x00000000000000000000000000000000000000bb");
    expect(decoded.args[3]).toBe("0xdeadbeef");
  });
});
