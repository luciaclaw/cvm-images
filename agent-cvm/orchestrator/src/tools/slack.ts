/**
 * Slack tool implementations — send messages, read channels, list channels.
 *
 * Uses Slack Web API REST. Bot token via OAuth 2.0.
 */

import { registerTool } from '../tool-registry.js';
import { getAccessToken } from '../oauth.js';

const SLACK_API = 'https://slack.com/api';

async function slackFetch(method: string, body?: Record<string, unknown>): Promise<any> {
  const token = await getAccessToken('slack');
  if (!token) throw new Error('Slack not connected. Please connect Slack in Settings.');

  const response = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json() as any;
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data;
}

export function registerSlackTools(): void {
  registerTool({
    name: 'slack.send',
    description: 'Send a message to a Slack channel. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['channel', 'text'],
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g., "#general") or channel ID' },
        text: { type: 'string', description: 'Message text' },
      },
    },
    requiredCredentials: ['slack'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { channel, text } = args as { channel: string; text: string };

      // If channel starts with #, strip it for the API
      const channelId = channel.startsWith('#') ? channel.slice(1) : channel;

      const data = await slackFetch('chat.postMessage', {
        channel: channelId,
        text,
      });

      return {
        ok: true,
        channel: data.channel,
        ts: data.ts,
        messageText: text,
      };
    },
  });

  registerTool({
    name: 'slack.read',
    description: 'Read recent messages from a Slack channel.',
    parameters: {
      type: 'object',
      required: ['channel'],
      properties: {
        channel: { type: 'string', description: 'Channel name or ID' },
        limit: { type: 'number', description: 'Number of messages to fetch (default: 10)' },
      },
    },
    requiredCredentials: ['slack'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { channel, limit = 10 } = args as { channel: string; limit?: number };
      const channelId = channel.startsWith('#') ? channel.slice(1) : channel;

      const data = await slackFetch('conversations.history', {
        channel: channelId,
        limit,
      });

      const messages = (data.messages || []).map((msg: any) => ({
        user: msg.user,
        text: msg.text,
        ts: msg.ts,
        type: msg.type,
      }));

      return { messages, channel: channelId };
    },
  });

  registerTool({
    name: 'slack.list_channels',
    description: 'List available Slack channels.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum channels to return (default: 20)' },
      },
    },
    requiredCredentials: ['slack'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { limit = 20 } = args as { limit?: number };

      const data = await slackFetch('conversations.list', {
        types: 'public_channel,private_channel',
        limit,
      });

      const channels = (data.channels || []).map((ch: any) => ({
        id: ch.id,
        name: ch.name,
        topic: ch.topic?.value,
        purpose: ch.purpose?.value,
        memberCount: ch.num_members,
        isPrivate: ch.is_private,
      }));

      return { channels };
    },
  });
}
