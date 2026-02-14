/**
 * Usage handler — handles PWA requests for usage data over WebSocket.
 */

import type { MessageEnvelope, UsageListPayload, UsageSetLimitsPayload } from '@luciaclaw/protocol';
import { getUsageSummary, setLimits } from './token-tracker.js';

/** Handle usage.list request — returns usage summary for a time period */
export async function handleUsageList(payload: UsageListPayload): Promise<MessageEnvelope> {
  const summary = getUsageSummary(payload.period || 'day');
  return {
    id: crypto.randomUUID(),
    type: 'usage.response',
    timestamp: Date.now(),
    payload: summary,
  };
}

/** Handle usage.set_limits request — sets daily/monthly credit limits */
export async function handleUsageSetLimits(payload: UsageSetLimitsPayload): Promise<MessageEnvelope> {
  setLimits(payload.daily, payload.monthly);
  // Return current usage summary so the client can see the updated limits
  const summary = getUsageSummary('day');
  return {
    id: crypto.randomUUID(),
    type: 'usage.response',
    timestamp: Date.now(),
    payload: summary,
  };
}
