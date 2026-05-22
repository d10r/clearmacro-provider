import type {
  RelayExecutionRepository,
  RelayExecutionEventRepository,
  RelayerTransactionRepository,
} from "../db/repositories.js";
import type { OzRelayerClient } from "./client.js";
import { OzRelayerHttpError, OzRelayerRateLimitError } from "./errors.js";
import { projectRelayerState } from "./mapper.js";
import { buildRunMacroCalldata } from "../tx/builder.js";
import type { LoadedRegistry } from "../config/registry.js";
import { preflightRunMacro, type ClearMacroForwarderCall } from "../chain/readiness.js";
import type { RelayExecutionReceipt } from "../db/repositories.js";
import { normalizeOzReceipt, type RawOzReceipt } from "./receiptNormalize.js";

export type RelayerWorkerDeps = {
  executions: RelayExecutionRepository;
  executionEvents: RelayExecutionEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  relayerClient: OzRelayerClient;
  registry: LoadedRegistry;
  batchSize: number;
  submitRetryCount?: number;
  /** When set, poll loop backs off across ticks after OZ HTTP 429. */
  ozPollBackoff?: { until: number };
  preflightSimulation?: (
    input: ClearMacroForwarderCall & {
      chain: LoadedRegistry["raw"]["chains"][number];
      relayerSigner: string;
      signature: string;
      msgValue: string;
    },
  ) => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
};

function isTransientSubmitError(error: unknown): boolean {
  if (error instanceof OzRelayerRateLimitError) {
    return true;
  }
  if (error instanceof OzRelayerHttpError && error.status >= 500) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("429") ||
    /\b5\d\d\b/.test(message) ||
    message.includes("timeout") ||
    message.includes("eai_again") ||
    message.includes("econn") ||
    message.includes("network")
  );
}

function getSubmitAttemptsFromErrorJson(value: string | null): number {
  if (!value) {
    return 0;
  }
  try {
    const parsed = JSON.parse(value) as { submitAttempts?: unknown };
    if (
      typeof parsed.submitAttempts === "number" &&
      Number.isFinite(parsed.submitAttempts) &&
      parsed.submitAttempts >= 0
    ) {
      return parsed.submitAttempts;
    }
  } catch {
    // ignore parse errors and treat as no attempts
  }
  return 0;
}

export async function processRelayerWorkerTick(
  deps: RelayerWorkerDeps,
): Promise<void> {
  const submitRetryCount = deps.submitRetryCount ?? 3;
  const submittable = deps.executions.listSubmittable(deps.batchSize);
  for (const execution of submittable) {
    try {
      const chain = deps.registry.chainsById.get(execution.chainId);
      if (!chain) {
        deps.executions.transitionState(execution.id, "failed", {
          errorJson: JSON.stringify({
            code: "CHAIN_NOT_ALLOWED",
            message: "Chain missing from registry",
            category: "provider",
            retryable: false,
          }),
        });
        continue;
      }
      const relayer = await deps.relayerClient.getRelayer(
        execution.ozRelayerId,
      );
      const skipPreflight = execution.forceAfterPreflightRevert === 1;
      if (!skipPreflight) {
        const preflightFn = deps.preflightSimulation ?? preflightRunMacro;
        const preflight = await preflightFn({
          chain,
          forwarder: execution.forwarderAddress,
          macro: execution.macroAddress,
          encodedPayload: execution.payload,
          signer: execution.signerAddress,
          relayerSigner: relayer.address,
          signature: execution.signature,
          msgValue: execution.value,
        });
        if (preflight === "deterministic_revert") {
          deps.executions.transitionState(execution.id, "rejected", {
            errorJson: JSON.stringify({
              code: "PREFLIGHT_REVERTED",
              message:
                "Post-creation safety check predicted revert before submission.",
              category: "user",
              retryable: false,
            }),
          });
          deps.executionEvents.append({
            executionId: execution.id,
            type: "terminal_error_set",
            actor: "worker",
            reason: "Deterministic preflight revert",
            detailsJson: JSON.stringify({}),
          });
          continue;
        }
        if (preflight === "rpc_unavailable") {
          deps.executionEvents.append({
            executionId: execution.id,
            type: "preflight_retry_scheduled",
            actor: "worker",
            reason: "Preflight RPC unavailable; will retry",
            detailsJson: JSON.stringify({ retry: true }),
          });
          continue;
        }
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      const validBefore = BigInt(execution.validBefore);
      if (validBefore !== 0n && validBefore <= now) {
        deps.executions.transitionState(execution.id, "expired", {
          errorJson: JSON.stringify({
            code: "CLEAR_MACRO_EXPIRED",
            message: "Validity window elapsed before submission.",
            category: "user",
            retryable: false,
          }),
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "state_changed",
          actor: "worker",
          reason: "Expired before submission",
          detailsJson: JSON.stringify({}),
        });
        continue;
      }

      const tx = await deps.relayerClient.submitTransaction(
        execution.ozRelayerId,
        {
          to: execution.forwarderAddress,
          value: execution.value,
          data: buildRunMacroCalldata({
            macro: execution.macroAddress,
            encodedPayload: execution.payload,
            signer: execution.signerAddress,
            signature: execution.signature,
          }),
          speed: "fast",
        },
      );
      deps.relayerTransactions.upsert({
        ozTransactionId: tx.id,
        executionId: execution.id,
        ozRelayerId: execution.ozRelayerId,
        status: tx.status,
        statusReason: tx.status_reason,
        txHash: tx.hash,
        nonce: tx.nonce === null ? null : String(tx.nonce),
        gasLimit: tx.gas_limit === null ? null : String(tx.gas_limit),
        gasPrice: tx.gas_price,
        maxFeePerGas: tx.max_fee_per_gas,
        maxPriorityFeePerGas: tx.max_priority_fee_per_gas,
        rawJson: JSON.stringify(tx),
        submittedAt: tx.sent_at,
        includedAt: tx.mined_at ?? null,
        confirmedAt: tx.confirmed_at,
        receiptJson: tx.receipt ? JSON.stringify(tx.receipt) : null,
        lastPolledAt: new Date().toISOString(),
      });
      deps.executions.applySubmitAcknowledgement(
        execution.id,
        tx.id,
        tx.hash ? (tx.hash as `0x${string}`) : null,
      );
      deps.executionEvents.append({
        executionId: execution.id,
        type: "relayer_submit_accepted",
        actor: "worker",
        reason: "Relayer accepted transaction intent",
        detailsJson: JSON.stringify({
          ozTransactionId: tx.id,
          status: tx.status,
        }),
      });
    } catch (error) {
      const currentAttempts = getSubmitAttemptsFromErrorJson(
        execution.lastErrorJson,
      );
      const nextAttempts = currentAttempts + 1;
      const errorPayload = JSON.stringify({
        code: "RELAYER_SUBMIT_ERROR",
        message: error instanceof Error ? error.message : "unknown",
        submitAttempts: nextAttempts,
      });
      const transient = isTransientSubmitError(error);
      if (transient && nextAttempts < submitRetryCount) {
        deps.executions.updateLastError(execution.id, errorPayload);
        deps.executionEvents.append({
          executionId: execution.id,
          type: "relayer_submit_retry_scheduled",
          actor: "worker",
          reason: "Transient relayer submission failure",
          detailsJson: JSON.stringify({
            submitAttempts: nextAttempts,
            retryLimit: submitRetryCount,
          }),
        });
        continue;
      }
      deps.executions.transitionState(execution.id, "failed", {
        errorJson: JSON.stringify({
          code: "RELAYER_SUBMIT_FAILED",
          message: "Relayer did not accept transaction intent after retries.",
          category: "relayer",
          retryable: false,
        }),
      });
      deps.executionEvents.append({
        executionId: execution.id,
        type: "terminal_error_set",
        actor: "worker",
        reason: "Relayer submission failed",
        detailsJson: JSON.stringify({
          message: error instanceof Error ? error.message : "unknown",
        }),
      });
    }
  }

  const pollable = deps.executions.listPollable(deps.batchSize);
  const skipPollsUntil = deps.ozPollBackoff?.until ?? 0;
  if (Date.now() >= skipPollsUntil) {
    for (const execution of pollable) {
      if (deps.ozPollBackoff && Date.now() < deps.ozPollBackoff.until) {
        break;
      }
      if (!execution.ozTransactionId) {
        continue;
      }
      try {
        const tx = await deps.relayerClient.getTransaction(
          execution.ozRelayerId,
          execution.ozTransactionId,
        );
        deps.relayerTransactions.upsert({
          ozTransactionId: tx.id,
          executionId: execution.id,
          ozRelayerId: execution.ozRelayerId,
          status: tx.status,
          statusReason: tx.status_reason,
          txHash: tx.hash,
          nonce: tx.nonce === null ? null : String(tx.nonce),
          gasLimit: tx.gas_limit === null ? null : String(tx.gas_limit),
          gasPrice: tx.gas_price,
          maxFeePerGas: tx.max_fee_per_gas,
          maxPriorityFeePerGas: tx.max_priority_fee_per_gas,
          rawJson: JSON.stringify(tx),
          submittedAt: tx.sent_at,
          includedAt: tx.mined_at ?? null,
          confirmedAt: tx.confirmed_at,
          receiptJson: tx.receipt ? JSON.stringify(tx.receipt) : null,
          lastPolledAt: new Date().toISOString(),
        });
        if (tx.hash && tx.hash !== execution.currentTransactionHash) {
          deps.executions.appendCurrentHashChange(
            execution.id,
            tx.hash as `0x${string}`,
          );
          deps.executionEvents.append({
            executionId: execution.id,
            type: execution.currentTransactionHash
              ? "transaction_hash_replaced"
              : "transaction_hash_observed",
            actor: "worker",
            reason: execution.currentTransactionHash
              ? "Replacement hash observed"
              : "First hash observed",
            detailsJson: JSON.stringify({ hash: tx.hash }),
          });
          const refreshed = deps.executions.getByIdOrThrow(execution.id);
          if (
            refreshed.state === "pending" &&
            refreshed.currentTransactionHash
          ) {
            deps.executions.transitionState(refreshed.id, "submitted");
          }
        }

        let receipt: RelayExecutionReceipt | null = null;
        if (tx.receipt) {
          const raw: RawOzReceipt = {
            transactionHash: tx.receipt.transactionHash,
            blockNumber: tx.receipt.blockNumber,
            status: tx.receipt.status,
          };
          if (tx.receipt.blockHash !== undefined) {
            raw.blockHash = tx.receipt.blockHash;
          }
          if (tx.receipt.gasUsed !== undefined) {
            raw.gasUsed = tx.receipt.gasUsed;
          }
          receipt = normalizeOzReceipt(raw);
        }

        const projected = projectRelayerState({
          status: tx.status,
          statusReason: tx.status_reason,
          hash: tx.hash,
          confirmedAt: tx.confirmed_at,
          receipt,
          requiredConfirmations: execution.requiredConfirmations,
        });

        const metadataUpdates: {
          receipt?: RelayExecutionReceipt;
          error?: {
            code: string;
            message: string;
            category: "user" | "provider" | "chain" | "relayer" | "unknown";
            retryable: boolean;
          };
        } = {};
        if (receipt) {
          metadataUpdates.receipt = receipt;
        }
        if (projected.error) {
          metadataUpdates.error = projected.error;
        }
        deps.executions.updateMetadata(execution.id, metadataUpdates);
        const latest = deps.executions.getByIdOrThrow(execution.id);
        if (latest.state !== projected.state) {
          deps.executions.transitionState(execution.id, projected.state);
          deps.executionEvents.append({
            executionId: execution.id,
            type: "state_changed",
            actor: "worker",
            reason: `Projected state: ${projected.state}`,
            detailsJson: JSON.stringify({
              relayerStatus: tx.status,
              statusReason: tx.status_reason,
            }),
          });
        }
      } catch (error) {
        if (error instanceof OzRelayerRateLimitError) {
          if (deps.ozPollBackoff) {
            const base =
              error.retryAfterMs !== undefined && error.retryAfterMs > 0
                ? Math.min(5000, error.retryAfterMs)
                : 300;
            deps.ozPollBackoff.until =
              Date.now() + base + Math.floor(Math.random() * 400);
          }
          deps.executionEvents.append({
            executionId: execution.id,
            type: "relayer_poll_rate_limited",
            actor: "worker",
            reason: "OpenZeppelin relayer rate limit during status poll",
            detailsJson: JSON.stringify({}),
          });
          break;
        }
        deps.executionEvents.append({
          executionId: execution.id,
          type: "relayer_status_polled",
          actor: "worker",
          reason: "Relayer polling error",
          detailsJson: JSON.stringify({}),
        });
      }
    }
  }
}
