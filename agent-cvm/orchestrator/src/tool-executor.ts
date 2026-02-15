/**
 * Tool executor — orchestrates tool call lifecycle.
 *
 * Flow: policy check → confirmation request (if needed) → execute → return result
 */

import type { MessageEnvelope, ToolCallPayload } from '@luciaclaw/protocol';
import { evaluatePolicy } from './policy.js';
import { getTool } from './tool-registry.js';
import { waitForConfirmation } from './tools.js';
import { sendPushNotification } from './push.js';
import { getActiveSendFn } from './chat.js';

/** Callback to send messages to the connected client */
type SendFn = (msg: MessageEnvelope) => void;

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120_000; // 2 minutes

/** Execute a tool call with policy check and optional user confirmation */
export async function executeTool(
  toolCall: ToolCallPayload,
  sendToClient: SendFn
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const { callId, name, arguments: args } = toolCall;

  // 1. Policy check (deterministic, not LLM-based)
  const policy = evaluatePolicy(name, args);

  if (!policy.allowed) {
    return { success: false, error: policy.reason };
  }

  // 2. Request user confirmation if needed
  if (policy.requiresConfirmation) {
    // Auto-approve when no PWA client is connected (automated context:
    // cron jobs, workflows, Telegram listener, webhooks). The user
    // pre-approved by creating the automation.
    const hasClient = getActiveSendFn() !== null;

    if (hasClient) {
      const description = buildConfirmationDescription(name, args);

      // Send confirmation request to PWA
      sendToClient({
        id: crypto.randomUUID(),
        type: 'tool.confirm.request',
        timestamp: Date.now(),
        payload: {
          toolCall,
          description,
          risk: policy.risk,
          timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
        },
      });

      // Also send push notification for confirmation
      sendPushNotification(
        'Action Requires Approval',
        description,
        '/chat',
        [
          { action: 'approve', title: 'Approve' },
          { action: 'deny', title: 'Deny' },
        ]
      ).catch(() => {}); // Non-critical

      // Wait for user response
      const approved = await waitForConfirmation(callId, DEFAULT_CONFIRMATION_TIMEOUT_MS);

      if (!approved) {
        return { success: false, error: 'Tool call denied by user or timed out' };
      }
    } else {
      console.log(`[tool-executor] Auto-approving ${name} (no PWA client connected)`);
    }
  }

  // 3. Execute the tool
  const tool = getTool(name);
  if (!tool) {
    return { success: false, error: `Tool not found: ${name}` };
  }

  try {
    const result = await tool.execute(args);
    return { success: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[tool-executor] Tool ${name} failed:`, message);
    return { success: false, error: message };
  }
}

/** Build a human-readable description for the confirmation dialog */
function buildConfirmationDescription(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case 'gmail.send':
      return `Send email to ${args.to || 'unknown recipient'}${args.subject ? `: "${args.subject}"` : ''}`;
    case 'calendar.create':
      return `Create calendar event: "${args.summary || 'Untitled'}"${args.start ? ` at ${args.start}` : ''}`;
    case 'calendar.update':
      return `Update calendar event: "${args.summary || args.eventId || 'unknown'}"`;
    case 'calendar.delete':
      return `Delete calendar event: ${args.eventId || 'unknown'}`;
    case 'slack.send':
      return `Send Slack message to ${args.channel || 'unknown channel'}`;
    case 'telegram.send':
      return `Send Telegram message to ${args.chat_id || 'unknown chat'}`;
    case 'browser.click':
      return `Click "${args.target || 'element'}" on the current page`;
    case 'browser.type':
      return `Type text into "${args.selector || 'input'}" on the current page`;
    case 'github.create_issue':
      return `Create GitHub issue "${args.title || 'Untitled'}" in ${args.owner || '?'}/${args.repo || '?'}`;
    case 'github.comment':
      return `Comment on ${args.owner || '?'}/${args.repo || '?'}#${args.issue_number || '?'}`;
    case 'github.trigger_workflow':
      return `Trigger workflow "${args.workflow_id || '?'}" on ${args.owner || '?'}/${args.repo || '?'} (ref: ${args.ref || '?'})`;
    case 'discord.send':
      return `Send Discord message to channel ${args.channel_id || 'unknown'}`;
    case 'whatsapp.send':
      return `Send WhatsApp message to ${args.to || 'unknown'}`;
    case 'whatsapp.send_template':
      return `Send WhatsApp template "${args.template_name || 'unknown'}" to ${args.to || 'unknown'}`;
    case 'whatsapp.send_media':
      return `Send WhatsApp ${args.media_type || 'media'} to ${args.to || 'unknown'}`;
    case 'workflow.execute':
      return `Execute workflow "${args.workflowId || 'unknown'}" (multi-step automation)`;
    default:
      return `Execute ${toolName} with ${Object.keys(args).length} arguments`;
  }
}
