/**
 * Scheduled task engine — cron v2.
 *
 * Supports three schedule types:
 * - 'cron': recurring via 5-field cron expression
 * - 'at': one-shot at a specific time (auto-deletes after run by default)
 * - 'interval': recurring at a fixed millisecond interval
 *
 * Features:
 * - Delivery routing: send results to any connected channel
 * - Retry with exponential backoff on failure
 * - Isolated execution mode (fresh conversation per run)
 * - Per-job model selection
 * - Concurrency control (configurable max concurrent runs)
 */

import type {
  ScheduleInfo,
  ScheduleStatus,
  ScheduleType,
  ExecutionMode,
  DeliveryConfig,
} from '@luciaclaw/protocol';
import cronParser from 'cron-parser';
import { getDb, encrypt, decrypt } from './storage.js';
import { createConversation } from './memory.js';
import { handleChatMessage } from './chat.js';
import { getActiveSendFn } from './chat.js';
import { sendPushNotification } from './push.js';
import { getTool } from './tool-registry.js';

let tickInterval: ReturnType<typeof setInterval> | null = null;

/** Max concurrent cron runs (configurable via CRON_MAX_CONCURRENT env var) */
const MAX_CONCURRENT_RUNS = parseInt(process.env.CRON_MAX_CONCURRENT || '1', 10);

/** Retry backoff caps at 60 minutes */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Backoff schedule: 30s, 1m, 5m, 15m, 60m */
const BACKOFF_STEPS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

/** Currently running schedule count */
let runningCount = 0;

interface ScheduleRow {
  id: string;
  name_enc: string;
  cron_expression_enc: string;
  timezone_enc: string;
  prompt_enc: string;
  status: string;
  schedule_type: string;
  execution_mode: string;
  delivery_enc: string | null;
  model: string | null;
  at_time: number | null;
  interval_ms: number | null;
  delete_after_run: number;
  max_retries: number;
  retry_backoff_ms: number;
  retry_count: number;
  last_error: string | null;
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

/** Parse a relative duration string (e.g., '20m', '2h', '1d') to milliseconds */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration format: "${duration}". Use format like 20m, 2h, 1d.`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/** Compute the next run time from a cron expression and timezone */
function computeNextRun(cronExpression: string, timezone: string): number {
  const interval = cronParser.parseExpression(cronExpression, {
    tz: timezone,
  });
  return interval.next().getTime();
}

/** Compute backoff delay for a given retry count */
function computeBackoff(retryCount: number, baseBackoffMs: number): number {
  if (retryCount < BACKOFF_STEPS.length) {
    return BACKOFF_STEPS[retryCount];
  }
  // After exhausting the step schedule, use exponential from base
  const delay = baseBackoffMs * Math.pow(2, retryCount);
  return Math.min(delay, MAX_BACKOFF_MS);
}

/** Decrypt all encrypted fields on a schedule row */
async function decryptScheduleRow(row: ScheduleRow): Promise<ScheduleInfo> {
  let delivery: DeliveryConfig | null = null;
  if (row.delivery_enc) {
    try {
      delivery = JSON.parse(await decrypt(row.delivery_enc));
    } catch {
      delivery = null;
    }
  }

  return {
    id: row.id,
    name: await decrypt(row.name_enc),
    scheduleType: (row.schedule_type || 'cron') as ScheduleType,
    cronExpression: row.cron_expression_enc ? await decrypt(row.cron_expression_enc) : null,
    timezone: await decrypt(row.timezone_enc),
    prompt: await decrypt(row.prompt_enc),
    status: row.status as ScheduleStatus,
    executionMode: (row.execution_mode || 'main') as ExecutionMode,
    delivery,
    model: row.model,
    atTime: row.at_time,
    intervalMs: row.interval_ms,
    deleteAfterRun: row.delete_after_run === 1,
    maxRetries: row.max_retries || 0,
    retryBackoffMs: row.retry_backoff_ms || 30_000,
    retryCount: row.retry_count || 0,
    lastError: row.last_error,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

/** Get a single schedule by ID */
async function getScheduleById(id: string): Promise<ScheduleInfo | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
  if (!row) return null;
  return decryptScheduleRow(row);
}

/** Compute the nextRunAt for a schedule based on its type */
function computeNextRunAt(
  scheduleType: ScheduleType,
  cronExpression: string | null,
  timezone: string,
  atTime: number | null,
  intervalMs: number | null
): number | null {
  switch (scheduleType) {
    case 'cron':
      if (!cronExpression) throw new Error('cronExpression is required for cron schedules');
      return computeNextRun(cronExpression, timezone);
    case 'at':
      if (!atTime) throw new Error('atTime is required for at schedules');
      return atTime;
    case 'interval':
      if (!intervalMs) throw new Error('intervalMs is required for interval schedules');
      return Date.now() + intervalMs;
    default:
      throw new Error(`Unknown schedule type: ${scheduleType}`);
  }
}

/** Create a new scheduled task */
export async function createSchedule(
  name: string,
  cronExpression: string | null,
  timezone: string,
  prompt: string,
  options: {
    scheduleType?: ScheduleType;
    executionMode?: ExecutionMode;
    delivery?: DeliveryConfig;
    model?: string;
    atTime?: number;
    atDuration?: string;
    intervalMs?: number;
    deleteAfterRun?: boolean;
    maxRetries?: number;
    retryBackoffMs?: number;
  } = {}
): Promise<ScheduleInfo> {
  const scheduleType = options.scheduleType || 'cron';

  // For 'at' type, resolve atDuration to atTime
  let atTime = options.atTime ?? null;
  if (scheduleType === 'at' && options.atDuration && !atTime) {
    atTime = Date.now() + parseDuration(options.atDuration);
  }

  // Validate based on type
  if (scheduleType === 'cron') {
    if (!cronExpression) throw new Error('cronExpression is required for cron schedules');
    cronParser.parseExpression(cronExpression, { tz: timezone });
  } else if (scheduleType === 'at') {
    if (!atTime) throw new Error('atTime or atDuration is required for at schedules');
    if (atTime <= Date.now()) throw new Error('atTime must be in the future');
  } else if (scheduleType === 'interval') {
    if (!options.intervalMs || options.intervalMs < 1000) {
      throw new Error('intervalMs >= 1000 is required for interval schedules');
    }
  }

  const executionMode = options.executionMode || 'main';
  const delivery = options.delivery || null;
  const model = options.model || null;
  const intervalMs = options.intervalMs ?? null;
  const deleteAfterRun = options.deleteAfterRun ?? (scheduleType === 'at');
  const maxRetries = options.maxRetries ?? 0;
  const retryBackoffMs = options.retryBackoffMs ?? 30_000;

  const id = crypto.randomUUID();
  const now = Date.now();
  const nextRunAt = computeNextRunAt(scheduleType, cronExpression, timezone, atTime, intervalMs);

  const nameEnc = await encrypt(name);
  const cronEnc = cronExpression ? await encrypt(cronExpression) : await encrypt('');
  const tzEnc = await encrypt(timezone);
  const promptEnc = await encrypt(prompt);
  const deliveryEnc = delivery ? await encrypt(JSON.stringify(delivery)) : null;

  const db = getDb();
  db.prepare(`
    INSERT INTO schedules (
      id, name_enc, cron_expression_enc, timezone_enc, prompt_enc,
      status, schedule_type, execution_mode, delivery_enc, model,
      at_time, interval_ms, delete_after_run, max_retries, retry_backoff_ms,
      retry_count, last_error, created_at, updated_at, next_run_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
  `).run(
    id, nameEnc, cronEnc, tzEnc, promptEnc,
    scheduleType, executionMode, deliveryEnc, model,
    atTime, intervalMs, deleteAfterRun ? 1 : 0, maxRetries, retryBackoffMs,
    now, now, nextRunAt
  );

  console.log(`[scheduler] Created ${scheduleType} schedule "${name}", next run: ${nextRunAt ? new Date(nextRunAt).toISOString() : 'N/A'}`);

  return {
    id,
    name,
    scheduleType,
    cronExpression,
    timezone,
    prompt,
    status: 'active',
    executionMode,
    delivery,
    model,
    atTime,
    intervalMs,
    deleteAfterRun,
    maxRetries,
    retryBackoffMs,
    retryCount: 0,
    lastError: null,
    conversationId: null,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt,
  };
}

/** Update an existing scheduled task */
export async function updateSchedule(
  scheduleId: string,
  updates: {
    name?: string;
    cronExpression?: string;
    timezone?: string;
    prompt?: string;
    status?: ScheduleStatus;
    executionMode?: ExecutionMode;
    delivery?: DeliveryConfig | null;
    model?: string | null;
    maxRetries?: number;
    retryBackoffMs?: number;
  }
): Promise<ScheduleInfo | null> {
  const existing = await getScheduleById(scheduleId);
  if (!existing) return null;

  const merged = {
    name: updates.name ?? existing.name,
    cronExpression: updates.cronExpression ?? existing.cronExpression,
    timezone: updates.timezone ?? existing.timezone,
    prompt: updates.prompt ?? existing.prompt,
    status: updates.status ?? existing.status,
    executionMode: updates.executionMode ?? existing.executionMode,
    delivery: updates.delivery !== undefined ? updates.delivery : existing.delivery,
    model: updates.model !== undefined ? updates.model : existing.model,
    maxRetries: updates.maxRetries ?? existing.maxRetries,
    retryBackoffMs: updates.retryBackoffMs ?? existing.retryBackoffMs,
  };

  // Validate cron if changed (only for cron type)
  if (existing.scheduleType === 'cron' && (updates.cronExpression || updates.timezone)) {
    if (merged.cronExpression) {
      cronParser.parseExpression(merged.cronExpression, { tz: merged.timezone });
    }
  }

  // Recompute nextRunAt
  let nextRunAt: number | null = existing.nextRunAt;
  if (merged.status === 'paused') {
    nextRunAt = null;
  } else if (
    updates.cronExpression !== undefined ||
    updates.timezone !== undefined ||
    (updates.status === 'active' && existing.status === 'paused')
  ) {
    try {
      nextRunAt = computeNextRunAt(
        existing.scheduleType,
        merged.cronExpression,
        merged.timezone,
        existing.atTime,
        existing.intervalMs
      );
    } catch {
      // Keep existing nextRunAt if computation fails
    }
  }

  const now = Date.now();
  const nameEnc = await encrypt(merged.name);
  const cronEnc = merged.cronExpression ? await encrypt(merged.cronExpression) : await encrypt('');
  const tzEnc = await encrypt(merged.timezone);
  const promptEnc = await encrypt(merged.prompt);
  const deliveryEnc = merged.delivery ? await encrypt(JSON.stringify(merged.delivery)) : null;

  const db = getDb();
  db.prepare(`
    UPDATE schedules SET
      name_enc = ?, cron_expression_enc = ?, timezone_enc = ?, prompt_enc = ?,
      status = ?, execution_mode = ?, delivery_enc = ?, model = ?,
      max_retries = ?, retry_backoff_ms = ?,
      updated_at = ?, next_run_at = ?
    WHERE id = ?
  `).run(
    nameEnc, cronEnc, tzEnc, promptEnc,
    merged.status, merged.executionMode, deliveryEnc, merged.model,
    merged.maxRetries, merged.retryBackoffMs,
    now, nextRunAt, scheduleId
  );

  console.log(`[scheduler] Updated schedule "${merged.name}"`);

  return {
    ...existing,
    ...merged,
    updatedAt: now,
    nextRunAt,
  };
}

/** Delete a scheduled task */
export function deleteSchedule(scheduleId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);
  if (result.changes > 0) {
    console.log(`[scheduler] Deleted schedule ${scheduleId}`);
    return true;
  }
  return false;
}

/** List schedules, optionally filtered by status */
export async function listSchedules(statusFilter?: ScheduleStatus): Promise<ScheduleInfo[]> {
  const db = getDb();
  let rows: ScheduleRow[];
  if (statusFilter) {
    rows = db.prepare('SELECT * FROM schedules WHERE status = ? ORDER BY created_at DESC').all(statusFilter) as ScheduleRow[];
  } else {
    rows = db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as ScheduleRow[];
  }

  const schedules: ScheduleInfo[] = [];
  for (const row of rows) {
    schedules.push(await decryptScheduleRow(row));
  }
  return schedules;
}

/** Deliver schedule results to a configured channel */
async function deliverResults(
  schedule: ScheduleInfo,
  responseContent: string
): Promise<void> {
  if (!schedule.delivery || schedule.delivery.mode === 'none') return;
  if (schedule.delivery.mode === 'silent') {
    console.log(`[scheduler] Silent delivery for "${schedule.name}": ${responseContent.substring(0, 100)}`);
    return;
  }

  // announce mode — send to channel
  const { channel, target } = schedule.delivery;
  if (!channel || !target) {
    console.warn(`[scheduler] Announce delivery for "${schedule.name}" missing channel or target`);
    return;
  }

  const toolName = `${channel}.send`;
  const tool = getTool(toolName);
  if (!tool) {
    console.warn(`[scheduler] Delivery tool "${toolName}" not found`);
    return;
  }

  const truncated = responseContent.length > 4000
    ? responseContent.substring(0, 3997) + '...'
    : responseContent;

  const message = `📋 **${schedule.name}**\n\n${truncated}`;

  try {
    // Build args based on channel type
    const args: Record<string, unknown> = { text: message };
    if (channel === 'telegram') {
      args.chat_id = target;
    } else if (channel === 'discord') {
      args.channel_id = target;
    } else if (channel === 'slack') {
      args.channel = target;
    } else if (channel === 'whatsapp') {
      args.to = target;
      delete args.text;
      args.text = message; // whatsapp.send uses 'text' arg
    } else if (channel === 'gmail') {
      args.to = target;
      args.subject = `Schedule: ${schedule.name}`;
      args.body = responseContent;
      delete args.text;
    } else {
      // Generic: try chat_id
      args.chat_id = target;
    }

    await tool.execute(args);
    console.log(`[scheduler] Delivered results for "${schedule.name}" to ${channel}:${target}`);
  } catch (err) {
    console.error(`[scheduler] Delivery failed for "${schedule.name}" to ${channel}:${target}:`, err);
  }
}

/** Fire a single schedule — inject its prompt into the chat pipeline */
async function fireSchedule(id: string): Promise<void> {
  const schedule = await getScheduleById(id);
  if (!schedule) return;

  console.log(`[scheduler] Firing ${schedule.scheduleType} schedule "${schedule.name}" (mode: ${schedule.executionMode})`);

  // Determine conversation ID based on execution mode
  let conversationId = schedule.conversationId;
  if (schedule.executionMode === 'isolated') {
    // Always create a fresh conversation for isolated execution
    conversationId = await createConversation(`${schedule.name} — ${new Date().toISOString()}`);
  } else if (!conversationId) {
    // Main mode: create a dedicated conversation if none exists
    conversationId = await createConversation(`Schedule: ${schedule.name}`);
    const db = getDb();
    db.prepare('UPDATE schedules SET conversation_id = ? WHERE id = ?').run(conversationId, id);
  }

  // Inject prompt into the chat pipeline (with optional model override)
  const messageId = crypto.randomUUID();
  let responseContent = '';
  let success = true;
  try {
    const response = await handleChatMessage(messageId, {
      content: schedule.prompt,
      conversationId,
      model: schedule.model ?? undefined,
    });
    responseContent = (response.payload as { content: string }).content || '';
  } catch (err: any) {
    console.error(`[scheduler] Error firing schedule "${schedule.name}":`, err);
    responseContent = `Schedule execution failed: ${err.message || 'Unknown error'}`;
    success = false;
  }

  const now = Date.now();
  const db = getDb();

  if (success) {
    // Reset retry count on success
    let nextRunAt: number | null = null;

    if (schedule.scheduleType === 'cron' && schedule.cronExpression) {
      try {
        nextRunAt = computeNextRun(schedule.cronExpression, schedule.timezone);
      } catch {
        nextRunAt = now + 60_000;
      }
    } else if (schedule.scheduleType === 'interval' && schedule.intervalMs) {
      nextRunAt = now + schedule.intervalMs;
    } else if (schedule.scheduleType === 'at') {
      // One-shot: no next run
      nextRunAt = null;
    }

    if (schedule.deleteAfterRun) {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      console.log(`[scheduler] One-shot schedule "${schedule.name}" auto-deleted after execution`);
    } else if (schedule.scheduleType === 'at') {
      // Disable one-shot schedules that aren't auto-deleted
      db.prepare('UPDATE schedules SET status = ?, last_run_at = ?, next_run_at = NULL, retry_count = 0, last_error = NULL, updated_at = ? WHERE id = ?')
        .run('paused', now, now, id);
    } else {
      db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ?, retry_count = 0, last_error = NULL, updated_at = ? WHERE id = ?')
        .run(now, nextRunAt, now, id);
    }
  } else {
    // Handle retry
    const newRetryCount = schedule.retryCount + 1;
    if (schedule.maxRetries > 0 && newRetryCount <= schedule.maxRetries) {
      const backoff = computeBackoff(newRetryCount - 1, schedule.retryBackoffMs);
      const retryAt = now + backoff;
      db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ?, retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(now, retryAt, newRetryCount, responseContent, now, id);
      console.log(`[scheduler] Schedule "${schedule.name}" failed, retry ${newRetryCount}/${schedule.maxRetries} in ${backoff / 1000}s`);
    } else {
      // No more retries — advance to next normal run
      let nextRunAt: number | null = null;
      if (schedule.scheduleType === 'cron' && schedule.cronExpression) {
        try { nextRunAt = computeNextRun(schedule.cronExpression, schedule.timezone); } catch { nextRunAt = null; }
      } else if (schedule.scheduleType === 'interval' && schedule.intervalMs) {
        nextRunAt = now + schedule.intervalMs;
      }

      db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ?, retry_count = 0, last_error = ?, updated_at = ? WHERE id = ?')
        .run(now, nextRunAt, responseContent, now, id);
      console.log(`[scheduler] Schedule "${schedule.name}" failed, max retries exhausted, advancing to next run`);
    }
  }

  // Deliver results to configured channel
  await deliverResults(schedule, responseContent).catch((err) => {
    console.error(`[scheduler] Delivery error for "${schedule.name}":`, err);
  });

  // Push schedule.executed message to connected client
  const sendFn = getActiveSendFn();
  if (sendFn) {
    sendFn({
      id: crypto.randomUUID(),
      type: 'schedule.executed',
      timestamp: Date.now(),
      payload: {
        scheduleId: id,
        name: schedule.name,
        prompt: schedule.prompt,
        responseContent,
        conversationId,
        executedAt: now,
        deliveryChannel: schedule.delivery?.channel,
      },
    });
  }

  // Send push notification
  const truncated = responseContent.length > 200
    ? responseContent.substring(0, 197) + '...'
    : responseContent;
  await sendPushNotification(
    `Schedule: ${schedule.name}`,
    truncated,
    `/chat?conversation=${conversationId}`
  ).catch((err) => {
    console.error('[scheduler] Push notification failed:', err);
  });

  console.log(`[scheduler] Schedule "${schedule.name}" completed`);
}

/** Tick — check for schedules that need to fire */
async function tick(): Promise<void> {
  const now = Date.now();
  const db = getDb();
  const dueRows = db.prepare(
    'SELECT id FROM schedules WHERE status = ? AND next_run_at <= ?'
  ).all('active', now) as Array<{ id: string }>;

  for (const row of dueRows) {
    // Concurrency control
    if (runningCount >= MAX_CONCURRENT_RUNS) {
      console.log(`[scheduler] Concurrency limit (${MAX_CONCURRENT_RUNS}) reached, deferring remaining`);
      break;
    }

    runningCount++;
    try {
      await fireSchedule(row.id);
    } catch (err) {
      console.error(`[scheduler] Failed to fire schedule ${row.id}:`, err);
    } finally {
      runningCount--;
    }
  }
}

/** Start the scheduler — runs tick every 60 seconds */
export function startScheduler(): void {
  if (tickInterval) return;

  console.log(`[scheduler] Starting scheduler (60s tick, max concurrent: ${MAX_CONCURRENT_RUNS})`);

  // First tick after 5s to catch any missed fires on restart
  setTimeout(() => {
    tick().catch((err) => console.error('[scheduler] Initial tick failed:', err));
  }, 5000);

  tickInterval = setInterval(() => {
    tick().catch((err) => console.error('[scheduler] Tick failed:', err));
  }, 60_000);
}

/** Stop the scheduler */
export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    console.log('[scheduler] Scheduler stopped');
  }
}

/** Exported for testing */
export const _testExports = { computeNextRun, computeBackoff, parseDuration, tick, fireSchedule, deliverResults };
