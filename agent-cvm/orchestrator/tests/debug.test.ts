import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Mocks (must be before imports that trigger module loading) ---

vi.mock('../src/chat.js', () => ({
  handleChatMessage: vi.fn(),
  getActiveSendFn: vi.fn().mockReturnValue(null),
  setActiveSendFn: vi.fn(),
}));

vi.mock('../src/push.js', () => ({
  sendPushNotification: vi.fn(),
  handlePushSubscribe: vi.fn(),
  handlePushUnsubscribe: vi.fn(),
}));

// Mock inference to avoid real API calls
vi.mock('../src/inference.js', () => ({
  callInference: vi.fn().mockResolvedValue({
    content: '## Summary\nMock diagnosis result',
    model: 'anthropic/claude-opus-4.6',
    finishReason: 'stop',
    promptTokens: 500,
    completionTokens: 200,
  }),
}));

// Mock workflow-engine to avoid complex DB initialization
vi.mock('../src/workflow-engine.js', () => ({
  getExecutionStatus: vi.fn().mockResolvedValue(null),
  recoverRunningExecutions: vi.fn().mockResolvedValue(undefined),
}));

const tempDir = mkdtempSync(join(tmpdir(), 'lucia-debug-test-'));
process.env.DATA_DIR = tempDir;

import { LogRingBuffer, logBuffer } from '../src/log-buffer.js';
import { collectDiagnostics, buildDebugSystemPrompt } from '../src/debug-collector.js';
import { closeDb } from '../src/storage.js';
import { registerSubAgentTools } from '../src/tools/sub-agent.js';
import { getTool, getAllTools } from '../src/tool-registry.js';
import { getModelForRole, getModelConfig } from '../src/model-registry.js';
import { callInference } from '../src/inference.js';

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Log Ring Buffer ─────────────────────────────────────────────

describe('LogRingBuffer', () => {
  it('push and getAll maintain insertion order', () => {
    const buf = new LogRingBuffer(5);
    buf.push({ timestamp: 1, level: 'log', message: 'a' });
    buf.push({ timestamp: 2, level: 'log', message: 'b' });
    buf.push({ timestamp: 3, level: 'log', message: 'c' });

    const all = buf.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].message).toBe('a');
    expect(all[2].message).toBe('c');
  });

  it('wraps at capacity', () => {
    const buf = new LogRingBuffer(3);
    buf.push({ timestamp: 1, level: 'log', message: 'a' });
    buf.push({ timestamp: 2, level: 'log', message: 'b' });
    buf.push({ timestamp: 3, level: 'log', message: 'c' });
    buf.push({ timestamp: 4, level: 'log', message: 'd' });

    const all = buf.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].message).toBe('b');
    expect(all[2].message).toBe('d');
  });

  it('getRecent filters by time window', () => {
    const buf = new LogRingBuffer();
    const now = Date.now();
    buf.push({ timestamp: now - 120_000, level: 'log', message: 'old' });
    buf.push({ timestamp: now - 30_000, level: 'error', message: 'recent error' });
    buf.push({ timestamp: now - 5_000, level: 'log', message: 'very recent' });

    const recent = buf.getRecent(60_000); // last 60s
    expect(recent).toHaveLength(2);
    expect(recent[0].message).toBe('recent error');
    expect(recent[1].message).toBe('very recent');
  });

  it('format produces readable output', () => {
    const buf = new LogRingBuffer();
    buf.push({ timestamp: 1700000000000, level: 'error', message: 'test error' });
    buf.push({ timestamp: 1700000001000, level: 'warn', message: 'test warn' });

    const output = buf.format();
    expect(output).toContain('[ERROR]');
    expect(output).toContain('[WARN]');
    expect(output).toContain('test error');
    expect(output).toContain('test warn');
  });

  it('format returns placeholder for empty buffer', () => {
    const buf = new LogRingBuffer();
    expect(buf.format()).toBe('(no log entries)');
  });

  it('clear empties the buffer', () => {
    const buf = new LogRingBuffer();
    buf.push({ timestamp: 1, level: 'log', message: 'x' });
    buf.clear();
    expect(buf.getAll()).toHaveLength(0);
  });

  it('getAll returns a copy, not a reference', () => {
    const buf = new LogRingBuffer();
    buf.push({ timestamp: 1, level: 'log', message: 'x' });
    const all = buf.getAll();
    all.push({ timestamp: 2, level: 'log', message: 'y' });
    expect(buf.getAll()).toHaveLength(1);
  });
});

// ─── Diagnostic Collector ────────────────────────────────────────

describe('collectDiagnostics', () => {
  beforeEach(() => {
    logBuffer.clear();
  });

  it('returns a bundle with all expected fields', async () => {
    const bundle = await collectDiagnostics();

    expect(bundle).toHaveProperty('recentLogs');
    expect(bundle).toHaveProperty('errorLogs');
    expect(bundle).toHaveProperty('workflowErrors');
    expect(bundle).toHaveProperty('cronErrors');
    expect(bundle).toHaveProperty('conversationContext');
    expect(bundle).toHaveProperty('systemInfo');
  });

  it('includes system info with node version', async () => {
    const bundle = await collectDiagnostics();
    expect(bundle.systemInfo).toContain('Node:');
    expect(bundle.systemInfo).toContain('Uptime:');
    expect(bundle.systemInfo).toContain('Heap:');
  });

  it('captures recent logs from the ring buffer', async () => {
    logBuffer.push({ timestamp: Date.now(), level: 'error', message: 'test failure xyz' });

    const bundle = await collectDiagnostics(undefined, { logWindowMs: 60_000 });
    expect(bundle.recentLogs).toContain('test failure xyz');
    expect(bundle.errorLogs).toContain('test failure xyz');
  });

  it('returns fallback strings when no errors exist', async () => {
    const bundle = await collectDiagnostics();
    expect(bundle.workflowErrors).toBe('(no failed workflow executions)');
    expect(bundle.cronErrors).toBe('(no cron errors)');
  });
});

describe('buildDebugSystemPrompt', () => {
  it('returns a string with expected sections', () => {
    const prompt = buildDebugSystemPrompt();
    expect(prompt).toContain('Summary');
    expect(prompt).toContain('Root Cause');
    expect(prompt).toContain('How to Fix');
    expect(prompt).toContain('Prevention');
  });
});

// ─── Model Registry — debug role ─────────────────────────────────

describe('debug model config', () => {
  it('getModelForRole returns claude opus for debug', () => {
    expect(getModelForRole('debug')).toBe('anthropic/claude-opus-4.6');
  });

  it('debug model has supportsTools: false', () => {
    const config = getModelConfig('debug');
    expect(config.supportsTools).toBe(false);
  });

  it('debug model has tee: false', () => {
    const config = getModelConfig('debug');
    expect(config.tee).toBe(false);
  });
});

// ─── Tool Registration ───────────────────────────────────────────

describe('agent.debug tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is registered by registerSubAgentTools', () => {
    registerSubAgentTools();
    const tool = getTool('agent.debug');
    expect(tool).toBeDefined();
  });

  it('has correct parameter schema', () => {
    const tool = getTool('agent.debug')!;
    const props = (tool.parameters as any).properties;
    expect(props).toHaveProperty('issue');
    expect(props).toHaveProperty('executionId');
    expect(props).toHaveProperty('timeWindowMinutes');
    expect(props.issue.type).toBe('string');
    expect(props.executionId.type).toBe('string');
    expect(props.timeWindowMinutes.type).toBe('number');
  });

  it('has low risk and no confirmation required', () => {
    const tool = getTool('agent.debug')!;
    expect(tool.riskLevel).toBe('low');
    expect(tool.requiresConfirmation).toBe(false);
  });

  it('has no required credentials', () => {
    const tool = getTool('agent.debug')!;
    expect(tool.requiredCredentials).toEqual([]);
  });
});

// ─── Integration: execute calls callInference ────────────────────

describe('agent.debug execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logBuffer.clear();
  });

  it('calls callInference with debug model and returns diagnosis', async () => {
    registerSubAgentTools();
    const tool = getTool('agent.debug')!;

    logBuffer.push({ timestamp: Date.now(), level: 'error', message: 'connection refused' });

    const result = (await tool.execute({ issue: 'workflow failed' })) as any;

    expect(result).toHaveProperty('diagnosis');
    expect(result.diagnosis).toContain('Mock diagnosis result');
    expect(result.model).toBe('anthropic/claude-opus-4.6');
    expect(result.tokensUsed).toBe(700); // 500 + 200

    // Verify callInference was called with system + user messages
    const mockInference = callInference as ReturnType<typeof vi.fn>;
    expect(mockInference).toHaveBeenCalledTimes(1);

    const [messages, model] = mockInference.mock.calls[0];
    expect(model).toBe('anthropic/claude-opus-4.6');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('workflow failed');
    expect(messages[1].content).toContain('connection refused');
  });

  it('includes diagnosticSummary in result', async () => {
    const tool = getTool('agent.debug')!;
    const result = (await tool.execute({})) as any;

    expect(result).toHaveProperty('diagnosticSummary');
    expect(result.diagnosticSummary).toHaveProperty('errorLogCount');
    expect(result.diagnosticSummary).toHaveProperty('hasWorkflowErrors');
    expect(result.diagnosticSummary).toHaveProperty('hasCronErrors');
    expect(result.diagnosticSummary).toHaveProperty('timeWindowMinutes');
    expect(result.diagnosticSummary.timeWindowMinutes).toBe(10);
  });

  it('respects custom timeWindowMinutes', async () => {
    const tool = getTool('agent.debug')!;

    // Add a log entry so the "Recent Logs" section appears with the time window
    logBuffer.push({ timestamp: Date.now(), level: 'error', message: 'some error' });

    const result = (await tool.execute({ timeWindowMinutes: 30 })) as any;

    expect(result.diagnosticSummary.timeWindowMinutes).toBe(30);

    const mockInference = callInference as ReturnType<typeof vi.fn>;
    const userPrompt = mockInference.mock.calls[0][0][1].content;
    expect(userPrompt).toContain('30 min');
  });
});
