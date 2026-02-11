/**
 * Tool registry — registration and lookup of available tools.
 *
 * Each tool declares its name, description, parameters (JSON Schema),
 * required credentials, risk level, and execute function.
 */

import type { ConfirmationRisk } from '@luciaclaw/protocol';

export interface ToolDefinition {
  /** Tool name (e.g., 'gmail.send', 'calendar.list') */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** JSON Schema for the tool's parameters */
  parameters: Record<string, unknown>;
  /** Service credentials required (e.g., 'google', 'slack') */
  requiredCredentials: string[];
  /** Risk level for policy engine */
  riskLevel: ConfirmationRisk;
  /** Whether user confirmation is required before execution */
  requiresConfirmation: boolean;
  /** Execute the tool and return a result */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

const registry = new Map<string, ToolDefinition>();

/** Register a tool */
export function registerTool(tool: ToolDefinition): void {
  registry.set(tool.name, tool);
  console.log(`[tools] Registered tool: ${tool.name}`);
}

/** Get a tool by name */
export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

/** Get all registered tools */
export function getAllTools(): ToolDefinition[] {
  return [...registry.values()];
}

/** Get tool definitions in OpenAI function calling format */
export function getToolsForInference(): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return getAllTools().map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
