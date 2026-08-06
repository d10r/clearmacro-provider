import type {
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayExecutionRow,
} from "../db/repositories.js";
import { ApiError } from "./errors.js";

export function isClientCancelable(row: RelayExecutionRow): boolean {
  if (row.state === "awaiting_authorization") {
    return true;
  }
  return row.state === "pending" && row.ozTransactionId === null;
}

export function cancelRelayExecution(
  deps: {
    executions: RelayExecutionRepository;
    executionEvents: RelayExecutionEventRepository;
  },
  input: {
    executionId: string;
    clientId: string;
    apiAuthEnabled: boolean;
  },
): RelayExecutionRow {
  const row = deps.executions.getById(input.executionId);
  if (!row || (input.apiAuthEnabled && row.clientId !== input.clientId)) {
    throw new ApiError(
      404,
      "EXECUTION_NOT_FOUND",
      "Relay execution not found.",
      "validation",
      false,
    );
  }

  if (row.state === "canceled") {
    return row;
  }

  if (!isClientCancelable(row)) {
    throw new ApiError(
      409,
      "EXECUTION_NOT_CANCELABLE",
      "Execution can only be canceled while awaiting authorization, or pending before relayer submission.",
      "validation",
      false,
      row.id,
    );
  }

  const updated = deps.executions.tryClientCancel(
    row.id,
    JSON.stringify({
      code: "CANCELED_BY_CLIENT",
      message: "Execution canceled by client.",
      category: "user",
      retryable: false,
    }),
  );
  if (!updated) {
    const raced = deps.executions.getById(row.id);
    if (raced?.state === "canceled") {
      return raced;
    }
    throw new ApiError(
      409,
      "EXECUTION_NOT_CANCELABLE",
      "Execution can no longer be canceled.",
      "validation",
      false,
      row.id,
    );
  }

  deps.executionEvents.append({
    executionId: updated.id,
    type: "state_changed",
    actor: "api",
    reason: "Canceled by client",
    detailsJson: JSON.stringify({ previousState: row.state }),
  });
  return updated;
}
