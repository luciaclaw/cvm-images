/**
 * WebSocket server with E2E handshake, OAuth callback, and health endpoint.
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { handleHandshake } from './handshake.js';
import { handleOAuthCallback } from './oauth.js';
import { getDb } from './storage.js';

export function startServer(port: number): void {
  // Initialize SQLite database on startup
  getDb();
  console.log('[storage] Database initialized');

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'lucia-orchestrator',
      version: '0.2.0',
      uptime: process.uptime(),
    });
  });

  // OAuth callback endpoint — receives redirects from OAuth providers
  app.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      res.status(400).send(`<html><body><h2>OAuth Error</h2><p>${error}</p><p>You can close this window.</p></body></html>`);
      return;
    }

    if (!code || !state) {
      res.status(400).send('<html><body><h2>Missing OAuth parameters</h2></body></html>');
      return;
    }

    const result = await handleOAuthCallback(code as string, state as string);
    const payload = result.payload as any;

    if (payload.success) {
      res.send(`<html><body><h2>Connected!</h2><p>${payload.service} has been successfully connected to Lucia.</p><p>You can close this window and return to the app.</p><script>window.close()</script></body></html>`);
    } else {
      res.status(400).send(`<html><body><h2>Connection Failed</h2><p>${payload.error}</p><p>Please try again from the Lucia settings page.</p></body></html>`);
    }

    // TODO: Send the oauth.callback message to the connected PWA client via WebSocket
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
