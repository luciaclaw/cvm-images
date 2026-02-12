/**
 * Discord tool implementations — send/read messages, list channels/guilds.
 *
 * Uses Discord REST API v10. Bot token via api_key credential (not OAuth).
 */

import { registerTool } from '../tool-registry.js';
import { getServiceCredential } from '../vault.js';

const DISCORD_API = 'https://discord.com/api/v10';

async function discordFetch(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const token = await getServiceCredential('discord');
  if (!token) throw new Error('Discord not connected. Please add your bot token in Settings.');

  const response = await fetch(`${DISCORD_API}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bot ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  const data = await response.json() as any;
  if (!response.ok) {
    throw new Error(`Discord API error (${response.status}): ${data.message || 'Unknown error'}`);
  }

  return data;
}

export function registerDiscordTools(): void {
  registerTool({
    name: 'discord.send',
    description: 'Send a message to a Discord channel. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['channel_id', 'content'],
      properties: {
        channel_id: { type: 'string', description: 'Discord channel ID' },
        content: { type: 'string', description: 'Message content (max 2000 characters)' },
      },
    },
    requiredCredentials: ['discord'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { channel_id, content } = args as { channel_id: string; content: string };

      if (content.length > 2000) {
        throw new Error('Message content exceeds Discord 2000 character limit');
      }

      const data = await discordFetch(`/channels/${channel_id}/messages`, {
        method: 'POST',
        body: { content },
      });

      return {
        id: data.id,
        channel_id: data.channel_id,
        content: data.content,
        timestamp: data.timestamp,
      };
    },
  });

  registerTool({
    name: 'discord.read',
    description: 'Read recent messages from a Discord channel.',
    parameters: {
      type: 'object',
      required: ['channel_id'],
      properties: {
        channel_id: { type: 'string', description: 'Discord channel ID' },
        limit: { type: 'number', description: 'Number of messages to fetch (1-100, default: 10)' },
      },
    },
    requiredCredentials: ['discord'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { channel_id, limit = 10 } = args as { channel_id: string; limit?: number };

      const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
      const data = await discordFetch(`/channels/${channel_id}/messages?${params}`);

      return {
        messages: (data as any[]).map((msg: any) => ({
          id: msg.id,
          author: msg.author?.username,
          content: msg.content,
          timestamp: msg.timestamp,
        })),
      };
    },
  });

  registerTool({
    name: 'discord.list_channels',
    description: 'List text channels in a Discord guild (server).',
    parameters: {
      type: 'object',
      required: ['guild_id'],
      properties: {
        guild_id: { type: 'string', description: 'Discord guild (server) ID' },
      },
    },
    requiredCredentials: ['discord'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { guild_id } = args as { guild_id: string };

      const data = await discordFetch(`/guilds/${guild_id}/channels`);

      // Filter to text-like channel types: 0=text, 5=announcement, 15=forum
      const textTypes = new Set([0, 5, 15]);
      const channels = (data as any[])
        .filter((ch: any) => textTypes.has(ch.type))
        .map((ch: any) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          topic: ch.topic,
          position: ch.position,
          parent_id: ch.parent_id,
        }));

      return { channels };
    },
  });

  registerTool({
    name: 'discord.list_guilds',
    description: 'List Discord guilds (servers) the bot is a member of.',
    parameters: {
      type: 'object',
      properties: {},
    },
    requiredCredentials: ['discord'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute() {
      const data = await discordFetch('/users/@me/guilds');

      return {
        guilds: (data as any[]).map((guild: any) => ({
          id: guild.id,
          name: guild.name,
          icon: guild.icon,
          owner: guild.owner,
          permissions: guild.permissions,
        })),
      };
    },
  });
}
