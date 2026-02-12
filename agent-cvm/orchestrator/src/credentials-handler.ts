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
  const { service, account, label, credentialType, value, scopes } = payload;
  const acct = account || 'default';

  await setServiceCredential(service, label, credentialType, value, scopes, acct);
  console.log(`[credentials] Stored credential for ${service}:${acct}`);

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
