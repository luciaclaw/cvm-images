/**
 * Message router — dispatches decrypted messages to handlers.
 */

import type { MessageEnvelope, ChatMessagePayload, ToolConfirmResponsePayload, ModelsListPayload } from '@luciaclaw/protocol';
import { handleChatMessage } from './chat.js';
import { handleToolConfirmation } from './tools.js';
import { fetchModels, getCurrentModel } from './inference.js';

export async function routeMessage(msg: MessageEnvelope): Promise<MessageEnvelope | null> {
  switch (msg.type) {
    case 'chat.message':
      return handleChatMessage(msg.id, msg.payload as ChatMessagePayload);

    case 'tool.confirm.response':
      handleToolConfirmation(msg.payload as ToolConfirmResponsePayload);
      return null;

    case 'models.list':
      return handleModelsList(msg.payload as ModelsListPayload);

    default:
      console.warn('[router] Unknown message type:', msg.type);
      return {
        id: crypto.randomUUID(),
        type: 'error',
        timestamp: Date.now(),
        payload: { code: 1002, message: `Unknown message type: ${msg.type}` },
      };
  }
}

async function handleModelsList(payload: ModelsListPayload): Promise<MessageEnvelope> {
  try {
    const response = await fetchModels();
    // Only offer TEE-attested models
    const TEE_MODELS = ['moonshotai/kimi-k2.5', 'phala/uncensored-24b'];
    const teeModels = response.data.filter((m) => TEE_MODELS.includes(m.id));

    const models = teeModels.map((m) => {
      const provider = m.id.split('/')[0] || 'unknown';
      const name = m.name || m.id;
      return {
        id: m.id,
        name,
        provider,
        contextLength: m.context_length || 0,
        inputPrice: parseFloat(m.pricing?.prompt || '0') * 1_000_000,
        outputPrice: parseFloat(m.pricing?.completion || '0') * 1_000_000,
      };
    });

    const filtered = models;

    return {
      id: crypto.randomUUID(),
      type: 'models.response',
      timestamp: Date.now(),
      payload: {
        models: filtered,
        currentModel: getCurrentModel(),
      },
    };
  } catch (err) {
    console.error('[router] Failed to fetch models:', err);
    return {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      payload: { code: 4000, message: 'Failed to fetch available models' },
    };
  }
}
