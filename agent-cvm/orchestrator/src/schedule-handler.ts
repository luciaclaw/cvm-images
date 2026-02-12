/**
 * Schedule management handler — processes schedule messages from PWA.
 *
 * Follows the credentials-handler.ts pattern: each handler calls the
 * scheduler module and returns a schedule.response with the full list.
 */

import type {
  MessageEnvelope,
  ScheduleCreatePayload,
  ScheduleUpdatePayload,
  ScheduleDeletePayload,
  ScheduleListPayload,
} from '@luciaclaw/protocol';
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedules,
} from './scheduler.js';

export async function handleScheduleCreate(
  payload: ScheduleCreatePayload
): Promise<MessageEnvelope> {
  try {
    await createSchedule(payload.name, payload.cronExpression, payload.timezone, payload.prompt);
    const schedules = await listSchedules();
    return {
      id: crypto.randomUUID(),
      type: 'schedule.response',
      timestamp: Date.now(),
      payload: { schedules },
    };
  } catch (err: any) {
    console.error('[schedule-handler] Create failed:', err);
    return {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      payload: { code: 6000, message: err.message || 'Failed to create schedule' },
    };
  }
}

export async function handleScheduleUpdate(
  payload: ScheduleUpdatePayload
): Promise<MessageEnvelope> {
  try {
    const { scheduleId, ...updates } = payload;
    const updated = await updateSchedule(scheduleId, updates);

    if (!updated) {
      return {
        id: crypto.randomUUID(),
        type: 'error',
        timestamp: Date.now(),
        payload: { code: 6001, message: `Schedule not found: ${scheduleId}` },
      };
    }

    const schedules = await listSchedules();
    return {
      id: crypto.randomUUID(),
      type: 'schedule.response',
      timestamp: Date.now(),
      payload: { schedules },
    };
  } catch (err: any) {
    console.error('[schedule-handler] Update failed:', err);
    return {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      payload: { code: 6000, message: err.message || 'Failed to update schedule' },
    };
  }
}

export async function handleScheduleDelete(
  payload: ScheduleDeletePayload
): Promise<MessageEnvelope> {
  deleteSchedule(payload.scheduleId);
  const schedules = await listSchedules();
  return {
    id: crypto.randomUUID(),
    type: 'schedule.response',
    timestamp: Date.now(),
    payload: { schedules },
  };
}

export async function handleScheduleList(
  payload: ScheduleListPayload
): Promise<MessageEnvelope> {
  const schedules = await listSchedules(payload.status);
  return {
    id: crypto.randomUUID(),
    type: 'schedule.response',
    timestamp: Date.now(),
    payload: { schedules },
  };
}
