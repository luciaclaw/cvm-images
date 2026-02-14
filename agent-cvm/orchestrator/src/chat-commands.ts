/**
 * Chat slash commands — mode switching from any channel (PWA, Telegram, WhatsApp).
 *
 * Commands:
 *   /standard    — switch to default model (GPT-OSS 120B)
 *   /reasoning   — switch to reasoning model (Kimi K2.5)
 *   /uncensored  — switch to uncensored model (Uncensored 24B)
 *   /model       — show current mode + available modes
 */

import type { ModelRole } from './model-registry.js';
import { getModelForRole, getModelConfig } from './model-registry.js';
import { setPreference, getPreference } from './persistent-memory.js';

export interface CommandResult {
  /** Confirmation text to send back to the user */
  response: string;
}

/** Roles that can be selected via slash command */
const SWITCHABLE_ROLES: ModelRole[] = ['default', 'reasoning', 'uncensored'];

/** Map command names to model roles */
const COMMAND_TO_ROLE: Record<string, ModelRole> = {
  standard: 'default',
  reasoning: 'reasoning',
  uncensored: 'uncensored',
};

/**
 * Try to handle a slash command. Returns a CommandResult if the text is
 * a recognized command, or null if it should pass through to the LLM.
 */
export async function handleChatCommand(text: string): Promise<CommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract command name (lowercase, no leading slash, ignore anything after whitespace)
  const command = trimmed.split(/\s+/)[0].slice(1).toLowerCase();

  // Mode switch commands
  const role = COMMAND_TO_ROLE[command];
  if (role) {
    return switchMode(role);
  }

  // /model — show current mode
  if (command === 'model') {
    return showCurrentMode();
  }

  // Not a recognized command — pass through to LLM
  return null;
}

async function switchMode(role: ModelRole): Promise<CommandResult> {
  const config = getModelConfig(role);
  await setPreference('chat_model_role', role);

  let response = `Switched to ${config.name} (${role} mode).`;

  if (!config.supportsTools) {
    response += '\n\nNote: Tool calling (email, calendar, web search, etc.) is disabled in this mode.';
  }

  return { response };
}

async function showCurrentMode(): Promise<CommandResult> {
  const currentRole = (await getPreference('chat_model_role')) as ModelRole | null;
  const activeRole = currentRole || 'default';
  const activeConfig = getModelConfig(activeRole);

  const lines = [
    `Current mode: ${activeConfig.name} (${activeRole})`,
    '',
    'Available commands:',
  ];

  for (const role of SWITCHABLE_ROLES) {
    const config = getModelConfig(role);
    const commandName = role === 'default' ? 'standard' : role;
    const marker = role === activeRole ? ' ← active' : '';
    const toolNote = config.supportsTools ? '' : ' (no tools)';
    lines.push(`  /${commandName} — ${config.name}${toolNote}${marker}`);
  }

  return { response: lines.join('\n') };
}
