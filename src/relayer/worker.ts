import type { RelayRequestRepository, AuditEventRepository, RelayerTransactionRepository } from "../db/repositories.js";
import type { OzRelayerClient } from "./client.js";
import { mapRelayerStatusToRequestState } from "./mapper.js";
import { isTerminalState } from "../tx/lifecycle.js";
import { buildRunMacroCalldata } from "../tx/builder.js";
import type { LoadedRegistry } from "../config/registry.js";
import { preflightRunMacro } from "../chain/readiness.js";

export type RelayerWorkerDeps = {
  requests: RelayRequestRepository;
  audits: AuditEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  relayerClient: OzRelayerClient;
  registry: LoadedRegistry;
  batchSize: number;
  preflightSimulation?: (input: {
    chain: LoadedRegistry["raw"]["chains"][number];
    forwarder: string;
    macro: string;
    params: string;
    signer: string;
    signature: string;
    msgValue: string;
  }) => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
};

export async function processRelayerWorkerTick(deps: RelayerWorkerDeps): Promise<void> {
  const submittable = deps.requests.listSubmittable(deps.batchSize);
  for (const request of submittable) {
    if (request.state === "accepted") {
      deps.requests.transitionState(request.id, "queued");
    }
    try {
      const chain = deps.registry.chainsById.get(request.chainId);
      if (!chain) {
        deps.requests.transitionState(request.id, "failed", {
          errorJson: JSON.stringify({ code: "CHAIN_NOT_ALLOWED", message: "Chain missing from registry" }),
        });
        continue;
      }
      const preflightFn = deps.preflightSimulation ?? preflightRunMacro;
      const preflight = await preflightFn({
        chain,
        forwarder: request.forwarder,
        macro: request.macro,
        params: request.params,
        signer: request.signer,
        signature: request.signature ?? "0x",
        msgValue: request.msgValue,
      });
      if (preflight === "deterministic_revert") {
        deps.requests.transitionState(request.id, "preflight_failed", {
          errorJson: JSON.stringify({ code: "SIMULATION_REVERTED", message: "Preflight simulation reverted" }),
        });
        deps.audits.append({
          requestId: request.id,
          type: "preflight_failed",
          actor: "worker",
          reason: "Deterministic preflight revert",
          detailsJson: JSON.stringify({}),
        });
        continue;
      }
      if (preflight === "rpc_unavailable") {
        deps.audits.append({
          requestId: request.id,
          type: "preflight_failed",
          actor: "worker",
          reason: "Preflight RPC unavailable; will retry",
          detailsJson: JSON.stringify({ retry: true }),
        });
        continue;
      }

      const tx = await deps.relayerClient.submitTransaction(request.ozRelayerId, {
        to: request.forwarder,
        value: request.msgValue,
        data: buildRunMacroCalldata({
          macro: request.macro,
          params: request.params,
          signer: request.signer,
          signature: request.signature ?? "0x",
        }),
        speed: "fast",
      });
      deps.relayerTransactions.upsert({
        ozTransactionId: tx.id,
        requestId: request.id,
        ozRelayerId: request.ozRelayerId,
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
        confirmedAt: tx.confirmed_at,
        lastPolledAt: new Date().toISOString(),
      });
      const transitionOptions = tx.hash ? { ozTransactionId: tx.id, txHash: tx.hash } : { ozTransactionId: tx.id };
      deps.requests.transitionState(request.id, "pending", transitionOptions);
      deps.audits.append({
        requestId: request.id,
        type: "relayer_submit_accepted",
        actor: "worker",
        reason: "Relayer accepted transaction intent",
        detailsJson: JSON.stringify({ ozTransactionId: tx.id, status: tx.status }),
      });
    } catch (error) {
      deps.requests.transitionState(request.id, "submit_failed", {
        errorJson: JSON.stringify({ code: "RELAYER_SUBMIT_ERROR", message: error instanceof Error ? error.message : "unknown" }),
      });
      deps.audits.append({
        requestId: request.id,
        type: "relayer_submit_failed",
        actor: "worker",
        reason: "Relayer submission failed",
        detailsJson: JSON.stringify({ message: error instanceof Error ? error.message : "unknown" }),
      });
    }
  }

  const pending = deps.requests.listPending(deps.batchSize);
  for (const request of pending) {
    if (!request.ozTransactionId) {
      continue;
    }
    try {
      const tx = await deps.relayerClient.getTransaction(request.ozRelayerId, request.ozTransactionId);
      deps.relayerTransactions.upsert({
        ozTransactionId: tx.id,
        requestId: request.id,
        ozRelayerId: request.ozRelayerId,
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
        confirmedAt: tx.confirmed_at,
        lastPolledAt: new Date().toISOString(),
      });
      const mapped = mapRelayerStatusToRequestState(tx.status, tx.status_reason);
      if (mapped !== "pending" && !isTerminalState(request.state)) {
        const transitionOptions = tx.hash ? { txHash: tx.hash } : undefined;
        deps.requests.transitionState(request.id, mapped, transitionOptions);
        deps.audits.append({
          requestId: request.id,
          type: "finalized",
          actor: "worker",
          reason: `Projected terminal state: ${mapped}`,
          detailsJson: JSON.stringify({ relayerStatus: tx.status, statusReason: tx.status_reason }),
        });
      }
    } catch (error) {
      deps.audits.append({
        requestId: request.id,
        type: "relayer_status_polled",
        actor: "worker",
        reason: "Relayer polling error",
        detailsJson: JSON.stringify({ message: error instanceof Error ? error.message : "unknown" }),
      });
    }
  }
}

