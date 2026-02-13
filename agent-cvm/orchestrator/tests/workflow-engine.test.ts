import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Track inference calls
let _mockInferenceCalls: Array<{ messages: unknown[]; model?: string; tools?: unknown[] }> = [];
let _mockInferenceResponses: Array<{
  content: string;
  model: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  finishReason: string;
}> = [];

// Mock inference
vi.mock('../src/inference.js', () => ({
  callInference: vi.fn().mockImplementation((messages: unknown[], model?: string, tools?: unknown[]) => {
    _mockInferenceCalls.push({ messages, model, tools });
    const response = _mockInferenceResponses.shift();
    if (response) return Promise.resolve(response);
    return Promise.resolve({
      content: 'Mock LLM response',
      model: model || 'mock-model',
      finishReason: 'stop',
    });
  }),
  callVisionInference: vi.fn(),
}));

// Track tool executions
let _mockToolExecutions: Array<{ name: string; args: Record<string, unknown> }> = [];

// Mock tool executor
vi.mock('../src/tool-executor.js', () => ({
  executeTool: vi.fn().mockImplementation((toolCall: { callId: string; name: string; arguments: Record<string, unknown> }) => {
    _mockToolExecutions.push({ name: toolCall.name, args: toolCall.arguments });
    return Promise.resolve({ success: true, result: { mockResult: true, tool: toolCall.name } });
  }),
}));

// Mock chat
vi.mock('../src/chat.js', () => ({
  handleChatMessage: vi.fn().mockResolvedValue({
    id: 'mock-response-id',
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: 'Mock response' },
  }),
  getActiveSendFn: vi.fn().mockReturnValue(null),
  setActiveSendFn: vi.fn(),
}));

// Mock push
vi.mock('../src/push.js', () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  handlePushSubscribe: vi.fn(),
  handlePushUnsubscribe: vi.fn(),
}));

// Mock tool registry
vi.mock('../src/tool-registry.js', () => ({
  registerTool: vi.fn(),
  getTool: vi.fn(),
  getAllTools: vi.fn().mockReturnValue([
    { name: 'gmail.send', description: 'Send email', parameters: {} },
    { name: 'gmail.read', description: 'Read email', parameters: {} },
    { name: 'web.search', description: 'Web search', parameters: {} },
    { name: 'calendar.list', description: 'List calendar events', parameters: {} },
  ]),
  getToolsForInference: vi.fn().mockReturnValue([
    { type: 'function', function: { name: 'gmail.send', description: 'Send email', parameters: {} } },
    { type: 'function', function: { name: 'gmail.read', description: 'Read email', parameters: {} } },
    { type: 'function', function: { name: 'web.search', description: 'Web search', parameters: {} } },
    { type: 'function', function: { name: 'calendar.list', description: 'List calendar events', parameters: {} } },
  ]),
}));

const tempDir = mkdtempSync(join(tmpdir(), 'lucia-workflow-test-'));
process.env.DATA_DIR = tempDir;

import {
  validateDAG,
  resolveTemplate,
  evaluateCondition,
  createWorkflow,
  listWorkflows,
  triggerWorkflow,
  getExecutionStatus,
} from '../src/workflow-engine.js';
import { closeDb } from '../src/storage.js';

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  _mockInferenceCalls = [];
  _mockInferenceResponses = [];
  _mockToolExecutions = [];
});

// ─── DAG Validation ──────────────────────────────────────────────

describe('validateDAG', () => {
  it('accepts a valid DAG', () => {
    expect(validateDAG([
      { id: 'a', name: 'Step A', type: 'delay', durationMs: 100 },
      { id: 'b', name: 'Step B', type: 'delay', durationMs: 100, dependsOn: ['a'] },
    ])).toBeNull();
  });

  it('rejects duplicate step IDs', () => {
    expect(validateDAG([
      { id: 'a', name: 'Step A', type: 'delay', durationMs: 100 },
      { id: 'a', name: 'Step A2', type: 'delay', durationMs: 100 },
    ])).toContain('Duplicate');
  });

  it('rejects unknown dependency', () => {
    expect(validateDAG([
      { id: 'a', name: 'Step A', type: 'delay', durationMs: 100, dependsOn: ['missing'] },
    ])).toContain('unknown step');
  });

  it('rejects circular dependency', () => {
    expect(validateDAG([
      { id: 'a', name: 'A', type: 'delay', durationMs: 1, dependsOn: ['b'] },
      { id: 'b', name: 'B', type: 'delay', durationMs: 1, dependsOn: ['a'] },
    ])).toContain('Circular');
  });
});

// ─── Template Resolution ─────────────────────────────────────────

describe('resolveTemplate', () => {
  const ctx = {
    steps: { search: { output: { results: ['item1', 'item2'], count: 2 } } },
    variables: { name: 'Alice' },
  };

  it('resolves simple template', () => {
    expect(resolveTemplate('Hello {{variables.name}}', ctx)).toBe('Hello Alice');
  });

  it('resolves full-value template to non-string', () => {
    expect(resolveTemplate('{{steps.search.output.count}}', ctx)).toBe(2);
  });

  it('resolves nested object templates', () => {
    const result = resolveTemplate({ to: '{{variables.name}}', count: '{{steps.search.output.count}}' }, ctx);
    expect(result).toEqual({ to: 'Alice', count: 2 });
  });
});

// ─── Condition Evaluation ────────────────────────────────────────

describe('evaluateCondition', () => {
  const ctx = {
    steps: { check: { output: { count: 5 }, status: 'completed' } },
    variables: { threshold: 3 },
  };

  it('evaluates comparison', () => {
    expect(evaluateCondition("steps.check.output.count > 3", ctx)).toBe(true);
    expect(evaluateCondition("steps.check.output.count < 3", ctx)).toBe(false);
  });

  it('evaluates equality', () => {
    expect(evaluateCondition("steps.check.status == 'completed'", ctx)).toBe(true);
  });

  it('evaluates logical operators', () => {
    expect(evaluateCondition("steps.check.output.count > 3 && steps.check.status == 'completed'", ctx)).toBe(true);
  });
});

// ─── Workflow CRUD ───────────────────────────────────────────────

describe('Workflow CRUD', () => {
  it('creates and lists a workflow', async () => {
    const wf = await createWorkflow('Test WF', 'A test workflow', [
      { id: 's1', name: 'Step 1', type: 'delay', durationMs: 10 },
    ]);
    expect(wf.id).toBeTruthy();
    expect(wf.name).toBe('Test WF');

    const all = await listWorkflows();
    expect(all.some((w) => w.id === wf.id)).toBe(true);
  });

  it('rejects workflow with invalid DAG', async () => {
    await expect(createWorkflow('Bad', 'Bad', [
      { id: 'a', name: 'A', type: 'delay', durationMs: 1, dependsOn: ['b'] },
      { id: 'b', name: 'B', type: 'delay', durationMs: 1, dependsOn: ['a'] },
    ])).rejects.toThrow('Circular');
  });
});

// ─── Agent Turn Step ─────────────────────────────────────────────

describe('agent_turn step type', () => {
  it('creates a workflow with agent_turn step', async () => {
    const wf = await createWorkflow('Agent WF', 'Workflow with sub-agent', [
      { id: 'agent', name: 'Sub-agent', type: 'agent_turn', prompt: 'Research the topic' },
    ]);
    expect(wf.steps[0].type).toBe('agent_turn');
  });

  it('executes agent_turn step with no tool calls (single turn)', async () => {
    _mockInferenceResponses = [
      { content: 'Research complete: found 3 results', model: 'mock-model', finishReason: 'stop' },
    ];

    const wf = await createWorkflow('Single Turn Agent', 'Agent that responds immediately', [
      { id: 'agent', name: 'Researcher', type: 'agent_turn', prompt: 'Research AI agents' },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool');
    // Wait for async execution
    await new Promise((r) => setTimeout(r, 200));

    const status = await getExecutionStatus(exec.id);
    expect(status).toBeTruthy();
    expect(status!.status).toBe('completed');

    const agentStep = status!.steps.find((s) => s.stepId === 'agent');
    expect(agentStep).toBeTruthy();
    expect(agentStep!.status).toBe('completed');
    expect((agentStep!.output as any).response).toBe('Research complete: found 3 results');
    expect((agentStep!.output as any).toolCallsMade).toBe(0);
    expect((agentStep!.output as any).turns).toBe(1);
  });

  it('executes agent_turn step with tool calls (multi-turn)', async () => {
    _mockInferenceResponses = [
      // Turn 1: LLM decides to call web.search
      {
        content: '',
        model: 'mock-model',
        toolCalls: [{ id: 'tc1', name: 'web.search', arguments: { query: 'AI agents 2026' } }],
        finishReason: 'tool_calls',
      },
      // Turn 2: LLM responds with the final answer
      {
        content: 'Based on my research, AI agents are trending in 2026.',
        model: 'mock-model',
        finishReason: 'stop',
      },
    ];

    const wf = await createWorkflow('Multi Turn Agent', 'Agent that uses tools', [
      { id: 'agent', name: 'Researcher', type: 'agent_turn', prompt: 'Search for AI agent trends' },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool');
    await new Promise((r) => setTimeout(r, 300));

    const status = await getExecutionStatus(exec.id);
    expect(status!.status).toBe('completed');

    const agentStep = status!.steps.find((s) => s.stepId === 'agent');
    expect((agentStep!.output as any).response).toBe('Based on my research, AI agents are trending in 2026.');
    expect((agentStep!.output as any).toolCallsMade).toBe(1);
    expect((agentStep!.output as any).turns).toBe(2);

    // Verify web.search was called
    expect(_mockToolExecutions.some((e) => e.name === 'web.search')).toBe(true);
  });

  it('respects allowedTools filter', async () => {
    _mockInferenceResponses = [
      { content: 'Done searching', model: 'mock-model', finishReason: 'stop' },
    ];

    const wf = await createWorkflow('Filtered Agent', 'Agent with limited tools', [
      {
        id: 'agent',
        name: 'Limited',
        type: 'agent_turn',
        prompt: 'Search for info',
        allowedTools: ['web.search'],
      },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool');
    await new Promise((r) => setTimeout(r, 200));

    // Verify inference was called with only web.search tool
    const inferenceCall = _mockInferenceCalls[0];
    expect(inferenceCall.tools).toBeTruthy();
    expect((inferenceCall.tools as any[]).length).toBe(1);
    expect((inferenceCall.tools as any[])[0].function.name).toBe('web.search');
  });

  it('respects allowedTools wildcard pattern', async () => {
    _mockInferenceResponses = [
      { content: 'Emails processed', model: 'mock-model', finishReason: 'stop' },
    ];

    const wf = await createWorkflow('Wildcard Agent', 'Agent with wildcard tools', [
      {
        id: 'agent',
        name: 'Email Agent',
        type: 'agent_turn',
        prompt: 'Process emails',
        allowedTools: ['gmail.*'],
      },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool');
    await new Promise((r) => setTimeout(r, 200));

    const inferenceCall = _mockInferenceCalls[0];
    expect((inferenceCall.tools as any[]).length).toBe(2); // gmail.send, gmail.read
    expect((inferenceCall.tools as any[]).every((t: any) => t.function.name.startsWith('gmail.'))).toBe(true);
  });

  it('passes model override to inference', async () => {
    _mockInferenceResponses = [
      { content: 'Done', model: 'openai/gpt-oss-120b', finishReason: 'stop' },
    ];

    const wf = await createWorkflow('Model Override Agent', 'Agent with custom model', [
      {
        id: 'agent',
        name: 'Custom Model',
        type: 'agent_turn',
        prompt: 'Do something',
        model: 'openai/gpt-oss-120b',
      },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool');
    await new Promise((r) => setTimeout(r, 200));

    expect(_mockInferenceCalls[0].model).toBe('openai/gpt-oss-120b');
  });

  it('respects maxTurns limit', async () => {
    // Set up infinite tool call loop
    _mockInferenceResponses = [
      { content: '', model: 'mock', toolCalls: [{ id: 'tc1', name: 'web.search', arguments: { q: '1' } }], finishReason: 'tool_calls' },
      { content: '', model: 'mock', toolCalls: [{ id: 'tc2', name: 'web.search', arguments: { q: '2' } }], finishReason: 'tool_calls' },
      // This would be the final response after maxTurns is reached
      { content: 'Forced stop after max turns', model: 'mock', finishReason: 'stop' },
    ];

    const wf = await createWorkflow('Limited Turns Agent', 'Agent with turn limit', [
      {
        id: 'agent',
        name: 'Limited',
        type: 'agent_turn',
        prompt: 'Keep searching',
        maxTurns: 2,
      },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool');
    await new Promise((r) => setTimeout(r, 300));

    const status = await getExecutionStatus(exec.id);
    expect(status!.status).toBe('completed');

    const agentStep = status!.steps.find((s) => s.stepId === 'agent');
    // maxTurns=2: turn 0 (tool call), turn 1 (last turn, forces final response)
    expect((agentStep!.output as any).turns).toBeLessThanOrEqual(2);
  });

  it('resolves template variables in agent_turn prompt', async () => {
    _mockInferenceResponses = [
      { content: 'Found info about topic X', model: 'mock', finishReason: 'stop' },
    ];

    const wf = await createWorkflow('Template Agent', 'Agent with templated prompt', [
      { id: 'setup', name: 'Setup', type: 'delay', durationMs: 10 },
      {
        id: 'agent',
        name: 'Researcher',
        type: 'agent_turn',
        prompt: 'Research this topic: {{variables.topic}}',
        dependsOn: ['setup'],
      },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool', { topic: 'quantum computing' });
    await new Promise((r) => setTimeout(r, 300));

    const status = await getExecutionStatus(exec.id);
    expect(status!.status).toBe('completed');

    // Verify the prompt was resolved with the variable
    const agentCall = _mockInferenceCalls.find((c) =>
      (c.messages as any[]).some((m: any) => m.content?.includes('quantum computing'))
    );
    expect(agentCall).toBeTruthy();
  });

  it('chains agent_turn output to downstream steps', async () => {
    _mockInferenceResponses = [
      { content: 'Agent found: important info', model: 'mock', finishReason: 'stop' },
      // For the llm_inference step that uses the agent output
      { content: 'Summary of agent findings', model: 'mock', finishReason: 'stop' },
    ];

    const wf = await createWorkflow('Chained Agent', 'Agent feeds into next step', [
      { id: 'agent', name: 'Research', type: 'agent_turn', prompt: 'Find information' },
      {
        id: 'summarize',
        name: 'Summarize',
        type: 'llm_inference',
        prompt: 'Summarize: {{steps.agent.output.response}}',
        dependsOn: ['agent'],
      },
    ]);

    const exec = await triggerWorkflow(wf.id, 'tool');
    await new Promise((r) => setTimeout(r, 400));

    const status = await getExecutionStatus(exec.id);
    expect(status!.status).toBe('completed');

    // Verify both steps completed
    expect(status!.steps.every((s) => s.status === 'completed')).toBe(true);

    // Verify the summarize step received the agent output
    const summarizeCall = _mockInferenceCalls.find((c) =>
      (c.messages as any[]).some((m: any) => m.content?.includes('Agent found: important info'))
    );
    expect(summarizeCall).toBeTruthy();
  });
});
