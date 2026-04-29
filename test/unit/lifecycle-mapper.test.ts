import { describe, expect, it } from "vitest";
import { mapRelayerStatusToRequestState } from "../../src/relayer/mapper.js";

describe("mapRelayerStatusToRequestState", () => {
  it("maps submitted to pending", () => {
    expect(mapRelayerStatusToRequestState("submitted", null)).toBe("pending");
  });

  it("maps confirmed to confirmed", () => {
    expect(mapRelayerStatusToRequestState("confirmed", null)).toBe("confirmed");
  });

  it("maps revert-like failed to reverted", () => {
    expect(mapRelayerStatusToRequestState("failed", "execution reverted")).toBe("reverted");
  });

  it("maps generic failed to failed", () => {
    expect(mapRelayerStatusToRequestState("failed", "rpc unavailable")).toBe("failed");
  });
});

