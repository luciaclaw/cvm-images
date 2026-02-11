/**
 * Deterministic policy engine — validates tool calls before execution.
 *
 * CRITICAL: This engine is NOT LLM-based. It uses deterministic rules
 * to prevent prompt injection bypass of security gates.
 *
 * Validates:
 * - Tool exists in registry
 * - Required credentials are configured
 * - Arguments match expected schema
 * - Rate limits are respected
 */

import type { ConfirmationRisk } from '@luciaclaw/protocol';
import { getTool } from './tool-registry.js';
import { listServiceCredentials } from './vault.js';

export interface PolicyResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  risk: ConfirmationRisk;
  reason?: string;
}

/** Rate limit tracking: tool name → timestamps of recent calls */
const rateLimitWindow = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_CALLS = 30; // per minute per tool

/** Evaluate whether a tool call should be allowed */
export function evaluatePolicy(
  toolName: string,
  args: Record<string, unknown>
): PolicyResult {
  // 1. Check tool exists
  const tool = getTool(toolName);
  if (!tool) {
    return {
      allowed: false,
      requiresConfirmation: false,
      risk: 'high',
      reason: `Unknown tool: ${toolName}`,
    };
  }

  // 2. Check required credentials are configured
  if (tool.requiredCredentials.length > 0) {
    const credentials = listServiceCredentials();
    const connectedServices = new Set(
      credentials.filter((c) => c.connected).map((c) => c.service)
    );

    for (const required of tool.requiredCredentials) {
      if (!connectedServices.has(required)) {
        return {
          allowed: false,
          requiresConfirmation: false,
          risk: tool.riskLevel,
          reason: `Missing credential for service: ${required}. Please connect ${required} in Settings.`,
        };
      }
    }
  }

  // 3. Rate limit check
  const now = Date.now();
  const timestamps = rateLimitWindow.get(toolName) || [];
  const recentCalls = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (recentCalls.length >= RATE_LIMIT_MAX_CALLS) {
    return {
      allowed: false,
      requiresConfirmation: false,
      risk: tool.riskLevel,
      reason: `Rate limit exceeded for ${toolName}. Please wait before trying again.`,
    };
  }

  // Record this call for rate limiting
  recentCalls.push(now);
  rateLimitWindow.set(toolName, recentCalls);

  // 4. Basic argument validation
  if (tool.parameters.required && Array.isArray(tool.parameters.required)) {
    for (const required of tool.parameters.required as string[]) {
      if (!(required in args)) {
        return {
          allowed: false,
          requiresConfirmation: false,
          risk: tool.riskLevel,
          reason: `Missing required argument: ${required}`,
        };
      }
    }
  }

  // 5. All checks passed
  return {
    allowed: true,
    requiresConfirmation: tool.requiresConfirmation,
    risk: tool.riskLevel,
  };
}
