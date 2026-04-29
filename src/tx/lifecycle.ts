export const requestStates = [
  "accepted",
  "queued",
  "preflight_failed",
  "submit_failed",
  "pending",
  "confirmed",
  "reverted",
  "canceled",
  "expired",
  "rejected",
  "failed",
] as const;

export type RequestState = (typeof requestStates)[number];

const terminalStates = new Set<RequestState>([
  "preflight_failed",
  "submit_failed",
  "confirmed",
  "reverted",
  "canceled",
  "expired",
  "rejected",
  "failed",
]);

const allowedTransitions: Readonly<Record<RequestState, ReadonlySet<RequestState>>> = {
  accepted: new Set(["queued", "preflight_failed", "expired", "rejected", "failed"]),
  queued: new Set(["pending", "preflight_failed", "submit_failed", "expired", "failed"]),
  pending: new Set(["confirmed", "reverted", "canceled", "expired", "failed"]),
  preflight_failed: new Set(),
  submit_failed: new Set(),
  confirmed: new Set(),
  reverted: new Set(),
  canceled: new Set(),
  expired: new Set(),
  rejected: new Set(),
  failed: new Set(),
};

export function isTerminalState(state: RequestState): boolean {
  return terminalStates.has(state);
}

export function canTransitionState(from: RequestState, to: RequestState): boolean {
  return allowedTransitions[from].has(to);
}

export function assertTransitionState(from: RequestState, to: RequestState): void {
  if (!canTransitionState(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

