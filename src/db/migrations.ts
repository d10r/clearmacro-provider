import type { DbClient } from "./client.js";

type Migration = {
  version: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    version: "001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relay_executions (
        id text PRIMARY KEY,
        client_id text NOT NULL,
        client_request_id text NULL,
        idempotency_key text NULL,
        request_body_hash text NOT NULL,
        kind text NOT NULL,
        state text NOT NULL,
        terminal integer NOT NULL DEFAULT 0,
        chain_id integer NOT NULL,
        oz_relayer_id text NOT NULL,
        oz_transaction_id text NULL,
        forwarder_address text NOT NULL,
        macro_address text NOT NULL,
        signer_address text NOT NULL,
        provider text NOT NULL,
        nonce text NOT NULL,
        valid_after text NOT NULL,
        valid_before text NOT NULL,
        value text NOT NULL DEFAULT '0',
        payload text NOT NULL,
        signature text NOT NULL,
        permit2_json text NULL,
        metadata_json text NOT NULL DEFAULT '{}',
        current_transaction_hash text NULL,
        transaction_hashes_json text NOT NULL DEFAULT '[]',
        receipt_json text NULL,
        required_confirmations integer NULL,
        last_error_json text NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        terminal_at text NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS relay_executions_client_idempotency_uniq
        ON relay_executions(client_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS relay_executions_semantic_uniq
        ON relay_executions(chain_id, forwarder_address, macro_address, signer_address, nonce);
      CREATE INDEX IF NOT EXISTS relay_executions_state_chain_created_idx
        ON relay_executions(state, chain_id, created_at);
      CREATE INDEX IF NOT EXISTS relay_executions_chain_tx_hash_idx
        ON relay_executions(chain_id, current_transaction_hash)
        WHERE current_transaction_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS relay_executions_oz_ids_idx
        ON relay_executions(oz_relayer_id, oz_transaction_id)
        WHERE oz_transaction_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS relay_executions_client_request_id_idx
        ON relay_executions(client_id, client_request_id)
        WHERE client_request_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS relayer_transactions (
        oz_transaction_id text PRIMARY KEY,
        execution_id text NOT NULL REFERENCES relay_executions(id),
        oz_relayer_id text NOT NULL,
        status text NOT NULL,
        status_reason text NULL,
        tx_hash text NULL,
        nonce text NULL,
        gas_limit text NULL,
        gas_price text NULL,
        max_fee_per_gas text NULL,
        max_priority_fee_per_gas text NULL,
        raw_json text NOT NULL,
        submitted_at text NULL,
        included_at text NULL,
        confirmed_at text NULL,
        receipt_json text NULL,
        last_polled_at text NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );

      CREATE INDEX IF NOT EXISTS relayer_transactions_execution_idx
        ON relayer_transactions(execution_id);
      CREATE INDEX IF NOT EXISTS relayer_transactions_status_updated_idx
        ON relayer_transactions(status, updated_at);
      CREATE INDEX IF NOT EXISTS relayer_transactions_tx_hash_idx
        ON relayer_transactions(tx_hash)
        WHERE tx_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS relay_execution_events (
        id text PRIMARY KEY,
        execution_id text NOT NULL REFERENCES relay_executions(id),
        type text NOT NULL,
        actor text NOT NULL,
        reason text NOT NULL,
        details_json text NOT NULL DEFAULT '{}',
        created_at text NOT NULL
      );

      CREATE INDEX IF NOT EXISTS relay_execution_events_execution_created_idx
        ON relay_execution_events(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS relay_execution_events_type_created_idx
        ON relay_execution_events(type, created_at);
    `,
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

export function runMigrations(client: DbClient): void {
  client.db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at text NOT NULL
    );
  `);

  const select = client.db.prepare("SELECT version FROM schema_migrations WHERE version = ?");
  const insert = client.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)");

  for (const migration of migrations) {
    const row = select.get(migration.version) as { version: string } | undefined;
    if (row) {
      continue;
    }
    client.transaction(() => {
      client.db.exec(migration.sql);
      insert.run(migration.version, nowIso());
    });
  }
}

