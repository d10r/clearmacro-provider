import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { AuditEventRepository, RelayRequestRepository } from "../../src/db/repositories.js";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "db-test-"));
  return openDatabase(join(dir, "app.sqlite"));
}

describe("db migrations and repositories", () => {
  it("applies migrations and enforces idempotency uniqueness", () => {
    const db = makeDb();
    runMigrations(db);
    const requests = new RelayRequestRepository(db);

    requests.createAccepted({
      clientId: "anonymous",
      clientRequestId: null,
      idempotencyKey: "k1",
      requestBodyHash: "abc",
      kind: "clearMacroV1",
      chainId: 1,
      ozRelayerId: "relayer",
      forwarder: "0x0000000000000000000000000000000000000001",
      macro: "0x0000000000000000000000000000000000000002",
      signer: "0x0000000000000000000000000000000000000003",
      provider: "macros.superfluid.eth",
      clearMacroNonce: "1",
      validAfter: "0",
      validBefore: "0",
      msgValue: "0",
      params: "0x",
      signature: "0x",
      permit2Json: null,
      metadataJson: "{}",
      requiredConfirmations: 1,
    });

    expect(() =>
      requests.createAccepted({
        clientId: "anonymous",
        clientRequestId: null,
        idempotencyKey: "k1",
        requestBodyHash: "def",
        kind: "clearMacroV1",
        chainId: 1,
        ozRelayerId: "relayer",
        forwarder: "0x0000000000000000000000000000000000000001",
        macro: "0x0000000000000000000000000000000000000002",
        signer: "0x0000000000000000000000000000000000000003",
        provider: "macros.superfluid.eth",
        clearMacroNonce: "2",
        validAfter: "0",
        validBefore: "0",
        msgValue: "0",
        params: "0x",
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
    const requests = new RelayRequestRepository(db);
    const audits = new AuditEventRepository(db);
    const created = requests.createAccepted({
      clientId: "anonymous",
      clientRequestId: null,
      idempotencyKey: null,
      requestBodyHash: "abc",
      kind: "clearMacroV1",
      chainId: 1,
      ozRelayerId: "relayer",
      forwarder: "0x0000000000000000000000000000000000000001",
      macro: "0x0000000000000000000000000000000000000002",
      signer: "0x0000000000000000000000000000000000000003",
      provider: "macros.superfluid.eth",
      clearMacroNonce: "1",
      validAfter: "0",
      validBefore: "0",
      msgValue: "0",
      params: "0x",
      signature: "0x",
      permit2Json: null,
      metadataJson: "{}",
      requiredConfirmations: 1,
    });
    requests.transitionState(created.id, "queued");
    audits.append({
      requestId: created.id,
      type: "queued",
      actor: "worker",
      reason: "claimed",
      detailsJson: "{}",
    });
    const updated = requests.getByIdOrThrow(created.id);
    expect(updated.state).toBe("queued");
    expect(audits.listByRequest(created.id)).toHaveLength(1);
  });
});

