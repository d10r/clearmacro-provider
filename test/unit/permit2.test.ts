import { describe, expect, it } from "vitest";
import {
  computePermit2Digest,
  normalizePermit2Request,
  type Permit2RequestInput,
} from "../../src/chain/permit2.js";

const basePermit2: Permit2RequestInput = {
  permit: {
    permitted: {
      token: "0x3333333333333333333333333333333333333333",
      amount: "1000000",
    },
    nonce: "123",
    deadline: "1760000000",
  },
  spender: "0x4444444444444444444444444444444444444444",
  upgradeSuperToken: "0x0000000000000000000000000000000000000000",
  signature: "0xabcdef",
};

describe("computePermit2Digest", () => {
  it("is stable for the same fixture", () => {
    const stored = normalizePermit2Request(basePermit2);
    const input = {
      permit2: stored,
      owner: "0x2222222222222222222222222222222222222222",
      witness: `0x${"aa".repeat(32)}` as const,
      witnessTypeString: "ClearMacro witness)Action(...)ClearMacro(...)",
      domainSeparator: `0x${"bb".repeat(32)}` as const,
    };
    const first = computePermit2Digest(input);
    const second = computePermit2Digest(input);
    expect(first).toBe(second);
  });

  it("changes when spender changes", () => {
    const storedA = normalizePermit2Request(basePermit2);
    const storedB = normalizePermit2Request({
      ...basePermit2,
      spender: "0x5555555555555555555555555555555555555555",
    });
    const common = {
      owner: "0x2222222222222222222222222222222222222222",
      witness: `0x${"aa".repeat(32)}` as const,
      witnessTypeString: "ClearMacro witness)Action(...)ClearMacro(...)",
      domainSeparator: `0x${"bb".repeat(32)}` as const,
    };
    expect(computePermit2Digest({ permit2: storedA, ...common })).not.toBe(
      computePermit2Digest({ permit2: storedB, ...common }),
    );
  });

  it("changes when permit nonce changes", () => {
    const storedA = normalizePermit2Request(basePermit2);
    const storedB = normalizePermit2Request({
      ...basePermit2,
      permit: {
        ...basePermit2.permit,
        nonce: "124",
      },
    });
    const common = {
      owner: "0x2222222222222222222222222222222222222222",
      witness: `0x${"aa".repeat(32)}` as const,
      witnessTypeString: "ClearMacro witness)Action(...)ClearMacro(...)",
      domainSeparator: `0x${"bb".repeat(32)}` as const,
    };
    expect(computePermit2Digest({ permit2: storedA, ...common })).not.toBe(
      computePermit2Digest({ permit2: storedB, ...common }),
    );
  });

  it("lowercases normalized address fields", () => {
    const stored = normalizePermit2Request({
      ...basePermit2,
      permit: {
        ...basePermit2.permit,
        permitted: {
          token: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "1",
        },
      },
      spender: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      upgradeSuperToken: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    });
    expect(stored.permit.permitted.token).toBe(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(stored.spender).toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(stored.upgradeSuperToken).toBe(
      "0xcccccccccccccccccccccccccccccccccccccccc",
    );
  });
});
