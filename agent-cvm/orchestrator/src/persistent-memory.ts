/**
 * Persistent memory — encrypted storage, FTS5 search, preferences, and LLM extraction.
 *
 * Memories and preferences are encrypted at rest in SQLite.
 * FTS5 indexes plaintext for search (acceptable: both tables reside within
 * the same TDX-encrypted CVM filesystem).
 */

import type { MemoryCategory, MemoryEntry } from '@luciaclaw/protocol';
import { getDb, encrypt, decrypt } from './storage.js';
import { callInference } from './inference.js';

// ── Storage functions ──────────────────────────────────────────────────

export async function storeMemory(
  content: string,
  category: MemoryCategory = 'general',
  conversationId?: string,
): Promise<MemoryEntry> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  const contentEnc = await encrypt(content);

  db.prepare(
    `INSERT INTO memories (id, content_enc, category, conversation_id, created_at, access_count)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(id, contentEnc, category, conversationId ?? null, now);

  // Insert plaintext into FTS5 for search
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number } | undefined;
  if (row) {
    db.prepare('INSERT INTO memory_fts (rowid, content, category) VALUES (?, ?, ?)').run(
      row.rowid,
      content,
      category,
    );
  }

  return { id, content, category, conversationId, createdAt: now, accessCount: 0 };
}

export async function searchMemories(
  query: string,
  category?: MemoryCategory,
  limit = 10,
): Promise<MemoryEntry[]> {
  const db = getDb();

  // Sanitize query for FTS5: remove special chars, build OR terms
  const terms = query
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];

  const ftsQuery = terms.join(' OR ');

  let sql = `
    SELECT m.id, m.content_enc, m.category, m.conversation_id,
           m.created_at, m.last_accessed_at, m.access_count
    FROM memory_fts f
    JOIN memories m ON m.rowid = f.rowid
    WHERE memory_fts MATCH ?`;
  const params: unknown[] = [ftsQuery];

  if (category) {
    sql += ' AND m.category = ?';
    params.push(category);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    content_enc: string;
    category: MemoryCategory;
    conversation_id: string | null;
    created_at: number;
    last_accessed_at: number | null;
    access_count: number;
  }>;

  const now = Date.now();
  const updateStmt = db.prepare(
    'UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
  );
  for (const row of rows) {
    updateStmt.run(now, row.id);
  }

  const results: MemoryEntry[] = [];
  for (const row of rows) {
    const content = await decrypt(row.content_enc);
    if (content === null) continue; // skip undecryptable entries
    results.push({
      id: row.id,
      content,
      category: row.category,
      conversationId: row.conversation_id ?? undefined,
      createdAt: row.created_at,
      lastAccessedAt: now,
      accessCount: row.access_count + 1,
    });
  }

  return results;
}

export async function listMemories(
  category?: MemoryCategory,
  limit = 50,
  offset = 0,
): Promise<{ memories: MemoryEntry[]; total: number }> {
  const db = getDb();

  let countSql = 'SELECT COUNT(*) as total FROM memories';
  let selectSql = `
    SELECT id, content_enc, category, conversation_id,
           created_at, last_accessed_at, access_count
    FROM memories`;
  const params: unknown[] = [];

  if (category) {
    countSql += ' WHERE category = ?';
    selectSql += ' WHERE category = ?';
    params.push(category);
  }

  selectSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

  const totalRow = db.prepare(countSql).get(...params) as { total: number };
  const rows = db.prepare(selectSql).all(...params, limit, offset) as Array<{
    id: string;
    content_enc: string;
    category: MemoryCategory;
    conversation_id: string | null;
    created_at: number;
    last_accessed_at: number | null;
    access_count: number;
  }>;

  const memories: MemoryEntry[] = [];
  for (const row of rows) {
    const content = await decrypt(row.content_enc);
    if (content === null) continue; // skip undecryptable entries
    memories.push({
      id: row.id,
      content,
      category: row.category,
      conversationId: row.conversation_id ?? undefined,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      accessCount: row.access_count,
    });
  }

  return { memories, total: totalRow.total };
}

export function deleteMemory(id: string): boolean {
  const db = getDb();

  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as
    | { rowid: number }
    | undefined;
  if (!row) return false;

  db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(row.rowid);
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return true;
}

export function getMemoryCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
  return row.count;
}

// ── Preferences functions ──────────────────────────────────────────────

export async function setPreference(key: string, value: string): Promise<void> {
  const db = getDb();
  const valueEnc = await encrypt(value);
  db.prepare(
    `INSERT INTO user_preferences (key, value_enc, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
  ).run(key, valueEnc, Date.now());
}

export async function getPreference(key: string): Promise<string | null> {
  const db = getDb();
  const row = db.prepare('SELECT value_enc FROM user_preferences WHERE key = ?').get(key) as
    | { value_enc: string }
    | undefined;
  if (!row) return null;
  return await decrypt(row.value_enc);
}

export async function getAllPreferences(): Promise<Record<string, string>> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value_enc FROM user_preferences').all() as Array<{
    key: string;
    value_enc: string;
  }>;

  const prefs: Record<string, string> = {};
  for (const row of rows) {
    const value = await decrypt(row.value_enc);
    if (value === null) continue; // skip undecryptable entries
    prefs[row.key] = value;
  }
  return prefs;
}

// ── Chat integration ───────────────────────────────────────────────────

/**
 * Maximum total character length of the memory context injected into the system prompt.
 * This prevents the system prompt from growing unbounded when the user has many
 * memories/preferences (which caused 400 errors from upstream LLM providers).
 */
const MAX_CONTEXT_LENGTH = 4000;

/** Maximum character length for a single memory or preference value */
const MAX_ENTRY_LENGTH = 500;

/**
 * Preference keys that are already loaded individually in chat.ts and should NOT
 * be duplicated in the memory context. Also includes internal system keys.
 */
const EXCLUDED_PREF_KEYS = new Set([
  'personality_tone',
  'personality_instructions',
  'user_timezone',
  'user_full_name',
  'user_preferred_name',
  'agent_name',
  'usage_limit_daily',
  'usage_limit_monthly',
]);

export async function getRelevantMemories(userMessage: string, limit = 5): Promise<string> {
  const parts: string[] = [];

  // Search memories using key terms from the user's message
  const terms = userMessage
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  if (terms.length > 0) {
    const query = terms.slice(0, 8).join(' OR ');
    try {
      const memories = await searchMemories(query, undefined, limit);
      console.log(`[memory-diag] searchMemories returned ${memories.length} results for query="${query}"`);
      for (const m of memories) {
        console.log(`[memory-diag]   memory id=${m.id} category=${m.category} len=${m.content.length} preview="${m.content.slice(0, 100)}"`);
      }
      if (memories.length > 0) {
        parts.push('## What you remember about the user:');
        for (const m of memories) {
          const truncated = m.content.length > MAX_ENTRY_LENGTH
            ? m.content.slice(0, MAX_ENTRY_LENGTH) + '…'
            : m.content;
          parts.push(`- ${truncated} (${m.category})`);
        }
      }
    } catch {
      // FTS5 query failed — non-critical, skip
    }
  }

  // Include preferences (excluding keys already loaded individually in chat.ts)
  const prefs = await getAllPreferences();
  const allPrefEntries = Object.entries(prefs);
  const prefEntries = allPrefEntries.filter(([key]) => !EXCLUDED_PREF_KEYS.has(key));
  console.log(`[memory-diag] getAllPreferences returned ${allPrefEntries.length} total, ${prefEntries.length} after filtering`);
  for (const [key, value] of allPrefEntries) {
    console.log(`[memory-diag]   pref key="${key}" len=${value.length} excluded=${EXCLUDED_PREF_KEYS.has(key)} preview="${value.slice(0, 100)}"`);
  }
  if (prefEntries.length > 0) {
    parts.push('## User preferences:');
    for (const [key, value] of prefEntries) {
      const truncated = value.length > MAX_ENTRY_LENGTH
        ? value.slice(0, MAX_ENTRY_LENGTH) + '…'
        : value;
      parts.push(`- ${key}: ${truncated}`);
    }
  }

  let result = parts.join('\n');

  // Hard cap on total memory context length
  if (result.length > MAX_CONTEXT_LENGTH) {
    result = result.slice(0, MAX_CONTEXT_LENGTH) + '\n[…memory context truncated]';
    console.warn(`[memory] Context truncated from ${parts.join('\n').length} to ${MAX_CONTEXT_LENGTH} chars`);
  }

  return result;
}

const EXTRACTION_PROMPT = `Extract any memorable facts, preferences, or important information from this conversation exchange that would be useful to remember in future conversations. Return a JSON array of objects with "content" and "category" fields. Categories: fact, preference, event, decision, relationship, general. Return an empty array [] if nothing is worth remembering.

Only extract genuinely useful long-term information. Do NOT extract:
- Trivial greetings or small talk
- Information that is only relevant to the current conversation
- Things the user already asked you to do (those are tasks, not memories)

Examples of good memories:
- {"content": "User's name is Alex", "category": "fact"}
- {"content": "Prefers concise replies over detailed explanations", "category": "preference"}
- {"content": "Works at Acme Corp as a product manager", "category": "fact"}
- {"content": "Decided to use React for the dashboard project", "category": "decision"}

Respond with ONLY the JSON array, no other text.`;

export async function extractAndStoreMemories(
  userMessage: string,
  assistantResponse: string,
  conversationId: string,
): Promise<void> {
  try {
    const messages = [
      { role: 'system' as const, content: EXTRACTION_PROMPT },
      {
        role: 'user' as const,
        content: `User: ${userMessage}\n\nAssistant: ${assistantResponse}`,
      },
    ];

    const result = await callInference(messages);
    const text = result.content.trim();

    // Parse JSON array from response (handle markdown code blocks)
    const jsonStr = text.startsWith('[') ? text : text.match(/\[[\s\S]*\]/)?.[0];
    if (!jsonStr) return;

    const extracted = JSON.parse(jsonStr) as Array<{ content: string; category?: string }>;
    if (!Array.isArray(extracted) || extracted.length === 0) return;

    for (const item of extracted) {
      if (!item.content || typeof item.content !== 'string') continue;

      const category = (
        ['fact', 'preference', 'event', 'decision', 'relationship', 'general'].includes(
          item.category || '',
        )
          ? item.category
          : 'general'
      ) as MemoryCategory;

      await storeMemory(item.content, category, conversationId);

      // Auto-extract preferences as key-value pairs
      if (category === 'preference') {
        const kvMatch = item.content.match(/^(.+?)\s+(?:is|are|:)\s+(.+)$/i);
        if (kvMatch) {
          const key = kvMatch[1].toLowerCase().replace(/^(?:user's?|their)\s+/i, '').trim();
          await setPreference(key, kvMatch[2].trim());
        }
      }

      // Auto-extract name as a preference
      if (category === 'fact') {
        const nameMatch = item.content.match(/(?:name|called)\s+(?:is\s+)?(\w+)/i);
        if (nameMatch) {
          await setPreference('name', nameMatch[1]);
        }
      }
    }

    console.log(`[memory] Extracted ${extracted.length} memories from conversation ${conversationId}`);
  } catch (err) {
    console.error('[memory] Extraction failed:', err);
  }
}
