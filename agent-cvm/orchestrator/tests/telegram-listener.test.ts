import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';

// Mock fetch globally (for Telegram API calls made by the source code)
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock chat module
vi.mock('../src/chat.js', () => ({
  handleChatMessage: vi.fn().mockResolvedValue({
    id: 'mock-response-id',
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: 'Hello from Lucia!' },
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

// Mock vault — include deriveMemoryKey so storage.ts encrypt/decrypt work
vi.mock('../src/vault.js', () => {
  const subtle = globalThis.crypto.subtle;
  let memKey: CryptoKey | null = null;
  return {
    getServiceCredential: vi.fn().mockResolvedValue('test-bot-token-123'),
    setServiceCredential: vi.fn(),
    deleteServiceCredential: vi.fn(),
    listServiceCredentials: vi.fn().mockReturnValue([]),
    deriveMemoryKey: vi.fn(async () => {
      if (memKey) return memKey;
      const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
      memKey = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      return memKey;
    }),
  };
});

const tempDir = mkdtempSync(join(tmpdir(), 'lucia-telegram-listener-test-'));
process.env.DATA_DIR = tempDir;

import express from 'express';
import {
  createTelegramRouter,
  setupTelegramWebhook,
  removeTelegramWebhook,
  _testExports,
} from '../src/telegram-listener.js';
import { handleChatMessage } from '../src/chat.js';
import { getServiceCredential } from '../src/vault.js';
import { closeDb } from '../src/storage.js';

let server: http.Server;
let port: number;

/** Make an HTTP request to the local test server using Node http (bypasses mocked fetch). */
function request(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method: options.method || 'POST',
        headers: options.headers || {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode!, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

beforeAll(async () => {
  const app = express();
  app.use('/telegram', createTelegramRouter());

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('setupTelegramWebhook', () => {
  it('calls Telegram setWebhook API with correct URL and secret', async () => {
    process.env.CVM_PUBLIC_URL = 'https://test-cvm.phala.network';
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true }),
    });

    await setupTelegramWebhook();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-bot-token-123/setWebhook',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.url).toBe('https://test-cvm.phala.network/telegram/webhook');
    expect(callBody.secret_token).toBeTruthy();
    expect(callBody.secret_token.length).toBe(64); // 32 bytes hex
    expect(callBody.allowed_updates).toEqual(['message']);

    // Secret token should be stored internally
    expect(_testExports.webhookSecretToken).toBe(callBody.secret_token);
  });

  it('skips setup when no bot token', async () => {
    vi.mocked(getServiceCredential).mockResolvedValueOnce(null);
    mockFetch.mockClear();

    await setupTelegramWebhook();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips setup when CVM_PUBLIC_URL not set', async () => {
    delete process.env.CVM_PUBLIC_URL;
    mockFetch.mockClear();

    await setupTelegramWebhook();

    expect(mockFetch).not.toHaveBeenCalled();

    // Restore for subsequent tests
    process.env.CVM_PUBLIC_URL = 'https://test-cvm.phala.network';
  });
});

describe('removeTelegramWebhook', () => {
  it('calls Telegram deleteWebhook API', async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true }),
    });

    await removeTelegramWebhook();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-bot-token-123/deleteWebhook',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(_testExports.webhookSecretToken).toBeNull();
  });
});

describe('POST /telegram/webhook', () => {
  it('rejects requests with invalid secret token', async () => {
    _testExports.webhookSecretToken = 'valid-secret';

    const resp = await request('/telegram/webhook', {
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
      },
      body: JSON.stringify({ message: { text: 'hi', chat: { id: 1, type: 'private' } } }),
    });

    expect(resp.status).toBe(403);
  });

  it('rejects requests with no secret token header', async () => {
    _testExports.webhookSecretToken = 'valid-secret';

    const resp = await request('/telegram/webhook', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { text: 'hi', chat: { id: 1, type: 'private' } } }),
    });

    expect(resp.status).toBe(403);
  });

  it('returns 200 for valid request and processes message', async () => {
    const secret = 'test-secret-token';
    _testExports.webhookSecretToken = secret;
    vi.mocked(handleChatMessage).mockClear();
    mockFetch.mockClear();

    // Mock the sendMessage call that happens after processing
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });

    const resp = await request('/telegram/webhook', {
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 1,
          from: { id: 999, first_name: 'Alice' },
          chat: { id: 999, type: 'private' },
          text: 'Hello bot!',
          date: 1700000000,
        },
      }),
    });

    expect(resp.status).toBe(200);

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 200));

    // Verify handleChatMessage was called with the message text
    expect(handleChatMessage).toHaveBeenCalledWith(
      expect.any(String), // UUID
      expect.objectContaining({
        content: 'Hello bot!',
        conversationId: expect.any(String),
      }),
    );

    // Verify response was sent back via Telegram sendMessage
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-bot-token-123/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"chat_id":"999"'),
      }),
    );
  });

  it('returns 200 and ignores non-message updates', async () => {
    const secret = 'test-secret-token';
    _testExports.webhookSecretToken = secret;
    vi.mocked(handleChatMessage).mockClear();

    const resp = await request('/telegram/webhook', {
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
      body: JSON.stringify({
        update_id: 12346,
        callback_query: { id: '1', data: 'button_click' },
      }),
    });

    expect(resp.status).toBe(200);

    // Wait for any async processing
    await new Promise((r) => setTimeout(r, 100));

    // handleChatMessage should NOT have been called
    expect(handleChatMessage).not.toHaveBeenCalled();
  });

  it('returns 200 and ignores non-text messages (photo, sticker, etc.)', async () => {
    const secret = 'test-secret-token';
    _testExports.webhookSecretToken = secret;
    vi.mocked(handleChatMessage).mockClear();

    const resp = await request('/telegram/webhook', {
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
      body: JSON.stringify({
        update_id: 12347,
        message: {
          message_id: 2,
          from: { id: 999, first_name: 'Alice' },
          chat: { id: 999, type: 'private' },
          photo: [{ file_id: 'abc', width: 100, height: 100 }],
          date: 1700000001,
        },
      }),
    });

    expect(resp.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    expect(handleChatMessage).not.toHaveBeenCalled();
  });

  it('routes group messages to isolated session', async () => {
    const secret = 'test-secret-token';
    _testExports.webhookSecretToken = secret;
    vi.mocked(handleChatMessage).mockClear();
    mockFetch.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 43 } }),
    });

    const resp = await request('/telegram/webhook', {
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': secret,
      },
      body: JSON.stringify({
        update_id: 12348,
        message: {
          message_id: 3,
          from: { id: 777, first_name: 'Bob' },
          chat: { id: -100123, type: 'supergroup', title: 'Test Group' },
          text: 'Hello group!',
          date: 1700000002,
        },
      }),
    });

    expect(resp.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    // handleChatMessage should have been called with a conversationId
    // (the session router creates an isolated session for groups)
    expect(handleChatMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: 'Hello group!',
        conversationId: expect.any(String),
      }),
    );
  });
});
