/**
 * Telegram Bot webhook listener — receives incoming messages and sends responses.
 *
 * Registers a webhook with Telegram's Bot API so that incoming messages are
 * POSTed to /telegram/webhook. Each update is verified via secret_token header,
 * routed through the session router (DM vs group), processed by the chat
 * pipeline, and the LLM response is sent back to the Telegram chat.
 */

import type { Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { getServiceCredential } from './vault.js';
import { handleChatMessage, getActiveSendFn } from './chat.js';
import { handleChatCommand } from './chat-commands.js';
import { resolveSession, telegramSessionType } from './session-router.js';
import { downloadTelegramFile } from './tools/voice.js';
import { callTranscription } from './inference.js';

const TELEGRAM_API = 'https://api.telegram.org';

/** Secret token for verifying incoming webhook requests from Telegram */
let webhookSecretToken: string | null = null;

/**
 * Create the Express router for the Telegram webhook endpoint.
 */
export function createTelegramRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  router.post('/webhook', async (req, res) => {
    // Verify secret token header
    const headerToken = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
    if (!webhookSecretToken || headerToken !== webhookSecretToken) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Respond 200 immediately — Telegram requires fast acknowledgement
    res.status(200).json({ ok: true });

    const update = req.body;

    const message = update?.message;
    if (!message) return;

    const chatId = String(message.chat.id);
    const chatType = message.chat.type as string; // 'private', 'group', 'supergroup', 'channel'
    const senderName = message.from?.first_name || 'Unknown';
    const chatTitle = message.chat.title || `${senderName} (DM)`;

    // Resolve message content: text or voice transcription
    let text: string | undefined;

    if (message.text) {
      text = message.text as string;
    } else if (message.voice || message.audio || message.video_note) {
      // Voice message, audio file, or video note — transcribe via STT
      const fileId = (message.voice?.file_id || message.audio?.file_id || message.video_note?.file_id) as string;
      try {
        console.log(`[telegram] Transcribing voice message from ${senderName} (file_id: ${fileId})`);
        const { base64, filename } = await downloadTelegramFile(fileId);
        const result = await callTranscription(base64, filename);
        text = result.text;
        if (!text?.trim()) {
          console.log('[telegram] Transcription returned empty text — ignoring');
          return;
        }
        console.log(`[telegram] Transcribed ${result.duration ?? '?'}s voice message (${result.language ?? 'auto'}): "${text.slice(0, 80)}..."`);
      } catch (err) {
        console.error('[telegram] Voice transcription failed:', err instanceof Error ? err.message : err);
        // Notify user of the failure
        const token = await getServiceCredential('telegram');
        if (token) {
          await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: 'Sorry, I couldn\'t process that voice message. Please try again or send it as text.',
              reply_to_message_id: message.message_id,
            }),
          });
        }
        return;
      }
    } else {
      console.log(`[telegram] Ignoring unsupported message type (${message.sticker ? 'sticker' : message.photo ? 'photo' : 'other'})`);
      return;
    }

    try {
      // Intercept slash commands — respond directly, skip chat pipeline
      const commandResult = await handleChatCommand(text);
      if (commandResult) {
        const token = await getServiceCredential('telegram');
        if (token) {
          await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: commandResult.response,
            }),
          });
        }
        console.log(`[telegram] Handled command "${text.trim()}" from ${senderName}`);
        return;
      }

      // Route to correct session
      const sessionType = telegramSessionType(chatType);
      const conversationId = await resolveSession('telegram', chatId, sessionType, chatTitle);

      // Process through the chat pipeline
      const responseEnvelope = await handleChatMessage(
        crypto.randomUUID(),
        { content: text, conversationId },
      );

      // Extract response text
      const responseText = (responseEnvelope.payload as any)?.content;
      if (!responseText) return;

      // Send response back to Telegram
      const token = await getServiceCredential('telegram');
      if (!token) {
        console.error('[telegram] Cannot send reply — no bot token available');
        return;
      }

      await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: responseText,
        }),
      });

      // Forward to PWA if connected
      const sendFn = getActiveSendFn();
      if (sendFn) {
        // Notify PWA of the inbound Telegram message
        sendFn({
          id: crypto.randomUUID(),
          type: 'chat.event' as any,
          timestamp: Date.now(),
          payload: {
            source: 'telegram',
            chatId,
            chatType,
            senderName,
            content: text,
            response: responseText,
            conversationId,
          },
        });
      }

      console.log(`[telegram] Processed message from ${senderName} in ${chatType} chat ${chatId}`);
    } catch (err) {
      console.error('[telegram] Error processing incoming message:', err instanceof Error ? err.message : err);
    }
  });

  return router;
}

/**
 * Register the webhook URL with Telegram's Bot API.
 */
export async function setupTelegramWebhook(): Promise<void> {
  const token = await getServiceCredential('telegram');
  if (!token) {
    console.log('[telegram] No bot token configured — skipping webhook setup');
    return;
  }

  const publicUrl = process.env.CVM_PUBLIC_URL;
  if (!publicUrl) {
    console.warn('[telegram] CVM_PUBLIC_URL not set — cannot register webhook. Set this env var to enable Telegram webhook.');
    return;
  }

  // Generate a random secret for verifying incoming updates
  webhookSecretToken = crypto.randomBytes(32).toString('hex');

  const webhookUrl = `${publicUrl.replace(/\/$/, '')}/telegram/webhook`;

  try {
    const resp = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecretToken,
        allowed_updates: ['message'],
      }),
    });

    const data = await resp.json() as any;
    if (data.ok) {
      console.log(`[telegram] Webhook registered at ${webhookUrl}`);
    } else {
      console.error(`[telegram] Webhook registration failed: ${data.description || 'Unknown error'}`);
    }
  } catch (err) {
    console.error('[telegram] Failed to register webhook:', err instanceof Error ? err.message : err);
  }
}

/**
 * Remove the webhook from Telegram's Bot API.
 */
export async function removeTelegramWebhook(): Promise<void> {
  const token = await getServiceCredential('telegram');
  if (!token) return;

  webhookSecretToken = null;

  try {
    await fetch(`${TELEGRAM_API}/bot${token}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('[telegram] Webhook removed');
  } catch (err) {
    console.error('[telegram] Failed to remove webhook:', err instanceof Error ? err.message : err);
  }
}

/**
 * Initialize Telegram listener on startup.
 * Checks if a Telegram credential exists and registers the webhook if so.
 */
export async function initTelegramListener(): Promise<void> {
  const token = await getServiceCredential('telegram');
  if (token) {
    await setupTelegramWebhook();
  } else {
    console.log('[telegram] No bot token found — listener inactive. Set token via Settings to enable.');
  }
}

/** Exported for testing */
export const _testExports = {
  get webhookSecretToken() { return webhookSecretToken; },
  set webhookSecretToken(v: string | null) { webhookSecretToken = v; },
};
