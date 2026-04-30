import type { RelayExecutionState } from "../tx/lifecycle.js";
import type { RelayExecutionError, RelayExecutionReceipt } from "../db/repositories.js";

export type RelayerProjectionInput = {
  status: string;
  statusReason: string | null;
  hash: string | null;
  confirmedAt: string | null;
  receipt?: RelayExecutionReceipt | null;
  requiredConfirmations: number | null;
};

export type RelayerProjection = {
  state: RelayExecutionState;
  error?: RelayExecutionError;
};

function isRevertReason(statusReason: string | null): boolean {
  const reason = (statusReason ?? "").toLowerCase();
  return reason.includes("revert") || reason.includes("receipt status: failed");
}

export function projectRelayerState(input: RelayerProjectionInput): RelayerProjection {
  const hasHash = typeof input.hash === "string" && input.hash.length > 0;
  const status = input.status.toLowerCase();

  if (input.receipt?.status === "reverted") {
    return {
      state: "reverted",
      error: {
        code: "ONCHAIN_REVERTED",
        message: "Transaction reverted onchain.",
        category: "user",
        retryable: false,
      },
    };
  }

  if (status === "pending" || status === "sent" || status === "submitted") {
    return { state: hasHash ? "submitted" : "pending" };
  }
  if (status === "inmempool") {
    return { state: "submitted" };
  }
  if (status === "mined") {
    if (input.requiredConfirmations !== null && input.requiredConfirmations > 1 && !input.confirmedAt) {
      return { state: "included" };
    }
    return { state: "succeeded" };
  }
  if (status === "confirmed") {
    return { state: "succeeded" };
  }
  if (status === "failed") {
    if (isRevertReason(input.statusReason)) {
      return {
        state: "reverted",
        error: {
          code: "RELAYER_REPORTED_REVERT",
          message: "Relayer reported transaction revert.",
          category: "user",
          retryable: false,
        },
      };
    }
    return {
      state: "failed",
      error: {
        code: "RELAYER_FAILED",
        message: "Relayer failed to execute transaction.",
        category: "relayer",
        retryable: false,
      },
    };
  }
  if (status === "canceled") {
    return { state: "canceled" };
  }
  if (status === "expired") {
    return { state: "expired" };
  }
  return { state: hasHash ? "submitted" : "pending" };
}

