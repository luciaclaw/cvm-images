/**
 * WebSocket server with E2E handshake and health endpoint.
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { handleHandshake } from './handshake.js';

export function startServer(port: number): void {
  const app = express();
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'lucia-orchestrator',
      version: '0.1.0',
      uptime: process.uptime(),
    });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Origin validation
    const origin = req.headers.origin;
    const allowedOriginsRaw = process.env.ALLOWED_ORIGINS || 'http://localhost:5173';
    const allowAll = allowedOriginsRaw.trim() === '*';
    if (!allowAll && origin && !allowedOriginsRaw.split(',').includes(origin)) {
      console.warn(`[orchestrator] Rejected connection from origin: ${origin}`);
      ws.close(4003, 'Origin not allowed');
      return;
    }

    console.log('[orchestrator] Client connected');
    handleHandshake(ws);
  });

  server.listen(port, () => {
    console.log(`[orchestrator] Listening on port ${port}`);
    console.log(`[orchestrator] WebSocket: ws://localhost:${port}/ws`);
  });
}
