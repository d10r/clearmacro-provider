import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { RelayExecutionEventRepository, RelayExecutionRepository } from "../../src/db/repositories.js";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "db-test-"));
  return openDatabase(join(dir, "app.sqlite"));
}

describe("db migrations and repositories", () => {
  it("applies migrations and enforces idempotency uniqueness", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);

    executions.createAccepted({
      clientId: "anonymous",
      clientRequestId: null,
      idempotencyKey: "k1",
      requestBodyHash: "abc",
      kind: "clearMacroV1",
      chainId: 1,
      ozRelayerId: "relayer",
      forwarderAddress: "0x0000000000000000000000000000000000000001",
      macroAddress: "0x0000000000000000000000000000000000000002",
      signerAddress: "0x0000000000000000000000000000000000000003",
      provider: "macros.superfluid.eth",
      nonce: "1",
      validAfter: "0",
      validBefore: "0",
      value: "0",
      payload: "0x",
      signature: "0x",
      permit2Json: null,
      metadataJson: "{}",
      requiredConfirmations: 1,
    });

    expect(() =>
      executions.createAccepted({
        clientId: "anonymous",
        clientRequestId: null,
        idempotencyKey: "k1",
        requestBodyHash: "def",
        kind: "clearMacroV1",
        chainId: 1,
        ozRelayerId: "relayer",
        forwarderAddress: "0x0000000000000000000000000000000000000001",
        macroAddress: "0x0000000000000000000000000000000000000002",
        signerAddress: "0x0000000000000000000000000000000000000003",
        provider: "macros.superfluid.eth",
        nonce: "2",
        validAfter: "0",
        validBefore: "0",
        value: "0",
        payload: "0x",
        signature: "0x",
        permit2Json: null,
        metadataJson: "{}",
        requiredConfirmations: 1,
      }),
    ).toThrow();
  });

  it("writes request transition and audit atomically", () => {
    const db = makeDb();
    runMigrations(db);
    const executions = new RelayExecutionRepository(db);
    const executionEvents = new RelayExecutionEventRepository(db);
    const created = executions.createAccepted({
      clientId: "anonymous",
      clientRequestId: null,
      idempotencyKey: null,
      requestBodyHash: "abc",
      kind: "clearMacroV1",
      chainId: 1,
      ozRelayerId: "relayer",
      forwarderAddress: "0x0000000000000000000000000000000000000001",
      macroAddress: "0x0000000000000000000000000000000000000002",
      signerAddress: "0x0000000000000000000000000000000000000003",
      provider: "macros.superfluid.eth",
      nonce: "1",
      validAfter: "0",
      validBefore: "0",
      value: "0",
      payload: "0x",
      signature: "0x",
      permit2Json: null,
      metadataJson: "{}",
      requiredConfirmations: 1,
    });
    executions.transitionState(created.id, "pending");
    executionEvents.append({
      executionId: created.id,
      type: "state_changed",
      actor: "worker",
      reason: "claimed",
      detailsJson: "{}",
    });
    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("pending");
    expect(executionEvents.listByExecution(created.id)).toHaveLength(1);
  });
});

