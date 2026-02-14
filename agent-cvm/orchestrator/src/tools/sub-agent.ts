/**
 * Sub-agent tools — LLM-callable tools for explicit sub-agent dispatch.
 *
 * These allow the main agent to delegate tasks to specialized models:
 * - agent.reason: Complex reasoning (Kimi K2.5)
 * - agent.code: Coding tasks (Claude Opus)
 * - agent.uncensored: Unrestricted responses (Uncensored 24B)
 * - agent.debug: Diagnostic analysis (Claude Opus — no tools, pure analyst)
 */

import { registerTool } from '../tool-registry.js';
import { runSubAgent } from '../sub-agent.js';
import { collectDiagnostics, buildDebugSystemPrompt } from '../debug-collector.js';
import { callInference } from '../inference.js';
import { getModelForRole } from '../model-registry.js';
import { trackUsage } from '../token-tracker.js';
import { getCurrentConversationId } from '../memory.js';
import { getExecutionStatus } from '../workflow-engine.js';

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

  registerTool({
    name: 'agent.debug',
    description:
      'Diagnose errors and failures by collecting recent logs, workflow/cron errors, and conversation context, then sending them to Claude Opus for root cause analysis. Use when something went wrong, a workflow failed, or the user asks "what happened" / "debug this".',
    parameters: {
      type: 'object',
      required: [],
      properties: {
        issue: {
          type: 'string',
          description: 'Description of the issue to investigate',
        },
        executionId: {
          type: 'string',
          description: 'Optional workflow execution ID for per-step breakdown',
        },
        timeWindowMinutes: {
          type: 'number',
          description: 'How far back to look in logs (default: 10 minutes)',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const issue = args.issue as string | undefined;
      const executionId = args.executionId as string | undefined;
      const timeWindowMinutes = (args.timeWindowMinutes as number) || 10;
      const logWindowMs = timeWindowMinutes * 60 * 1000;

      const conversationId = await getCurrentConversationId();
      const bundle = await collectDiagnostics(conversationId, { logWindowMs });

      // Build user prompt with labeled sections
      const sections: string[] = [];

      if (issue) {
        sections.push(`## Reported Issue\n${issue}`);
      }

      if (bundle.errorLogs !== '(no log entries)') {
        sections.push(`## Error Logs (last ${timeWindowMinutes} min)\n${bundle.errorLogs}`);
      }

      if (bundle.recentLogs !== '(no log entries)') {
        sections.push(`## Recent Logs (last ${timeWindowMinutes} min)\n${bundle.recentLogs}`);
      }

      if (bundle.workflowErrors !== '(no failed workflow executions)') {
        sections.push(`## Failed Workflow Executions\n${bundle.workflowErrors}`);
      }

      // Per-step breakdown for a specific execution
      if (executionId) {
        try {
          const execStatus = await getExecutionStatus(executionId);
          if (execStatus) {
            sections.push(
              `## Execution ${executionId} Details\n${JSON.stringify(execStatus, null, 2)}`,
            );
          }
        } catch {
          // Non-critical — proceed without per-step details
        }
      }

      if (bundle.cronErrors !== '(no cron errors)') {
        sections.push(`## Cron Job Errors\n${bundle.cronErrors}`);
      }

      if (bundle.conversationContext !== '(no conversation history)') {
        sections.push(`## Recent Conversation\n${bundle.conversationContext}`);
      }

      sections.push(`## System Info\n${bundle.systemInfo}`);

      const userPrompt = sections.join('\n\n');
      const systemPrompt = buildDebugSystemPrompt();
      const modelId = getModelForRole('debug');

      const result = await callInference(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        modelId,
      );

      // Track usage for cost visibility
      if (result.promptTokens || result.completionTokens) {
        trackUsage(modelId, 'debug', result.promptTokens || 0, result.completionTokens || 0);
      }

      const tokensUsed = (result.promptTokens || 0) + (result.completionTokens || 0);

      return {
        diagnosis: result.content,
        model: modelId,
        tokensUsed,
        diagnosticSummary: {
          errorLogCount: bundle.errorLogs === '(no log entries)' ? 0 : bundle.errorLogs.split('\n').length,
          hasWorkflowErrors: bundle.workflowErrors !== '(no failed workflow executions)',
          hasCronErrors: bundle.cronErrors !== '(no cron errors)',
          timeWindowMinutes,
        },
      };
    },
  });
}
