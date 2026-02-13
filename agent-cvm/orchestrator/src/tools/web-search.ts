/**
 * Web search & URL fetch tools — search the web and retrieve page content.
 *
 * Uses Brave Search API (privacy-aligned, no user tracking).
 * Platform credential via BRAVE_SEARCH_API_KEY env var.
 */

import { registerTool } from '../tool-registry.js';
import { getServiceCredential } from '../vault.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

/** Maximum download size for web.fetch (512 KB) */
const MAX_FETCH_BYTES = 512 * 1024;

/** Default timeout for web.fetch (15 seconds) */
const FETCH_TIMEOUT_MS = 15_000;

/** Default max content length returned */
const DEFAULT_MAX_LENGTH = 8000;

/**
 * SSRF protection — block requests to private/internal networks.
 * Checks hostname against RFC 1918, loopback, and link-local ranges.
 */
function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Block obvious private hostnames
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === '[::1]'
  ) {
    return true;
  }

  // Block private IP ranges
  const ipMatch = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 127) return true;                          // 127.0.0.0/8
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
    if (a === 0) return true;                            // 0.0.0.0/8
  }

  return false;
}

/** Strip HTML to plain text using regex (no external dependency) */
function htmlToText(html: string): string {
  return html
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Convert <br>, <p>, <div>, <li>, headings to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6]|tr|blockquote)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract <title> from HTML */
function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).trim() : undefined;
}

async function getBraveApiKey(): Promise<string> {
  // Vault-first: check for runtime-configured key
  const vaultKey = await getServiceCredential('brave_search');
  if (vaultKey) return vaultKey;

  // Env-var fallback
  const envKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!envKey) {
    throw new Error('Brave Search API key is not configured. Set it in Settings > CVM Configuration or via BRAVE_SEARCH_API_KEY env var.');
  }
  return envKey;
}

/** @internal Exported only for testing */
export const _testExports = { isPrivateHost, htmlToText, extractTitle };

export function registerWebSearchTools(): void {
  registerTool({
    name: 'web.search',
    description:
      'Search the web using Brave Search. Returns titles, URLs, and descriptions. Use this to find information, research topics, or look up current data.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: {
          type: 'number',
          description: 'Number of results to return (1–20, default: 5)',
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Filter by recency: day, week, month, or year',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { query, count = 5, freshness } = args as {
        query: string;
        count?: number;
        freshness?: string;
      };

      const apiKey = await getBraveApiKey();
      const clampedCount = Math.max(1, Math.min(20, count));

      const params = new URLSearchParams({
        q: query,
        count: String(clampedCount),
      });
      if (freshness) {
        params.set('freshness', freshness);
      }

      const response = await fetch(`${BRAVE_SEARCH_URL}?${params}`, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      const webResults = data.web?.results || [];

      const results = webResults.map((r: any) => ({
        title: r.title,
        url: r.url,
        description: r.description,
        age: r.age,
      }));

      return {
        query,
        results,
        totalEstimate: data.web?.totalEstimatedMatches,
      };
    },
  });

  registerTool({
    name: 'web.fetch',
    description:
      'Fetch a web page and extract its text content. Useful for reading articles, documentation, or any web page. Only HTTPS URLs are allowed.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'HTTPS URL to fetch (e.g., https://example.com/page)',
        },
        maxLength: {
          type: 'number',
          description: 'Maximum characters to return (default: 8000)',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { url, maxLength = DEFAULT_MAX_LENGTH } = args as {
        url: string;
        maxLength?: number;
      };

      // HTTPS only
      if (!url.startsWith('https://')) {
        throw new Error('Only HTTPS URLs are allowed for security.');
      }

      // SSRF protection
      const parsed = new URL(url);
      if (isPrivateHost(parsed.hostname)) {
        throw new Error('Access to private/internal network addresses is not allowed.');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'LuciaAgent/1.0 (compatible; bot)',
            Accept: 'text/html, application/xhtml+xml, text/plain',
          },
          redirect: 'follow',
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        // Enforce download size limit
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_FETCH_BYTES) {
          throw new Error(`Page too large (${contentLength} bytes). Maximum is ${MAX_FETCH_BYTES} bytes.`);
        }

        // Read body with size limit
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_FETCH_BYTES) {
            reader.cancel();
            break;
          }
          chunks.push(value);
        }

        const decoder = new TextDecoder('utf-8', { fatal: false });
        const html = decoder.decode(
          new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0)).buffer
            ? Buffer.concat(chunks)
            : new Uint8Array()
        );

        const title = extractTitle(html);
        const contentType = response.headers.get('content-type') || '';
        const isHtml = contentType.includes('html');

        let content = isHtml ? htmlToText(html) : html;
        const truncated = content.length > maxLength;
        if (truncated) {
          content = content.slice(0, maxLength);
        }

        return { url, title, content, contentLength: content.length, truncated };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
