/**
 * Memory management handler — processes memory messages from PWA.
 *
 * Follows the credentials-handler.ts pattern: each handler calls the
 * persistent-memory module and returns a memory.response.
 */

import type {
  MessageEnvelope,
  MemoryListPayload,
  MemorySearchPayload,
  MemoryDeletePayload,
} from '@luciaclaw/protocol';
import { listMemories, searchMemories, deleteMemory } from './persistent-memory.js';

export async function handleMemoryList(
  payload: MemoryListPayload,
): Promise<MessageEnvelope> {
  const { memories, total } = await listMemories(payload.category, payload.limit, payload.offset);
  return {
    id: crypto.randomUUID(),
    type: 'memory.response',
    timestamp: Date.now(),
    payload: { memories, total },
  };
}

export async function handleMemorySearch(
  payload: MemorySearchPayload,
): Promise<MessageEnvelope> {
  const memories = await searchMemories(payload.query, payload.category, payload.limit);
  return {
    id: crypto.randomUUID(),
    type: 'memory.response',
    timestamp: Date.now(),
    payload: { memories },
  };
}

export async function handleMemoryDelete(
  payload: MemoryDeletePayload,
): Promise<MessageEnvelope> {
  deleteMemory(payload.memoryId);
  const { memories, total } = await listMemories();
  return {
    id: crypto.randomUUID(),
    type: 'memory.response',
    timestamp: Date.now(),
    payload: { memories, total },
  };
}
