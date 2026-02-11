/**
 * Conversation memory — in-memory for Phase 1.
 *
 * Phase 2 adds encrypted persistent storage within the CVM.
 */

import type { ChatMessage } from '@luciaclaw/protocol';

const MAX_HISTORY = 100;
let history: ChatMessage[] = [];

export function getHistory(): ChatMessage[] {
  return [...history];
}

export function addToHistory(message: ChatMessage): void {
  history.push(message);
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }
}

export function clearHistory(): void {
  history = [];
}
