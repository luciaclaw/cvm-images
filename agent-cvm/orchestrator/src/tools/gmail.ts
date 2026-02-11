/**
 * Gmail tool implementations — send, read, search, list emails.
 *
 * Uses Google Gmail API v1 REST directly (no googleapis npm package).
 * OAuth token retrieved from vault, refreshed via oauth.ts.
 */

import { registerTool } from '../tool-registry.js';
import { getAccessToken } from '../oauth.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken('google');
  if (!token) throw new Error('Google not connected. Please connect Google in Settings.');

  const response = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error (${response.status}): ${error}`);
  }

  return response;
}

/** Build a raw RFC 2822 email message */
function buildRawEmail(to: string, subject: string, body: string, cc?: string): string {
  const lines = [
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

export function registerGmailTools(): void {
  registerTool({
    name: 'gmail.send',
    description: 'Send an email via Gmail. Requires user confirmation.',
    parameters: {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC email address (optional)' },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'high',
    requiresConfirmation: true,
    async execute(args) {
      const { to, subject, body, cc } = args as { to: string; subject: string; body: string; cc?: string };
      const raw = buildRawEmail(to, subject, body, cc);

      const response = await gmailFetch('/messages/send', {
        method: 'POST',
        body: JSON.stringify({ raw }),
      });

      const data = await response.json() as any;
      return { messageId: data.id, threadId: data.threadId };
    },
  });

  registerTool({
    name: 'gmail.read',
    description: 'Read a specific email by message ID.',
    parameters: {
      type: 'object',
      required: ['messageId'],
      properties: {
        messageId: { type: 'string', description: 'Gmail message ID' },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { messageId } = args as { messageId: string };
      const response = await gmailFetch(`/messages/${messageId}?format=full`);
      const data = await response.json() as any;

      const headers = data.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      // Extract plain text body
      let body = '';
      if (data.payload?.body?.data) {
        body = Buffer.from(data.payload.body.data, 'base64url').toString('utf-8');
      } else if (data.payload?.parts) {
        const textPart = data.payload.parts.find((p: any) => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
        }
      }

      return {
        id: data.id,
        threadId: data.threadId,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        body: body.substring(0, 5000), // Limit body size
        snippet: data.snippet,
      };
    },
  });

  registerTool({
    name: 'gmail.search',
    description: 'Search emails by query (e.g., "from:boss subject:meeting").',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Gmail search query' },
        maxResults: { type: 'number', description: 'Maximum results (default: 10)' },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { query, maxResults = 10 } = args as { query: string; maxResults?: number };
      const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
      const response = await gmailFetch(`/messages?${params}`);
      const data = await response.json() as any;

      if (!data.messages || data.messages.length === 0) {
        return { results: [], totalEstimate: 0 };
      }

      // Fetch metadata for each result
      const results = await Promise.all(
        data.messages.slice(0, maxResults).map(async (msg: any) => {
          const msgResponse = await gmailFetch(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          const msgData = await msgResponse.json() as any;
          const headers = msgData.payload?.headers || [];
          const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

          return {
            id: msg.id,
            threadId: msg.threadId,
            from: getHeader('From'),
            subject: getHeader('Subject'),
            date: getHeader('Date'),
            snippet: msgData.snippet,
          };
        })
      );

      return { results, totalEstimate: data.resultSizeEstimate || results.length };
    },
  });

  registerTool({
    name: 'gmail.list',
    description: 'List recent emails from inbox.',
    parameters: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Maximum results (default: 10)' },
        label: { type: 'string', description: 'Label to filter by (default: INBOX)' },
      },
    },
    requiredCredentials: ['google'],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { maxResults = 10, label = 'INBOX' } = args as { maxResults?: number; label?: string };
      const params = new URLSearchParams({ labelIds: label, maxResults: String(maxResults) });
      const response = await gmailFetch(`/messages?${params}`);
      const data = await response.json() as any;

      if (!data.messages || data.messages.length === 0) {
        return { emails: [], total: 0 };
      }

      const emails = await Promise.all(
        data.messages.slice(0, maxResults).map(async (msg: any) => {
          const msgResponse = await gmailFetch(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          const msgData = await msgResponse.json() as any;
          const headers = msgData.payload?.headers || [];
          const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

          return {
            id: msg.id,
            from: getHeader('From'),
            subject: getHeader('Subject'),
            date: getHeader('Date'),
            snippet: msgData.snippet,
          };
        })
      );

      return { emails, total: data.resultSizeEstimate || emails.length };
    },
  });
}
