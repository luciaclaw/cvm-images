/**
 * Scheduled task engine — cron-based automation.
 *
 * When a schedule fires, it injects a chat prompt into the existing
 * handleChatMessage pipeline, reusing the full inference + tool calling loop.
 * Results are delivered via push notification and stored in a dedicated
 * conversation per schedule.
 */

import type { ScheduleInfo, ScheduleStatus } from '@luciaclaw/protocol';
import cronParser from 'cron-parser';
import { getDb, encrypt, decrypt } from './storage.js';
import { createConversation } from './memory.js';
import { handleChatMessage } from './chat.js';
import { getActiveSendFn } from './chat.js';
import { sendPushNotification } from './push.js';

let tickInterval: ReturnType<typeof setInterval> | null = null;

interface ScheduleRow {
  id: string;
  name_enc: string;
  cron_expression_enc: string;
  timezone_enc: string;
  prompt_enc: string;
  status: string;
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

/** Compute the next run time from a cron expression and timezone */
function computeNextRun(cronExpression: string, timezone: string): number {
  const interval = cronParser.parseExpression(cronExpression, {
    tz: timezone,
  });
  return interval.next().getTime();
}

/** Decrypt all encrypted fields on a schedule row */
async function decryptScheduleRow(row: ScheduleRow): Promise<ScheduleInfo> {
  return {
    id: row.id,
    name: await decrypt(row.name_enc),
    cronExpression: await decrypt(row.cron_expression_enc),
    timezone: await decrypt(row.timezone_enc),
    prompt: await decrypt(row.prompt_enc),
    status: row.status as ScheduleStatus,
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

/** Create a new scheduled task */
export async function createSchedule(
  name: string,
  cronExpression: string,
  timezone: string,
  prompt: string
): Promise<ScheduleInfo> {
  // Validate cron expression (throws on invalid)
  cronParser.parseExpression(cronExpression, { tz: timezone });

  const id = crypto.randomUUID();
  const now = Date.now();
  const nextRunAt = computeNextRun(cronExpression, timezone);

  const nameEnc = await encrypt(name);
  const cronEnc = await encrypt(cronExpression);
  const tzEnc = await encrypt(timezone);
  const promptEnc = await encrypt(prompt);

  const db = getDb();
  db.prepare(`
    INSERT INTO schedules (id, name_enc, cron_expression_enc, timezone_enc, prompt_enc, status, created_at, updated_at, next_run_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(id, nameEnc, cronEnc, tzEnc, promptEnc, now, now, nextRunAt);

  console.log(`[scheduler] Created schedule "${name}" (${cronExpression} ${timezone}), next run: ${new Date(nextRunAt).toISOString()}`);

  return {
    id,
    name,
    cronExpression,
    timezone,
    prompt,
    status: 'active',
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
  };

  // Validate cron if changed
  if (updates.cronExpression || updates.timezone) {
    cronParser.parseExpression(merged.cronExpression, { tz: merged.timezone });
  }

  // Recompute nextRunAt if cron/tz/status changed
  let nextRunAt: number | null = existing.nextRunAt;
  if (merged.status === 'paused') {
    nextRunAt = null;
  } else if (
    updates.cronExpression !== undefined ||
    updates.timezone !== undefined ||
    (updates.status === 'active' && existing.status === 'paused')
  ) {
    nextRunAt = computeNextRun(merged.cronExpression, merged.timezone);
  }

  const now = Date.now();
  const nameEnc = await encrypt(merged.name);
  const cronEnc = await encrypt(merged.cronExpression);
  const tzEnc = await encrypt(merged.timezone);
  const promptEnc = await encrypt(merged.prompt);

  const db = getDb();
  db.prepare(`
    UPDATE schedules SET
      name_enc = ?, cron_expression_enc = ?, timezone_enc = ?, prompt_enc = ?,
      status = ?, updated_at = ?, next_run_at = ?
    WHERE id = ?
  `).run(nameEnc, cronEnc, tzEnc, promptEnc, merged.status, now, nextRunAt, scheduleId);

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

/** Fire a single schedule — inject its prompt into the chat pipeline */
async function fireSchedule(id: string): Promise<void> {
  const schedule = await getScheduleById(id);
  if (!schedule) return;

  console.log(`[scheduler] Firing schedule "${schedule.name}"`);

  // Create a dedicated conversation if none exists
  let conversationId = schedule.conversationId;
  if (!conversationId) {
    conversationId = await createConversation(`Schedule: ${schedule.name}`);
    const db = getDb();
    db.prepare('UPDATE schedules SET conversation_id = ? WHERE id = ?').run(conversationId, id);
  }

  // Inject prompt into the chat pipeline
  const messageId = crypto.randomUUID();
  let responseContent = '';
  try {
    const response = await handleChatMessage(messageId, {
      content: schedule.prompt,
      conversationId,
    });
    responseContent = (response.payload as { content: string }).content || '';
  } catch (err) {
    console.error(`[scheduler] Error firing schedule "${schedule.name}":`, err);
    responseContent = 'Schedule execution failed.';
  }

  // Update lastRunAt and advance nextRunAt
  const now = Date.now();
  let nextRunAt: number;
  try {
    nextRunAt = computeNextRun(schedule.cronExpression, schedule.timezone);
  } catch {
    nextRunAt = now + 60_000; // fallback to 1 minute
  }

  const db = getDb();
  db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .run(now, nextRunAt, now, id);

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

  console.log(`[scheduler] Schedule "${schedule.name}" completed, next run: ${new Date(nextRunAt).toISOString()}`);
}

/** Tick — check for schedules that need to fire */
async function tick(): Promise<void> {
  const now = Date.now();
  const db = getDb();
  const dueRows = db.prepare(
    'SELECT id FROM schedules WHERE status = ? AND next_run_at <= ?'
  ).all('active', now) as Array<{ id: string }>;

  for (const row of dueRows) {
    try {
      await fireSchedule(row.id);
    } catch (err) {
      console.error(`[scheduler] Failed to fire schedule ${row.id}:`, err);
    }
  }
}

/** Start the scheduler — runs tick every 60 seconds */
export function startScheduler(): void {
  if (tickInterval) return;

  console.log('[scheduler] Starting scheduler (60s tick interval)');

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
export const _testExports = { computeNextRun, tick, fireSchedule };
