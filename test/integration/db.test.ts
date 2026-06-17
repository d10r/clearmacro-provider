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
});
