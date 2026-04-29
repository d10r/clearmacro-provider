import { randomUUID, createHash } from "node:crypto";
import type { DbClient } from "./client.js";
import { assertTransitionState, isTerminalState, type RequestState } from "../tx/lifecycle.js";

export type RelayRequestRow = {
  id: string;
  clientId: string;
  clientRequestId: string | null;
  idempotencyKey: string | null;
  requestBodyHash: string;
  kind: string;
  state: RequestState;
  terminal: number;
  chainId: number;
  ozRelayerId: string;
  ozTransactionId: string | null;
  forwarder: string;
  macro: string;
  signer: string;
  provider: string;
  clearMacroNonce: string;
  validAfter: string;
  validBefore: string;
  msgValue: string;
  params: string;
  signature: string | null;
  permit2Json: string | null;
  metadataJson: string;
  currentTxHash: string | null;
  requiredConfirmations: number | null;
  lastErrorJson: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
};

export type NewRelayRequest = Omit<
  RelayRequestRow,
  "id" | "state" | "terminal" | "ozTransactionId" | "currentTxHash" | "lastErrorJson" | "createdAt" | "updatedAt" | "terminalAt"
>;

export type AuditEvent = {
  id: string;
  requestId: string;
  type: string;
  actor: string;
  reason: string;
  detailsJson: string;
  createdAt: string;
};

const mapRelayRequest = (row: Record<string, unknown>): RelayRequestRow => ({
  id: String(row.id),
  clientId: String(row.client_id),
  clientRequestId: row.client_request_id === null ? null : String(row.client_request_id),
  idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
  requestBodyHash: String(row.request_body_hash),
  kind: String(row.kind),
  state: String(row.state) as RequestState,
  terminal: Number(row.terminal),
  chainId: Number(row.chain_id),
  ozRelayerId: String(row.oz_relayer_id),
  ozTransactionId: row.oz_transaction_id === null ? null : String(row.oz_transaction_id),
  forwarder: String(row.forwarder),
  macro: String(row.macro),
  signer: String(row.signer),
  provider: String(row.provider),
  clearMacroNonce: String(row.clear_macro_nonce),
  validAfter: String(row.valid_after),
  validBefore: String(row.valid_before),
  msgValue: String(row.msg_value),
  params: String(row.params),
  signature: row.signature === null ? null : String(row.signature),
  permit2Json: row.permit2_json === null ? null : String(row.permit2_json),
  metadataJson: String(row.metadata_json),
  currentTxHash: row.current_tx_hash === null ? null : String(row.current_tx_hash),
  requiredConfirmations: row.required_confirmations === null ? null : Number(row.required_confirmations),
  lastErrorJson: row.last_error_json === null ? null : String(row.last_error_json),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  terminalAt: row.terminal_at === null ? null : String(row.terminal_at),
});

function nowIso(): string {
  return new Date().toISOString();
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export class RelayRequestRepository {
  constructor(private readonly client: DbClient) {}

  createAccepted(input: NewRelayRequest): RelayRequestRow {
    const timestamp = nowIso();
    const id = randomUUID();
    this.client.db
      .prepare(
        `INSERT INTO relay_requests(
            id, client_id, client_request_id, idempotency_key, request_body_hash, kind, state, terminal,
            chain_id, oz_relayer_id, oz_transaction_id, forwarder, macro, signer, provider, clear_macro_nonce,
            valid_after, valid_before, msg_value, params, signature, permit2_json, metadata_json, current_tx_hash,
            required_confirmations, last_error_json, created_at, updated_at, terminal_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        input.clientId,
        input.clientRequestId,
        input.idempotencyKey,
        input.requestBodyHash,
        input.kind,
        input.chainId,
        input.ozRelayerId,
        input.forwarder,
        input.macro,
        input.signer,
        input.provider,
        input.clearMacroNonce,
        input.validAfter,
        input.validBefore,
        input.msgValue,
        input.params,
        input.signature,
        input.permit2Json,
        input.metadataJson,
        input.requiredConfirmations,
        timestamp,
        timestamp,
      );
    return this.getByIdOrThrow(id);
  }

  getById(id: string): RelayRequestRow | undefined {
    const row = this.client.db.prepare("SELECT * FROM relay_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRelayRequest(row) : undefined;
  }

  getByIdOrThrow(id: string): RelayRequestRow {
    const row = this.getById(id);
    if (!row) {
      throw new Error(`Request not found: ${id}`);
    }
    return row;
  }

  findByClientIdempotency(clientId: string, idempotencyKey: string): RelayRequestRow | undefined {
    const row = this.client.db
      .prepare("SELECT * FROM relay_requests WHERE client_id = ? AND idempotency_key = ?")
      .get(clientId, idempotencyKey) as Record<string, unknown> | undefined;
    return row ? mapRelayRequest(row) : undefined;
  }

  listSubmittable(limit: number): RelayRequestRow[] {
    const rows = this.client.db
      .prepare(
        "SELECT * FROM relay_requests WHERE terminal = 0 AND oz_transaction_id IS NULL AND state IN ('accepted', 'queued') ORDER BY created_at ASC LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRelayRequest);
  }

  listPending(limit: number): RelayRequestRow[] {
    const rows = this.client.db
      .prepare("SELECT * FROM relay_requests WHERE terminal = 0 AND oz_transaction_id IS NOT NULL AND state = 'pending' ORDER BY updated_at ASC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRelayRequest);
  }

  transitionState(requestId: string, toState: RequestState, options?: { errorJson?: string; ozTransactionId?: string; txHash?: string }): RelayRequestRow {
    return this.client.transaction(() => {
      const existing = this.getByIdOrThrow(requestId);
      assertTransitionState(existing.state, toState);
      const terminal = isTerminalState(toState) ? 1 : 0;
      const timestamp = nowIso();
      const terminalAt = terminal ? timestamp : null;
      this.client.db
        .prepare(
          `UPDATE relay_requests
           SET state = ?, terminal = ?, updated_at = ?, terminal_at = COALESCE(terminal_at, ?),
               oz_transaction_id = COALESCE(?, oz_transaction_id),
               current_tx_hash = COALESCE(?, current_tx_hash),
               last_error_json = COALESCE(?, last_error_json)
           WHERE id = ?`,
        )
        .run(toState, terminal, timestamp, terminalAt, options?.ozTransactionId ?? null, options?.txHash ?? null, options?.errorJson ?? null, requestId);
      return this.getByIdOrThrow(requestId);
    });
  }
}

export class AuditEventRepository {
  constructor(private readonly client: DbClient) {}

  append(input: Omit<AuditEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): AuditEvent {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    this.client.db
      .prepare("INSERT INTO audit_events(id, request_id, type, actor, reason, details_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.requestId, input.type, input.actor, input.reason, input.detailsJson, createdAt);
    return { id, requestId: input.requestId, type: input.type, actor: input.actor, reason: input.reason, detailsJson: input.detailsJson, createdAt };
  }

  listByRequest(requestId: string): AuditEvent[] {
    const rows = this.client.db
      .prepare("SELECT * FROM audit_events WHERE request_id = ? ORDER BY created_at ASC")
      .all(requestId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      requestId: String(row.request_id),
      type: String(row.type),
      actor: String(row.actor),
      reason: String(row.reason),
      detailsJson: String(row.details_json),
      createdAt: String(row.created_at),
    }));
  }
}

export type RelayerTransactionUpsert = {
  ozTransactionId: string;
  requestId: string;
  ozRelayerId: string;
  status: string;
  statusReason: string | null;
  txHash: string | null;
  nonce: string | null;
  gasLimit: string | null;
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  rawJson: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  lastPolledAt: string | null;
};

export type RelayerTransactionRow = {
  ozTransactionId: string;
  requestId: string;
  ozRelayerId: string;
  status: string;
  statusReason: string | null;
  txHash: string | null;
  nonce: string | null;
  gasLimit: string | null;
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  rawJson: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const mapRelayerTransaction = (row: Record<string, unknown>): RelayerTransactionRow => ({
  ozTransactionId: String(row.oz_transaction_id),
  requestId: String(row.request_id),
  ozRelayerId: String(row.oz_relayer_id),
  status: String(row.status),
  statusReason: row.status_reason === null ? null : String(row.status_reason),
  txHash: row.tx_hash === null ? null : String(row.tx_hash),
  nonce: row.nonce === null ? null : String(row.nonce),
  gasLimit: row.gas_limit === null ? null : String(row.gas_limit),
  gasPrice: row.gas_price === null ? null : String(row.gas_price),
  maxFeePerGas: row.max_fee_per_gas === null ? null : String(row.max_fee_per_gas),
  maxPriorityFeePerGas: row.max_priority_fee_per_gas === null ? null : String(row.max_priority_fee_per_gas),
  rawJson: String(row.raw_json),
  submittedAt: row.submitted_at === null ? null : String(row.submitted_at),
  confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
  lastPolledAt: row.last_polled_at === null ? null : String(row.last_polled_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class RelayerTransactionRepository {
  constructor(private readonly client: DbClient) {}

  upsert(input: RelayerTransactionUpsert): void {
    const timestamp = nowIso();
    this.client.db
      .prepare(
        `INSERT INTO relayer_transactions(
          oz_transaction_id, request_id, oz_relayer_id, status, status_reason, tx_hash, nonce, gas_limit, gas_price,
          max_fee_per_gas, max_priority_fee_per_gas, raw_json, submitted_at, confirmed_at, last_polled_at, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(oz_transaction_id) DO UPDATE SET
          request_id = excluded.request_id,
          oz_relayer_id = excluded.oz_relayer_id,
          status = excluded.status,
          status_reason = excluded.status_reason,
          tx_hash = excluded.tx_hash,
          nonce = excluded.nonce,
          gas_limit = excluded.gas_limit,
          gas_price = excluded.gas_price,
          max_fee_per_gas = excluded.max_fee_per_gas,
          max_priority_fee_per_gas = excluded.max_priority_fee_per_gas,
          raw_json = excluded.raw_json,
          submitted_at = excluded.submitted_at,
          confirmed_at = excluded.confirmed_at,
          last_polled_at = excluded.last_polled_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.ozTransactionId,
        input.requestId,
        input.ozRelayerId,
        input.status,
        input.statusReason,
        input.txHash,
        input.nonce,
        input.gasLimit,
        input.gasPrice,
        input.maxFeePerGas,
        input.maxPriorityFeePerGas,
        input.rawJson,
        input.submittedAt,
        input.confirmedAt,
        input.lastPolledAt,
        timestamp,
        timestamp,
      );
  }

  getByRequestId(requestId: string): RelayerTransactionRow | undefined {
    const row = this.client.db
      .prepare("SELECT * FROM relayer_transactions WHERE request_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(requestId) as Record<string, unknown> | undefined;
    return row ? mapRelayerTransaction(row) : undefined;
  }
}

