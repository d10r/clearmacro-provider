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

      CREATE TABLE IF NOT EXISTS relay_requests (
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
        forwarder text NOT NULL,
        macro text NOT NULL,
        signer text NOT NULL,
        provider text NOT NULL,
        clear_macro_nonce text NOT NULL,
        valid_after text NOT NULL,
        valid_before text NOT NULL,
        msg_value text NOT NULL DEFAULT '0',
        params text NOT NULL,
        signature text NULL,
        permit2_json text NULL,
        metadata_json text NOT NULL DEFAULT '{}',
        current_tx_hash text NULL,
        required_confirmations integer NULL,
        last_error_json text NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        terminal_at text NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS relay_requests_client_idempotency_uniq
        ON relay_requests(client_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS relay_requests_semantic_uniq
        ON relay_requests(chain_id, forwarder, macro, signer, clear_macro_nonce);
      CREATE INDEX IF NOT EXISTS relay_requests_state_chain_created_idx
        ON relay_requests(state, chain_id, created_at);
      CREATE INDEX IF NOT EXISTS relay_requests_chain_tx_hash_idx
        ON relay_requests(chain_id, current_tx_hash)
        WHERE current_tx_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS relay_requests_oz_ids_idx
        ON relay_requests(oz_relayer_id, oz_transaction_id)
        WHERE oz_transaction_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS relayer_transactions (
        oz_transaction_id text PRIMARY KEY,
        request_id text NOT NULL REFERENCES relay_requests(id),
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
        confirmed_at text NULL,
        last_polled_at text NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );

      CREATE INDEX IF NOT EXISTS relayer_transactions_request_idx
        ON relayer_transactions(request_id);
      CREATE INDEX IF NOT EXISTS relayer_transactions_status_updated_idx
        ON relayer_transactions(status, updated_at);
      CREATE INDEX IF NOT EXISTS relayer_transactions_tx_hash_idx
        ON relayer_transactions(tx_hash)
        WHERE tx_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS audit_events (
        id text PRIMARY KEY,
        request_id text NOT NULL REFERENCES relay_requests(id),
        type text NOT NULL,
        actor text NOT NULL,
        reason text NOT NULL,
        details_json text NOT NULL DEFAULT '{}',
        created_at text NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_request_created_idx
        ON audit_events(request_id, created_at);
      CREATE INDEX IF NOT EXISTS audit_events_type_created_idx
        ON audit_events(type, created_at);
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

