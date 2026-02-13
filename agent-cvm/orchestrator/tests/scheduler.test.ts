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

// Mock tool registry for delivery tests
vi.mock('../src/tool-registry.js', () => {
  const mockExecute = vi.fn().mockResolvedValue({ success: true });
  return {
    getTool: vi.fn().mockImplementation((name: string) => {
      if (name === 'telegram.send' || name === 'discord.send' || name === 'slack.send') {
        return { execute: mockExecute };
      }
      return undefined;
    }),
    registerTool: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    getToolsForInference: vi.fn().mockReturnValue([]),
    _mockExecute: mockExecute,
  };
});

// Set DATA_DIR before any storage module usage
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
import { getTool } from '../src/tool-registry.js';
import { closeDb } from '../src/storage.js';

const { computeNextRun, computeBackoff, parseDuration, tick, fireSchedule, deliverResults } = _testExports;

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Cron CRUD (backwards compat) ───

describe('Scheduler CRUD — cron type', () => {
  it('creates a cron schedule with computed nextRunAt', async () => {
    const schedule = await createSchedule(
      'Morning briefing',
      '0 8 * * *',
      'UTC',
      'Give me a morning briefing'
    );

    expect(schedule.id).toBeTruthy();
    expect(schedule.name).toBe('Morning briefing');
    expect(schedule.scheduleType).toBe('cron');
    expect(schedule.cronExpression).toBe('0 8 * * *');
    expect(schedule.timezone).toBe('UTC');
    expect(schedule.prompt).toBe('Give me a morning briefing');
    expect(schedule.status).toBe('active');
    expect(schedule.executionMode).toBe('main');
    expect(schedule.delivery).toBeNull();
    expect(schedule.model).toBeNull();
    expect(schedule.atTime).toBeNull();
    expect(schedule.intervalMs).toBeNull();
    expect(schedule.deleteAfterRun).toBe(false);
    expect(schedule.maxRetries).toBe(0);
    expect(schedule.retryBackoffMs).toBe(30000);
    expect(schedule.retryCount).toBe(0);
    expect(schedule.lastError).toBeNull();
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

    deleteSchedule(s1.id);
    deleteSchedule(s2.id);
  });
});

// ─── One-shot (at) scheduling ───

describe('One-shot (at) scheduling', () => {
  it('creates an at-type schedule with absolute time', async () => {
    const futureTime = Date.now() + 600_000; // 10 min from now
    const schedule = await createSchedule(
      'Reminder',
      null,
      'UTC',
      'Remind me about the meeting',
      { scheduleType: 'at', atTime: futureTime }
    );

    expect(schedule.scheduleType).toBe('at');
    expect(schedule.cronExpression).toBeNull();
    expect(schedule.atTime).toBe(futureTime);
    expect(schedule.nextRunAt).toBe(futureTime);
    expect(schedule.deleteAfterRun).toBe(true); // default for at type
    deleteSchedule(schedule.id);
  });

  it('creates an at-type schedule with relative duration', async () => {
    const before = Date.now();
    const schedule = await createSchedule(
      'Quick reminder',
      null,
      'UTC',
      'Check the oven',
      { scheduleType: 'at', atDuration: '20m' }
    );

    expect(schedule.scheduleType).toBe('at');
    expect(schedule.atTime).toBeGreaterThanOrEqual(before + 20 * 60 * 1000 - 100);
    expect(schedule.atTime).toBeLessThanOrEqual(Date.now() + 20 * 60 * 1000 + 100);
    expect(schedule.nextRunAt).toBe(schedule.atTime);
    deleteSchedule(schedule.id);
  });

  it('rejects at-type without atTime or atDuration', async () => {
    await expect(
      createSchedule('Bad at', null, 'UTC', 'test', { scheduleType: 'at' })
    ).rejects.toThrow('atTime or atDuration is required');
  });

  it('rejects at-type with past time', async () => {
    await expect(
      createSchedule('Past at', null, 'UTC', 'test', {
        scheduleType: 'at',
        atTime: Date.now() - 1000,
      })
    ).rejects.toThrow('atTime must be in the future');
  });

  it('auto-deletes one-shot schedule after execution', async () => {
    const schedule = await createSchedule(
      'Auto-delete me',
      null,
      'UTC',
      'One-shot prompt',
      { scheduleType: 'at', atTime: Date.now() + 1000, deleteAfterRun: true }
    );

    // Force schedule to be overdue
    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, schedule.id);

    vi.mocked(handleChatMessage).mockClear();
    await tick();

    // Schedule should be deleted
    const remaining = await listSchedules();
    expect(remaining.find((s) => s.id === schedule.id)).toBeUndefined();
  });
});

// ─── Interval scheduling ───

describe('Interval scheduling', () => {
  it('creates an interval schedule', async () => {
    const schedule = await createSchedule(
      'Hourly check',
      null,
      'UTC',
      'Check system status',
      { scheduleType: 'interval', intervalMs: 3600_000 }
    );

    expect(schedule.scheduleType).toBe('interval');
    expect(schedule.intervalMs).toBe(3600_000);
    expect(schedule.cronExpression).toBeNull();
    expect(schedule.nextRunAt).toBeGreaterThan(Date.now());
    expect(schedule.nextRunAt!).toBeLessThanOrEqual(Date.now() + 3600_000 + 100);
    deleteSchedule(schedule.id);
  });

  it('rejects interval < 1000ms', async () => {
    await expect(
      createSchedule('Too fast', null, 'UTC', 'test', {
        scheduleType: 'interval',
        intervalMs: 500,
      })
    ).rejects.toThrow('intervalMs >= 1000');
  });
});

// ─── parseDuration ───

describe('parseDuration', () => {
  it('parses seconds', () => expect(parseDuration('30s')).toBe(30_000));
  it('parses minutes', () => expect(parseDuration('20m')).toBe(1_200_000));
  it('parses hours', () => expect(parseDuration('2h')).toBe(7_200_000));
  it('parses days', () => expect(parseDuration('1d')).toBe(86_400_000));
  it('rejects invalid format', () => expect(() => parseDuration('abc')).toThrow());
  it('rejects empty string', () => expect(() => parseDuration('')).toThrow());
});

// ─── computeNextRun ───

describe('computeNextRun', () => {
  it('computes a future timestamp', () => {
    const next = computeNextRun('0 8 * * *', 'UTC');
    expect(next).toBeGreaterThan(Date.now() - 1000);
  });

  it('throws on invalid cron', () => {
    expect(() => computeNextRun('not a cron', 'UTC')).toThrow();
  });
});

// ─── computeBackoff ───

describe('computeBackoff', () => {
  it('uses step schedule for first 5 retries', () => {
    expect(computeBackoff(0, 30_000)).toBe(30_000);
    expect(computeBackoff(1, 30_000)).toBe(60_000);
    expect(computeBackoff(2, 30_000)).toBe(300_000);
    expect(computeBackoff(3, 30_000)).toBe(900_000);
    expect(computeBackoff(4, 30_000)).toBe(3_600_000);
  });

  it('uses exponential after step schedule with 60m cap', () => {
    const result = computeBackoff(10, 30_000);
    expect(result).toBeLessThanOrEqual(3_600_000);
  });
});

// ─── Retry with backoff ───

describe('Retry with exponential backoff', () => {
  it('retries on failure and tracks retry count', async () => {
    vi.mocked(handleChatMessage).mockRejectedValueOnce(new Error('API down'));

    const schedule = await createSchedule(
      'Retry me',
      '0 0 * * *',
      'UTC',
      'Failing prompt',
      { maxRetries: 3, retryBackoffMs: 30_000 }
    );

    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, schedule.id);

    await tick();

    const updated = (await listSchedules()).find((s) => s.id === schedule.id);
    expect(updated).toBeDefined();
    expect(updated!.retryCount).toBe(1);
    expect(updated!.lastError).toContain('API down');
    // nextRunAt should be in the future (backoff applied)
    expect(updated!.nextRunAt).toBeGreaterThan(Date.now());

    deleteSchedule(schedule.id);
    vi.mocked(handleChatMessage).mockResolvedValue({
      id: 'mock-response-id',
      type: 'chat.response' as const,
      timestamp: Date.now(),
      payload: { content: 'Mock schedule response' },
    });
  });

  it('resets retry count on success', async () => {
    const schedule = await createSchedule(
      'Reset retry',
      '0 0 * * *',
      'UTC',
      'Success prompt',
      { maxRetries: 3 }
    );

    // Manually set retry count
    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET retry_count = 2, next_run_at = ? WHERE id = ?')
      .run(Date.now() - 1000, schedule.id);

    vi.mocked(handleChatMessage).mockClear();
    await tick();

    const updated = (await listSchedules()).find((s) => s.id === schedule.id);
    expect(updated!.retryCount).toBe(0);
    expect(updated!.lastError).toBeNull();

    deleteSchedule(schedule.id);
  });
});

// ─── Delivery routing ───

describe('Delivery routing', () => {
  it('calls telegram.send for announce delivery', async () => {
    const schedule = await createSchedule(
      'Telegram delivery',
      '0 0 * * *',
      'UTC',
      'Daily report',
      {
        delivery: { mode: 'announce', channel: 'telegram', target: '123456' },
      }
    );

    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, schedule.id);

    vi.mocked(handleChatMessage).mockClear();
    const mockExecute = (await import('../src/tool-registry.js') as any)._mockExecute;
    mockExecute.mockClear();

    await tick();

    expect(getTool).toHaveBeenCalledWith('telegram.send');
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: '123456' })
    );

    deleteSchedule(schedule.id);
  });

  it('skips delivery when mode is none', async () => {
    const schedule = await createSchedule(
      'No delivery',
      '0 0 * * *',
      'UTC',
      'Silent job',
      {
        delivery: { mode: 'none' },
      }
    );

    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, schedule.id);

    const mockExecute = (await import('../src/tool-registry.js') as any)._mockExecute;
    mockExecute.mockClear();

    await tick();

    expect(mockExecute).not.toHaveBeenCalled();
    deleteSchedule(schedule.id);
  });
});

// ─── Isolated execution ───

describe('Isolated execution', () => {
  it('creates a fresh conversation for each isolated run', async () => {
    const schedule = await createSchedule(
      'Isolated job',
      '0 0 * * *',
      'UTC',
      'Fresh context prompt',
      { executionMode: 'isolated' }
    );

    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, schedule.id);

    vi.mocked(handleChatMessage).mockClear();
    await tick();

    // Check that handleChatMessage was called with a conversationId
    expect(handleChatMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: 'Fresh context prompt' })
    );

    // The schedule's conversation_id should still be null (isolated doesn't persist)
    const updated = (await listSchedules()).find((s) => s.id === schedule.id);
    expect(updated!.conversationId).toBeNull();

    deleteSchedule(schedule.id);
  });
});

// ─── Per-job model selection ───

describe('Per-job model selection', () => {
  it('passes model override to handleChatMessage', async () => {
    const schedule = await createSchedule(
      'Custom model job',
      '0 0 * * *',
      'UTC',
      'Use expensive model',
      { model: 'openai/gpt-oss-120b' }
    );

    expect(schedule.model).toBe('openai/gpt-oss-120b');

    const { getDb } = await import('../src/storage.js');
    const db = getDb();
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, schedule.id);

    vi.mocked(handleChatMessage).mockClear();
    await tick();

    expect(handleChatMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: 'openai/gpt-oss-120b' })
    );

    deleteSchedule(schedule.id);
  });
});

// ─── Tick behavior ───

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

  it('creates conversation if none exists when firing in main mode', async () => {
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

// ─── Update with new fields ───

describe('Update with new fields', () => {
  it('updates execution mode and delivery config', async () => {
    const schedule = await createSchedule('Updatable', '0 8 * * *', 'UTC', 'test');
    expect(schedule.executionMode).toBe('main');
    expect(schedule.delivery).toBeNull();

    const updated = await updateSchedule(schedule.id, {
      executionMode: 'isolated',
      delivery: { mode: 'announce', channel: 'discord', target: 'chan123' },
    });

    expect(updated!.executionMode).toBe('isolated');
    expect(updated!.delivery).toEqual({ mode: 'announce', channel: 'discord', target: 'chan123' });

    // Clear delivery
    const cleared = await updateSchedule(schedule.id, { delivery: null });
    expect(cleared!.delivery).toBeNull();

    deleteSchedule(schedule.id);
  });

  it('updates model and retry config', async () => {
    const schedule = await createSchedule('Model job', '0 8 * * *', 'UTC', 'test');

    const updated = await updateSchedule(schedule.id, {
      model: 'openai/gpt-oss-120b',
      maxRetries: 5,
      retryBackoffMs: 60_000,
    });

    expect(updated!.model).toBe('openai/gpt-oss-120b');
    expect(updated!.maxRetries).toBe(5);
    expect(updated!.retryBackoffMs).toBe(60_000);

    deleteSchedule(schedule.id);
  });
});
