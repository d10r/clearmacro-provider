import { describe, expect, it } from "vitest";
import { ApiError, toErrorBody } from "../../src/api/errors.js";

describe("ApiError / toErrorBody", () => {
  it("serializes executionId null for hidden duplicates", () => {
    const err = new ApiError(409, "DUPLICATE_EXECUTION", "Hidden duplicate.", "validation", false, null);
    const body = toErrorBody(err);
    expect(body.error.executionId).toBeNull();
    expect(body.error.retryable).toBe(false);
  });
});
