import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageEnvelope } from '@luciaclaw/protocol';
import { setActiveSendFn, getActiveSendFn } from '../src/chat.js';

describe('getActiveSendFn', () => {
  beforeEach(() => {
    setActiveSendFn(null);
  });

  it('returns null by default', () => {
    expect(getActiveSendFn()).toBeNull();
  });

  it('returns the function set by setActiveSendFn', () => {
    const mockSend = (_msg: MessageEnvelope) => {};
    setActiveSendFn(mockSend);
    expect(getActiveSendFn()).toBe(mockSend);
  });

  it('returns null after clearing with setActiveSendFn(null)', () => {
    setActiveSendFn((_msg: MessageEnvelope) => {});
    setActiveSendFn(null);
    expect(getActiveSendFn()).toBeNull();
  });
});

describe('OAuth callback WebSocket notification', () => {
  beforeEach(() => {
    setActiveSendFn(null);
  });

  it('sends oauth.callback result when client is connected', () => {
    const sent: MessageEnvelope[] = [];
    setActiveSendFn((msg) => sent.push(msg));

    const result: MessageEnvelope = {
      id: 'test-id',
      type: 'oauth.callback',
      timestamp: Date.now(),
      payload: { service: 'google', success: true, grantedScopes: ['email'] },
    };

    // Simulate what server.ts does after handleOAuthCallback
    const sendFn = getActiveSendFn();
    if (sendFn) {
      sendFn(result);
    }

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(result);
  });

  it('gracefully skips when no client is connected', () => {
    const result: MessageEnvelope = {
      id: 'test-id',
      type: 'oauth.callback',
      timestamp: Date.now(),
      payload: { service: 'google', success: true },
    };

    // Should not throw
    const sendFn = getActiveSendFn();
    if (sendFn) {
      sendFn(result);
    }

    expect(getActiveSendFn()).toBeNull();
  });

  it('sends error results too so PWA can clear loading state', () => {
    const sent: MessageEnvelope[] = [];
    setActiveSendFn((msg) => sent.push(msg));

    const result: MessageEnvelope = {
      id: 'test-id',
      type: 'oauth.callback',
      timestamp: Date.now(),
      payload: { service: 'slack', success: false, error: 'Token exchange failed' },
    };

    const sendFn = getActiveSendFn();
    if (sendFn) {
      sendFn(result);
    }

    expect(sent).toHaveLength(1);
    expect((sent[0].payload as any).success).toBe(false);
    expect((sent[0].payload as any).error).toBe('Token exchange failed');
  });
});
