import { describe, expect, it } from "vitest";
import { isActionableFailure } from "../../src/metrics/actionableFailures.js";

describe("isActionableFailure", () => {
  const cases: Array<{
    stage: Parameters<typeof isActionableFailure>[0];
    code: string;
    expected: boolean;
  }> = [
    { stage: "admission", code: "CHAIN_NOT_ALLOWED", expected: false },
    { stage: "worker_submit", code: "CHAIN_NOT_ALLOWED", expected: true },
    { stage: "admission", code: "SIGNATURE_INVALID", expected: false },
    { stage: "admission", code: "PREFLIGHT_REVERTED", expected: false },
    { stage: "admission", code: "PROVIDER_NOT_READY", expected: true },
    { stage: "admission", code: "CHAIN_UNAVAILABLE", expected: true },
    { stage: "admission", code: "RELAYER_UNAVAILABLE", expected: true },
    { stage: "admission", code: "RELAYER_RATE_LIMITED", expected: true },
    { stage: "worker_submit", code: "RELAYER_SUBMIT_FAILED", expected: true },
    { stage: "worker_poll", code: "RELAYER_FAILED", expected: true },
    { stage: "worker_submit", code: "INTERNAL_INVARIANT", expected: true },
    { stage: "worker_submit", code: "INVALID_PERMIT2_STATE", expected: true },
    { stage: "authorization", code: "INVALID_AUTHORIZATION_STATE", expected: true },
    { stage: "authorization", code: "SAFE_API_UNAUTHORIZED", expected: true },
    { stage: "authorization", code: "SAFE_API_ERROR", expected: true },
    { stage: "authorization", code: "SAFE_CHAIN_UNSUPPORTED", expected: true },
    { stage: "authorization", code: "SAFE_AUTHORIZATION_UNSUPPORTED", expected: false },
    { stage: "worker_poll", code: "ONCHAIN_REVERTED", expected: false },
    { stage: "worker_poll", code: "RELAYER_REPORTED_REVERT", expected: false },
    { stage: "worker_tick", code: "RELAYER_WORKER_TICK_FAILED", expected: true },
    { stage: "worker_tick", code: "AUTHORIZATION_WORKER_TICK_FAILED", expected: true },
  ];

  it.each(cases)("stage=$stage code=$code => $expected", ({ stage, code, expected }) => {
    expect(isActionableFailure(stage, code)).toBe(expected);
  });
});
