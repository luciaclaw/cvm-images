/**
 * Secrets Vault — encrypted key-value store for credentials.
 *
 * In production, the encryption key is derived from the TDX sealing key,
 * making secrets inaccessible outside the CVM.
 *
 * Phase 1: AES-256-GCM with a key derived from VAULT_MASTER_KEY env var.
 * Phase 2+: TDX sealing key integration via dstack SDK.
 */

const subtle = globalThis.crypto.subtle;

interface EncryptedEntry {
  iv: string; // base64
  ciphertext: string; // base64
}

const store = new Map<string, EncryptedEntry>();
let vaultKey: CryptoKey | null = null;

async function getVaultKey(): Promise<CryptoKey> {
  if (vaultKey) return vaultKey;

  const masterKeyHex = process.env.VAULT_MASTER_KEY;
  if (!masterKeyHex) {
    // Generate a random key for development
    vaultKey = await subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    console.warn('[vault] Using ephemeral key — secrets will not persist across restarts');
    return vaultKey;
  }

  // Derive key from master secret using HKDF
  const rawKey = Buffer.from(masterKeyHex, 'hex');
  const baseKey = await subtle.importKey('raw', rawKey, 'HKDF', false, ['deriveKey']);
  vaultKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('lucia-vault-v1'),
      info: new TextEncoder().encode('secrets-vault'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return vaultKey;
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
