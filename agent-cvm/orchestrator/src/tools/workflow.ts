/**
 * Workflow tools — allow the LLM to create, list, execute, and monitor workflows.
 */

import { registerTool } from '../tool-registry.js';
import {
  createWorkflow,
  listWorkflows,
  triggerWorkflow,
  getExecutionStatus,
} from '../workflow-engine.js';
import type { WorkflowStep, WorkflowStatus } from '@luciaclaw/protocol';

export function registerWorkflowTools(): void {
  registerTool({
    name: 'workflow.create',
    description:
      'Create a new multi-step workflow (DAG). Steps can be tool_call, llm_inference, or delay. Steps run in dependency order with natural parallelism.',
    parameters: {
      type: 'object',
      required: ['name', 'description', 'steps'],
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'What this workflow does' },
        steps: {
          type: 'array',
          description: 'Array of workflow steps. Each step has id, name, type, and type-specific fields. Use dependsOn to set ordering.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique step ID' },
              name: { type: 'string', description: 'Step name' },
              type: { type: 'string', enum: ['tool_call', 'llm_inference', 'delay', 'agent_turn'] },
              toolName: { type: 'string', description: 'Tool to call (for tool_call type)' },
              arguments: { type: 'object', description: 'Tool arguments (for tool_call type). Supports {{steps.stepId.output.field}} templates.' },
              prompt: { type: 'string', description: 'LLM prompt (for llm_inference type). Supports templates.' },
              model: { type: 'string', description: 'Optional model override (for llm_inference type)' },
              durationMs: { type: 'number', description: 'Delay in ms (for delay type)' },
              allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool patterns for agent_turn (e.g. ["gmail.*", "web.search"]). Empty = all tools.' },
              maxTurns: { type: 'number', description: 'Max inference turns for agent_turn (default 5)' },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Step IDs this step depends on' },
              condition: { type: 'string', description: 'Condition expression — step skipped if falsy' },
              retryMax: { type: 'number', description: 'Max retry attempts (default 0)' },
              retryBackoffMs: { type: 'number', description: 'Backoff between retries in ms (default 1000)' },
            },
          },
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { name, description, steps } = args as {
        name: string;
        description: string;
        steps: WorkflowStep[];
      };
      const workflow = await createWorkflow(name, description, steps);
      return { created: true, id: workflow.id, name: workflow.name, stepCount: workflow.steps.length };
    },
  });

  registerTool({
    name: 'workflow.list',
    description: 'List available workflows. Optionally filter by status (active/archived).',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'archived'],
          description: 'Filter by workflow status',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { status } = args as { status?: WorkflowStatus };
      const workflows = await listWorkflows(status);
      return {
        workflows: workflows.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          status: w.status,
          stepCount: w.steps.length,
          createdAt: w.createdAt,
        })),
      };
    },
  });

  registerTool({
    name: 'workflow.execute',
    description:
      'Execute a workflow by ID. Workflows can chain multiple tool calls and LLM steps, so this action requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', description: 'ID of the workflow to execute' },
        variables: {
          type: 'object',
          description: 'Runtime variables injected into step templates via {{variables.key}}',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { workflowId, variables } = args as {
        workflowId: string;
        variables?: Record<string, unknown>;
      };
      const execution = await triggerWorkflow(workflowId, 'tool', variables);
      return {
        started: true,
        executionId: execution.id,
        workflowName: execution.workflowName,
        status: execution.status,
      };
    },
  });

  registerTool({
    name: 'workflow.get_status',
    description: 'Get the current status of a workflow execution, including per-step progress.',
    parameters: {
      type: 'object',
      required: ['executionId'],
      properties: {
        executionId: { type: 'string', description: 'ID of the execution to check' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { executionId } = args as { executionId: string };
      const execution = await getExecutionStatus(executionId);
      if (!execution) return { error: 'Execution not found' };
      return {
        executionId: execution.id,
        workflowName: execution.workflowName,
        status: execution.status,
        trigger: execution.trigger,
        steps: execution.steps.map((s) => ({
          stepId: s.stepId,
          name: s.name,
          type: s.type,
          status: s.status,
          attempts: s.attempts,
          error: s.error,
        })),
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        error: execution.error,
      };
    },
  });
}
