/**
 * Session router — maps (channel, peer) to conversation IDs.
 *
 * Routes inbound messages from messaging platforms to the correct conversation:
 * - DMs (private chats): consolidated into the main session for continuity
 * - Groups (Telegram groups, Discord channels, Slack channels): isolated session per group
 *
 * This prevents cross-channel context leakage and keeps group noise out of
 * personal conversation.
 */

import { getDb, encrypt, decrypt } from './storage.js';
import { createConversation, getCurrentConversationId } from './memory.js';

/** Session type derived from the chat context */
export type SessionType = 'dm' | 'group';

/** Channel types supported for session routing */
export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp';

interface SessionMappingRow {
  channel: string;
  peer_id: string;
  session_type: string;
  conversation_id: string;
  label_enc: string;
  created_at: number;
  last_message_at: number;
}

/** Initialize the session_mappings table (called from storage.ts getDb) */
export function initSessionTable(): void {
  const db = getDb();
  db.exec(`
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
}

/**
 * Resolve the conversation ID for an inbound message.
 *
 * For DMs: returns the main session conversation ID (shared context).
 * For groups: returns or creates an isolated conversation per (channel, peer_id).
 */
export async function resolveSession(
  channel: ChannelType,
  peerId: string,
  sessionType: SessionType,
  label?: string
): Promise<string> {
  if (sessionType === 'dm') {
    // DMs consolidate into the main session
    return await getCurrentConversationId();
  }

  // Groups: check for existing session mapping
  const db = getDb();
  const row = db.prepare(
    'SELECT conversation_id FROM session_mappings WHERE channel = ? AND peer_id = ?'
  ).get(channel, peerId) as { conversation_id: string } | undefined;

  if (row) {
    // Update last_message_at
    db.prepare(
      'UPDATE session_mappings SET last_message_at = ? WHERE channel = ? AND peer_id = ?'
    ).run(Date.now(), channel, peerId);
    return row.conversation_id;
  }

  // Create a new isolated conversation for this group
  const displayLabel = label || `${channel}:${peerId}`;
  const conversationId = await createConversation(`Group: ${displayLabel}`);
  const labelEnc = await encrypt(displayLabel);
  const now = Date.now();

  db.prepare(`
    INSERT INTO session_mappings (channel, peer_id, session_type, conversation_id, label_enc, created_at, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(channel, peerId, sessionType, conversationId, labelEnc, now, now);

  console.log(`[session-router] Created isolated session for ${channel}:${peerId} → ${conversationId}`);

  return conversationId;
}

/**
 * Determine session type from Telegram chat info.
 * Telegram chat types: 'private', 'group', 'supergroup', 'channel'
 */
export function telegramSessionType(chatType: string): SessionType {
  return chatType === 'private' ? 'dm' : 'group';
}

/**
 * Determine session type from Discord context.
 * Discord channel types: 1 = DM, 0/2/4/5/10/11/12/13/15 = guild/group
 */
export function discordSessionType(channelType: number): SessionType {
  return channelType === 1 ? 'dm' : 'group';
}

/** List all session mappings (for admin/debugging) */
export async function listSessions(): Promise<Array<{
  channel: string;
  peerId: string;
  sessionType: string;
  conversationId: string;
  label: string;
  lastMessageAt: number;
}>> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM session_mappings ORDER BY last_message_at DESC').all() as SessionMappingRow[];

  const sessions = [];
  for (const row of rows) {
    const label = await decrypt(row.label_enc);
    sessions.push({
      channel: row.channel,
      peerId: row.peer_id,
      sessionType: row.session_type,
      conversationId: row.conversation_id,
      label: label ?? '(encrypted)',
      lastMessageAt: row.last_message_at,
    });
  }
  return sessions;
}

/** Remove a session mapping */
export function removeSession(channel: string, peerId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM session_mappings WHERE channel = ? AND peer_id = ?'
  ).run(channel, peerId);
  return result.changes > 0;
}

/** Exported for testing */
export const _testExports = {
  resolveSession,
  telegramSessionType,
  discordSessionType,
  listSessions,
  removeSession,
};
