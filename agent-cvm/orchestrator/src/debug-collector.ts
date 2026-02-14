/**
 * Diagnostic collector — gathers logs, DB errors, and context for debug analysis.
 *
 * Produces a DiagnosticBundle consumed by the agent.debug tool and
 * a structured system prompt that instructs Claude to output root cause analysis.
 */

import { getDb, decrypt } from './storage.js';
import { getHistory, getCurrentConversationId } from './memory.js';
import { logBuffer } from './log-buffer.js';

export interface DiagnosticBundle {
  /** Recent console output within the time window */
  recentLogs: string;
  /** Error-only logs within the time window */
  errorLogs: string;
  /** Failed workflow executions (decrypted) */
  workflowErrors: string;
  /** Cron jobs with last_error set */
  cronErrors: string;
  /** Last N conversation messages (truncated) */
  conversationContext: string;
  /** System info (uptime, heap, node version) */
  systemInfo: string;
}

interface CollectOptions {
  logWindowMs?: number;
  maxConversationMessages?: number;
  maxMessageLength?: number;
}

const DEFAULT_LOG_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_MAX_MSG_LENGTH = 500;

export async function collectDiagnostics(
  conversationId?: string,
  options?: CollectOptions,
): Promise<DiagnosticBundle> {
  const windowMs = options?.logWindowMs ?? DEFAULT_LOG_WINDOW_MS;
  const maxMessages = options?.maxConversationMessages ?? DEFAULT_MAX_MESSAGES;
  const maxMsgLen = options?.maxMessageLength ?? DEFAULT_MAX_MSG_LENGTH;

  // 1. Recent logs from ring buffer
  const recentEntries = logBuffer.getRecent(windowMs);
  const recentLogs = logBuffer.format(recentEntries);

  // 2. Error-only logs
  const errorEntries = recentEntries.filter((e) => e.level === 'error');
  const errorLogs = logBuffer.format(errorEntries);

  // 3. Workflow errors from DB
  const workflowErrors = await collectWorkflowErrors();

  // 4. Cron errors from DB
  const cronErrors = await collectCronErrors();

  // 5. Conversation context
  const conversationContext = await collectConversationContext(
    conversationId,
    maxMessages,
    maxMsgLen,
  );

  // 6. System info
  const mem = process.memoryUsage();
  const systemInfo = [
    `Node: ${process.version}`,
    `Uptime: ${Math.floor(process.uptime())}s`,
    `Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`,
    `Timestamp: ${new Date().toISOString()}`,
  ].join('\n');

  return { recentLogs, errorLogs, workflowErrors, cronErrors, conversationContext, systemInfo };
}

async function collectWorkflowErrors(): Promise<string> {
  try {
    const db = getDb();
    const failedExecs = db
      .prepare(
        `SELECT we.id, we.workflow_id, we.error, we.started_at, we.completed_at
         FROM workflow_executions we
         WHERE we.status = 'failed'
         ORDER BY we.completed_at DESC
         LIMIT 10`,
      )
      .all() as Array<{
      id: string;
      workflow_id: string;
      error: string | null;
      started_at: number | null;
      completed_at: number | null;
    }>;

    if (failedExecs.length === 0) return '(no failed workflow executions)';

    const lines: string[] = [];
    for (const exec of failedExecs) {
      lines.push(`Execution ${exec.id} (workflow ${exec.workflow_id}): ${exec.error || 'unknown error'}`);

      // Get failed step details
      const failedSteps = db
        .prepare(
          `SELECT step_id, error, attempts
           FROM workflow_step_executions
           WHERE execution_id = ? AND status = 'failed'`,
        )
        .all(exec.id) as Array<{ step_id: string; error: string | null; attempts: number }>;

      for (const step of failedSteps) {
        lines.push(`  Step ${step.step_id}: ${step.error || 'unknown'} (${step.attempts} attempts)`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    return `(could not query workflow errors: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function collectCronErrors(): Promise<string> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, name_enc, last_error, last_run_at
         FROM schedules
         WHERE last_error IS NOT NULL
         ORDER BY last_run_at DESC
         LIMIT 10`,
      )
      .all() as Array<{
      id: string;
      name_enc: string;
      last_error: string | null;
      last_run_at: number | null;
    }>;

    if (rows.length === 0) return '(no cron errors)';

    const lines: string[] = [];
    for (const row of rows) {
      const name = (await decrypt(row.name_enc)) || '(encrypted)';
      const when = row.last_run_at ? new Date(row.last_run_at).toISOString() : 'never';
      lines.push(`Schedule "${name}" (${row.id}): ${row.last_error} [last run: ${when}]`);
    }
    return lines.join('\n');
  } catch (err) {
    return `(could not query cron errors: ${err instanceof Error ? err.message : String(err)})`;
  }
}

async function collectConversationContext(
  conversationId: string | undefined,
  maxMessages: number,
  maxMsgLen: number,
): Promise<string> {
  try {
    const id = conversationId || (await getCurrentConversationId());
    const history = await getHistory(id);
    const recent = history.slice(-maxMessages);

    if (recent.length === 0) return '(no conversation history)';

    return recent
      .map((msg) => {
        const content =
          msg.content.length > maxMsgLen ? msg.content.slice(0, maxMsgLen) + '...' : msg.content;
        return `[${msg.role}] ${content}`;
      })
      .join('\n');
  } catch (err) {
    return `(could not load conversation: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export function buildDebugSystemPrompt(): string {
  return `You are Lucia's diagnostic sub-agent. Your job is to analyze logs, errors, and system state to identify root causes of failures.

Analyze the diagnostic data provided and respond with this exact structure:

## Summary
One-sentence description of what went wrong.

## What Happened
Step-by-step sequence of events leading to the failure.

## Root Cause
The underlying technical reason for the failure.

## How to Fix
Specific, actionable steps to resolve the issue.

## Prevention
What could prevent this from happening again.

Be precise and technical. Reference specific error messages, log entries, and timestamps. If the data is insufficient to determine the root cause, say so and suggest what additional information would help.`;
}
