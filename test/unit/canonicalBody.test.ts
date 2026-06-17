import { describe, expect, it } from "vitest";
import { canonicalCreateBodyJson, hashCanonicalCreateBody } from "../../src/api/canonicalBody.js";

describe("canonical create body hashing", () => {
  it("sorts metadata keys and defaults for stable hashes", () => {
    const a = hashCanonicalCreateBody({
      kind: "clearMacroV1",
      chainId: 1,
      macroAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      signerAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      payload: "0x01",
      signature: "0x02",
      metadata: { z: "1", a: "2" },
    });
    const b = hashCanonicalCreateBody({
      kind: "clearMacroV1",
      chainId: 1,
      macroAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      payload: "0x01",
      signature: "0x02",
      metadata: { a: "2", z: "1" },
    });
    expect(a).toBe(b);
  });

  it("includes force flag default false in canonical form", () => {
    const without = canonicalCreateBodyJson({
      kind: "clearMacroV1",
      chainId: 1,
      macroAddress: "0x" + "cc".repeat(20),
      signerAddress: "0x" + "dd".repeat(20),
      payload: "0x",
      signature: "0x",
    });
    const withFalse = canonicalCreateBodyJson({
      kind: "clearMacroV1",
      chainId: 1,
      macroAddress: "0x" + "cc".repeat(20),
      signerAddress: "0x" + "dd".repeat(20),
      payload: "0x",
      signature: "0x",
      forceExecuteAfterPreflightRevert: false,
    });
    expect(without).toBe(withFalse);
  });

  it("hashes equivalent Permit2 requests identically despite metadata key order", () => {
    const permit2 = {
      permit: {
        permitted: { token: "0x3333333333333333333333333333333333333333", amount: "1" },
        nonce: "1",
        deadline: "999",
      },
      spender: "0x4444444444444444444444444444444444444444",
      upgradeSuperToken: "0x0000000000000000000000000000000000000000",
      signature: "0xabcd",
    };
    const a = hashCanonicalCreateBody({
      kind: "clearMacroPermit2V1",
      chainId: 1,
      macroAddress: "0x" + "aa".repeat(20),
      signerAddress: "0x" + "bb".repeat(20),
      payload: "0x01",
      permit2,
      metadata: { z: "1", a: "2" },
    });
    const b = hashCanonicalCreateBody({
      kind: "clearMacroPermit2V1",
      chainId: 1,
      macroAddress: "0x" + "AA".repeat(20),
      signerAddress: "0x" + "BB".repeat(20),
      payload: "0x01",
      permit2: {
        ...permit2,
        permit: {
          ...permit2.permit,
          permitted: {
            token: "0x3333333333333333333333333333333333333333",
            amount: "1",
          },
        },
      },
      metadata: { a: "2", z: "1" },
    });
    expect(a).toBe(b);
  });

  it("changes Permit2 canonical hash when nonce, spender, signature, or upgradeSuperToken differ", () => {
    const base = {
      kind: "clearMacroPermit2V1" as const,
      chainId: 1,
      macroAddress: "0x" + "cc".repeat(20),
      signerAddress: "0x" + "dd".repeat(20),
      payload: "0x",
      permit2: {
        permit: {
          permitted: { token: "0x" + "11".repeat(20), amount: "1" },
          nonce: "1",
          deadline: "999",
        },
        spender: "0x" + "22".repeat(20),
        upgradeSuperToken: "0x0000000000000000000000000000000000000000",
        signature: "0x01",
      },
    };
    const baseline = hashCanonicalCreateBody(base);
    expect(hashCanonicalCreateBody({
      ...base,
      permit2: { ...base.permit2, permit: { ...base.permit2.permit, nonce: "2" } },
    })).not.toBe(baseline);
    expect(hashCanonicalCreateBody({
      ...base,
      permit2: { ...base.permit2, spender: "0x" + "33".repeat(20) },
    })).not.toBe(baseline);
    expect(hashCanonicalCreateBody({
      ...base,
      permit2: { ...base.permit2, signature: "0x02" },
    })).not.toBe(baseline);
    expect(hashCanonicalCreateBody({
      ...base,
      permit2: { ...base.permit2, upgradeSuperToken: "0x" + "44".repeat(20) },
    })).not.toBe(baseline);
  });
});
