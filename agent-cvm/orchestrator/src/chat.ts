/**
 * Chat handler — conversation management, prompt construction, inference, tool calling.
 */

import type { MessageEnvelope, ChatMessagePayload, ChatMessage } from '@luciaclaw/protocol';
import {
  getHistory,
  addToHistory,
  getCurrentConversationId,
  setCurrentConversation,
  autoTitleIfNeeded,
} from './memory.js';
import { callInference } from './inference.js';
import { getToolsForInference, getAllTools } from './tool-registry.js';
import { executeTool } from './tool-executor.js';

const MAX_TOOL_ITERATIONS = 5;

const SYSTEM_PROMPT = `You are Lucia, a privacy-preserving AI agent. You run inside a Trusted Execution Environment (Intel TDX) on Phala Cloud. All communication with the user is end-to-end encrypted. Not even the platform operator can access conversation data.

Be helpful, concise, and honest. If you don't know something, say so. When you need to take actions (like sending emails or checking calendars), use the available tool calls. Sensitive operations require user confirmation before execution.`;

/** Callback to send messages to the connected client */
type SendFn = (msg: MessageEnvelope) => void;

/** Send function — set by the handshake handler when connection is established */
let activeSendFn: SendFn | null = null;

export function setActiveSendFn(fn: SendFn | null): void {
  activeSendFn = fn;
}

export function getActiveSendFn(): SendFn | null {
  return activeSendFn;
}

export async function handleChatMessage(
  messageId: string,
  payload: ChatMessagePayload
): Promise<MessageEnvelope> {
  const { content, model, conversationId } = payload;

  // Switch to specified conversation or ensure one exists
  if (conversationId) {
    setCurrentConversation(conversationId);
  }
  const activeConvId = await getCurrentConversationId();

  // Add user message to history
  await addToHistory(
    {
      messageId,
      role: 'user',
      content,
      timestamp: Date.now(),
    },
    activeConvId
  );

  // Auto-title the conversation from the first user message
  await autoTitleIfNeeded(activeConvId, content);

  // Build prompt from conversation history
  const history = await getHistory(activeConvId);
  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  // Get available tools for inference
  const tools = getToolsForInference();
  const hasTools = tools.length > 0;

  // Tool calling loop (max iterations to prevent infinite loops)
  let responseContent = '';
  let usedModel: string | undefined;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    try {
      const result = await callInference(messages, model, hasTools ? tools : undefined);
      usedModel = result.model;

      // If no tool calls, we have the final response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        responseContent = result.content;
        break;
      }

      // Process tool calls
      // Add the assistant message with tool calls to the conversation
      messages.push({
        role: 'assistant',
        content: result.content || '',
      });

      for (const toolCall of result.toolCalls) {
        const sendFn = activeSendFn || (() => {});

        const toolResult = await executeTool(
          {
            callId: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
          sendFn
        );

        // Add tool result to messages for next inference call
        messages.push({
          role: 'tool',
          content: JSON.stringify(toolResult.success ? toolResult.result : { error: toolResult.error }),
          tool_call_id: toolCall.id,
        });

        // Send tool result to client
        if (activeSendFn) {
          activeSendFn({
            id: crypto.randomUUID(),
            type: 'tool.result',
            timestamp: Date.now(),
            payload: {
              callId: toolCall.id,
              success: toolResult.success,
              result: toolResult.result,
              error: toolResult.error,
            },
          });
        }
      }

      // If this is the last iteration, get a final response without tools
      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        const finalResult = await callInference(messages, model);
        responseContent = finalResult.content;
        usedModel = finalResult.model;
      }
    } catch (err) {
      console.error('[chat] Inference/tool error:', err);
      responseContent = 'I apologize, but I encountered an error processing your request. Please try again.';
      break;
    }
  }

  // Add assistant response to history
  const responseId = crypto.randomUUID();
  await addToHistory(
    {
      messageId: responseId,
      role: 'assistant',
      content: responseContent,
      timestamp: Date.now(),
    },
    activeConvId
  );

  return {
    id: responseId,
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: responseContent, model: usedModel },
  };
}
