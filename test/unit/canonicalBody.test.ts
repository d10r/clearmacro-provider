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
});
