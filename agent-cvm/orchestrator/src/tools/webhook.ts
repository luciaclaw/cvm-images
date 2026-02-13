/**
 * Webhook management tools — let the LLM create and manage webhook receivers.
 */

import { registerTool } from '../tool-registry.js';
import { createWebhook, listWebhooks, deleteWebhook } from '../webhook.js';

export function registerWebhookTools(): void {
  registerTool({
    name: 'webhook.create',
    description:
      'Create an inbound webhook endpoint to receive events from external services. ' +
      'Returns the webhook URL path and secret for configuring the sender. ' +
      'Supported sources: github, whatsapp, telegram, stripe, generic.',
    parameters: {
      type: 'object',
      required: ['name', 'source'],
      properties: {
        name: { type: 'string', description: 'Human-readable name (e.g. "My Repo Pushes")' },
        source: {
          type: 'string',
          enum: ['github', 'whatsapp', 'telegram', 'stripe', 'generic'],
          description: 'Event source type (determines signature verification method)',
        },
        secret: { type: 'string', description: 'Custom webhook secret (auto-generated if omitted)' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { name, source, secret } = args as {
        name: string;
        source: string;
        secret?: string;
      };

      const webhook = await createWebhook(name, source, secret);
      return {
        id: webhook.id,
        name: webhook.name,
        source: webhook.source,
        path: webhook.path,
        note: 'Configure the sender to POST events to this path. Include the webhook secret for signature verification.',
      };
    },
  });

  registerTool({
    name: 'webhook.list',
    description: 'List all configured inbound webhooks with their status and trigger counts.',
    parameters: {
      type: 'object',
      properties: {},
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute() {
      const webhooks = await listWebhooks();
      return {
        webhooks: webhooks.map((wh) => ({
          id: wh.id,
          name: wh.name,
          source: wh.source,
          active: wh.active,
          path: wh.path,
          triggerCount: wh.triggerCount,
          lastTriggeredAt: wh.lastTriggeredAt
            ? new Date(wh.lastTriggeredAt).toISOString()
            : null,
        })),
      };
    },
  });

  registerTool({
    name: 'webhook.delete',
    description: 'Delete a webhook endpoint by ID. Events will no longer be received.',
    parameters: {
      type: 'object',
      required: ['webhookId'],
      properties: {
        webhookId: { type: 'string', description: 'ID of the webhook to delete' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'medium',
    requiresConfirmation: false,
    async execute(args) {
      const { webhookId } = args as { webhookId: string };
      const deleted = deleteWebhook(webhookId);
      return { deleted, webhookId };
    },
  });
}
