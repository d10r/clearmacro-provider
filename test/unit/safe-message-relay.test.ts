import { describe, expect, it } from "vitest";
import { canTransitionState } from "../../src/tx/lifecycle.js";
import { canonicalCreateBodyJson } from "../../src/api/canonicalBody.js";
import { buildSafeMessageLink } from "../../src/safe/config.js";
import { hashSafeMessageDigest } from "../../src/safe/messageValidation.js";
import { isSafeApiKitChainSupported } from "../../src/safe/apiKit.js";

describe("safe message relay helpers", () => {
  it("allows awaiting_authorization to promote to pending", () => {
    expect(canTransitionState("awaiting_authorization", "pending")).toBe(true);
    expect(canTransitionState("awaiting_authorization", "expired")).toBe(true);
    expect(canTransitionState("pending", "awaiting_authorization")).toBe(false);
  });

  it("canonicalizes signature and authorization bodies distinctly", () => {
    const signatureBody = canonicalCreateBodyJson({
      kind: "clearMacroV1",
      chainId: 11155420,
      macroAddress: "0x1111111111111111111111111111111111111111",
      signerAddress: "0x2222222222222222222222222222222222222222",
      payload: "0x1234",
      signature: "0xabcdef",
    });
    const authorizationBody = canonicalCreateBodyJson({
      kind: "clearMacroV1",
      chainId: 11155420,
      macroAddress: "0x1111111111111111111111111111111111111111",
      signerAddress: "0x2222222222222222222222222222222222222222",
      payload: "0x1234",
      authorization: {
        type: "safeMessageV1",
        safeMessageHash: `0x${"aa".repeat(32)}`,
      },
    });
    expect(signatureBody).not.toEqual(authorizationBody);
    expect(signatureBody).toContain('"signature"');
    expect(authorizationBody).toContain('"authorization"');
  });

  it("builds Safe message deep links for optimism", () => {
    const link = buildSafeMessageLink({
      chainId: 10,
      safeAddress: "0x0000000000000000000000000000000000000001",
      safeMessageHash: `0x${"bb".repeat(32)}`,
    });
    expect(link).toContain("app.safe.global/transactions/msg");
    expect(link).toContain("oeth%3A0x0000000000000000000000000000000000000001");
  });

  it("builds Safe message deep links for OP Sepolia", () => {
    const link = buildSafeMessageLink({
      chainId: 11155420,
      safeAddress: "0x0000000000000000000000000000000000000001",
      safeMessageHash: `0x${"bb".repeat(32)}`,
    });
    expect(link).toContain("app.safe.global/transactions/msg");
    expect(link).toContain("opsep%3A0x0000000000000000000000000000000000000001");
  });

  it("builds Safe message deep links for Base Sepolia", () => {
    const link = buildSafeMessageLink({
      chainId: 84532,
      safeAddress: "0x0000000000000000000000000000000000000001",
      safeMessageHash: `0x${"bb".repeat(32)}`,
    });
    expect(link).toContain("basesep%3A0x0000000000000000000000000000000000000001");
  });

  it("reports api-kit chain support from the SDK network list", () => {
    expect(isSafeApiKitChainSupported(10)).toBe(true);
    expect(isSafeApiKitChainSupported(11155420)).toBe(false);
  });

  it("treats custom tx service URLs as supported for arbitrary chain IDs", () => {
    expect(isSafeApiKitChainSupported(31337, "http://localhost:18080/api")).toBe(true);
  });

  it("hashes EIP-712 typed data from Safe message payloads", () => {
    const digest = hashSafeMessageDigest({
      domain: {
        name: "ClearMacroForwarder",
        version: "1",
        chainId: 11155420,
        verifyingContract: "0x0000000000000000000000000000000000000001",
      },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Msg: [{ name: "value", type: "uint256" }],
      },
      primaryType: "Msg",
      message: { value: 1 },
    });
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
