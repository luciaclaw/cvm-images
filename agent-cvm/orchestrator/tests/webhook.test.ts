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

const tempDir = mkdtempSync(join(tmpdir(), 'lucia-webhook-test-'));
process.env.DATA_DIR = tempDir;

import {
  initWebhookTable,
  createWebhook,
  listWebhooks,
  deleteWebhook,
} from '../src/webhook.js';
import { closeDb } from '../src/storage.js';

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('webhook CRUD', () => {
  it('initializes webhook table', () => {
    // Should not throw
    initWebhookTable();
  });

  it('creates a webhook', async () => {
    const wh = await createWebhook('Test Webhook', 'github');
    expect(wh.id).toBeTruthy();
    expect(wh.name).toBe('Test Webhook');
    expect(wh.source).toBe('github');
    expect(wh.path).toBe(`/webhooks/${wh.id}`);
  });

  it('creates a webhook with custom secret', async () => {
    const wh = await createWebhook('Custom Secret', 'generic', 'my-secret-123');
    expect(wh.id).toBeTruthy();
    expect(wh.source).toBe('generic');
  });

  it('lists webhooks', async () => {
    const webhooks = await listWebhooks();
    expect(webhooks.length).toBeGreaterThanOrEqual(2);
    expect(webhooks[0].active).toBe(true);
    expect(webhooks[0].triggerCount).toBe(0);
  });

  it('deletes a webhook', async () => {
    const wh = await createWebhook('Deletable', 'stripe');
    const deleted = deleteWebhook(wh.id);
    expect(deleted).toBe(true);

    const remaining = await listWebhooks();
    expect(remaining.some((w) => w.id === wh.id)).toBe(false);
  });

  it('returns false when deleting non-existent webhook', () => {
    const deleted = deleteWebhook('nonexistent-id');
    expect(deleted).toBe(false);
  });
});

describe('webhook tools', () => {
  it('registers webhook management tools', async () => {
    const { registerWebhookTools } = await import('../src/tools/webhook.js');
    const { getTool, getAllTools } = await import('../src/tool-registry.js');

    registerWebhookTools();

    const names = getAllTools().map((t) => t.name);
    expect(names).toContain('webhook.create');
    expect(names).toContain('webhook.list');
    expect(names).toContain('webhook.delete');
  });
});
