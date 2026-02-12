/**
 * Integration registry — static registry of supported third-party services.
 *
 * Each integration defines its auth requirements, capabilities, and scopes.
 * The PWA queries this to render the settings UI.
 */

import type {
  MessageEnvelope,
  IntegrationInfo,
  IntegrationsListPayload,
} from '@luciaclaw/protocol';
import { listServiceCredentials } from './vault.js';

interface IntegrationDefinition {
  service: string;
  name: string;
  description: string;
  authType: 'oauth' | 'api_key' | 'token';
  requiredScopes?: string[];
  capabilities: string[];
  icon?: string;
}

const INTEGRATIONS: IntegrationDefinition[] = [
  {
    service: 'google',
    name: 'Google (Gmail + Calendar)',
    description: 'Send and read emails, manage calendar events',
    authType: 'oauth',
    requiredScopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    capabilities: ['gmail.send', 'gmail.read', 'gmail.search', 'gmail.list', 'calendar.list', 'calendar.create', 'calendar.update', 'calendar.delete'],
    icon: 'google',
  },
  {
    service: 'slack',
    name: 'Slack',
    description: 'Send messages and read channels',
    authType: 'oauth',
    requiredScopes: ['chat:write', 'channels:read', 'channels:history', 'users:read'],
    capabilities: ['slack.send', 'slack.read', 'slack.list_channels'],
    icon: 'slack',
  },
  {
    service: 'telegram',
    name: 'Telegram',
    description: 'Send and receive messages via Telegram Bot',
    authType: 'api_key',
    capabilities: ['telegram.send', 'telegram.read', 'telegram.get_chat'],
    icon: 'telegram',
  },
];

/** Get the full list of integrations with connection status */
export function getIntegrations(filter?: 'all' | 'connected' | 'available'): IntegrationInfo[] {
  const credentials = listServiceCredentials();
  const connectedServices = new Set(credentials.filter(c => c.connected).map(c => c.service));

  let integrations = INTEGRATIONS.map((def) => ({
    ...def,
    connected: connectedServices.has(def.service),
  }));

  if (filter === 'connected') {
    integrations = integrations.filter((i) => i.connected);
  } else if (filter === 'available') {
    integrations = integrations.filter((i) => !i.connected);
  }

  return integrations;
}

export async function handleIntegrationsList(
  payload: IntegrationsListPayload
): Promise<MessageEnvelope> {
  const integrations = getIntegrations(payload.filter);

  return {
    id: crypto.randomUUID(),
    type: 'integrations.response',
    timestamp: Date.now(),
    payload: { integrations },
  };
}
