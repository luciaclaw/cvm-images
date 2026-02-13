/**
 * Push notification handler — Web Push API server-side implementation.
 *
 * Sends push notifications to subscribed PWA clients for:
 * - Tool completion results
 * - Async task updates
 * - Confirmation requests (with approve/deny actions)
 */

import type {
  MessageEnvelope,
  PushSubscribePayload,
  PushUnsubscribePayload,
} from '@luciaclaw/protocol';
import webpush from 'web-push';
import { getDb, encrypt, decrypt } from './storage.js';

// Configure VAPID keys from env
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@luciaclaw.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[push] VAPID configured');
} else {
  console.warn('[push] VAPID keys not configured — push notifications disabled');
}

interface PushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Handle push.subscribe — store the subscription */
export async function handlePushSubscribe(
  payload: PushSubscribePayload
): Promise<MessageEnvelope | null> {
  const { subscription } = payload;
  const subscriptionEnc = await encrypt(JSON.stringify(subscription));

  const db = getDb();
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription_enc, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      subscription_enc = excluded.subscription_enc
  `).run(subscription.endpoint, subscriptionEnc, Date.now());

  console.log('[push] Subscription stored');
  return null; // No response needed
}

/** Handle push.unsubscribe — remove the subscription */
export async function handlePushUnsubscribe(
  payload: PushUnsubscribePayload
): Promise<MessageEnvelope | null> {
  const db = getDb();
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(payload.endpoint);
  console.log('[push] Subscription removed');
  return null;
}

/** Send a push notification to all subscribed clients */
export async function sendPushNotification(
  title: string,
  body: string,
  url?: string,
  actions?: Array<{ action: string; title: string }>
): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] Cannot send notification — VAPID not configured');
    return;
  }

  const db = getDb();
  const rows = db.prepare('SELECT endpoint, subscription_enc FROM push_subscriptions').all() as Array<{
    endpoint: string;
    subscription_enc: string;
  }>;

  const notificationPayload = JSON.stringify({
    title,
    body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    data: { url: url || '/chat' },
    actions,
  });

  for (const row of rows) {
    try {
      const subJson = await decrypt(row.subscription_enc);
      if (subJson === null) continue; // skip undecryptable subscriptions
      const subscription: PushSubscription = JSON.parse(subJson);
      await webpush.sendNotification(subscription as any, notificationPayload);
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — clean up
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
        console.log('[push] Cleaned up expired subscription');
      } else {
        console.error('[push] Failed to send notification:', err.message);
      }
    }
  }
}
