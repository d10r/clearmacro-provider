import type { RequestState } from "../tx/lifecycle.js";

export function mapRelayerStatusToRequestState(status: string, statusReason: string | null): RequestState {
  if (status === "pending" || status === "sent" || status === "submitted") {
    return "pending";
  }
  if (status === "mined" || status === "confirmed") {
    return "confirmed";
  }
  if (status === "canceled") {
    return "canceled";
  }
  if (status === "expired") {
    return "expired";
  }
  if (status === "failed") {
    const reason = (statusReason ?? "").toLowerCase();
    if (reason.includes("revert") || reason.includes("receipt status: failed")) {
      return "reverted";
    }
    return "failed";
  }
  return "pending";
}

