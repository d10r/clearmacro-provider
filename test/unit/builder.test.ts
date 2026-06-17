import { describe, expect, it } from "vitest";
import { clearMacroForwarderV1Abi } from "../../src/chain/clearMacroForwarderV1Abi.js";
import {
  buildRunMacroCalldata,
  buildRunPermit2AndMacroCalldata,
} from "../../src/tx/builder.js";
import { decodeFunctionData } from "viem";

describe("buildRunMacroCalldata", () => {
  it("encodes runMacro with macro, encodedPayload, signer, signature", () => {
    const data = buildRunMacroCalldata({
      macro: "0x00000000000000000000000000000000000000aa",
      encodedPayload: "0xabcd",
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

describe("buildRunPermit2AndMacroCalldata", () => {
  it("encodes runPermit2AndMacro with permit2 context, macro, and payload", () => {
    const data = buildRunPermit2AndMacroCalldata({
      permit2Context: {
        permit: {
          permitted: {
            token: "0x00000000000000000000000000000000000000cc",
            amount: 1_000_000n,
          },
          nonce: 123n,
          deadline: 1_760_000_000n,
        },
        owner: "0x00000000000000000000000000000000000000bb",
        witness: `0x${"11".repeat(32)}`,
        witnessTypeString: "ClearMacro witness)Action(...)ClearMacro(...)",
        signature: "0xdeadbeef",
        spender: "0x0000000000000000000000000000000000000001",
        upgradeSuperToken: "0x0000000000000000000000000000000000000000",
      },
      macro: "0x00000000000000000000000000000000000000aa",
      encodedPayload: "0xabcd",
    });
    const decoded = decodeFunctionData({
      abi: clearMacroForwarderV1Abi,
      data: data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("runPermit2AndMacro");
    const context = decoded.args[0] as {
      owner: string;
      signature: string;
      permit: { nonce: bigint; permitted: { amount: bigint } };
    };
    expect(String(context.owner).toLowerCase()).toBe(
      "0x00000000000000000000000000000000000000bb",
    );
    expect(context.signature).toBe("0xdeadbeef");
    expect(context.permit.nonce).toBe(123n);
    expect(context.permit.permitted.amount).toBe(1_000_000n);
    expect(String(decoded.args[1]).toLowerCase()).toBe(
      "0x00000000000000000000000000000000000000aa",
    );
    expect(decoded.args[2]).toBe("0xabcd");
  });
});
