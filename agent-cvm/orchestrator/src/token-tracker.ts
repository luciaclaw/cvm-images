/**
 * Token usage tracker — per-model usage with daily/monthly aggregation and credit system.
 *
 * Token counts are stored unencrypted (aggregate stats only, no PII).
 * Credits: CREDITS_PER_DOLLAR = 1000.
 * Soft limits with rolling 1-minute cooldown on exceed.
 */

import type { UsageSummary, ModelUsage } from '@luciaclaw/protocol';
import { getDb } from './storage.js';
import { getModelConfigById } from './model-registry.js';

export const CREDITS_PER_DOLLAR = 1000;

/** Cooldown tracking — rolling 1-min window from last attempt during exceeded state */
let cooldownUntil: number | null = null;

/** Initialize the token_usage table */
export function initTokenTracker(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      role TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      credits REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model, timestamp);
  `);
}

/** Calculate credits from token counts and model pricing */
function calculateCredits(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const config = getModelConfigById(model);
  if (!config) {
    // Unknown model — estimate at default pricing
    return ((promptTokens * 0.15 + completionTokens * 0.60) / 1_000_000) * CREDITS_PER_DOLLAR;
  }
  const costDollars =
    (promptTokens * config.inputPricePerMillion + completionTokens * config.outputPricePerMillion) / 1_000_000;
  return costDollars * CREDITS_PER_DOLLAR;
}

/** Record token usage for an inference call */
export function trackUsage(
  model: string,
  role: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const credits = calculateCredits(model, promptTokens, completionTokens);
  getDb()
    .prepare(
      `INSERT INTO token_usage (model, role, prompt_tokens, completion_tokens, credits, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(model, role, promptTokens, completionTokens, credits, Date.now());
}

/** Get the start-of-period timestamp */
function periodStart(period: 'day' | 'month'): number {
  const now = new Date();
  if (period === 'day') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

/** Get per-model usage breakdown for a period */
export function getUsageByModel(period: 'day' | 'month'): ModelUsage[] {
  const since = periodStart(period);
  const rows = getDb()
    .prepare(
      `SELECT model, role,
              SUM(prompt_tokens) as prompt_tokens,
              SUM(completion_tokens) as completion_tokens,
              SUM(credits) as credits,
              COUNT(*) as call_count
       FROM token_usage
       WHERE timestamp >= ?
       GROUP BY model, role
       ORDER BY credits DESC`,
    )
    .all(since) as Array<{
    model: string;
    role: string;
    prompt_tokens: number;
    completion_tokens: number;
    credits: number;
    call_count: number;
  }>;

  return rows.map((r) => ({
    model: r.model,
    role: r.role,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    credits: r.credits,
    callCount: r.call_count,
  }));
}

/** Get stored usage limits from user_preferences */
export function getLimits(): { daily: number | null; monthly: number | null } {
  const db = getDb();
  const dailyRow = db.prepare("SELECT value_enc FROM user_preferences WHERE key = 'usage_limit_daily'").get() as
    | { value_enc: string }
    | undefined;
  const monthlyRow = db.prepare("SELECT value_enc FROM user_preferences WHERE key = 'usage_limit_monthly'").get() as
    | { value_enc: string }
    | undefined;

  return {
    daily: dailyRow ? parseFloat(dailyRow.value_enc) : null,
    monthly: monthlyRow ? parseFloat(monthlyRow.value_enc) : null,
  };
}

/** Set usage limits (stores as plaintext numbers — not sensitive data) */
export function setLimits(daily?: number | null, monthly?: number | null): void {
  const db = getDb();
  const now = Date.now();

  if (daily !== undefined) {
    if (daily === null) {
      db.prepare("DELETE FROM user_preferences WHERE key = 'usage_limit_daily'").run();
    } else {
      db.prepare(
        `INSERT INTO user_preferences (key, value_enc, updated_at) VALUES ('usage_limit_daily', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      ).run(String(daily), now);
    }
  }

  if (monthly !== undefined) {
    if (monthly === null) {
      db.prepare("DELETE FROM user_preferences WHERE key = 'usage_limit_monthly'").run();
    } else {
      db.prepare(
        `INSERT INTO user_preferences (key, value_enc, updated_at) VALUES ('usage_limit_monthly', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      ).run(String(monthly), now);
    }
  }

  // Reset cooldown when limits are changed
  cooldownUntil = null;
}

/** Get total credits for a period */
function getTotalCredits(period: 'day' | 'month'): number {
  const since = periodStart(period);
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(credits), 0) as total FROM token_usage WHERE timestamp >= ?')
    .get(since) as { total: number };
  return row.total;
}

export interface LimitStatus {
  exceeded: boolean;
  cooldownUntil: number | null;
}

/** Check if usage limits are exceeded. If exceeded, set/extend rolling cooldown. */
export function checkLimits(): LimitStatus {
  // If we're in cooldown, check if it's expired
  if (cooldownUntil !== null) {
    if (Date.now() < cooldownUntil) {
      // Still in cooldown — extend it (rolling 1-min window)
      cooldownUntil = Date.now() + 60_000;
      return { exceeded: true, cooldownUntil };
    }
    // Cooldown expired
    cooldownUntil = null;
  }

  const limits = getLimits();
  let exceeded = false;

  if (limits.daily !== null) {
    const dailyCredits = getTotalCredits('day');
    if (dailyCredits >= limits.daily) exceeded = true;
  }

  if (limits.monthly !== null) {
    const monthlyCredits = getTotalCredits('month');
    if (monthlyCredits >= limits.monthly) exceeded = true;
  }

  if (exceeded) {
    cooldownUntil = Date.now() + 60_000;
    return { exceeded: true, cooldownUntil };
  }

  return { exceeded: false, cooldownUntil: null };
}

/** Get full usage summary for a period */
export function getUsageSummary(period: 'day' | 'month'): UsageSummary {
  const byModel = getUsageByModel(period);
  const limits = getLimits();
  const limitStatus = checkLimits();

  const totalCredits = byModel.reduce((sum, m) => sum + m.credits, 0);
  const totalPromptTokens = byModel.reduce((sum, m) => sum + m.promptTokens, 0);
  const totalCompletionTokens = byModel.reduce((sum, m) => sum + m.completionTokens, 0);

  return {
    period,
    totalCredits,
    totalPromptTokens,
    totalCompletionTokens,
    byModel,
    limits,
    limitExceeded: limitStatus.exceeded,
  };
}
