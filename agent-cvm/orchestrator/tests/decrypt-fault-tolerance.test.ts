import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Set DATA_DIR before any storage module usage
const tempDir = mkdtempSync(join(tmpdir(), 'lucia-decrypt-test-'));
process.env.DATA_DIR = tempDir;

// Start with a known master key
process.env.VAULT_MASTER_KEY = 'a'.repeat(64); // 256-bit hex key

import { getDb, encrypt, decrypt, closeDb, _resetMemoryKey } from '../src/storage.js';
import { setPreference, getPreference, getAllPreferences } from '../src/persistent-memory.js';
import {
  createConversation,
  listConversations,
  loadConversation,
  addToHistory,
} from '../src/memory.js';

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Core decrypt fault-tolerance ───

describe('decrypt() fault tolerance', () => {
  it('round-trips encrypt/decrypt with the same key', async () => {
    const plaintext = 'Hello, Lucia!';
    const encrypted = await encrypt(plaintext);
    const decrypted = await decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('returns null for data encrypted with a different key', async () => {
    const plaintext = 'Secret data';
    const encrypted = await encrypt(plaintext);

    // Simulate key rotation
    process.env.VAULT_MASTER_KEY = 'b'.repeat(64);
    _resetMemoryKey();

    const result = await decrypt(encrypted);
    expect(result).toBeNull();

    // Restore original key
    process.env.VAULT_MASTER_KEY = 'a'.repeat(64);
    _resetMemoryKey();
  });

  it('returns null for corrupted base64', async () => {
    const result = await decrypt('not-valid-base64!!!');
    expect(result).toBeNull();
  });

  it('returns null for truncated ciphertext', async () => {
    const encrypted = await encrypt('test');
    // Truncate the ciphertext (remove last 10 chars)
    const truncated = encrypted.substring(0, encrypted.length - 10);
    const result = await decrypt(truncated);
    expect(result).toBeNull();
  });

  it('still works after a failed decrypt', async () => {
    // First, try a bad decrypt
    const badResult = await decrypt('garbage-data');
    expect(badResult).toBeNull();

    // Then verify a good decrypt still works
    const plaintext = 'Still works';
    const encrypted = await encrypt(plaintext);
    const decrypted = await decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });
});

// ─── Preference fault-tolerance ───

describe('getPreference() with undecryptable values', () => {
  it('returns null for missing key', async () => {
    const result = await getPreference('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null for undecryptable value', async () => {
    // Store a preference with the current key
    await setPreference('test-key', 'test-value');

    // Rotate key
    process.env.VAULT_MASTER_KEY = 'c'.repeat(64);
    _resetMemoryKey();

    const result = await getPreference('test-key');
    expect(result).toBeNull();

    // Restore
    process.env.VAULT_MASTER_KEY = 'a'.repeat(64);
    _resetMemoryKey();
  });
});

describe('getAllPreferences() skips undecryptable entries', () => {
  it('returns only decryptable preferences', async () => {
    // Store prefs with key 'a'
    await setPreference('pref-a1', 'value-a1');
    await setPreference('pref-a2', 'value-a2');

    // Rotate to key 'd' and store another pref
    process.env.VAULT_MASTER_KEY = 'd'.repeat(64);
    _resetMemoryKey();
    await setPreference('pref-d1', 'value-d1');

    // Now read all — should only get pref-d1 (a-key prefs are undecryptable)
    const prefs = await getAllPreferences();
    expect(prefs['pref-d1']).toBe('value-d1');
    expect(prefs['pref-a1']).toBeUndefined();
    expect(prefs['pref-a2']).toBeUndefined();

    // Restore
    process.env.VAULT_MASTER_KEY = 'a'.repeat(64);
    _resetMemoryKey();
  });
});

// ─── Conversation fault-tolerance ───

describe('listConversations() skips undecryptable rows', () => {
  it('skips conversations with undecryptable titles', async () => {
    // Create conversation with key 'a'
    const id1 = await createConversation('Readable conversation');

    // Rotate key and create another conversation
    process.env.VAULT_MASTER_KEY = 'e'.repeat(64);
    _resetMemoryKey();
    const id2 = await createConversation('New key conversation');

    // List — should only contain the one encrypted with current key
    const conversations = await listConversations();
    const ids = conversations.map((c) => c.id);
    expect(ids).toContain(id2);
    expect(ids).not.toContain(id1);

    // The new-key conversation should have the correct title
    const found = conversations.find((c) => c.id === id2);
    expect(found?.title).toBe('New key conversation');

    // Restore
    process.env.VAULT_MASTER_KEY = 'a'.repeat(64);
    _resetMemoryKey();
  });
});

describe('loadConversation() skips undecryptable messages', () => {
  it('skips messages encrypted with a different key', async () => {
    // Create conversation and add a message with key 'a'
    const convId = await createConversation('Test conversation');
    await addToHistory(
      {
        messageId: crypto.randomUUID(),
        role: 'user',
        content: 'Old key message',
        timestamp: Date.now(),
      },
      convId,
    );

    // Rotate key and add another message
    process.env.VAULT_MASTER_KEY = 'f'.repeat(64);
    _resetMemoryKey();
    await addToHistory(
      {
        messageId: crypto.randomUUID(),
        role: 'assistant',
        content: 'New key message',
        timestamp: Date.now() + 1,
      },
      convId,
    );

    // Load — should only contain the message from the new key
    const { messages } = await loadConversation(convId);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('New key message');
    expect(messages[0].role).toBe('assistant');

    // Restore
    process.env.VAULT_MASTER_KEY = 'a'.repeat(64);
    _resetMemoryKey();
  });
});
