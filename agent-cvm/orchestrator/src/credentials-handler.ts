/**
 * Credential management handler — processes credential messages from PWA.
 *
 * Credentials are stored encrypted in SQLite via the vault module.
 * This handler never returns secret values to the client — only metadata.
 */

import type {
  MessageEnvelope,
  CredentialSetPayload,
  CredentialDeletePayload,
  CredentialListPayload,
} from '@luciaclaw/protocol';
import {
  setServiceCredential,
  getServiceCredential,
  deleteServiceCredential,
  listServiceCredentials,
} from './vault.js';

/**
 * Notify the inference bridge when LLM backend config changes.
 * The bridge runs on localhost:8000 and exposes POST /internal/config.
 */
async function notifyBridgeConfigChange(service: string): Promise<void> {
  if (service !== 'llm_backend') return;

  const raw = await getServiceCredential('llm_backend');
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    const body: Record<string, string> = {};
    if (parsed.apiKey) body.llm_api_key = parsed.apiKey;
    if (parsed.backendUrl) body.llm_backend_url = parsed.backendUrl;
    if (parsed.modelName) body.model_name = parsed.modelName;

    await fetch('http://localhost:8000/internal/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log('[credentials] Notified inference bridge of LLM config update');
  } catch (err) {
    console.warn('[credentials] Failed to notify inference bridge:', err);
  }
}

export async function handleCredentialSet(
  payload: CredentialSetPayload
): Promise<MessageEnvelope> {
  const { service, account, label, credentialType, value, scopes } = payload;
  const acct = account || 'default';

  await setServiceCredential(service, label, credentialType, value, scopes, acct);
  console.log(`[credentials] Stored credential for ${service}:${acct}`);

  // Side effect: push LLM config updates to the inference bridge
  await notifyBridgeConfigChange(service);

  return {
    id: crypto.randomUUID(),
    type: 'credentials.response',
    timestamp: Date.now(),
    payload: {
      credentials: listServiceCredentials(service),
    },
  };
}

export async function handleCredentialDelete(
  payload: CredentialDeletePayload
): Promise<MessageEnvelope> {
  const { service, account } = payload;
  const acct = account || 'default';
  const deleted = deleteServiceCredential(service, acct);

  if (deleted) {
    console.log(`[credentials] Deleted credential for ${service}:${acct}`);
  } else {
    console.warn(`[credentials] No credential found for ${service}:${acct}`);
  }

  return {
    id: crypto.randomUUID(),
    type: 'credentials.response',
    timestamp: Date.now(),
    payload: {
      credentials: listServiceCredentials(),
    },
  };
}

export async function handleCredentialList(
  payload: CredentialListPayload
): Promise<MessageEnvelope> {
  const credentials = listServiceCredentials(payload.service, payload.account);

  return {
    id: crypto.randomUUID(),
    type: 'credentials.response',
    timestamp: Date.now(),
    payload: { credentials },
  };
}
