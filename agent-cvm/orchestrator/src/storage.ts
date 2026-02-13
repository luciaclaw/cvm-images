/**
 * Encrypted SQLite storage layer for persistent memory.
 *
 * All content fields (_enc) are AES-256-GCM encrypted before writing.
 * The encryption key is derived from the vault master key via HKDF
 * with info="memory-encryption" to keep it separate from the secrets vault key.
 *
 * Uses better-sqlite3 for synchronous, fast, single-user access.
 */

import Database from 'better-sqlite3';
import { deriveMemoryKey } from './vault.js';

const subtle = globalThis.crypto.subtle;

let db: Database.Database | null = null;
let memoryKey: CryptoKey | null = null;

function getDbPath(): string {
  const dataDir = process.env.DATA_DIR || '/data';
  return process.env.DB_PATH || `${dataDir}/lucia.db`;
}

export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title_enc TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_enc TEXT NOT NULL,
      tool_calls_enc TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, timestamp);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credentials (
      service TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT 'default',
      label TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      scopes TEXT,
      connected INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      PRIMARY KEY (service, account)
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      subscription_enc TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name_enc TEXT NOT NULL,
      cron_expression_enc TEXT NOT NULL,
      timezone_enc TEXT NOT NULL,
      prompt_enc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_next_run
      ON schedules(status, next_run_at);

    -- Schedule columns added for cron v2 (one-shot, delivery, retry, isolation, model)
    -- Uses ALTER TABLE for migration from existing databases

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content_enc TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      category
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name_enc TEXT NOT NULL,
      description_enc TEXT NOT NULL,
      definition_enc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      context_enc TEXT,
      trigger TEXT NOT NULL DEFAULT 'manual',
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workflow_step_executions (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output_enc TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow
      ON workflow_executions(workflow_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_workflow_step_executions_exec
      ON workflow_step_executions(execution_id);

    CREATE TABLE IF NOT EXISTS session_mappings (
      channel TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      session_type TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      label_enc TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      PRIMARY KEY (channel, peer_id)
    );
  `);

  // Migrate old single-PK credentials table to compound PK (service, account)
  const tableInfo = db.pragma('table_info(credentials)') as any[];
  const hasAccountColumn = tableInfo.some((col: any) => col.name === 'account');
  if (!hasAccountColumn) {
    db.exec(`
      ALTER TABLE credentials RENAME TO credentials_old;
      CREATE TABLE credentials (
        service TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT 'default',
        label TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        scopes TEXT,
        connected INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        PRIMARY KEY (service, account)
      );
      INSERT INTO credentials (service, account, label, credential_type, value_enc, scopes, connected, created_at, last_used_at)
        SELECT service, 'default', label, credential_type, value_enc, scopes, connected, created_at, last_used_at FROM credentials_old;
      DROP TABLE credentials_old;
    `);
    console.log('[storage] Migrated credentials table to compound PK (service, account)');
  }

  // Migrate schedules table for cron v2 features
  const scheduleInfo = db.pragma('table_info(schedules)') as any[];
  const scheduleColumns = new Set(scheduleInfo.map((col: any) => col.name));
  if (!scheduleColumns.has('schedule_type')) {
    db.exec(`
      ALTER TABLE schedules ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'cron';
      ALTER TABLE schedules ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE schedules ADD COLUMN delivery_enc TEXT;
      ALTER TABLE schedules ADD COLUMN model TEXT;
      ALTER TABLE schedules ADD COLUMN at_time INTEGER;
      ALTER TABLE schedules ADD COLUMN interval_ms INTEGER;
      ALTER TABLE schedules ADD COLUMN delete_after_run INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE schedules ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE schedules ADD COLUMN retry_backoff_ms INTEGER NOT NULL DEFAULT 30000;
      ALTER TABLE schedules ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE schedules ADD COLUMN last_error TEXT;
    `);
    console.log('[storage] Migrated schedules table for cron v2 (one-shot, delivery, retry, isolation, model)');
  }

  return db;
}

async function getMemoryKey(): Promise<CryptoKey> {
  if (memoryKey) return memoryKey;
  memoryKey = await deriveMemoryKey();
  return memoryKey;
}

/** Encrypt a string value with AES-256-GCM using the memory key */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getMemoryKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  // Pack IV + ciphertext as base64
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return Buffer.from(combined).toString('base64');
}

/** Decrypt an AES-256-GCM encrypted value */
export async function decrypt(packed: string): Promise<string> {
  const key = await getMemoryKey();
  const combined = Buffer.from(packed, 'base64');
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const decrypted = await subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

/** Close the database connection */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
