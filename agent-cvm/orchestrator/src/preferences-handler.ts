/**
 * Preferences handler — get/set user preferences from PWA.
 */

import type {
  MessageEnvelope,
  PreferencesSetPayload,
  PreferencesListPayload,
} from '@luciaclaw/protocol';
import { setPreference, getAllPreferences } from './persistent-memory.js';

export async function handlePreferencesSet(
  payload: PreferencesSetPayload,
): Promise<MessageEnvelope> {
  await setPreference(payload.key, payload.value);
  const preferences = await getAllPreferences();
  return {
    id: crypto.randomUUID(),
    type: 'preferences.response',
    timestamp: Date.now(),
    payload: { preferences },
  };
}

export async function handlePreferencesList(
  payload: PreferencesListPayload,
): Promise<MessageEnvelope> {
  const preferences = await getAllPreferences();
  return {
    id: crypto.randomUUID(),
    type: 'preferences.response',
    timestamp: Date.now(),
    payload: { preferences },
  };
}
