/**
 * Browser automation tools — headless Chromium via Playwright.
 *
 * Provides navigate, screenshot, click, type, and extract capabilities.
 * Sessions are pooled with idle timeout and concurrency limits.
 */

import { registerTool } from '../tool-registry.js';
import type { Browser, BrowserContext, Page } from 'playwright-core';

/** Maximum concurrent browser sessions */
const MAX_SESSIONS = 3;

/** Session idle timeout (5 minutes) */
const SESSION_IDLE_MS = 5 * 60 * 1000;

/** Navigation timeout */
const NAV_TIMEOUT_MS = 30_000;

/** Maximum content length for extracted text */
const MAX_CONTENT_LENGTH = 6000;

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

let browser: Browser | null = null;
const sessions = new Map<string, BrowserSession>();

/**
 * SSRF protection — block requests to private/internal networks.
 * Duplicated from web-search.ts to keep tool files self-contained.
 */
function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === '[::1]'
  ) {
    return true;
  }

  const ipMatch = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  return false;
}

function validateUrl(url: string): void {
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new Error('URL must start with https:// or http://');
  }
  const parsed = new URL(url);
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('Access to private/internal network addresses is not allowed.');
  }
}

/** @internal Exported only for testing */
export const _testExports = { isPrivateHost, validateUrl };

async function launchBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  // Dynamic import to avoid requiring playwright-core at module load
  const { chromium } = await import('playwright-core');

  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  console.log('[browser] Chromium launched');
  return browser;
}

function resetIdleTimer(sessionId: string, session: BrowserSession): void {
  clearTimeout(session.idleTimer);
  session.lastUsed = Date.now();
  session.idleTimer = setTimeout(() => {
    destroySession(sessionId);
  }, SESSION_IDLE_MS);
}

async function destroySession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  clearTimeout(session.idleTimer);
  sessions.delete(sessionId);

  try {
    await session.context.close();
  } catch {
    // Context may already be closed
  }

  console.log(`[browser] Session "${sessionId}" destroyed (${sessions.size} remaining)`);

  // If no sessions remain, close the browser
  if (sessions.size === 0 && browser) {
    try {
      await browser.close();
    } catch {
      // Browser may already be closed
    }
    browser = null;
    console.log('[browser] Chromium closed (no active sessions)');
  }
}

async function getSession(sessionId: string): Promise<BrowserSession> {
  const existing = sessions.get(sessionId);
  if (existing) {
    resetIdleTimer(sessionId, existing);
    return existing;
  }

  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(
      `Maximum ${MAX_SESSIONS} concurrent browser sessions reached. Close an existing session first.`
    );
  }

  const b = await launchBrowser();
  const context = await b.newContext({
    userAgent: 'LuciaAgent/1.0 (compatible; bot)',
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const session: BrowserSession = {
    context,
    page,
    lastUsed: Date.now(),
    idleTimer: setTimeout(() => destroySession(sessionId), SESSION_IDLE_MS),
  };

  sessions.set(sessionId, session);
  console.log(`[browser] Session "${sessionId}" created (${sessions.size} active)`);

  return session;
}

export function registerBrowserTools(): void {
  // --- browser.navigate ---
  registerTool({
    name: 'browser.navigate',
    description:
      'Navigate to a URL in a headless browser. Returns the page title and text content. Useful for pages that require JavaScript rendering.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        sessionId: {
          type: 'string',
          description: 'Browser session ID (default: "default"). Use different IDs for parallel workflows.',
        },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { url, sessionId = 'default' } = args as {
        url: string;
        sessionId?: string;
      };

      validateUrl(url);

      const session = await getSession(sessionId);
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });

      const title = await session.page.title();
      let content = await session.page.innerText('body').catch(() => '');

      const truncated = content.length > MAX_CONTENT_LENGTH;
      if (truncated) {
        content = content.slice(0, MAX_CONTENT_LENGTH);
      }

      return {
        url: session.page.url(),
        title,
        content,
        contentLength: content.length,
        truncated,
      };
    },
  });

  // --- browser.screenshot ---
  registerTool({
    name: 'browser.screenshot',
    description:
      'Capture a screenshot of the current page or a specific element. Returns a base64-encoded PNG that can be passed to vision.analyze.',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector of element to screenshot. If omitted, captures the full viewport.',
        },
        sessionId: { type: 'string', description: 'Browser session ID (default: "default")' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { selector, sessionId = 'default' } = args as {
        selector?: string;
        sessionId?: string;
      };

      const session = await getSession(sessionId);

      let buffer: Buffer;
      if (selector) {
        const element = session.page.locator(selector).first();
        buffer = await element.screenshot({ type: 'png' }) as Buffer;
      } else {
        buffer = await session.page.screenshot({ type: 'png' }) as Buffer;
      }

      const base64 = buffer.toString('base64');

      return {
        image: `data:image/png;base64,${base64}`,
        url: session.page.url(),
        selector: selector || 'viewport',
      };
    },
  });

  // --- browser.click ---
  registerTool({
    name: 'browser.click',
    description:
      'Click an element on the current page. Can target by CSS selector or visible text. Requires user confirmation as it may trigger actions (form submissions, purchases, etc.).',
    parameters: {
      type: 'object',
      required: ['target'],
      properties: {
        target: {
          type: 'string',
          description: 'CSS selector (e.g., "button.submit") or visible text to click (e.g., "Sign In")',
        },
        sessionId: { type: 'string', description: 'Browser session ID (default: "default")' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { target, sessionId = 'default' } = args as {
        target: string;
        sessionId?: string;
      };

      const session = await getSession(sessionId);

      // Try CSS selector first, fall back to text-based click
      try {
        const locator = session.page.locator(target).first();
        if (await locator.count() > 0) {
          await locator.click();
          return { clicked: target, method: 'selector', url: session.page.url() };
        }
      } catch {
        // Not a valid selector, try text matching
      }

      // Text-based click
      await session.page.getByText(target, { exact: false }).first().click();
      return { clicked: target, method: 'text', url: session.page.url() };
    },
  });

  // --- browser.type ---
  registerTool({
    name: 'browser.type',
    description:
      'Type text into an input field on the current page. Can target by CSS selector, label, or placeholder text. Requires user confirmation as it submits user data.',
    parameters: {
      type: 'object',
      required: ['selector', 'text'],
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector (e.g., "input[name=email]"), label text, or placeholder text',
        },
        text: { type: 'string', description: 'Text to type into the field' },
        pressEnter: {
          type: 'boolean',
          description: 'Press Enter after typing (default: false)',
        },
        sessionId: { type: 'string', description: 'Browser session ID (default: "default")' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'medium',
    requiresConfirmation: true,
    async execute(args) {
      const { selector, text, pressEnter = false, sessionId = 'default' } = args as {
        selector: string;
        text: string;
        pressEnter?: boolean;
        sessionId?: string;
      };

      const session = await getSession(sessionId);

      // Try CSS selector first
      let filled = false;
      try {
        const locator = session.page.locator(selector).first();
        if (await locator.count() > 0) {
          await locator.fill(text);
          filled = true;
        }
      } catch {
        // Not a valid selector
      }

      // Try label or placeholder match
      if (!filled) {
        const byLabel = session.page.getByLabel(selector);
        if (await byLabel.count() > 0) {
          await byLabel.first().fill(text);
          filled = true;
        }
      }

      if (!filled) {
        const byPlaceholder = session.page.getByPlaceholder(selector);
        if (await byPlaceholder.count() > 0) {
          await byPlaceholder.first().fill(text);
          filled = true;
        }
      }

      if (!filled) {
        throw new Error(`Could not find input matching "${selector}"`);
      }

      if (pressEnter) {
        await session.page.keyboard.press('Enter');
      }

      return {
        selector,
        typed: text.length > 50 ? `${text.slice(0, 50)}...` : text,
        pressedEnter: pressEnter,
        url: session.page.url(),
      };
    },
  });

  // --- browser.extract ---
  registerTool({
    name: 'browser.extract',
    description:
      'Extract structured data from the current page: text content, all links, tables, or raw HTML of a specific element.',
    parameters: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['text', 'links', 'tables', 'html'],
          description: 'What to extract: "text" (page text), "links" (all links), "tables" (table data), "html" (raw HTML of selector)',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to scope extraction (default: entire page)',
        },
        sessionId: { type: 'string', description: 'Browser session ID (default: "default")' },
      },
    },
    requiredCredentials: [],
    riskLevel: 'low',
    requiresConfirmation: false,
    async execute(args) {
      const { type, selector, sessionId = 'default' } = args as {
        type: 'text' | 'links' | 'tables' | 'html';
        selector?: string;
        sessionId?: string;
      };

      const session = await getSession(sessionId);
      const scope = selector || 'body';

      switch (type) {
        case 'text': {
          let text = await session.page.locator(scope).first().innerText();
          const truncated = text.length > MAX_CONTENT_LENGTH;
          if (truncated) text = text.slice(0, MAX_CONTENT_LENGTH);
          return { type: 'text', content: text, truncated, url: session.page.url() };
        }

        case 'links': {
          const links = await session.page.locator(`${scope} a[href]`).evaluateAll(
            (elements) =>
              elements.map((el) => ({
                text: (el as HTMLAnchorElement).innerText.trim(),
                href: (el as HTMLAnchorElement).href,
              }))
          );
          return { type: 'links', links: links.slice(0, 100), url: session.page.url() };
        }

        case 'tables': {
          const tables = await session.page.locator(`${scope} table`).evaluateAll(
            (elements) =>
              elements.map((table) => {
                const rows = Array.from((table as HTMLTableElement).rows);
                return rows.map((row) =>
                  Array.from(row.cells).map((cell) => cell.innerText.trim())
                );
              })
          );
          return { type: 'tables', tables: tables.slice(0, 10), url: session.page.url() };
        }

        case 'html': {
          let html = await session.page.locator(scope).first().innerHTML();
          const truncated = html.length > MAX_CONTENT_LENGTH;
          if (truncated) html = html.slice(0, MAX_CONTENT_LENGTH);
          return { type: 'html', html, truncated, url: session.page.url() };
        }

        default:
          throw new Error(`Unknown extraction type: ${type}`);
      }
    },
  });
}
