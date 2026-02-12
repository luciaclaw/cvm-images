/**
 * Workflow handler — processes workflow messages from PWA.
 *
 * Follows the schedule-handler.ts pattern: each handler calls the
 * workflow engine module and returns a workflow.response.
 */

import type {
  MessageEnvelope,
  WorkflowCreatePayload,
  WorkflowUpdatePayload,
  WorkflowDeletePayload,
  WorkflowListPayload,
  WorkflowExecutePayload,
} from '@luciaclaw/protocol';
import {
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listWorkflows,
  triggerWorkflow,
} from './workflow-engine.js';

export async function handleWorkflowCreate(
  payload: WorkflowCreatePayload
): Promise<MessageEnvelope> {
  try {
    await createWorkflow(payload.name, payload.description, payload.steps);
    const workflows = await listWorkflows();
    return {
      id: crypto.randomUUID(),
      type: 'workflow.response',
      timestamp: Date.now(),
      payload: { workflows },
    };
  } catch (err: any) {
    console.error('[workflow-handler] Create failed:', err);
    return {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      payload: { code: 8000, message: err.message || 'Failed to create workflow' },
    };
  }
}

export async function handleWorkflowUpdate(
  payload: WorkflowUpdatePayload
): Promise<MessageEnvelope> {
  try {
    const { workflowId, ...updates } = payload;
    const updated = await updateWorkflow(workflowId, updates);

    if (!updated) {
      return {
        id: crypto.randomUUID(),
        type: 'error',
        timestamp: Date.now(),
        payload: { code: 8001, message: `Workflow not found: ${workflowId}` },
      };
    }

    const workflows = await listWorkflows();
    return {
      id: crypto.randomUUID(),
      type: 'workflow.response',
      timestamp: Date.now(),
      payload: { workflows },
    };
  } catch (err: any) {
    console.error('[workflow-handler] Update failed:', err);
    return {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      payload: { code: 8000, message: err.message || 'Failed to update workflow' },
    };
  }
}

export async function handleWorkflowDelete(
  payload: WorkflowDeletePayload
): Promise<MessageEnvelope> {
  deleteWorkflow(payload.workflowId);
  const workflows = await listWorkflows();
  return {
    id: crypto.randomUUID(),
    type: 'workflow.response',
    timestamp: Date.now(),
    payload: { workflows },
  };
}

export async function handleWorkflowList(
  payload: WorkflowListPayload
): Promise<MessageEnvelope> {
  const workflows = await listWorkflows(payload.status);
  return {
    id: crypto.randomUUID(),
    type: 'workflow.response',
    timestamp: Date.now(),
    payload: { workflows },
  };
}

export async function handleWorkflowExecute(
  payload: WorkflowExecutePayload
): Promise<MessageEnvelope> {
  try {
    const execution = await triggerWorkflow(payload.workflowId, 'manual', payload.variables);
    return {
      id: crypto.randomUUID(),
      type: 'workflow.response',
      timestamp: Date.now(),
      payload: { execution },
    };
  } catch (err: any) {
    console.error('[workflow-handler] Execute failed:', err);
    return {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      payload: { code: 8000, message: err.message || 'Failed to execute workflow' },
    };
  }
}
