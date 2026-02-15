/**
 * Memory tools — allow the LLM to explicitly store, search, and manage memories.
 */

import { registerTool } from '../tool-registry.js';
import {
  storeMemory,
  searchMemories,
  getAllPreferences,
  setPreference,
} from '../persistent-memory.js';
import type { MemoryCategory } from '@luciaclaw/protocol';

export function registerMemoryTools(): void {
  registerTool({
    name: 'memory.store',
    description:
      'Store a new memory about the user for future conversations. Use this when the user shares important facts, preferences, or decisions.',
    parameters: {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'The memory content to store (e.g., "User works at Acme Corp")',
        },
        category: {
          type: 'string',
          enum: ['fact', 'preference', 'event', 'decision', 'relationship', 'general'],
          description: 'Memory category (default: general)',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { content, category } = args as { content: string; category?: MemoryCategory };
      const entry = await storeMemory(content, category || 'general');
      if (!entry) {
        return { stored: false, reason: 'duplicate', message: 'A similar memory already exists.' };
      }
      return { stored: true, id: entry.id, content: entry.content, category: entry.category };
    },
  });

  registerTool({
    name: 'memory.search',
    description:
      'Search stored memories about the user. Use this to recall facts, preferences, or past decisions.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query text' },
        limit: { type: 'number', description: 'Max results to return (default: 10)' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { query, limit } = args as { query: string; limit?: number };
      const memories = await searchMemories(query, undefined, limit || 10);
      return {
        results: memories.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          createdAt: m.createdAt,
        })),
      };
    },
  });

  registerTool({
    name: 'memory.get_preferences',
    description: "Get all stored user preferences (name, timezone, communication style, etc.).",
    parameters: {
      type: 'object',
      properties: {},
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute() {
      const prefs = await getAllPreferences();
      return { preferences: prefs };
    },
  });

  registerTool({
    name: 'memory.set_preference',
    description:
      'Set a user preference (e.g., name, timezone, communication style). These are key-value pairs available in every conversation.',
    parameters: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string', description: 'Preference key (e.g., "user_full_name", "user_preferred_name", "user_timezone", "personality_tone", "personality_instructions")' },
        value: { type: 'string', description: 'Preference value' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { key, value } = args as { key: string; value: string };
      await setPreference(key, value);
      return { stored: true, key, value };
    },
  });
}
