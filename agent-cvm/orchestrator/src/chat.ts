/**
 * Chat handler — conversation management, prompt construction, inference.
 */

import type { MessageEnvelope, ChatMessagePayload, ChatMessage } from '@luciaclaw/protocol';
import { getHistory, addToHistory } from './memory.js';
import { callInference } from './inference.js';

const SYSTEM_PROMPT = `You are Lucia, a privacy-preserving AI agent. You run inside a Trusted Execution Environment (Intel TDX) on Phala Cloud. All communication with the user is end-to-end encrypted. Not even the platform operator can access conversation data.

Be helpful, concise, and honest. If you don't know something, say so. When you need to take actions (like sending emails or checking calendars), you'll use tool calls that require user confirmation for sensitive operations.`;

export async function handleChatMessage(
  messageId: string,
  payload: ChatMessagePayload
): Promise<MessageEnvelope> {
  const { content, model } = payload;

  // Add user message to history
  addToHistory({
    messageId,
    role: 'user',
    content,
    timestamp: Date.now(),
  });

  // Build prompt from conversation history
  const history = getHistory();
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  // Call inference bridge with the selected model
  let responseContent: string;
  let usedModel: string | undefined;
  try {
    const result = await callInference(messages, model);
    responseContent = result.content;
    usedModel = result.model;
  } catch (err) {
    console.error('[chat] Inference error:', err);
    responseContent = 'I apologize, but I encountered an error processing your request. Please try again.';
  }

  // Add assistant response to history
  const responseId = crypto.randomUUID();
  addToHistory({
    messageId: responseId,
    role: 'assistant',
    content: responseContent,
    timestamp: Date.now(),
  });

  return {
    id: responseId,
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: responseContent, model: usedModel },
  };
}
