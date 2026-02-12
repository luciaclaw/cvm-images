/**
 * Message router — dispatches decrypted messages to handlers.
 */

import type {
  MessageEnvelope,
  ChatMessagePayload,
  ToolConfirmResponsePayload,
  ModelsListPayload,
  CredentialSetPayload,
  CredentialDeletePayload,
  CredentialListPayload,
  ConversationsListPayload,
  ConversationsLoadPayload,
  ConversationsDeletePayload,
  OAuthInitPayload,
  PushSubscribePayload,
  PushUnsubscribePayload,
  IntegrationsListPayload,
  ScheduleCreatePayload,
  ScheduleUpdatePayload,
  ScheduleDeletePayload,
  ScheduleListPayload,
} from '@luciaclaw/protocol';
import { handleChatMessage } from './chat.js';
import { handleToolConfirmation } from './tools.js';
import { fetchModels, getCurrentModel } from './inference.js';
import { handleCredentialSet, handleCredentialDelete, handleCredentialList } from './credentials-handler.js';
import { listConversations, loadConversation, deleteConversation } from './memory.js';
import { handleOAuthInit } from './oauth.js';
import { handlePushSubscribe, handlePushUnsubscribe } from './push.js';
import { handleIntegrationsList } from './integrations.js';
import { handleScheduleCreate, handleScheduleUpdate, handleScheduleDelete, handleScheduleList } from './schedule-handler.js';

export async function routeMessage(msg: MessageEnvelope): Promise<MessageEnvelope | null> {
  switch (msg.type) {
    case 'chat.message':
      return handleChatMessage(msg.id, msg.payload as ChatMessagePayload);

    case 'tool.confirm.response':
      handleToolConfirmation(msg.payload as ToolConfirmResponsePayload);
      return null;

    case 'models.list':
      return handleModelsList(msg.payload as ModelsListPayload);

    // Credential management
    case 'credentials.set':
      return handleCredentialSet(msg.payload as CredentialSetPayload);

    case 'credentials.delete':
      return handleCredentialDelete(msg.payload as CredentialDeletePayload);

    case 'credentials.list':
      return handleCredentialList(msg.payload as CredentialListPayload);

    // Conversation management
    case 'conversations.list':
      return handleConversationsList(msg.payload as ConversationsListPayload);

    case 'conversations.load':
      return handleConversationsLoad(msg.payload as ConversationsLoadPayload);

    case 'conversations.delete':
      return handleConversationsDelete(msg.payload as ConversationsDeletePayload);

    // OAuth
    case 'oauth.init':
      return handleOAuthInit(msg.payload as OAuthInitPayload);

    // Push notifications
    case 'push.subscribe':
      return handlePushSubscribe(msg.payload as PushSubscribePayload);

    case 'push.unsubscribe':
      return handlePushUnsubscribe(msg.payload as PushUnsubscribePayload);

    // Integrations
    case 'integrations.list':
      return handleIntegrationsList(msg.payload as IntegrationsListPayload);

    // Schedules
    case 'schedule.create':
      return handleScheduleCreate(msg.payload as ScheduleCreatePayload);

    case 'schedule.update':
      return handleScheduleUpdate(msg.payload as ScheduleUpdatePayload);

    case 'schedule.delete':
      return handleScheduleDelete(msg.payload as ScheduleDeletePayload);

    case 'schedule.list':
      return handleScheduleList(msg.payload as ScheduleListPayload);

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
    const TEE_MODELS = ['moonshotai/kimi-k2.5', 'phala/uncensored-24b', 'z-ai/glm-5'];
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

async function handleConversationsList(
  payload: ConversationsListPayload
): Promise<MessageEnvelope> {
  const conversations = await listConversations(payload.limit, payload.offset);
  return {
    id: crypto.randomUUID(),
    type: 'conversations.response',
    timestamp: Date.now(),
    payload: { conversations },
  };
}

async function handleConversationsLoad(
  payload: ConversationsLoadPayload
): Promise<MessageEnvelope> {
  const { messages, total } = await loadConversation(
    payload.conversationId,
    payload.limit,
    payload.offset
  );
  return {
    id: crypto.randomUUID(),
    type: 'conversations.response',
    timestamp: Date.now(),
    payload: {
      conversationId: payload.conversationId,
      messages,
      totalMessages: total,
    },
  };
}

async function handleConversationsDelete(
  payload: ConversationsDeletePayload
): Promise<MessageEnvelope> {
  deleteConversation(payload.conversationId);
  const conversations = await listConversations();
  return {
    id: crypto.randomUUID(),
    type: 'conversations.response',
    timestamp: Date.now(),
    payload: { conversations },
  };
}
