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
  MemoryListPayload,
  MemorySearchPayload,
  MemoryDeletePayload,
  PreferencesSetPayload,
  PreferencesListPayload,
  WorkflowCreatePayload,
  WorkflowUpdatePayload,
  WorkflowDeletePayload,
  WorkflowListPayload,
  WorkflowExecutePayload,
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
import { handleMemoryList, handleMemorySearch, handleMemoryDelete } from './memory-handler.js';
import { handlePreferencesSet, handlePreferencesList } from './preferences-handler.js';
import { handleWorkflowCreate, handleWorkflowUpdate, handleWorkflowDelete, handleWorkflowList, handleWorkflowExecute } from './workflow-handler.js';

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

    // Workflows
    case 'workflow.create':
      return handleWorkflowCreate(msg.payload as WorkflowCreatePayload);

    case 'workflow.update':
      return handleWorkflowUpdate(msg.payload as WorkflowUpdatePayload);

    case 'workflow.delete':
      return handleWorkflowDelete(msg.payload as WorkflowDeletePayload);

    case 'workflow.list':
      return handleWorkflowList(msg.payload as WorkflowListPayload);

    case 'workflow.execute':
      return handleWorkflowExecute(msg.payload as WorkflowExecutePayload);

    // Persistent memory
    case 'memory.list':
      return handleMemoryList(msg.payload as MemoryListPayload);

    case 'memory.search':
      return handleMemorySearch(msg.payload as MemorySearchPayload);

    case 'memory.delete':
      return handleMemoryDelete(msg.payload as MemoryDeletePayload);

    // Preferences
    case 'preferences.set':
      return handlePreferencesSet(msg.payload as PreferencesSetPayload);

    case 'preferences.list':
      return handlePreferencesList(msg.payload as PreferencesListPayload);

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

/** Static metadata for TEE-attested models — always available as fallback */
const TEE_MODELS = [
  { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5', provider: 'moonshotai', contextLength: 131072, inputPrice: 0.20, outputPrice: 0.60 },
  { id: 'phala/uncensored-24b', name: 'Uncensored 24B', provider: 'phala', contextLength: 32768, inputPrice: 0.10, outputPrice: 0.30 },
  { id: 'z-ai/glm-5', name: 'GLM-5', provider: 'z-ai', contextLength: 131072, inputPrice: 0.50, outputPrice: 1.50 },
];

async function handleModelsList(payload: ModelsListPayload): Promise<MessageEnvelope> {
  const currentModel = getCurrentModel();

  try {
    const response = await fetchModels();
    const upstreamMap = new Map(response.data.map((m: { id: string }) => [m.id, m]));

    // Always return all whitelisted models; use upstream data when available, fallback to static
    const models = TEE_MODELS.map((tee) => {
      const upstream = upstreamMap.get(tee.id) as {
        id: string; name?: string; context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      } | undefined;
      if (upstream) {
        return {
          id: upstream.id,
          name: upstream.name || tee.name,
          provider: tee.provider,
          contextLength: upstream.context_length || tee.contextLength,
          inputPrice: parseFloat(upstream.pricing?.prompt || '0') * 1_000_000 || tee.inputPrice,
          outputPrice: parseFloat(upstream.pricing?.completion || '0') * 1_000_000 || tee.outputPrice,
        };
      }
      return { ...tee };
    });

    return {
      id: crypto.randomUUID(),
      type: 'models.response',
      timestamp: Date.now(),
      payload: { models, currentModel },
    };
  } catch (err) {
    console.error('[router] Failed to fetch models from upstream, using static list:', err);
    // Upstream unavailable: return all whitelisted models with static metadata
    return {
      id: crypto.randomUUID(),
      type: 'models.response',
      timestamp: Date.now(),
      payload: { models: TEE_MODELS, currentModel },
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
