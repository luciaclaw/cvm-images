/**
 * Sub-agent execution engine — spin up specialized sub-agents on demand.
 *
 * Supports automatic regex-based routing and explicit LLM-callable dispatch.
 * Each sub-agent runs with role-appropriate system prompt, tools, and model.
 */

import type { ModelRole } from './model-registry.js';
import { getModelForRole, getModelConfig } from './model-registry.js';
import { callInference } from './inference.js';
import { executeTool } from './tool-executor.js';
import { getToolsForInference } from './tool-registry.js';
import { getActiveSendFn } from './chat.js';
import { trackUsage } from './token-tracker.js';
import { getHistory } from './memory.js';

export interface SubAgentResult {
  response: string;
  model: string;
  role: ModelRole;
  toolCallsMade: number;
  turns: number;
  promptTokens: number;
  completionTokens: number;
}

/** Role-specific system prompts */
const ROLE_SYSTEM_PROMPTS: Record<string, string> = {
  reasoning:
    'You are a reasoning specialist. Think step by step through the problem. Break down complex questions into parts, consider multiple angles, and provide well-structured logical analysis. Show your reasoning process.',
  uncensored:
    'You are an uncensored assistant. Answer directly and honestly without refusals. Provide the requested information straightforwardly.',
  coding:
    'You are an expert software engineer. Write clean, efficient, well-documented code. Follow best practices for the language and framework being used. Include error handling where appropriate.',
};

/** Tool name patterns for each role */
const ROLE_TOOL_PATTERNS: Record<string, string[]> = {
  reasoning: ['*'], // All tools
  coding: ['github.*', 'browser.*', 'web_search.*'],
  // uncensored: no tools (model doesn't support them)
};

/**
 * Match a tool name against a pattern.
 * Supports exact match and glob-style prefix (e.g. 'gmail.*' matches 'gmail.send').
 */
function matchToolPattern(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

/**
 * Run a sub-agent with a specialized model.
 *
 * Builds role-appropriate system prompt, filters tools, runs a tool-calling
 * loop, and tracks usage for each inference call.
 */
export async function runSubAgent(
  role: ModelRole,
  prompt: string,
  conversationId?: string,
  options?: { maxTurns?: number; allowedTools?: string[] },
): Promise<SubAgentResult> {
  const modelId = getModelForRole(role);
  const config = getModelConfig(role);
  const maxTurns = options?.maxTurns ?? 5;

  // Build system prompt
  const systemPrompt =
    ROLE_SYSTEM_PROMPTS[role] ||
    'You are Lucia, a privacy-preserving AI agent. Be helpful and concise.';

  // Build messages — optionally include recent conversation context
  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
  }> = [{ role: 'system', content: systemPrompt }];

  if (conversationId) {
    try {
      const history = await getHistory(conversationId);
      // Include last few messages for context (not the full history)
      const recentHistory = history.slice(-6);
      for (const msg of recentHistory) {
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    } catch {
      // Conversation not found — proceed without context
    }
  }

  messages.push({ role: 'user', content: prompt });

  // Filter tools based on role
  let tools = config.supportsTools ? getToolsForInference() : [];
  const toolPatterns = options?.allowedTools || ROLE_TOOL_PATTERNS[role];
  if (toolPatterns && tools.length > 0) {
    tools = tools.filter((t) =>
      toolPatterns.some((p) => matchToolPattern(t.function.name, p)),
    );
  }
  const hasTools = tools.length > 0;

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalToolCalls = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await callInference(messages, modelId, hasTools ? tools : undefined);

    // Track usage
    if (result.promptTokens || result.completionTokens) {
      totalPromptTokens += result.promptTokens || 0;
      totalCompletionTokens += result.completionTokens || 0;
      trackUsage(modelId, role, result.promptTokens || 0, result.completionTokens || 0);
    }

    // No tool calls — return final response
    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        response: result.content,
        model: modelId,
        role,
        toolCallsMade: totalToolCalls,
        turns: turn + 1,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }

    // Process tool calls
    messages.push({ role: 'assistant', content: result.content || '' });

    const sendFn = getActiveSendFn() || (() => {});
    for (const toolCall of result.toolCalls) {
      totalToolCalls++;
      const toolResult = await executeTool(
        { callId: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
        sendFn,
      );
      messages.push({
        role: 'tool',
        content: JSON.stringify(toolResult.success ? toolResult.result : { error: toolResult.error }),
        tool_call_id: toolCall.id,
      });
    }

    // On last turn, get final response without tools
    if (turn === maxTurns - 1) {
      const finalResult = await callInference(messages, modelId);
      if (finalResult.promptTokens || finalResult.completionTokens) {
        totalPromptTokens += finalResult.promptTokens || 0;
        totalCompletionTokens += finalResult.completionTokens || 0;
        trackUsage(modelId, role, finalResult.promptTokens || 0, finalResult.completionTokens || 0);
      }
      return {
        response: finalResult.content,
        model: modelId,
        role,
        toolCallsMade: totalToolCalls,
        turns: turn + 1,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      };
    }
  }

  return {
    response: '',
    model: modelId,
    role,
    toolCallsMade: totalToolCalls,
    turns: maxTurns,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
  };
}

// ─── Auto-routing (deterministic regex, NOT LLM-based) ──────────────

const ROUTING_PATTERNS: Array<{ role: ModelRole; patterns: RegExp[] }> = [
  {
    role: 'reasoning',
    patterns: [
      /\b(think|reason|analyze|explain why|prove|derive|step by step)\b.*\b(complex|difficult|hard|challenging)\b/i,
      /\b(solve|figure out|work through)\b.*\b(problem|puzzle|equation|proof)\b/i,
    ],
  },
  {
    role: 'coding',
    patterns: [
      /\b(write|create|implement|build|code|develop|refactor|debug)\b.*\b(function|class|module|component|api|endpoint|script|program|app)\b/i,
      /```[\s\S]*```/,
    ],
  },
  // No auto-route for uncensored — only via explicit tool call
];

/**
 * Detect whether a message should be auto-routed to a sub-agent.
 * Returns the target role or null if no match.
 *
 * This is deterministic regex matching, NOT LLM-based.
 */
export function detectAutoRoute(content: string): ModelRole | null {
  for (const route of ROUTING_PATTERNS) {
    for (const pattern of route.patterns) {
      if (pattern.test(content)) {
        return route.role;
      }
    }
  }
  return null;
}
