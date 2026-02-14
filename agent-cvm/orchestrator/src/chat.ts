/**
 * Chat handler — conversation management, prompt construction, inference, tool calling.
 */

import type { MessageEnvelope, ChatMessagePayload, ChatMessage, Attachment } from '@luciaclaw/protocol';
import {
  getHistory,
  addToHistory,
  getCurrentConversationId,
  setCurrentConversation,
  autoTitleIfNeeded,
} from './memory.js';
import { callInference, callVisionInference } from './inference.js';
import { getToolsForInference, getAllTools } from './tool-registry.js';
import { executeTool } from './tool-executor.js';
import { getRelevantMemories, extractAndStoreMemories, getPreference } from './persistent-memory.js';
import { getServiceCredential } from './vault.js';
import { detectAutoRoute, runSubAgent } from './sub-agent.js';
import { checkLimits, trackUsage } from './token-tracker.js';

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

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
  const { content, model, conversationId, attachments } = payload;

  // Switch to specified conversation or ensure one exists
  if (conversationId) {
    setCurrentConversation(conversationId);
  }
  const activeConvId = await getCurrentConversationId();

  // Add user message to history (with attachments metadata, not data)
  await addToHistory(
    {
      messageId,
      role: 'user',
      content,
      attachments: attachments?.map(a => ({ ...a, data: '[stored]' })),
      timestamp: Date.now(),
    },
    activeConvId
  );

  // Auto-title the conversation from the first user message
  await autoTitleIfNeeded(activeConvId, content);

  // Check for image attachments — route to vision inference
  const imageAttachments = attachments?.filter(a => IMAGE_MIME_TYPES.has(a.mimeType)) || [];
  const textAttachments = attachments?.filter(a => !IMAGE_MIME_TYPES.has(a.mimeType)) || [];

  if (imageAttachments.length > 0) {
    return handleVisionMessage(messageId, content, imageAttachments, textAttachments, activeConvId);
  }

  // Build context from text/PDF attachments
  let augmentedContent = content;
  if (textAttachments.length > 0) {
    const attachmentContext = textAttachments.map(a => {
      const decoded = Buffer.from(a.data, 'base64').toString('utf-8');
      return `[Attached file: ${a.filename}]\n${decoded}`;
    }).join('\n\n');
    augmentedContent = `${attachmentContext}\n\n${content}`;
  }

  // Load personality and profile preferences
  const personalityTone = await getPreference('personality_tone');
  const personalityInstructions = await getPreference('personality_instructions');
  const userTimezone = await getPreference('user_timezone') || 'UTC';
  const userFullName = await getPreference('user_full_name');
  const userPreferredName = await getPreference('user_preferred_name');
  const agentName = await getPreference('agent_name') || 'Lucia';

  let personalizedPrompt = SYSTEM_PROMPT;

  // Context section: date/time, names
  const now = new Date();
  let formattedDateTime: string;
  try {
    formattedDateTime = now.toLocaleString('en-US', { timeZone: userTimezone, dateStyle: 'full', timeStyle: 'short' });
  } catch {
    formattedDateTime = now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  }

  personalizedPrompt += `\n\n## Context:`;
  personalizedPrompt += `\n- Current date/time: ${formattedDateTime} (${userTimezone})`;
  personalizedPrompt += `\n- Your name: ${agentName}`;
  if (userFullName) {
    const nameStr = userPreferredName
      ? `${userFullName} (prefers to be called "${userPreferredName}")`
      : userFullName;
    personalizedPrompt += `\n- User's name: ${nameStr}`;
  } else if (userPreferredName) {
    personalizedPrompt += `\n- User prefers to be called: ${userPreferredName}`;
  }

  // Personality guidelines
  if (personalityTone || personalityInstructions) {
    personalizedPrompt += '\n\n## Personality guidelines:';
    if (personalityTone) personalizedPrompt += `\n- Communication tone: ${personalityTone}`;
    if (personalityInstructions) personalizedPrompt += `\n- Custom instructions: ${personalityInstructions}`;
  }

  // Inject relevant memories into system prompt
  const memoryContext = await getRelevantMemories(augmentedContent);
  const systemPrompt = memoryContext
    ? `${personalizedPrompt}\n\n${memoryContext}`
    : personalizedPrompt;

  // Diagnostic logging — identify what's contributing to system prompt size
  console.log(`[prompt-diag] SYSTEM_PROMPT=${SYSTEM_PROMPT.length} personalizedPrompt=${personalizedPrompt.length} memoryContext=${memoryContext.length} systemPrompt=${systemPrompt.length}`);
  if (personalityTone) console.log(`[prompt-diag]   personalityTone len=${personalityTone.length}`);
  if (personalityInstructions) console.log(`[prompt-diag]   personalityInstructions len=${personalityInstructions.length}`);
  if (systemPrompt.length > 5000) {
    console.warn(`[prompt-diag] WARNING: systemPrompt is ${systemPrompt.length} chars! First 500: "${systemPrompt.slice(0, 500)}" Last 500: "${systemPrompt.slice(-500)}"`);
  }

  // Build prompt from conversation history
  const history = await getHistory(activeConvId);
  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }> = [
    { role: 'system', content: systemPrompt },
    ...history.slice(0, -1).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: augmentedContent },
  ];

  // Check that LLM API key is available before calling inference
  const llmCred = await getServiceCredential('llm_backend');
  if (!llmCred) {
    const noKeyMsg = 'No LLM API key configured. Please set your API key in Settings → Credentials to start chatting.';
    const responseId = crypto.randomUUID();
    await addToHistory(
      { messageId: responseId, role: 'assistant', content: noKeyMsg, timestamp: Date.now() },
      activeConvId,
    );
    return {
      id: responseId,
      type: 'chat.response',
      timestamp: Date.now(),
      payload: { content: noKeyMsg },
    };
  }

  // Check usage limits before inference
  const limitStatus = checkLimits();
  if (limitStatus.exceeded) {
    const waitSec = Math.ceil((limitStatus.cooldownUntil! - Date.now()) / 1000);
    const limitMsg = `Usage limit reached. You can continue in ${waitSec} seconds.`;
    const limitResponseId = crypto.randomUUID();
    await addToHistory(
      { messageId: limitResponseId, role: 'assistant', content: limitMsg, timestamp: Date.now() },
      activeConvId,
    );
    return {
      id: limitResponseId,
      type: 'chat.response',
      timestamp: Date.now(),
      payload: { content: limitMsg },
    };
  }

  // Auto-route to sub-agent if content matches routing patterns
  const autoRole = detectAutoRoute(content);
  if (autoRole) {
    const subResult = await runSubAgent(autoRole, augmentedContent, activeConvId);
    const autoResponseContent = `*[${autoRole} model: ${subResult.model}]*\n\n${subResult.response}`;
    const autoResponseId = crypto.randomUUID();
    await addToHistory(
      { messageId: autoResponseId, role: 'assistant', content: autoResponseContent, timestamp: Date.now() },
      activeConvId,
    );
    extractAndStoreMemories(content, autoResponseContent, activeConvId).catch((err) => {
      console.error('[chat] Memory extraction failed:', err);
    });
    return {
      id: autoResponseId,
      type: 'chat.response',
      timestamp: Date.now(),
      payload: { content: autoResponseContent, model: subResult.model },
    };
  }

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

      // Track token usage
      if (result.promptTokens || result.completionTokens) {
        trackUsage(result.model, 'default', result.promptTokens || 0, result.completionTokens || 0);
      }

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
        tool_calls: result.toolCalls?.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
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
        if (finalResult.promptTokens || finalResult.completionTokens) {
          trackUsage(finalResult.model, 'default', finalResult.promptTokens || 0, finalResult.completionTokens || 0);
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[chat] Inference/tool error:', detail);
      responseContent = `Something went wrong: ${detail}`;
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

  // Fire-and-forget memory extraction
  extractAndStoreMemories(content, responseContent, activeConvId).catch((err) => {
    console.error('[chat] Memory extraction failed:', err);
  });

  return {
    id: responseId,
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: responseContent, model: usedModel },
  };
}

/**
 * Handle messages with image attachments via vision inference.
 */
async function handleVisionMessage(
  messageId: string,
  content: string,
  imageAttachments: Attachment[],
  textAttachments: Attachment[],
  conversationId: string,
): Promise<MessageEnvelope> {
  // Build prompt including any text attachment context
  let prompt = content;
  if (textAttachments.length > 0) {
    const textContext = textAttachments.map(a => {
      const decoded = Buffer.from(a.data, 'base64').toString('utf-8');
      return `[Attached file: ${a.filename}]\n${decoded}`;
    }).join('\n\n');
    prompt = `${textContext}\n\n${content}`;
  }

  let responseContent = '';
  let usedModel = '';

  try {
    // Use the first image for vision inference (vision API typically handles one image)
    const img = imageAttachments[0];
    const dataUri = `data:${img.mimeType};base64,${img.data}`;

    if (imageAttachments.length > 1) {
      prompt += `\n\n(Note: ${imageAttachments.length} images were attached. Analyzing the first image: ${img.filename})`;
    }

    const result = await callVisionInference(dataUri, prompt);
    responseContent = result.content;
    usedModel = result.model;
  } catch (err) {
    console.error('[chat] Vision inference error:', err);
    responseContent = 'I apologize, but I encountered an error analyzing the image. Please try again.';
  }

  const responseId = crypto.randomUUID();
  await addToHistory(
    {
      messageId: responseId,
      role: 'assistant',
      content: responseContent,
      timestamp: Date.now(),
    },
    conversationId
  );

  return {
    id: responseId,
    type: 'chat.response',
    timestamp: Date.now(),
    payload: { content: responseContent, model: usedModel },
  };
}
