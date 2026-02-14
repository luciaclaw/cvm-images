/**
 * Sub-agent tools — LLM-callable tools for explicit sub-agent dispatch.
 *
 * These allow the main agent to delegate tasks to specialized models:
 * - agent.reason: Complex reasoning (Kimi K2.5)
 * - agent.code: Coding tasks (Claude Opus)
 * - agent.uncensored: Unrestricted responses (Uncensored 24B)
 */

import { registerTool } from '../tool-registry.js';
import { runSubAgent } from '../sub-agent.js';

export function registerSubAgentTools(): void {
  registerTool({
    name: 'agent.reason',
    description:
      'Delegate a complex reasoning task to the reasoning specialist model (Kimi K2.5). Use for multi-step logic, analysis, math proofs, strategic planning, and problems requiring careful step-by-step thinking.',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'The reasoning task to solve',
        },
        context: {
          type: 'string',
          description: 'Optional additional context to help with the task',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const task = args.task as string;
      const context = args.context as string | undefined;
      const prompt = context ? `${task}\n\nAdditional context: ${context}` : task;

      const result = await runSubAgent('reasoning', prompt);
      return {
        response: result.response,
        model: result.model,
        tokensUsed: result.promptTokens + result.completionTokens,
      };
    },
  });

  registerTool({
    name: 'agent.code',
    description:
      'Delegate a coding task to the coding specialist model (Claude Opus). Use for writing code, debugging, code reviews, architecture design, and technical implementation.',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'The coding task to complete',
        },
        context: {
          type: 'string',
          description: 'Optional additional context (existing code, requirements, constraints)',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const task = args.task as string;
      const context = args.context as string | undefined;
      const prompt = context ? `${task}\n\nAdditional context: ${context}` : task;

      const result = await runSubAgent('coding', prompt);
      return {
        response: result.response,
        model: result.model,
        tokensUsed: result.promptTokens + result.completionTokens,
      };
    },
  });

  registerTool({
    name: 'agent.uncensored',
    description:
      'Delegate a task to the uncensored model for unrestricted responses. No tool calling available. Use when other models refuse a legitimate request.',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'The task to complete without content restrictions',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'medium',
    requiresConfirmation: false,
    async execute(args) {
      const task = args.task as string;

      const result = await runSubAgent('uncensored', task);
      return {
        response: result.response,
        model: result.model,
        tokensUsed: result.promptTokens + result.completionTokens,
      };
    },
  });
}
