import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/db/client.js";
import { migrations, runMigrations } from "../../src/db/migrations.js";
import { RelayExecutionEventRepository, RelayExecutionRepository } from "../../src/db/repositories.js";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "db-test-"));
  return openDatabase(join(dir, "app.sqlite"));
}

function basePending() {
  return {
    clientId: "anonymous",
    clientRequestId: null,
    requestBodyHash: "abc",
    digest: "0x" + "11".repeat(32),
    domain: "test",
    kind: "clearMacroV1",
    chainId: 1,
    ozRelayerId: "relayer",
    forwarderAddress: "0x0000000000000000000000000000000000000001",
    macroAddress: "0x0000000000000000000000000000000000000002",
    signerAddress: "0x0000000000000000000000000000000000000003",
    nonce: "1",
    validAfter: "0",
    validBefore: "0",
    value: "0",
    payload: "0x",
    signature: "0x",
    permit2Json: null,
    metadataJson: "{}",
    forceAfterPreflightRevert: 0,
    requiredConfirmations: 1,
  };
}

describe("db migrations and repositories", () => {
  it("applies migrations and enforces digest dedupe uniqueness", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);

    executions.createPending({
      ...basePending(),
    });

    expect(() =>
      executions.createPending({
        ...basePending(),
        requestBodyHash: "def",
        clientRequestId: "other",
      }),
    ).toThrow();
  });

  it("writes request transition and audit atomically", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const executionEvents = new RelayExecutionEventRepository(db);
    const created = executions.createPending({
      ...basePending(),
      digest: "0x" + "22".repeat(32),
    });
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-1" });
    executionEvents.append({
      executionId: created.id,
      type: "state_changed",
      actor: "worker",
      reason: "claimed",
      detailsJson: "{}",
    });
    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("submitted");
    expect(executionEvents.listByExecution(created.id)).toHaveLength(1);
  });

  it("persists and reads clearMacroPermit2V1 rows with permit2_json", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const permit2Json = JSON.stringify({
      permit: {
        permitted: { token: "0x00000000000000000000000000000000000000cc", amount: "1" },
        nonce: "9",
        deadline: "9999999999",
      },
      spender: "0x00000000000000000000000000000000000000dd",
      upgradeSuperToken: "0x0000000000000000000000000000000000000000",
      signature: "0xbeef",
    });
    const created = executions.createPending({
      ...basePending(),
      kind: "clearMacroPermit2V1",
      digest: "0x" + "33".repeat(32),
      signature: "0xbeef",
      permit2Json,
    });
    const loaded = executions.getByIdOrThrow(created.id);
    expect(loaded.kind).toBe("clearMacroPermit2V1");
    expect(loaded.permit2Json).toBe(permit2Json);
  });

  it("maps legacy clearMacroV1 rows with null permit2_json", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const created = executions.createPending({
      ...basePending(),
      digest: "0x" + "44".repeat(32),
      permit2Json: null,
    });
    expect(executions.getByIdOrThrow(created.id).permit2Json).toBeNull();
  });

  it("findByDedupKey works with a Permit2 authorization digest", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const digest = "0x" + "55".repeat(32);
    const created = executions.createPending({
      ...basePending(),
      kind: "clearMacroPermit2V1",
      digest,
      signature: "0xbeef",
      permit2Json: JSON.stringify({
        permit: {
          permitted: { token: "0x00000000000000000000000000000000000000cc", amount: "1" },
          nonce: "1",
          deadline: "9999999999",
        },
        spender: "0x00000000000000000000000000000000000000dd",
        upgradeSuperToken: "0x0000000000000000000000000000000000000000",
        signature: "0xbeef",
      }),
    });
    const found = executions.findByDedupKey(
      1,
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000003",
      digest,
    );
    expect(found?.id).toBe(created.id);
  });

  it("persists awaiting_authorization rows with null signature and safe metadata", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const created = executions.createAwaitingAuthorization({
      ...basePending(),
      digest: "0x" + "66".repeat(32),
      authorizationType: "safeMessageV1",
      safeMessageHash: "0x" + "77".repeat(32),
    });
    const loaded = executions.getByIdOrThrow(created.id);
    expect(loaded.state).toBe("awaiting_authorization");
    expect(loaded.signature).toBeNull();
    expect(loaded.authorizationType).toBe("safeMessageV1");
    expect(loaded.safeMessageHash).toBe("0x" + "77".repeat(32));
  });

  it("orders due authorization polls by authorization_poll_at", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const later = executions.createAwaitingAuthorization({
      ...basePending(),
      digest: "0x" + "88".repeat(32),
      authorizationType: "safeMessageV1",
      safeMessageHash: "0x" + "99".repeat(32),
    });
    const sooner = executions.createAwaitingAuthorization({
      ...basePending(),
      digest: "0x" + "aa".repeat(32),
      authorizationType: "safeMessageV1",
      safeMessageHash: "0x" + "bb".repeat(32),
    });
    executions.scheduleAuthorizationPoll(later.id, {
      pollAt: new Date(Date.now() + 60_000).toISOString(),
      pollAttempts: 1,
    });
    executions.scheduleAuthorizationPoll(sooner.id, {
      pollAt: new Date(Date.now() - 1_000).toISOString(),
      pollAttempts: 1,
    });

    const due = executions.listAwaitingAuthorizationDue(10);
    expect(due[0]?.id).toBe(sooner.id);
    expect(due.some((row) => row.id === later.id)).toBe(false);
  });

  it("atomically promotes awaiting_authorization to pending with signature", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const created = executions.createAwaitingAuthorization({
      ...basePending(),
      digest: "0x" + "cc".repeat(32),
      authorizationType: "safeMessageV1",
      safeMessageHash: "0x" + "dd".repeat(32),
    });
    const promoted = executions.promoteToPending(created.id, {
      signature: "0xbeef",
      signatureSource: "safe_prepared_signature",
      forceAfterPreflightRevert: 0,
    });
    expect(promoted.state).toBe("pending");
    expect(promoted.signature).toBe("0xbeef");
    expect(promoted.signatureSource).toBe("safe_prepared_signature");
    expect(promoted.authorizationPollAt).toBeNull();
  });

  it("dedup replay returns the same awaiting_authorization execution", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const digest = "0x" + "ee".repeat(32);
    const created = executions.createAwaitingAuthorization({
      ...basePending(),
      digest,
      authorizationType: "safeMessageV1",
      safeMessageHash: "0x" + "ff".repeat(32),
    });
    const found = executions.findByDedupKey(
      1,
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000003",
      digest,
    );
    expect(found?.id).toBe(created.id);
    expect(found?.state).toBe("awaiting_authorization");
  });

  it("survives provider restart with awaiting_authorization rows still due for poll", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const created = executions.createAwaitingAuthorization({
      ...basePending(),
      digest: "0x" + "ff".repeat(32),
      authorizationType: "safeMessageV1",
      safeMessageHash: "0x" + "00".repeat(32),
    });
    executions.scheduleAuthorizationPoll(created.id, {
      pollAt: new Date(Date.now() - 1_000).toISOString(),
      pollAttempts: 2,
    });

    const restarted = new RelayExecutionRepository(db);
    const due = restarted.listAwaitingAuthorizationDue(10);
    expect(due.some((row) => row.id === created.id)).toBe(true);
    expect(restarted.getByIdOrThrow(created.id).authorizationPollAttempts).toBe(2);
  });

  it("applies migration 003 while child foreign-key rows still reference relay_executions", () => {
    const db = makeDb();
    db.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at text NOT NULL
      );
    `);
    const insertVersion = db.db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)",
    );
    for (const migration of migrations) {
      if (migration.version === "003_safe_message_authorization") {
        break;
      }
      db.db.exec("PRAGMA foreign_keys = OFF;");
      try {
        db.transaction(() => {
          db.db.exec(migration.sql);
          insertVersion.run(migration.version, new Date().toISOString());
        });
      } finally {
        db.db.exec("PRAGMA foreign_keys = ON;");
      }
    }

    const now = new Date().toISOString();
    db.db
      .prepare(
        `INSERT INTO relay_executions(
            id, client_id, client_request_id, request_body_hash, digest, domain, kind, state, terminal,
            chain_id, oz_relayer_id, oz_transaction_id, forwarder_address, macro_address, signer_address, nonce,
            valid_after, valid_before, value, payload, signature, permit2_json, metadata_json, force_after_preflight_revert,
            current_transaction_hash, transaction_hashes_json, receipt_json, required_confirmations, last_error_json,
            created_at, updated_at, terminal_at
          ) VALUES (
            'exec-1', 'anonymous', NULL, 'hash', '0x11', 'test', 'clearMacroV1', 'pending', 0,
            1, 'relayer', NULL, '0x1', '0x2', '0x3', '1',
            '0', '0', '0', '0x', '0xsig', NULL, '{}', 0,
            NULL, '[]', NULL, 1, NULL, ?, ?, NULL
          )`,
      )
      .run(now, now);
    db.db
      .prepare(
        `INSERT INTO relayer_transactions(
            oz_transaction_id, execution_id, oz_relayer_id, status, status_reason, tx_hash, nonce,
            gas_limit, gas_price, max_fee_per_gas, max_priority_fee_per_gas, raw_json,
            submitted_at, included_at, confirmed_at, receipt_json, last_polled_at, created_at, updated_at
          ) VALUES (
            'oz-1', 'exec-1', 'relayer', 'pending', NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, '{}',
            NULL, NULL, NULL, NULL, NULL, ?, ?
          )`,
      )
      .run(now, now);
    db.db
      .prepare(
        `INSERT INTO relay_execution_events(
            id, execution_id, type, actor, reason, details_json, created_at
          ) VALUES ('evt-1', 'exec-1', 'state_changed', 'api', 'created', '{}', ?)`,
      )
      .run(now);

    expect(() => runMigrations(db)).not.toThrow();
    const executions = new RelayExecutionRepository(db);
    const row = executions.getByIdOrThrow("exec-1");
    expect(row.signature).toBe("0xsig");
    expect(row.authorizationType).toBeNull();
    expect(
      db.db.prepare("SELECT COUNT(*) AS c FROM relayer_transactions WHERE execution_id = 'exec-1'").get() as {
        c: number;
      },
    ).toEqual({ c: 1 });
  });

  it("applies migration 003 authorization columns", () => {
    const db = makeDb();
    runMigrations(db);
    const columns = db.db
      .prepare("PRAGMA table_info(relay_executions)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    expect(names.has("authorization_type")).toBe(true);
    expect(names.has("safe_message_hash")).toBe(true);
    expect(names.has("authorization_poll_at")).toBe(true);
    expect(names.has("signature_source")).toBe(true);
  });
});
