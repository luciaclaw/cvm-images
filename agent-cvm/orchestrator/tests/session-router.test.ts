import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock chat module
vi.mock('../src/chat.js', () => ({
  handleChatMessage: vi.fn().mockResolvedValue({
    id: 'mock-response-id',
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: 'Mock response' },
  }),
  getActiveSendFn: vi.fn().mockReturnValue(null),
  setActiveSendFn: vi.fn(),
}));

// Mock push
vi.mock('../src/push.js', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  handlePushSubscribe: vi.fn(),
  handlePushUnsubscribe: vi.fn(),
}));

const tempDir = mkdtempSync(join(tmpdir(), 'lucia-session-test-'));
process.env.DATA_DIR = tempDir;

import {
  resolveSession,
  telegramSessionType,
  discordSessionType,
  listSessions,
  removeSession,
} from '../src/session-router.js';
import { closeDb } from '../src/storage.js';

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('telegramSessionType', () => {
  it('returns dm for private chats', () => {
    expect(telegramSessionType('private')).toBe('dm');
  });

  it('returns group for group chats', () => {
    expect(telegramSessionType('group')).toBe('group');
    expect(telegramSessionType('supergroup')).toBe('group');
    expect(telegramSessionType('channel')).toBe('group');
  });
});

describe('discordSessionType', () => {
  it('returns dm for channel type 1', () => {
    expect(discordSessionType(1)).toBe('dm');
  });

  it('returns group for guild channels', () => {
    expect(discordSessionType(0)).toBe('group');
    expect(discordSessionType(2)).toBe('group');
    expect(discordSessionType(4)).toBe('group');
  });
});

describe('resolveSession', () => {
  it('returns main session for DMs', async () => {
    const convId = await resolveSession('telegram', 'user123', 'dm');
    expect(convId).toBeTruthy();
  });

  it('creates isolated session for new group', async () => {
    const convId = await resolveSession('telegram', 'group-456', 'group', 'Test Group');
    expect(convId).toBeTruthy();

    // Second call returns the same conversation
    const convId2 = await resolveSession('telegram', 'group-456', 'group');
    expect(convId2).toBe(convId);
  });

  it('creates different sessions for different groups', async () => {
    const conv1 = await resolveSession('discord', 'channel-100', 'group', 'Dev');
    const conv2 = await resolveSession('discord', 'channel-200', 'group', 'General');

    expect(conv1).not.toBe(conv2);
  });

  it('creates different sessions for same group on different channels', async () => {
    const conv1 = await resolveSession('telegram', 'same-id', 'group', 'TG Group');
    const conv2 = await resolveSession('discord', 'same-id', 'group', 'DC Channel');

    expect(conv1).not.toBe(conv2);
  });
});

describe('listSessions', () => {
  it('returns all session mappings', async () => {
    const sessions = await listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(sessions[0].lastMessageAt).toBeTypeOf('number');
    expect(sessions[0].label).toBeTruthy();
  });
});

describe('removeSession', () => {
  it('removes an existing session', async () => {
    const convId = await resolveSession('slack', 'chan-999', 'group', 'Temp Channel');
    expect(convId).toBeTruthy();

    const removed = removeSession('slack', 'chan-999');
    expect(removed).toBe(true);

    // Should create a new session next time
    const newConvId = await resolveSession('slack', 'chan-999', 'group', 'Temp Channel');
    expect(newConvId).not.toBe(convId);

    removeSession('slack', 'chan-999');
  });

  it('returns false for non-existent session', () => {
    const removed = removeSession('slack', 'nonexistent');
    expect(removed).toBe(false);
  });
});
