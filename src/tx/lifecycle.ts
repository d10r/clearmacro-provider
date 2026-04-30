export const relayExecutionStates = ["pending", "submitted", "succeeded", "reverted", "rejected", "failed", "expired", "canceled"] as const;

export type RelayExecutionState = (typeof relayExecutionStates)[number];

const terminalStates = new Set<RelayExecutionState>(["succeeded", "reverted", "rejected", "failed", "expired", "canceled"]);

const allowedTransitions: Readonly<Record<RelayExecutionState, ReadonlySet<RelayExecutionState>>> = {
  pending: new Set(["submitted", "rejected", "failed", "expired", "canceled"]),
  submitted: new Set(["submitted", "succeeded", "reverted", "failed", "expired", "canceled"]),
  succeeded: new Set(),
  reverted: new Set(),
  rejected: new Set(),
  failed: new Set(),
  expired: new Set(),
  canceled: new Set(),
};

export function isTerminalState(state: RelayExecutionState): boolean {
  return terminalStates.has(state);
}

export function canTransitionState(from: RelayExecutionState, to: RelayExecutionState): boolean {
  return allowedTransitions[from].has(to);
}

export function assertTransitionState(from: RelayExecutionState, to: RelayExecutionState): void {
  if (!canTransitionState(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
