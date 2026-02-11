/**
 * Lucia Agent Orchestrator — CVM entry point.
 *
 * Starts the WebSocket server, health endpoint, and all subsystems.
 */

import { startServer } from './server.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

startServer(PORT);
