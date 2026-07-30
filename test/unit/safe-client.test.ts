import { describe, expect, it } from "vitest";
import {
  SafeApiError,
  SafeMessageUnsupportedError,
  classifySafeApiError,
} from "../../src/safe/errors.js";
import {
  computeAuthorizationPollDelayMs,
} from "../../src/safe/client.js";
import {
  hashSafeMessageDigest,
  parseTypedDataMessage,
} from "../../src/safe/messageValidation.js";

describe("classifySafeApiError", () => {
  it("maps api-kit HTTP status codes to retry policy", () => {
    expect(classifySafeApiError({ statusCode: 404, message: "not found" })).toMatchObject({
      code: "SAFE_MESSAGE_NOT_FOUND",
      retryable: true,
      statusCode: 404,
    });
    expect(classifySafeApiError({ statusCode: 401, message: "unauthorized" })).toMatchObject({
      code: "SAFE_API_UNAUTHORIZED",
      retryable: false,
    });
    expect(classifySafeApiError({ statusCode: 429, message: "rate limited" })).toMatchObject({
      code: "SAFE_API_RATE_LIMITED",
      retryable: true,
    });
    expect(classifySafeApiError({ statusCode: 503, message: "unavailable" })).toMatchObject({
      code: "SAFE_API_UNAVAILABLE",
      retryable: true,
    });
  });

  it("rethrows unsupported Safe message errors unchanged", () => {
    const error = new SafeMessageUnsupportedError("unsupported");
    expect(() => classifySafeApiError(error)).toThrow(error);
  });

  it("passes through existing SafeApiError instances", () => {
    const error = new SafeApiError("already classified", 502, true, "SAFE_API_ERROR");
    expect(classifySafeApiError(error)).toBe(error);
  });
});

describe("computeAuthorizationPollDelayMs", () => {
  it("grows exponentially and caps at max delay", () => {
    const delay = computeAuthorizationPollDelayMs(10, 5_000, 60_000);
    expect(delay).toBeGreaterThanOrEqual(60_000);
    expect(delay).toBeLessThanOrEqual(60_250);
  });
});

describe("messageValidation", () => {
  it("parses JSON-string Safe message payloads", () => {
    const typedData = {
      domain: {
        name: "ClearMacroForwarder",
        version: "1",
        chainId: 10,
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
    };
    const digest = hashSafeMessageDigest(JSON.stringify(typedData));
    expect(digest).toBe(hashSafeMessageDigest(typedData));
  });

  it("rejects malformed typed data", () => {
    expect(() => parseTypedDataMessage({ domain: {}, types: {} })).toThrow(
      SafeMessageUnsupportedError,
    );
  });
});
