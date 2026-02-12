/**
 * Workflow engine — DAG-based multi-step execution.
 *
 * Reuses executeTool() for tool calls, callInference() for LLM steps,
 * and encrypt()/decrypt() from storage.ts for encrypted persistence.
 */

import type {
  WorkflowStep,
  WorkflowInfo,
  WorkflowExecutionInfo,
  WorkflowStepExecutionInfo,
  WorkflowStatus,
  WorkflowTrigger,
  WorkflowStepStatus,
  MessageEnvelope,
} from '@luciaclaw/protocol';
import { getDb, encrypt, decrypt } from './storage.js';
import { executeTool } from './tool-executor.js';
import { callInference } from './inference.js';
import { getActiveSendFn } from './chat.js';
import { sendPushNotification } from './push.js';

// ─── DAG Validation ────────────────────────────────────────────────

export function validateDAG(steps: WorkflowStep[]): string | null {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) return `Duplicate step ID: ${step.id}`;
    ids.add(step.id);
  }

  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) return `Step "${step.id}" depends on unknown step "${dep}"`;
      }
    }
  }

  // Topological sort via Kahn's algorithm to detect cycles
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const step of steps) {
    inDegree.set(step.id, 0);
    adj.set(step.id, []);
  }
  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        adj.get(dep)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(node) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited !== steps.length) return 'Circular dependency detected in workflow steps';

  return null;
}

// ─── Template Resolution ───────────────────────────────────────────

interface ExecutionContext {
  steps: Record<string, { output?: unknown; status?: string }>;
  variables: Record<string, unknown>;
}

function resolveDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveTemplate(value: unknown, context: ExecutionContext): unknown {
  if (typeof value === 'string') {
    // Check if the entire string is a single template expression
    const singleMatch = value.match(/^\{\{(.+?)\}\}$/);
    if (singleMatch) {
      return resolveDotPath(context, singleMatch[1].trim());
    }
    // Replace embedded templates in strings
    return value.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
      const resolved = resolveDotPath(context, path.trim());
      return resolved === undefined ? '' : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveTemplate(v, context);
    }
    return result;
  }
  return value;
}

// ─── Condition Evaluation ──────────────────────────────────────────

type Token =
  | { type: 'value'; value: unknown }
  | { type: 'op'; value: string }
  | { type: 'not' }
  | { type: 'lparen' }
  | { type: 'rparen' };

function tokenize(expr: string, context: ExecutionContext): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue; }

    // Parentheses
    if (expr[i] === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (expr[i] === ')') { tokens.push({ type: 'rparen' }); i++; continue; }

    // Two-char operators
    const twoChar = expr.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(twoChar)) {
      tokens.push({ type: 'op', value: twoChar }); i += 2; continue;
    }

    // Single-char operators
    if (expr[i] === '>' || expr[i] === '<') {
      tokens.push({ type: 'op', value: expr[i] }); i++; continue;
    }

    // Not operator
    if (expr[i] === '!') { tokens.push({ type: 'not' }); i++; continue; }

    // String literals
    if (expr[i] === "'" || expr[i] === '"') {
      const quote = expr[i];
      let str = '';
      i++;
      while (i < expr.length && expr[i] !== quote) { str += expr[i]; i++; }
      i++; // skip closing quote
      tokens.push({ type: 'value', value: str });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(expr[i]) || (expr[i] === '-' && i + 1 < expr.length && /[0-9]/.test(expr[i + 1]))) {
      let num = '';
      if (expr[i] === '-') { num += '-'; i++; }
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: 'value', value: parseFloat(num) });
      continue;
    }

    // Keywords and dot-path identifiers
    let ident = '';
    while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) { ident += expr[i]; i++; }

    if (ident === 'true') tokens.push({ type: 'value', value: true });
    else if (ident === 'false') tokens.push({ type: 'value', value: false });
    else if (ident === 'null') tokens.push({ type: 'value', value: null });
    else if (ident.length > 0) tokens.push({ type: 'value', value: resolveDotPath(context, ident) });
    else i++; // skip unknown char
  }

  return tokens;
}

function evalTokens(tokens: Token[], pos: { i: number }): unknown {
  let left = evalUnary(tokens, pos);

  while (pos.i < tokens.length) {
    const tok = tokens[pos.i];
    if (tok.type !== 'op') break;

    const op = tok.value;
    if (op === '||') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = (left as boolean) || (right as boolean);
    } else if (op === '&&') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = (left as boolean) && (right as boolean);
    } else if (op === '==') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = left == right;
    } else if (op === '!=') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = left != right;
    } else if (op === '>') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = (left as number) > (right as number);
    } else if (op === '<') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = (left as number) < (right as number);
    } else if (op === '>=') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = (left as number) >= (right as number);
    } else if (op === '<=') {
      pos.i++;
      const right = evalUnary(tokens, pos);
      left = (left as number) <= (right as number);
    } else {
      break;
    }
  }

  return left;
}

function evalUnary(tokens: Token[], pos: { i: number }): unknown {
  if (pos.i < tokens.length && tokens[pos.i].type === 'not') {
    pos.i++;
    return !evalUnary(tokens, pos);
  }
  return evalPrimary(tokens, pos);
}

function evalPrimary(tokens: Token[], pos: { i: number }): unknown {
  if (pos.i >= tokens.length) return undefined;

  const tok = tokens[pos.i];
  if (tok.type === 'lparen') {
    pos.i++;
    const val = evalTokens(tokens, pos);
    if (pos.i < tokens.length && tokens[pos.i].type === 'rparen') pos.i++;
    return val;
  }
  if (tok.type === 'value') {
    pos.i++;
    return tok.value;
  }
  pos.i++;
  return undefined;
}

export function evaluateCondition(expr: string, context: ExecutionContext): boolean {
  try {
    const tokens = tokenize(expr, context);
    if (tokens.length === 0) return true;
    const result = evalTokens(tokens, { i: 0 });
    return !!result;
  } catch {
    return false;
  }
}

// ─── CRUD ──────────────────────────────────────────────────────────

export async function createWorkflow(
  name: string,
  description: string,
  steps: WorkflowStep[],
): Promise<WorkflowInfo> {
  const error = validateDAG(steps);
  if (error) throw new Error(error);

  const id = crypto.randomUUID();
  const now = Date.now();
  const nameEnc = await encrypt(name);
  const descEnc = await encrypt(description);
  const defEnc = await encrypt(JSON.stringify(steps));

  getDb().prepare(
    `INSERT INTO workflows (id, name_enc, description_enc, definition_enc, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, nameEnc, descEnc, defEnc, now, now);

  return { id, name, description, steps, status: 'active', createdAt: now, updatedAt: now };
}

export async function updateWorkflow(
  id: string,
  updates: { name?: string; description?: string; steps?: WorkflowStep[]; status?: WorkflowStatus },
): Promise<WorkflowInfo | null> {
  const existing = await getWorkflowById(id);
  if (!existing) return null;

  if (updates.steps) {
    const error = validateDAG(updates.steps);
    if (error) throw new Error(error);
  }

  const name = updates.name ?? existing.name;
  const description = updates.description ?? existing.description;
  const steps = updates.steps ?? existing.steps;
  const status = updates.status ?? existing.status;
  const now = Date.now();

  const nameEnc = await encrypt(name);
  const descEnc = await encrypt(description);
  const defEnc = await encrypt(JSON.stringify(steps));

  getDb().prepare(
    `UPDATE workflows SET name_enc = ?, description_enc = ?, definition_enc = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(nameEnc, descEnc, defEnc, status, now, id);

  return { id, name, description, steps, status, createdAt: existing.createdAt, updatedAt: now };
}

export function deleteWorkflow(id: string): void {
  getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id);
}

export async function listWorkflows(status?: WorkflowStatus): Promise<WorkflowInfo[]> {
  const rows = status
    ? getDb().prepare('SELECT * FROM workflows WHERE status = ? ORDER BY updated_at DESC').all(status) as any[]
    : getDb().prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as any[];

  const results: WorkflowInfo[] = [];
  for (const row of rows) {
    results.push({
      id: row.id,
      name: await decrypt(row.name_enc),
      description: await decrypt(row.description_enc),
      steps: JSON.parse(await decrypt(row.definition_enc)),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return results;
}

export async function getWorkflowById(id: string): Promise<WorkflowInfo | null> {
  const row = getDb().prepare('SELECT * FROM workflows WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: await decrypt(row.name_enc),
    description: await decrypt(row.description_enc),
    steps: JSON.parse(await decrypt(row.definition_enc)),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Execution Engine ──────────────────────────────────────────────

export async function triggerWorkflow(
  workflowId: string,
  trigger: WorkflowTrigger,
  variables?: Record<string, unknown>,
): Promise<WorkflowExecutionInfo> {
  const workflow = await getWorkflowById(workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  if (workflow.status !== 'active') throw new Error(`Workflow is ${workflow.status}, cannot execute`);

  const executionId = crypto.randomUUID();
  const now = Date.now();

  const contextEnc = await encrypt(JSON.stringify({ variables: variables || {} }));

  getDb().prepare(
    `INSERT INTO workflow_executions (id, workflow_id, status, context_enc, trigger, started_at)
     VALUES (?, ?, 'running', ?, ?, ?)`
  ).run(executionId, workflowId, contextEnc, trigger, now);

  // Create step execution rows
  const insertStep = getDb().prepare(
    `INSERT INTO workflow_step_executions (id, execution_id, step_id, status, attempts)
     VALUES (?, ?, ?, 'pending', 0)`
  );
  for (const step of workflow.steps) {
    insertStep.run(crypto.randomUUID(), executionId, step.id);
  }

  // Fire-and-forget execution
  runExecution(executionId).catch((err) => {
    console.error(`[workflow] Execution ${executionId} failed:`, err);
  });

  return buildExecutionInfo(executionId, workflow);
}

async function runExecution(executionId: string): Promise<void> {
  const exec = getDb().prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId) as any;
  if (!exec || exec.status !== 'running') return;

  const workflow = await getWorkflowById(exec.workflow_id);
  if (!workflow) return;

  const contextData = JSON.parse(await decrypt(exec.context_enc));
  const context: ExecutionContext = {
    steps: {},
    variables: contextData.variables || {},
  };

  // Load any already-completed step outputs (for recovery)
  const stepRows = getDb().prepare(
    'SELECT * FROM workflow_step_executions WHERE execution_id = ?'
  ).all(executionId) as any[];

  for (const sr of stepRows) {
    if (sr.status === 'completed' && sr.output_enc) {
      context.steps[sr.step_id] = {
        output: JSON.parse(await decrypt(sr.output_enc)),
        status: sr.status,
      };
    } else {
      context.steps[sr.step_id] = { status: sr.status };
    }
  }

  const stepMap = new Map<string, WorkflowStep>();
  for (const step of workflow.steps) {
    stepMap.set(step.id, step);
  }

  let hasFailure = false;

  // DAG execution loop
  while (true) {
    // Refresh step statuses
    const currentSteps = getDb().prepare(
      'SELECT step_id, status FROM workflow_step_executions WHERE execution_id = ?'
    ).all(executionId) as any[];

    const statusMap = new Map<string, string>();
    for (const cs of currentSteps) {
      statusMap.set(cs.step_id, cs.status);
    }

    // Find ready steps: pending AND all dependsOn completed/skipped
    const readySteps: WorkflowStep[] = [];
    let hasPending = false;

    for (const step of workflow.steps) {
      const status = statusMap.get(step.id);
      if (status !== 'pending') continue;
      hasPending = true;

      const depsReady = !step.dependsOn || step.dependsOn.every((dep) => {
        const depStatus = statusMap.get(dep);
        return depStatus === 'completed' || depStatus === 'skipped';
      });

      // If a dependency failed, skip this step
      const depFailed = step.dependsOn?.some((dep) => statusMap.get(dep) === 'failed');
      if (depFailed) {
        getDb().prepare(
          'UPDATE workflow_step_executions SET status = ? WHERE execution_id = ? AND step_id = ?'
        ).run('skipped', executionId, step.id);
        context.steps[step.id] = { status: 'skipped' };
        continue;
      }

      if (depsReady) readySteps.push(step);
    }

    if (readySteps.length === 0) {
      // No more ready steps
      if (!hasPending) break; // All done
      // Still have pending but nothing ready — means blocked by failures
      break;
    }

    // Evaluate conditions and execute ready steps in parallel
    const execPromises: Promise<void>[] = [];
    for (const step of readySteps) {
      if (step.condition) {
        const condResult = evaluateCondition(step.condition, context);
        if (!condResult) {
          getDb().prepare(
            'UPDATE workflow_step_executions SET status = ? WHERE execution_id = ? AND step_id = ?'
          ).run('skipped', executionId, step.id);
          context.steps[step.id] = { status: 'skipped' };
          await pushExecutionStatus(executionId, workflow);
          continue;
        }
      }

      execPromises.push(
        runStep(executionId, step, context).then(async (result) => {
          if (result.status === 'failed') hasFailure = true;
          context.steps[step.id] = { output: result.output, status: result.status };
          await pushExecutionStatus(executionId, workflow);
        })
      );
    }

    await Promise.all(execPromises);

    // Stop on first failure
    if (hasFailure) break;
  }

  // Finalize execution
  const finalSteps = getDb().prepare(
    'SELECT status FROM workflow_step_executions WHERE execution_id = ?'
  ).all(executionId) as any[];

  const allCompleted = finalSteps.every((s: any) => s.status === 'completed' || s.status === 'skipped');
  const anyFailed = finalSteps.some((s: any) => s.status === 'failed');

  const finalStatus = anyFailed ? 'failed' : allCompleted ? 'completed' : 'failed';
  const now = Date.now();

  getDb().prepare(
    'UPDATE workflow_executions SET status = ?, completed_at = ?, error = ? WHERE id = ?'
  ).run(finalStatus, now, anyFailed ? 'One or more steps failed' : null, executionId);

  await pushExecutionStatus(executionId, workflow);

  // Push notification
  sendPushNotification(
    `Workflow ${finalStatus === 'completed' ? 'completed' : 'failed'}`,
    `"${workflow.name}" ${finalStatus === 'completed' ? 'finished successfully' : 'encountered errors'}`,
    '/workflows',
  ).catch(() => {});
}

interface StepResult {
  status: WorkflowStepStatus;
  output?: unknown;
  error?: string;
}

async function runStep(
  executionId: string,
  step: WorkflowStep,
  context: ExecutionContext,
): Promise<StepResult> {
  const maxRetries = step.retryMax || 0;
  const backoffMs = step.retryBackoffMs || 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Mark as running
    getDb().prepare(
      `UPDATE workflow_step_executions SET status = 'running', attempts = ?, started_at = COALESCE(started_at, ?)
       WHERE execution_id = ? AND step_id = ?`
    ).run(attempt + 1, Date.now(), executionId, step.id);

    try {
      let output: unknown;

      if (step.type === 'tool_call') {
        const resolvedArgs = resolveTemplate(step.arguments, context) as Record<string, unknown>;
        const sendFn = getActiveSendFn() || (() => {});
        const result = await executeTool(
          { callId: crypto.randomUUID(), name: step.toolName, arguments: resolvedArgs },
          sendFn,
        );
        if (!result.success) throw new Error(result.error || 'Tool call failed');
        output = result.result;
      } else if (step.type === 'llm_inference') {
        const resolvedPrompt = resolveTemplate(step.prompt, context) as string;
        const result = await callInference(
          [
            { role: 'system', content: 'You are Lucia, executing a workflow step. Respond concisely.' },
            { role: 'user', content: resolvedPrompt },
          ],
          step.model,
        );
        output = result.content;
      } else if (step.type === 'delay') {
        await new Promise((r) => setTimeout(r, step.durationMs));
        output = { delayed: step.durationMs };
      }

      // Success — persist
      const outputEnc = await encrypt(JSON.stringify(output));
      getDb().prepare(
        `UPDATE workflow_step_executions SET status = 'completed', output_enc = ?, completed_at = ?
         WHERE execution_id = ? AND step_id = ?`
      ).run(outputEnc, Date.now(), executionId, step.id);

      return { status: 'completed', output };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[workflow] Step "${step.id}" attempt ${attempt + 1} failed:`, errorMsg);

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }

      // Final failure
      getDb().prepare(
        `UPDATE workflow_step_executions SET status = 'failed', error = ?, completed_at = ?
         WHERE execution_id = ? AND step_id = ?`
      ).run(errorMsg, Date.now(), executionId, step.id);

      return { status: 'failed', error: errorMsg };
    }
  }

  return { status: 'failed', error: 'Exhausted retries' };
}

// ─── Status Push ───────────────────────────────────────────────────

async function buildExecutionInfo(
  executionId: string,
  workflow: WorkflowInfo,
): Promise<WorkflowExecutionInfo> {
  const exec = getDb().prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId) as any;
  const stepRows = getDb().prepare(
    'SELECT * FROM workflow_step_executions WHERE execution_id = ? ORDER BY started_at ASC NULLS LAST'
  ).all(executionId) as any[];

  const stepMap = new Map<string, WorkflowStep>();
  for (const s of workflow.steps) stepMap.set(s.id, s);

  const steps: WorkflowStepExecutionInfo[] = [];
  for (const sr of stepRows) {
    const def = stepMap.get(sr.step_id);
    const info: WorkflowStepExecutionInfo = {
      stepId: sr.step_id,
      name: def?.name || sr.step_id,
      type: def?.type || 'tool_call',
      status: sr.status,
      attempts: sr.attempts,
    };
    if (sr.output_enc) {
      try { info.output = JSON.parse(await decrypt(sr.output_enc)); } catch {}
    }
    if (sr.error) info.error = sr.error;
    if (sr.started_at) info.startedAt = sr.started_at;
    if (sr.completed_at) info.completedAt = sr.completed_at;
    steps.push(info);
  }

  return {
    id: exec.id,
    workflowId: exec.workflow_id,
    workflowName: workflow.name,
    status: exec.status,
    trigger: exec.trigger,
    steps,
    startedAt: exec.started_at || undefined,
    completedAt: exec.completed_at || undefined,
    error: exec.error || undefined,
  };
}

async function pushExecutionStatus(executionId: string, workflow: WorkflowInfo): Promise<void> {
  const sendFn = getActiveSendFn();
  if (!sendFn) return;

  const execution = await buildExecutionInfo(executionId, workflow);
  sendFn({
    id: crypto.randomUUID(),
    type: 'workflow.status',
    timestamp: Date.now(),
    payload: { execution },
  });
}

// ─── Recovery ──────────────────────────────────────────────────────

export async function recoverRunningExecutions(): Promise<void> {
  const running = getDb().prepare(
    "SELECT id, workflow_id FROM workflow_executions WHERE status = 'running'"
  ).all() as any[];

  if (running.length === 0) return;
  console.log(`[workflow] Recovering ${running.length} running execution(s)...`);

  for (const exec of running) {
    runExecution(exec.id).catch((err) => {
      console.error(`[workflow] Recovery of ${exec.id} failed:`, err);
    });
  }
}

// ─── Execution Status Query ────────────────────────────────────────

export async function getExecutionStatus(executionId: string): Promise<WorkflowExecutionInfo | null> {
  const exec = getDb().prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId) as any;
  if (!exec) return null;

  const workflow = await getWorkflowById(exec.workflow_id);
  if (!workflow) return null;

  return buildExecutionInfo(executionId, workflow);
}
