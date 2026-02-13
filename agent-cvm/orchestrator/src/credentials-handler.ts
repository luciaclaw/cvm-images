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
import { setCurrentModel } from './inference.js';

const BRIDGE_CONFIG_URL = 'http://localhost:8000/internal/config';

/**
 * Push LLM config from the vault to the inference bridge and orchestrator.
 *
 * Called after credential writes AND at startup to restore vault-stored config.
 * The bridge exposes POST /internal/config on localhost only.
 */
async function pushLlmConfigToBridge(): Promise<void> {
  const raw = await getServiceCredential('llm_backend');
  if (!raw) return;

  let parsed: { apiKey?: string; backendUrl?: string; modelName?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[credentials] Malformed llm_backend credential — skipping bridge notification');
    return;
  }

  const body: Record<string, string> = {};
  if (parsed.apiKey) body.llm_api_key = parsed.apiKey;
  if (parsed.backendUrl) body.llm_backend_url = parsed.backendUrl;
  if (parsed.modelName) body.model_name = parsed.modelName;

  if (Object.keys(body).length === 0) return;

  // Update the orchestrator's model selection if a model was provided
  if (parsed.modelName) {
    setCurrentModel(parsed.modelName);
    console.log(`[credentials] Updated orchestrator model to ${parsed.modelName}`);
  }

  try {
    const resp = await fetch(BRIDGE_CONFIG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`[credentials] Bridge config update failed: ${resp.status} ${detail}`);
      return;
    }
    console.log('[credentials] Pushed LLM config to inference bridge');
  } catch (err) {
    console.warn('[credentials] Failed to reach inference bridge:', err instanceof Error ? err.message : err);
  }
}

/**
 * Sync vault-stored LLM config to the inference bridge on startup.
 *
 * Retries a few times because the bridge may still be booting when the
 * orchestrator starts.
 */
export async function syncLlmConfigOnStartup(): Promise<void> {
  const raw = await getServiceCredential('llm_backend');
  if (!raw) return; // No vault-stored config — nothing to sync

  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await pushLlmConfigToBridge();
      return;
    } catch {
      if (attempt < MAX_RETRIES) {
        console.log(`[credentials] Bridge not ready, retrying in ${RETRY_DELAY_MS}ms (${attempt}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  console.warn('[credentials] Could not sync LLM config to bridge after retries — will sync on next credential save');
}

export async function handleCredentialSet(
  payload: CredentialSetPayload
): Promise<MessageEnvelope> {
  const { service, account, label, credentialType, value, scopes } = payload;
  const acct = account || 'default';

  await setServiceCredential(service, label, credentialType, value, scopes, acct);
  console.log(`[credentials] Stored credential for ${service}:${acct}`);

  // Side effect: push LLM config updates to the inference bridge + orchestrator model
  if (service === 'llm_backend') {
    await pushLlmConfigToBridge();
  }

  // Return the full credential list so the PWA stays in sync
  return {
    id: crypto.randomUUID(),
    type: 'credentials.response',
    timestamp: Date.now(),
    payload: {
      credentials: listServiceCredentials(),
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
