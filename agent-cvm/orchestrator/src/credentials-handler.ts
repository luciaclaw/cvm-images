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
  deleteServiceCredential,
  listServiceCredentials,
} from './vault.js';

export async function handleCredentialSet(
  payload: CredentialSetPayload
): Promise<MessageEnvelope> {
  const { service, label, credentialType, value, scopes } = payload;

  await setServiceCredential(service, label, credentialType, value, scopes);
  console.log(`[credentials] Stored credential for service: ${service}`);

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
  const { service } = payload;
  const deleted = deleteServiceCredential(service);

  if (deleted) {
    console.log(`[credentials] Deleted credential for service: ${service}`);
  } else {
    console.warn(`[credentials] No credential found for service: ${service}`);
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
  const credentials = listServiceCredentials(payload.service);

  return {
    id: crypto.randomUUID(),
    type: 'credentials.response',
    timestamp: Date.now(),
    payload: { credentials },
  };
}
