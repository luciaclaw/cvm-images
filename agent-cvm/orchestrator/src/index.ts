/**
 * Lucia Agent Orchestrator — CVM entry point.
 *
 * Starts the WebSocket server, health endpoint, and all subsystems.
 * Registers available tools for the agent to use.
 */

import { startServer } from './server.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerSlackTools } from './tools/slack.js';
import { registerTelegramTools } from './tools/telegram.js';
import { registerVisionTools } from './tools/vision.js';
import { registerWebSearchTools } from './tools/web-search.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerGithubTools } from './tools/github.js';
import { registerDiscordTools } from './tools/discord.js';
import { registerWhatsappTools } from './tools/whatsapp.js';
import { registerVoiceTools } from './tools/voice.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerMediaTools } from './tools/media.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { registerCronTools } from './tools/cron.js';
import { registerWebhookTools } from './tools/webhook.js';
import { recoverRunningExecutions } from './workflow-engine.js';

// Register all tools
registerGmailTools();
registerCalendarTools();
registerSlackTools();
registerTelegramTools();
registerVisionTools();
registerWebSearchTools();
registerBrowserTools();
registerGithubTools();
registerDiscordTools();
registerWhatsappTools();
registerVoiceTools();
registerMemoryTools();
registerMediaTools();
registerWorkflowTools();
registerCronTools();
registerWebhookTools();

const PORT = parseInt(process.env.PORT || '8080', 10);

startServer(PORT);

// Recover any workflows that were running when the CVM restarted
recoverRunningExecutions().catch((err) => console.error('[workflow] Recovery failed:', err));
