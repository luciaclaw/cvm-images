/**
 * Server-side ECDH P-256 handshake.
 *
 * After handshake, routes decrypted messages through the router.
 */

import type { WebSocket } from 'ws';
import type {
  MessageEnvelope,
  HandshakeInitPayload,
  HandshakeCompletePayload,
} from '@luciaclaw/protocol';
import { PROTOCOL_VERSION } from '@luciaclaw/protocol';
import { routeMessage } from './router.js';
import { setActiveSendFn } from './chat.js';

const subtle = globalThis.crypto.subtle;

export async function handleHandshake(ws: WebSocket): Promise<void> {
  let sessionKey: CryptoKey | null = null;

  ws.on('message', async (data) => {
    try {
      const raw = typeof data === 'string' ? data : data.toString('utf-8');
      const envelope: MessageEnvelope = JSON.parse(raw);

      if (envelope.type === 'handshake.init') {
        const { clientPublicKey } = envelope.payload as HandshakeInitPayload;

        const serverKeyPair = await subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          ['deriveKey', 'deriveBits']
        );

        const serverPubExported = await subtle.exportKey('spki', serverKeyPair.publicKey);
        const serverPubBase64 = Buffer.from(serverPubExported).toString('base64');

        const clientPubKey = await subtle.importKey(
          'spki',
          Buffer.from(clientPublicKey, 'base64'),
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          []
        );

        sessionKey = await subtle.deriveKey(
          { name: 'ECDH', public: clientPubKey },
          serverKeyPair.privateKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );

        // TODO: In production, generate real TDX attestation via dstack SDK
        const response: MessageEnvelope = {
          id: crypto.randomUUID(),
          type: 'handshake.response',
          timestamp: Date.now(),
          payload: {
            serverPublicKey: serverPubBase64,
            protocolVersion: PROTOCOL_VERSION,
            attestation: {
              tdx: {
                quote: process.env.TDX_QUOTE || 'MOCK_TDX_QUOTE',
                measurements: {
                  mrtd: process.env.TDX_MRTD || '0'.repeat(96),
                  rtmr0: process.env.TDX_RTMR0 || '0'.repeat(96),
                  rtmr1: process.env.TDX_RTMR1 || '0'.repeat(96),
                  rtmr2: process.env.TDX_RTMR2 || '0'.repeat(96),
                  rtmr3: process.env.TDX_RTMR3 || '0'.repeat(96),
                },
              },
              generatedAt: Date.now(),
              imageHash: process.env.IMAGE_HASH || 'sha256:dev',
            },
          },
        };
        ws.send(JSON.stringify(response));
        console.log('[orchestrator] Handshake response sent');
        return;
      }

      if (envelope.type === 'encrypted' && sessionKey) {
        const { iv, ciphertext } = envelope.payload as { iv: string; ciphertext: string };
        const decrypted = await subtle.decrypt(
          { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
          sessionKey,
          Buffer.from(ciphertext, 'base64')
        );
        const inner: MessageEnvelope = JSON.parse(new TextDecoder().decode(decrypted));

        if (inner.type === 'handshake.complete') {
          console.log('[orchestrator] E2E channel established');
          // Set the send function for tool executor to push messages to client
          setActiveSendFn((msg) => sendEncrypted(ws, sessionKey!, msg));
          return;
        }

        let response: MessageEnvelope | null;
        try {
          response = await routeMessage(inner);
        } catch (routeErr) {
          console.error('[orchestrator] Route error:', routeErr);
          response = {
            id: crypto.randomUUID(),
            type: 'error',
            timestamp: Date.now(),
            payload: { code: 1500, message: routeErr instanceof Error ? routeErr.message : 'Internal error' },
          };
        }
        if (response) {
          await sendEncrypted(ws, sessionKey, response);
        }
        return;
      }

      // Reject unencrypted messages after handshake should be complete
      if (sessionKey && envelope.type !== 'encrypted') {
        const error: MessageEnvelope = {
          id: crypto.randomUUID(),
          type: 'error',
          timestamp: Date.now(),
          payload: { code: 2003, message: 'Unencrypted messages not accepted after handshake' },
        };
        await sendEncrypted(ws, sessionKey, error);
      }
    } catch (err) {
      console.error('[orchestrator] Error:', err);
    }
  });

  ws.on('close', () => {
    console.log('[orchestrator] Client disconnected');
    sessionKey = null;
    setActiveSendFn(null);
  });
}

async function sendEncrypted(ws: WebSocket, key: CryptoKey, message: MessageEnvelope): Promise<void> {
  const plaintext = JSON.stringify(message);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const envelope: MessageEnvelope = {
    id: crypto.randomUUID(),
    type: 'encrypted',
    timestamp: Date.now(),
    payload: {
      iv: Buffer.from(iv).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    },
  };
  ws.send(JSON.stringify(envelope));
}
