/**
 * Inbound webhook receiver — accept events from external services.
 *
 * Supports:
 * - GitHub webhooks (push, PR, issues, etc.)
 * - WhatsApp Business API webhooks (incoming messages)
 * - Telegram Bot API webhooks (alternative to polling)
 * - Generic webhooks (custom integrations, Stripe, etc.)
 *
 * Each webhook is verified (signature checking where applicable) and
 * routed to the chat pipeline or workflow engine as appropriate.
 */

import type { Request, Response, Router } from 'express';
import express from 'express';
import crypto from 'crypto';
import { getDb, encrypt, decrypt } from './storage.js';
import { handleChatMessage, getActiveSendFn } from './chat.js';
import { handleChatCommand } from './chat-commands.js';
import { resolveSession } from './session-router.js';
import { getServiceCredential } from './vault.js';

// ─── Webhook Registration Storage ────────────────────────────────

interface WebhookRow {
  id: string;
  name: string;
  source: string;
  secret_enc: string;
  active: number;
  created_at: number;
  last_triggered_at: number | null;
  trigger_count: number;
}

export function initWebhookTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      secret_enc TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_triggered_at INTEGER,
      trigger_count INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export async function createWebhook(
  name: string,
  source: string,
  secret?: string,
): Promise<{ id: string; name: string; source: string; path: string }> {
  const id = crypto.randomUUID();
  const webhookSecret = secret || crypto.randomBytes(32).toString('hex');
  const secretEnc = await encrypt(webhookSecret);
  const now = Date.now();

  getDb().prepare(
    `INSERT INTO webhooks (id, name, source, secret_enc, active, created_at, trigger_count)
     VALUES (?, ?, ?, ?, 1, ?, 0)`
  ).run(id, name, source, secretEnc, now);

  console.log(`[webhook] Created webhook "${name}" (${source}) → /webhooks/${id}`);

  return {
    id,
    name,
    source,
    path: `/webhooks/${id}`,
  };
}

export async function listWebhooks(): Promise<Array<{
  id: string;
  name: string;
  source: string;
  active: boolean;
  path: string;
  triggerCount: number;
  lastTriggeredAt: number | null;
}>> {
  const rows = getDb().prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as WebhookRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    source: row.source,
    active: row.active === 1,
    path: `/webhooks/${row.id}`,
    triggerCount: row.trigger_count,
    lastTriggeredAt: row.last_triggered_at,
  }));
}

export function deleteWebhook(id: string): boolean {
  const result = getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Signature Verification ──────────────────────────────────────

function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function verifyGenericSignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Webhook Processing ──────────────────────────────────────────

const GRAPH_API = 'https://graph.facebook.com/v21.0';

async function processWebhookEvent(
  webhook: WebhookRow,
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Update trigger count and timestamp
  getDb().prepare(
    'UPDATE webhooks SET trigger_count = trigger_count + 1, last_triggered_at = ? WHERE id = ?'
  ).run(Date.now(), webhook.id);

  // WhatsApp: intercept slash commands from incoming messages
  if (source === 'whatsapp') {
    const handled = await handleWhatsAppCommands(payload);
    if (handled) return;
  }

  // Format as a chat message for the agent
  const summary = formatWebhookSummary(source, eventType, payload);

  // Route to appropriate session
  const conversationId = await resolveSession(
    source as any,
    `webhook-${webhook.id}`,
    'group',
    `Webhook: ${webhook.name}`,
  );

  // Inject into chat pipeline
  await handleChatMessage(
    crypto.randomUUID(),
    {
      content: summary,
      conversationId,
    },
  );

  console.log(`[webhook] Processed ${source}/${eventType} for "${webhook.name}"`);
}

/**
 * Check WhatsApp webhook payload for slash commands. If any message is a
 * command, reply directly via WhatsApp Cloud API and return true.
 * Returns false if no commands were found (normal processing should continue).
 */
async function handleWhatsAppCommands(payload: Record<string, unknown>): Promise<boolean> {
  const entries = (payload.entry as any[]) || [];
  let anyHandled = false;

  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== 'messages') continue;
      const phoneNumberId = change.value?.metadata?.phone_number_id as string | undefined;
      const messages = change.value?.messages || [];

      for (const msg of messages) {
        const body = msg.text?.body as string | undefined;
        if (!body) continue;

        const commandResult = await handleChatCommand(body);
        if (!commandResult) continue;

        // Reply via WhatsApp Cloud API
        const replyPhoneId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
        const token = await getServiceCredential('whatsapp');
        if (token && replyPhoneId) {
          await fetch(`${GRAPH_API}/${replyPhoneId}/messages`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: msg.from,
              type: 'text',
              text: { body: commandResult.response },
            }),
          });
          console.log(`[webhook] WhatsApp command "${body.trim()}" from ${msg.from}`);
        }
        anyHandled = true;
      }
    }
  }

  return anyHandled;
}

function formatWebhookSummary(
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  const parts = [`[Webhook: ${source}/${eventType}]`];

  switch (source) {
    case 'github': {
      if (eventType === 'push') {
        const repo = (payload.repository as any)?.full_name;
        const ref = payload.ref as string;
        const commits = (payload.commits as any[])?.length || 0;
        const pusher = (payload.pusher as any)?.name;
        parts.push(`${pusher} pushed ${commits} commit(s) to ${repo} (${ref})`);
        const commitList = ((payload.commits as any[]) || []).slice(0, 5);
        for (const commit of commitList) {
          parts.push(`  - ${commit.message?.split('\n')[0]}`);
        }
      } else if (eventType === 'pull_request') {
        const action = payload.action;
        const pr = payload.pull_request as any;
        parts.push(`PR #${pr?.number} ${action}: "${pr?.title}" by ${pr?.user?.login}`);
      } else if (eventType === 'issues') {
        const action = payload.action;
        const issue = payload.issue as any;
        parts.push(`Issue #${issue?.number} ${action}: "${issue?.title}" by ${issue?.user?.login}`);
      } else {
        parts.push(`Event data: ${JSON.stringify(payload).substring(0, 500)}`);
      }
      break;
    }
    case 'whatsapp': {
      const entries = (payload.entry as any[]) || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field === 'messages') {
            const messages = change.value?.messages || [];
            for (const msg of messages) {
              parts.push(`From ${msg.from}: ${msg.text?.body || msg.type || 'media'}`);
            }
          }
        }
      }
      break;
    }
    case 'telegram': {
      if (payload.message) {
        const msg = payload.message as any;
        parts.push(`From ${msg.from?.first_name || 'unknown'}: ${msg.text || '[non-text]'}`);
      }
      break;
    }
    default:
      parts.push(`Payload: ${JSON.stringify(payload).substring(0, 1000)}`);
  }

  return parts.join('\n');
}

// ─── Express Router ──────────────────────────────────────────────

export function createWebhookRouter(): Router {
  const router = express.Router();

  // Parse raw body for signature verification
  router.use(express.json({ limit: '1mb' }));

  // WhatsApp webhook verification (GET challenge)
  router.get('/:webhookId', async (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token && challenge) {
      // WhatsApp/Meta webhook verification
      const webhook = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.webhookId) as WebhookRow | undefined;
      if (!webhook) {
        res.status(404).send('Webhook not found');
        return;
      }

      const secret = await decrypt(webhook.secret_enc);
      if (secret === null) {
        res.status(500).send('Webhook secret unavailable');
        return;
      }
      if (token === secret) {
        res.status(200).send(challenge);
        return;
      }
      res.status(403).send('Verification failed');
      return;
    }

    res.status(200).json({ status: 'ok', webhookId: req.params.webhookId });
  });

  // Receive webhook events (POST)
  router.post('/:webhookId', async (req: Request, res: Response) => {
    const webhook = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.webhookId) as WebhookRow | undefined;

    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    if (!webhook.active) {
      res.status(200).json({ status: 'ignored', reason: 'Webhook is inactive' });
      return;
    }

    // Verify signature if present
    const secret = await decrypt(webhook.secret_enc);

    if (secret === null) {
      // Secret undecryptable after key rotation — cannot verify signatures
      res.status(500).json({ error: 'Webhook secret unavailable' });
      return;
    }

    if (webhook.source === 'github') {
      const signature = req.headers['x-hub-signature-256'] as string;
      if (signature) {
        const rawBody = JSON.stringify(req.body);
        if (!verifyGitHubSignature(rawBody, signature, secret)) {
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }
    } else {
      const signature = req.headers['x-webhook-signature'] as string || req.headers['x-signature'] as string;
      if (signature) {
        const rawBody = JSON.stringify(req.body);
        if (!verifyGenericSignature(rawBody, signature, secret)) {
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }
    }

    // Determine event type
    let eventType = 'unknown';
    if (webhook.source === 'github') {
      eventType = (req.headers['x-github-event'] as string) || 'unknown';
    } else if (webhook.source === 'whatsapp') {
      eventType = 'message';
    } else if (webhook.source === 'telegram') {
      eventType = req.body.message ? 'message' : req.body.callback_query ? 'callback_query' : 'update';
    } else {
      eventType = (req.headers['x-event-type'] as string) || 'event';
    }

    // Process asynchronously — respond immediately
    res.status(200).json({ received: true });

    processWebhookEvent(webhook, webhook.source, eventType, req.body).catch((err) => {
      console.error(`[webhook] Processing error for "${webhook.name}":`, err);
    });
  });

  return router;
}
