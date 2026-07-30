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
  {
    version: "002_simplified_relay_schema",
    sql: `
      PRAGMA foreign_keys = OFF;

      DROP TABLE IF EXISTS relay_execution_events;
      DROP TABLE IF EXISTS relayer_transactions;
      DROP TABLE IF EXISTS relay_executions;

      CREATE TABLE relay_executions (
        id text PRIMARY KEY,
        client_id text NOT NULL,
        client_request_id text NULL,
        request_body_hash text NOT NULL,
        digest text NOT NULL,
        domain text NOT NULL,
        kind text NOT NULL,
        state text NOT NULL,
        terminal integer NOT NULL DEFAULT 0,
        chain_id integer NOT NULL,
        oz_relayer_id text NOT NULL,
        oz_transaction_id text NULL,
        forwarder_address text NOT NULL,
        macro_address text NOT NULL,
        signer_address text NOT NULL,
        nonce text NOT NULL,
        valid_after text NOT NULL,
        valid_before text NOT NULL,
        value text NOT NULL DEFAULT '0',
        payload text NOT NULL,
        signature text NOT NULL,
        permit2_json text NULL,
        metadata_json text NOT NULL DEFAULT '{}',
        force_after_preflight_revert integer NOT NULL DEFAULT 0,
        current_transaction_hash text NULL,
        transaction_hashes_json text NOT NULL DEFAULT '[]',
        receipt_json text NULL,
        required_confirmations integer NULL,
        last_error_json text NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        terminal_at text NULL
      );

      CREATE UNIQUE INDEX relay_executions_dedup_uniq
        ON relay_executions(chain_id, forwarder_address, signer_address, digest);

      CREATE INDEX relay_executions_state_chain_created_idx
        ON relay_executions(state, chain_id, created_at);
      CREATE INDEX relay_executions_chain_tx_hash_idx
        ON relay_executions(chain_id, current_transaction_hash)
        WHERE current_transaction_hash IS NOT NULL;
      CREATE INDEX relay_executions_oz_ids_idx
        ON relay_executions(oz_relayer_id, oz_transaction_id)
        WHERE oz_transaction_id IS NOT NULL;
      CREATE INDEX relay_executions_client_request_id_idx
        ON relay_executions(client_id, client_request_id)
        WHERE client_request_id IS NOT NULL;

      CREATE TABLE relayer_transactions (
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

      CREATE INDEX relayer_transactions_execution_idx
        ON relayer_transactions(execution_id);
      CREATE INDEX relayer_transactions_status_updated_idx
        ON relayer_transactions(status, updated_at);
      CREATE INDEX relayer_transactions_tx_hash_idx
        ON relayer_transactions(tx_hash)
        WHERE tx_hash IS NOT NULL;

      CREATE TABLE relay_execution_events (
        id text PRIMARY KEY,
        execution_id text NOT NULL REFERENCES relay_executions(id),
        type text NOT NULL,
        actor text NOT NULL,
        reason text NOT NULL,
        details_json text NOT NULL DEFAULT '{}',
        created_at text NOT NULL
      );

      CREATE INDEX relay_execution_events_execution_created_idx
        ON relay_execution_events(execution_id, created_at);
      CREATE INDEX relay_execution_events_type_created_idx
        ON relay_execution_events(type, created_at);

      CREATE TABLE create_request_audit_log (
        id text PRIMARY KEY,
        created_at text NOT NULL,
        client_id text NOT NULL,
        request_body_hash text NOT NULL,
        outcome_code text NOT NULL,
        execution_id text NULL,
        chain_id integer NULL,
        kind text NULL,
        forwarder_address text NULL,
        domain text NULL,
        macro_address text NULL,
        signer_address text NULL,
        provider_name text NULL,
        nonce text NULL,
        digest text NULL
      );

      CREATE INDEX create_request_audit_log_created_idx
        ON create_request_audit_log(created_at);
      CREATE INDEX create_request_audit_log_client_created_idx
        ON create_request_audit_log(client_id, created_at);

      PRAGMA foreign_keys = ON;
    `,
  },
  {
    version: "003_safe_message_authorization",
    sql: `
      PRAGMA foreign_keys = OFF;

      CREATE TABLE relay_executions_new (
        id text PRIMARY KEY,
        client_id text NOT NULL,
        client_request_id text NULL,
        request_body_hash text NOT NULL,
        digest text NOT NULL,
        domain text NOT NULL,
        kind text NOT NULL,
        state text NOT NULL,
        terminal integer NOT NULL DEFAULT 0,
        chain_id integer NOT NULL,
        oz_relayer_id text NOT NULL,
        oz_transaction_id text NULL,
        forwarder_address text NOT NULL,
        macro_address text NOT NULL,
        signer_address text NOT NULL,
        nonce text NOT NULL,
        valid_after text NOT NULL,
        valid_before text NOT NULL,
        value text NOT NULL DEFAULT '0',
        payload text NOT NULL,
        signature text NULL,
        permit2_json text NULL,
        metadata_json text NOT NULL DEFAULT '{}',
        force_after_preflight_revert integer NOT NULL DEFAULT 0,
        authorization_type text NULL,
        safe_message_hash text NULL,
        authorization_poll_at text NULL,
        authorization_poll_attempts integer NOT NULL DEFAULT 0,
        authorization_last_error_json text NULL,
        signature_source text NULL,
        current_transaction_hash text NULL,
        transaction_hashes_json text NOT NULL DEFAULT '[]',
        receipt_json text NULL,
        required_confirmations integer NULL,
        last_error_json text NULL,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        terminal_at text NULL
      );

      INSERT INTO relay_executions_new (
        id, client_id, client_request_id, request_body_hash, digest, domain, kind, state, terminal,
        chain_id, oz_relayer_id, oz_transaction_id, forwarder_address, macro_address, signer_address,
        nonce, valid_after, valid_before, value, payload, signature, permit2_json, metadata_json,
        force_after_preflight_revert, authorization_type, safe_message_hash, authorization_poll_at,
        authorization_poll_attempts, authorization_last_error_json, signature_source,
        current_transaction_hash, transaction_hashes_json, receipt_json, required_confirmations,
        last_error_json, created_at, updated_at, terminal_at
      )
      SELECT
        id, client_id, client_request_id, request_body_hash, digest, domain, kind, state, terminal,
        chain_id, oz_relayer_id, oz_transaction_id, forwarder_address, macro_address, signer_address,
        nonce, valid_after, valid_before, value, payload, signature, permit2_json, metadata_json,
        force_after_preflight_revert, NULL, NULL, NULL, 0, NULL, NULL,
        current_transaction_hash, transaction_hashes_json, receipt_json, required_confirmations,
        last_error_json, created_at, updated_at, terminal_at
      FROM relay_executions;

      DROP TABLE relay_executions;
      ALTER TABLE relay_executions_new RENAME TO relay_executions;

      CREATE UNIQUE INDEX relay_executions_dedup_uniq
        ON relay_executions(chain_id, forwarder_address, signer_address, digest);
      CREATE INDEX relay_executions_state_chain_created_idx
        ON relay_executions(state, chain_id, created_at);
      CREATE INDEX relay_executions_chain_tx_hash_idx
        ON relay_executions(chain_id, current_transaction_hash)
        WHERE current_transaction_hash IS NOT NULL;
      CREATE INDEX relay_executions_oz_ids_idx
        ON relay_executions(oz_relayer_id, oz_transaction_id)
        WHERE oz_transaction_id IS NOT NULL;
      CREATE INDEX relay_executions_client_request_id_idx
        ON relay_executions(client_id, client_request_id)
        WHERE client_request_id IS NOT NULL;
      CREATE INDEX relay_executions_awaiting_auth_poll_idx
        ON relay_executions(authorization_poll_at, created_at)
        WHERE terminal = 0 AND state = 'awaiting_authorization';

      PRAGMA foreign_keys = ON;
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

