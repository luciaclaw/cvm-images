/**
 * Conversation memory — persistent encrypted SQLite storage.
 *
 * All message content and conversation titles are encrypted at rest
 * using AES-256-GCM with a key derived from the vault master key.
 */

import type { ChatMessage } from '@luciaclaw/protocol';
import type { ConversationSummary } from '@luciaclaw/protocol';
import { getDb, encrypt, decrypt } from './storage.js';

let currentConversationId: string | null = null;

/** Get the current conversation ID, creating one if none exists */
export async function getCurrentConversationId(): Promise<string> {
  if (currentConversationId) return currentConversationId;
  const id = await createConversation('New conversation');
  return id;
}

/** Set the current active conversation */
export function setCurrentConversation(id: string): void {
  currentConversationId = id;
}

/** Create a new conversation and return its ID */
export async function createConversation(title: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const titleEnc = await encrypt(title);

  const db = getDb();
  db.prepare(
    'INSERT INTO conversations (id, title_enc, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(id, titleEnc, now, now);

  currentConversationId = id;
  return id;
}

/** Update a conversation's title */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const titleEnc = await encrypt(title);
  const db = getDb();
  db.prepare('UPDATE conversations SET title_enc = ?, updated_at = ? WHERE id = ?')
    .run(titleEnc, Date.now(), id);
}

/** List all conversations (metadata only) */
export async function listConversations(
  limit = 50,
  offset = 0
): Promise<ConversationSummary[]> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.id, c.title_enc, c.created_at, c.updated_at,
            COUNT(m.id) as message_count
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     GROUP BY c.id
     ORDER BY c.updated_at DESC
     LIMIT ? OFFSET ?`
  ).all(limit, offset) as Array<{
    id: string;
    title_enc: string;
    created_at: number;
    updated_at: number;
    message_count: number;
  }>;

  const conversations: ConversationSummary[] = [];
  for (const row of rows) {
    const title = await decrypt(row.title_enc);
    if (title === null) continue; // skip undecryptable rows
    conversations.push({
      id: row.id,
      title,
      messageCount: row.message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return conversations;
}

/** Load messages for a conversation */
export async function loadConversation(
  conversationId: string,
  limit = 100,
  offset = 0
): Promise<{ messages: ChatMessage[]; total: number }> {
  const db = getDb();

  const countRow = db.prepare(
    'SELECT COUNT(*) as total FROM messages WHERE conversation_id = ?'
  ).get(conversationId) as { total: number } | undefined;
  const total = countRow?.total ?? 0;

  const rows = db.prepare(
    `SELECT id, role, content_enc, tool_calls_enc, timestamp
     FROM messages
     WHERE conversation_id = ?
     ORDER BY timestamp ASC
     LIMIT ? OFFSET ?`
  ).all(conversationId, limit, offset) as Array<{
    id: string;
    role: string;
    content_enc: string;
    tool_calls_enc: string | null;
    timestamp: number;
  }>;

  const messages: ChatMessage[] = [];
  for (const row of rows) {
    const content = await decrypt(row.content_enc);
    if (content === null) continue; // skip undecryptable messages
    const msg: ChatMessage = {
      messageId: row.id,
      role: row.role as ChatMessage['role'],
      content,
      timestamp: row.timestamp,
    };
    if (row.tool_calls_enc) {
      const toolCallsJson = await decrypt(row.tool_calls_enc);
      if (toolCallsJson !== null) {
        msg.toolCalls = JSON.parse(toolCallsJson);
      }
    }
    messages.push(msg);
  }

  return { messages, total };
}

/** Delete a conversation and all its messages */
export function deleteConversation(conversationId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
  if (currentConversationId === conversationId) {
    currentConversationId = null;
  }
}

/** Get conversation history for the current (or specified) conversation */
export async function getHistory(conversationId?: string): Promise<ChatMessage[]> {
  const id = conversationId || currentConversationId;
  if (!id) return [];
  const { messages } = await loadConversation(id);
  return messages;
}

/** Add a message to the current (or specified) conversation */
export async function addToHistory(
  message: ChatMessage,
  conversationId?: string
): Promise<void> {
  const id = conversationId || (await getCurrentConversationId());

  const contentEnc = await encrypt(message.content);
  const toolCallsEnc = message.toolCalls
    ? await encrypt(JSON.stringify(message.toolCalls))
    : null;

  const db = getDb();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_enc, tool_calls_enc, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(message.messageId, id, message.role, contentEnc, toolCallsEnc, message.timestamp);

  // Update conversation's updated_at timestamp
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(message.timestamp, id);
}

/** Auto-generate a title from the first user message */
export async function autoTitleIfNeeded(
  conversationId: string,
  firstMessage: string
): Promise<void> {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?'
  ).get(conversationId) as { count: number };

  // Only auto-title on the first message
  if (row.count <= 1) {
    const title = firstMessage.length > 60
      ? firstMessage.substring(0, 57) + '...'
      : firstMessage;
    await updateConversationTitle(conversationId, title);
  }
}

/** Clear all history (used in tests) */
export function clearHistory(): void {
  const db = getDb();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM conversations').run();
  currentConversationId = null;
}
