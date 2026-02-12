import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock handleChatMessage to avoid inference dependency
vi.mock('../src/chat.js', () => ({
  handleChatMessage: vi.fn().mockResolvedValue({
    id: 'mock-response-id',
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: 'Mock schedule response' },
  }),
  getActiveSendFn: vi.fn().mockReturnValue(null),
  setActiveSendFn: vi.fn(),
}));

// Mock push notifications
vi.mock('../src/push.js', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  handlePushSubscribe: vi.fn(),
  handlePushUnsubscribe: vi.fn(),
}));

// Set DATA_DIR before any storage module usage (getDbPath reads lazily)
const tempDir = mkdtempSync(join(tmpdir(), 'lucia-sched-test-'));
process.env.DATA_DIR = tempDir;

import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  listSchedules,
  _testExports,
} from '../src/scheduler.js';
import { handleChatMessage } from '../src/chat.js';
import { closeDb } from '../src/storage.js';

const { computeNextRun, tick } = _testExports;

// Clean up once after all tests in this file
afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Scheduler CRUD', () => {
  it('creates a schedule with computed nextRunAt', async () => {
    const schedule = await createSchedule(
      'Morning briefing',
      '0 8 * * *',
      'UTC',
      'Give me a morning briefing'
    );

    expect(schedule.id).toBeTruthy();
    expect(schedule.name).toBe('Morning briefing');
    expect(schedule.cronExpression).toBe('0 8 * * *');
    expect(schedule.timezone).toBe('UTC');
    expect(schedule.prompt).toBe('Give me a morning briefing');
    expect(schedule.status).toBe('active');
    expect(schedule.conversationId).toBeNull();
    expect(schedule.nextRunAt).toBeTypeOf('number');
    expect(schedule.nextRunAt!).toBeGreaterThan(Date.now() - 1000);
    expect(schedule.lastRunAt).toBeNull();
  });

  it('lists schedules with entries', async () => {
    const schedules = await listSchedules();
    expect(schedules.length).toBeGreaterThanOrEqual(1);
    expect(schedules.some((s) => s.name === 'Morning briefing')).toBe(true);
  });

  it('updates schedule name, cron, and timezone', async () => {
    const schedules = await listSchedules();
    const target = schedules.find((s) => s.name === 'Morning briefing')!;

    const updated = await updateSchedule(target.id, {
      name: 'Updated briefing',
      cronExpression: '0 9 * * 1-5',
      timezone: 'America/New_York',
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Updated briefing');
    expect(updated!.cronExpression).toBe('0 9 * * 1-5');
    expect(updated!.timezone).toBe('America/New_York');
    expect(updated!.nextRunAt).toBeTypeOf('number');
  });

  it('pausing sets nextRunAt to null', async () => {
    const schedules = await listSchedules();
    const target = schedules.find((s) => s.name === 'Updated briefing')!;

    const paused = await updateSchedule(target.id, { status: 'paused' });
    expect(paused).not.toBeNull();
    expect(paused!.status).toBe('paused');
    expect(paused!.nextRunAt).toBeNull();
  });

  it('resuming recomputes nextRunAt', async () => {
    const schedules = await listSchedules();
    const target = schedules.find((s) => s.name === 'Updated briefing')!;

    const resumed = await updateSchedule(target.id, { status: 'active' });
    expect(resumed).not.toBeNull();
    expect(resumed!.status).toBe('active');
    expect(resumed!.nextRunAt).toBeTypeOf('number');
    expect(resumed!.nextRunAt!).toBeGreaterThan(Date.now() - 1000);
  });

  it('deletes a schedule', async () => {
    const schedules = await listSchedules();
    const target = schedules.find((s) => s.name === 'Updated briefing')!;

    const deleted = deleteSchedule(target.id);
    expect(deleted).toBe(true);

    const remaining = await listSchedules();
    expect(remaining.find((s) => s.id === target.id)).toBeUndefined();
  });

  it('delete returns false for non-existent schedule', () => {
    const deleted = deleteSchedule('non-existent-id');
    expect(deleted).toBe(false);
  });

  it('update returns null for non-existent schedule', async () => {
    const result = await updateSchedule('non-existent-id', { name: 'Updated' });
    expect(result).toBeNull();
  });

  it('rejects invalid cron expression', async () => {
    await expect(
      createSchedule('Bad cron', 'invalid cron', 'UTC', 'test')
    ).rejects.toThrow();
  });

  it('filters by status', async () => {
    const s1 = await createSchedule('Active one', '0 8 * * *', 'UTC', 'test1');
    const s2 = await createSchedule('Paused one', '0 9 * * *', 'UTC', 'test2');
    await updateSchedule(s2.id, { status: 'paused' });

    const activeOnly = await listSchedules('active');
    expect(activeOnly.every((s) => s.status === 'active')).toBe(true);

    const pausedOnly = await listSchedules('paused');
    expect(pausedOnly.every((s) => s.status === 'paused')).toBe(true);

    // Cleanup
    deleteSchedule(s1.id);
    deleteSchedule(s2.id);
  });
});

describe('computeNextRun', () => {
  it('computes a future timestamp', () => {
    const next = computeNextRun('0 8 * * *', 'UTC');
    expect(next).toBeGreaterThan(Date.now() - 1000);
  });

  it('throws on invalid cron', () => {
    expect(() => computeNextRun('not a cron', 'UTC')).toThrow();
  });
});

describe('Scheduler tick', () => {
  it('fires schedule whose nextRunAt is in the past', async () => {
    const schedule = await createSchedule('Overdue', '0 0 * * *', 'UTC', 'Overdue prompt');
    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 60_000, schedule.id);

    vi.mocked(handleChatMessage).mockClear();

    await tick();

    expect(handleChatMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: 'Overdue prompt' })
    );

    // Verify lastRunAt was updated
    const updated = (await listSchedules()).find((s) => s.id === schedule.id);
    expect(updated!.lastRunAt).toBeTypeOf('number');
    expect(updated!.nextRunAt).toBeGreaterThan(Date.now() - 1000);

    deleteSchedule(schedule.id);
  });

  it('skips paused schedules', async () => {
    const schedule = await createSchedule('Paused tick', '0 0 * * *', 'UTC', 'Should not fire');
    await updateSchedule(schedule.id, { status: 'paused' });

    vi.mocked(handleChatMessage).mockClear();
    await tick();

    const calls = vi.mocked(handleChatMessage).mock.calls;
    const firedForThisSchedule = calls.some(
      ([, payload]) => (payload as any).content === 'Should not fire'
    );
    expect(firedForThisSchedule).toBe(false);

    deleteSchedule(schedule.id);
  });

  it('skips schedules whose nextRunAt is in the future', async () => {
    const schedule = await createSchedule('Future', '0 0 * * *', 'UTC', 'Future prompt');

    vi.mocked(handleChatMessage).mockClear();
    await tick();

    const calls = vi.mocked(handleChatMessage).mock.calls;
    const firedForThisSchedule = calls.some(
      ([, payload]) => (payload as any).content === 'Future prompt'
    );
    expect(firedForThisSchedule).toBe(false);

    deleteSchedule(schedule.id);
  });

  it('creates conversation if none exists when firing', async () => {
    const schedule = await createSchedule('No conv', '0 0 * * *', 'UTC', 'Create conv prompt');
    expect(schedule.conversationId).toBeNull();

    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, schedule.id);

    await tick();

    const updated = (await listSchedules()).find((s) => s.id === schedule.id);
    expect(updated!.conversationId).toBeTruthy();

    deleteSchedule(schedule.id);
  });
});
