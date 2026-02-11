/**
 * Tool call dispatch and confirmation handling.
 *
 * In Phase 1, tools are stubbed. Phase 2 adds real integrations
 * (calendar, email, browser automation).
 */

import type { ToolConfirmResponsePayload } from '@luciaclaw/protocol';

const pendingConfirmations = new Map<string, (approved: boolean) => void>();

export function handleToolConfirmation(payload: ToolConfirmResponsePayload): void {
  const { callId, approved } = payload;
  const resolver = pendingConfirmations.get(callId);
  if (resolver) {
    resolver(approved);
    pendingConfirmations.delete(callId);
  } else {
    console.warn('[tools] No pending confirmation for callId:', callId);
  }
}

export function waitForConfirmation(callId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(callId);
      resolve(false);
    }, timeoutMs);

    pendingConfirmations.set(callId, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });
  });
}
