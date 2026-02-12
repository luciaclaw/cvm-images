/**
 * Telegram tool implementations — send messages, read updates, get chat info.
 *
 * Uses Telegram Bot API REST. Bot token via api_key credential (not OAuth).
 */

import { registerTool } from '../tool-registry.js';
import { getServiceCredential } from '../vault.js';

const TELEGRAM_API = 'https://api.telegram.org';

async function telegramFetch(method: string, body?: Record<string, unknown>): Promise<any> {
  const token = await getServiceCredential('telegram');
  if (!token) throw new Error('Telegram not connected. Please add your bot token in Settings.');

  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json() as any;
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
  }

  return data;
}

export function registerTelegramTools(): void {
  registerTool({
    name: 'telegram.send',
    description: 'Send a message via Telegram Bot. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['chat_id', 'text'],
      properties: {
        chat_id: { type: 'string', description: 'Chat ID or @channel username' },
        text: { type: 'string', description: 'Message text' },
        parse_mode: { type: 'string', description: 'Optional: "Markdown" or "HTML"' },
      },
    },
    requiredCredentials: ['telegram'],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { chat_id, text, parse_mode } = args as {
        chat_id: string;
        text: string;
        parse_mode?: string;
      };

      const body: Record<string, unknown> = { chat_id, text };
      if (parse_mode) body.parse_mode = parse_mode;

      const data = await telegramFetch('sendMessage', body);

      return {
        ok: true,
        message_id: data.result.message_id,
        chat: data.result.chat,
        date: data.result.date,
      };
    },
  });

  registerTool({
    name: 'telegram.read',
    description: 'Read recent incoming messages/updates from the Telegram bot.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of updates to fetch (1-100, default: 10)' },
        offset: { type: 'number', description: 'Update offset for pagination' },
      },
    },
    requiredCredentials: ['telegram'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { limit = 10, offset } = args as { limit?: number; offset?: number };

      const body: Record<string, unknown> = { limit, timeout: 0 };
      if (offset !== undefined) body.offset = offset;

      const data = await telegramFetch('getUpdates', body);

      const messages = (data.result || []).map((update: any) => ({
        update_id: update.update_id,
        from: update.message?.from,
        chat: update.message?.chat,
        text: update.message?.text,
        date: update.message?.date,
      }));

      return { messages };
    },
  });

  registerTool({
    name: 'telegram.get_chat',
    description: 'Get information about a Telegram chat (group, channel, or user).',
    parameters: {
      type: 'object',
      required: ['chat_id'],
      properties: {
        chat_id: { type: 'string', description: 'Chat ID or @channel username' },
      },
    },
    requiredCredentials: ['telegram'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { chat_id } = args as { chat_id: string };

      const chatData = await telegramFetch('getChat', { chat_id });

      let memberCount: number | undefined;
      try {
        const countData = await telegramFetch('getChatMemberCount', { chat_id });
        memberCount = countData.result;
      } catch {
        // getChatMemberCount may fail for some chat types — graceful fallback
      }

      return {
        id: chatData.result.id,
        type: chatData.result.type,
        title: chatData.result.title,
        username: chatData.result.username,
        firstName: chatData.result.first_name,
        lastName: chatData.result.last_name,
        description: chatData.result.description,
        memberCount,
      };
    },
  });
}

export const _testExports = { telegramFetch };
