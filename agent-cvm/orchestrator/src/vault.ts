/**
 * Secrets Vault — encrypted key-value store for credentials.
 *
 * In production, the encryption key is derived from the TDX sealing key,
 * making secrets inaccessible outside the CVM.
 *
 * Phase 1: AES-256-GCM with a key derived from VAULT_MASTER_KEY env var.
 * Phase 2+: TDX sealing key integration via dstack SDK.
 */

import type { CredentialInfo } from '@luciaclaw/protocol';
import { getDb, encrypt, decrypt } from './storage.js';

const subtle = globalThis.crypto.subtle;

interface EncryptedEntry {
  iv: string; // base64
  ciphertext: string; // base64
}

const store = new Map<string, EncryptedEntry>();
let vaultKey: CryptoKey | null = null;

async function getBaseKey(): Promise<CryptoKey> {
  const masterKeyHex = process.env.VAULT_MASTER_KEY;
  if (!masterKeyHex) {
    // Generate a random key for development
    const key = await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    console.warn('[vault] Using ephemeral key — secrets will not persist across restarts');
    return key;
  }

  const rawKey = Buffer.from(masterKeyHex, 'hex');
  return subtle.importKey('raw', rawKey, 'HKDF', false, ['deriveKey']);
}

async function deriveKeyWithInfo(info: string): Promise<CryptoKey> {
  const masterKeyHex = process.env.VAULT_MASTER_KEY;
  if (!masterKeyHex) {
    // No master key — generate ephemeral
    return subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  const rawKey = Buffer.from(masterKeyHex, 'hex');
  const baseKey = await subtle.importKey('raw', rawKey, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('lucia-vault-v1'),
      info: new TextEncoder().encode(info),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function getVaultKey(): Promise<CryptoKey> {
  if (vaultKey) return vaultKey;
  vaultKey = await deriveKeyWithInfo('secrets-vault');
  return vaultKey;
}

/** Derive a separate key for memory/storage encryption (different from vault key) */
export async function deriveMemoryKey(): Promise<CryptoKey> {
  return deriveKeyWithInfo('memory-encryption');
}

/** Store a secret (encrypted at rest). */
export async function setSecret(key: string, value: string): Promise<void> {
  const encKey = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    encKey,
    new TextEncoder().encode(value)
  );
  store.set(key, {
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
  });
}

/** Retrieve a secret (decrypted in memory). */
export async function getSecret(key: string): Promise<string | null> {
  const entry = store.get(key);
  if (!entry) return null;

  const encKey = await getVaultKey();
  const decrypted = await subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(entry.iv, 'base64') },
    encKey,
    Buffer.from(entry.ciphertext, 'base64')
  );
  return new TextDecoder().decode(decrypted);
}

/** Delete a secret. */
export function deleteSecret(key: string): boolean {
  return store.delete(key);
}

/** List all secret keys (not values). */
export function listSecretKeys(): string[] {
  return [...store.keys()];
}

// --- Service Credential Management (backed by SQLite) ---

/** Store or update a service credential in encrypted SQLite */
export async function setServiceCredential(
  service: string,
  label: string,
  credentialType: string,
  value: string,
  scopes?: string[],
  account: string = 'default'
): Promise<void> {
  const valueEnc = await encrypt(value);
  const db = getDb();

  db.prepare(`
    INSERT INTO credentials (service, account, label, credential_type, value_enc, scopes, connected, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(service, account) DO UPDATE SET
      label = excluded.label,
      credential_type = excluded.credential_type,
      value_enc = excluded.value_enc,
      scopes = excluded.scopes,
      connected = 1
  `).run(service, account, label, credentialType, valueEnc, scopes ? JSON.stringify(scopes) : null, Date.now());
}

/** Retrieve a decrypted service credential value */
export async function getServiceCredential(service: string, account: string = 'default'): Promise<string | null> {
  const db = getDb();
  const row = db.prepare(
    'SELECT value_enc FROM credentials WHERE service = ? AND account = ? AND connected = 1'
  ).get(service, account) as { value_enc: string } | undefined;

  if (!row) return null;

  // Update last_used_at
  db.prepare('UPDATE credentials SET last_used_at = ? WHERE service = ? AND account = ?')
    .run(Date.now(), service, account);

  return decrypt(row.value_enc);
}

/** Delete a service credential */
export function deleteServiceCredential(service: string, account: string = 'default'): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM credentials WHERE service = ? AND account = ?').run(service, account);
  return result.changes > 0;
}

/** List service credentials (metadata only, no secret values) */
export function listServiceCredentials(serviceFilter?: string, accountFilter?: string): CredentialInfo[] {
  const db = getDb();
  let query = 'SELECT * FROM credentials';
  const conditions: string[] = [];
  const params: string[] = [];

  if (serviceFilter) {
    conditions.push('service = ?');
    params.push(serviceFilter);
  }
  if (accountFilter) {
    conditions.push('account = ?');
    params.push(accountFilter);
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params) as any[];

  return rows.map((row) => ({
    service: row.service,
    ...(row.account !== 'default' ? { account: row.account } : {}),
    label: row.label,
    credentialType: row.credential_type,
    connected: row.connected === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || undefined,
    scopes: row.scopes ? JSON.parse(row.scopes) : undefined,
  }));
}
