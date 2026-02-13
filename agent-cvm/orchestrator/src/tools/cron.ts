/**
 * Cron self-scheduling tools — let the LLM manage its own schedules.
 *
 * The agent can create, list, update, and delete cron jobs autonomously.
 * Example: "I'll check on this every hour" → creates an interval schedule.
 */

import { registerTool } from '../tool-registry.js';
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedules,
} from '../scheduler.js';

export function registerCronTools(): void {
  registerTool({
    name: 'cron.create',
    description:
      'Create a scheduled task that fires automatically. Supports three types: ' +
      '"cron" (recurring via cron expression, e.g. "0 8 * * *" for daily at 8am), ' +
      '"at" (one-shot at a specific time, or relative like "20m" for 20 minutes from now), ' +
      '"interval" (recurring every N milliseconds, minimum 1000ms). ' +
      'The schedule will inject the prompt into the chat pipeline when it fires.',
    parameters: {
      type: 'object',
      required: ['name', 'prompt'],
      properties: {
        name: { type: 'string', description: 'Human-readable name for the schedule' },
        prompt: { type: 'string', description: 'Prompt to execute when the schedule fires' },
        scheduleType: {
          type: 'string',
          enum: ['cron', 'at', 'interval'],
          description: 'Type of schedule (default: "cron")',
        },
        cronExpression: {
          type: 'string',
          description: '5-field cron expression (required for "cron" type). E.g. "0 8 * * *" for daily at 8am, "*/30 * * * *" for every 30 min',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone (default: "UTC"). E.g. "America/New_York", "Europe/London"',
        },
        atDuration: {
          type: 'string',
          description: 'Relative duration for "at" type: "20m" (20 min), "2h" (2 hours), "1d" (1 day)',
        },
        atTime: {
          type: 'number',
          description: 'Unix timestamp in milliseconds for "at" type (alternative to atDuration)',
        },
        intervalMs: {
          type: 'number',
          description: 'Interval in milliseconds for "interval" type (minimum 1000)',
        },
        executionMode: {
          type: 'string',
          enum: ['main', 'isolated'],
          description: '"main" = shared conversation context (default), "isolated" = fresh conversation each run',
        },
        delivery: {
          type: 'object',
          description: 'Route results to a channel. E.g. { mode: "announce", channel: "telegram", target: "123456" }',
          properties: {
            mode: { type: 'string', enum: ['announce', 'silent', 'none'] },
            channel: { type: 'string', description: 'Channel type: telegram, discord, slack, gmail' },
            target: { type: 'string', description: 'Target ID: chat_id, channel_id, email, etc.' },
          },
        },
        model: {
          type: 'string',
          description: 'LLM model override for this job (e.g. "openai/gpt-oss-120b")',
        },
        maxRetries: {
          type: 'number',
          description: 'Max retry attempts on failure (default: 0)',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const {
        name, prompt, scheduleType, cronExpression, timezone,
        atDuration, atTime, intervalMs, executionMode, delivery,
        model, maxRetries,
      } = args as {
        name: string;
        prompt: string;
        scheduleType?: string;
        cronExpression?: string;
        timezone?: string;
        atDuration?: string;
        atTime?: number;
        intervalMs?: number;
        executionMode?: string;
        delivery?: { mode: string; channel?: string; target?: string };
        model?: string;
        maxRetries?: number;
      };

      const schedule = await createSchedule(
        name,
        cronExpression ?? null,
        timezone || 'UTC',
        prompt,
        {
          scheduleType: (scheduleType as any) || 'cron',
          executionMode: (executionMode as any) || 'main',
          delivery: delivery as any,
          model,
          atTime,
          atDuration,
          intervalMs,
          maxRetries,
        }
      );

      return {
        id: schedule.id,
        name: schedule.name,
        scheduleType: schedule.scheduleType,
        nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
        status: schedule.status,
      };
    },
  });

  registerTool({
    name: 'cron.list',
    description:
      'List all scheduled tasks. Optionally filter by status ("active" or "paused"). ' +
      'Returns schedule names, types, next run times, and status.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'paused'],
          description: 'Filter by status',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { status } = args as { status?: string };
      const schedules = await listSchedules(status as any);
      return schedules.map((s) => ({
        id: s.id,
        name: s.name,
        scheduleType: s.scheduleType,
        cronExpression: s.cronExpression,
        timezone: s.timezone,
        prompt: s.prompt.length > 100 ? s.prompt.substring(0, 97) + '...' : s.prompt,
        status: s.status,
        executionMode: s.executionMode,
        model: s.model,
        nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
        lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
        retryCount: s.retryCount,
        lastError: s.lastError,
      }));
    },
  });

  registerTool({
    name: 'cron.update',
    description:
      'Update an existing scheduled task. Can change name, prompt, cron expression, timezone, ' +
      'status (pause/resume), execution mode, delivery config, model, and retry settings.',
    parameters: {
      type: 'object',
      required: ['scheduleId'],
      properties: {
        scheduleId: { type: 'string', description: 'ID of the schedule to update' },
        name: { type: 'string', description: 'New name' },
        prompt: { type: 'string', description: 'New prompt' },
        cronExpression: { type: 'string', description: 'New cron expression' },
        timezone: { type: 'string', description: 'New timezone' },
        status: {
          type: 'string',
          enum: ['active', 'paused'],
          description: 'Pause or resume the schedule',
        },
        executionMode: {
          type: 'string',
          enum: ['main', 'isolated'],
          description: 'Execution mode',
        },
        model: { type: 'string', description: 'LLM model override (null to clear)' },
        maxRetries: { type: 'number', description: 'Max retry attempts' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { scheduleId, ...updates } = args as {
        scheduleId: string;
        [key: string]: unknown;
      };

      const updated = await updateSchedule(scheduleId, updates as any);
      if (!updated) {
        return { error: `Schedule not found: ${scheduleId}` };
      }

      return {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        nextRunAt: updated.nextRunAt ? new Date(updated.nextRunAt).toISOString() : null,
      };
    },
  });

  registerTool({
    name: 'cron.delete',
    description: 'Delete a scheduled task by ID. This is permanent and cannot be undone.',
    parameters: {
      type: 'object',
      required: ['scheduleId'],
      properties: {
        scheduleId: { type: 'string', description: 'ID of the schedule to delete' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'medium',
    requiresConfirmation: false,
    async execute(args) {
      const { scheduleId } = args as { scheduleId: string };
      const deleted = deleteSchedule(scheduleId);
      return { deleted, scheduleId };
    },
  });
}
