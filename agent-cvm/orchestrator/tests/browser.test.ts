import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _testExports, registerBrowserTools } from '../src/tools/browser.js';
import { getTool } from '../src/tool-registry.js';

const { isPrivateHost, validateUrl } = _testExports;

// ---------------------------------------------------------------------------
// Unit tests — no browser needed
// ---------------------------------------------------------------------------

describe('browser isPrivateHost', () => {
  it('blocks localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
  });

  it('blocks .local domains', () => {
    expect(isPrivateHost('myhost.local')).toBe(true);
  });

  it('blocks .internal domains', () => {
    expect(isPrivateHost('service.internal')).toBe(true);
  });

  it('blocks IPv6 loopback', () => {
    expect(isPrivateHost('[::1]')).toBe(true);
  });

  it('blocks 10.x.x.x', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
  });

  it('blocks 172.16-31.x.x', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('blocks 192.168.x.x', () => {
    expect(isPrivateHost('192.168.0.1')).toBe(true);
  });

  it('blocks 127.x.x.x', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
  });

  it('blocks 169.254.x.x (link-local)', () => {
    expect(isPrivateHost('169.254.0.1')).toBe(true);
  });

  it('blocks 0.x.x.x', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });
});

describe('validateUrl', () => {
  it('accepts https:// URLs', () => {
    expect(() => validateUrl('https://example.com')).not.toThrow();
  });

  it('accepts http:// URLs', () => {
    expect(() => validateUrl('http://example.com')).not.toThrow();
  });

  it('rejects non-URL strings', () => {
    expect(() => validateUrl('not-a-url')).toThrow(/URL must start with/);
  });

  it('rejects ftp:// URLs', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow(/URL must start with/);
  });

  it('rejects private hosts', () => {
    expect(() => validateUrl('https://localhost')).toThrow(/private|internal/i);
    expect(() => validateUrl('http://10.0.0.1')).toThrow(/private|internal/i);
    expect(() => validateUrl('https://192.168.1.1')).toThrow(/private|internal/i);
    expect(() => validateUrl('http://127.0.0.1:8080')).toThrow(/private|internal/i);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require Chromium via Playwright
// ---------------------------------------------------------------------------

let chromiumAvailable = false;

try {
  // Quick check if chromium executable exists
  const { chromium } = await import('playwright-core');
  const execPath = chromium.executablePath();
  const { existsSync } = await import('fs');
  chromiumAvailable = !!execPath && existsSync(execPath);
} catch {
  chromiumAvailable = false;
}

describe.skipIf(!chromiumAvailable)('browser integration', () => {
  beforeAll(() => {
    registerBrowserTools();
  });

  afterAll(async () => {
    // Clean up: close any open sessions by navigating away
    // Sessions auto-close on idle, but we want clean test exits
  });

  it('browser.navigate — navigates to example.com', async () => {
    const tool = getTool('browser.navigate')!;
    const result = (await tool.execute({
      url: 'https://example.com',
      sessionId: 'test-nav',
    })) as any;

    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('title');
    expect(result.title).toMatch(/example/i);
    expect(result).toHaveProperty('content');
    expect(result.content.length).toBeGreaterThan(0);
  }, 30_000);

  it('browser.screenshot — returns base64 PNG', async () => {
    const tool = getTool('browser.screenshot')!;
    // Re-use session from previous test (already on example.com)
    const result = (await tool.execute({
      sessionId: 'test-nav',
    })) as any;

    expect(result).toHaveProperty('image');
    expect(result.image).toMatch(/^data:image\/png;base64,/);
    expect(result.image.length).toBeGreaterThan(100);
  }, 30_000);

  it('browser.extract (text) — extracts text content', async () => {
    const tool = getTool('browser.extract')!;
    const result = (await tool.execute({
      type: 'text',
      sessionId: 'test-nav',
    })) as any;

    expect(result).toHaveProperty('type', 'text');
    expect(result).toHaveProperty('content');
    expect(result.content.length).toBeGreaterThan(0);
  }, 30_000);

  it('browser.extract (links) — extracts links as array', async () => {
    const tool = getTool('browser.extract')!;
    const result = (await tool.execute({
      type: 'links',
      sessionId: 'test-nav',
    })) as any;

    expect(result).toHaveProperty('type', 'links');
    expect(Array.isArray(result.links)).toBe(true);
    // example.com has at least one link ("More information...")
    expect(result.links.length).toBeGreaterThanOrEqual(1);
    expect(result.links[0]).toHaveProperty('href');
  }, 30_000);

  it('browser.navigate — rejects private hosts', async () => {
    const tool = getTool('browser.navigate')!;
    await expect(
      tool.execute({ url: 'http://localhost:3000', sessionId: 'test-ssrf' })
    ).rejects.toThrow(/private|internal/i);
  });

  it('max sessions — exceeding limit throws error', async () => {
    const navigate = getTool('browser.navigate')!;

    // Create sessions up to MAX_SESSIONS (3).
    // test-nav already exists, so create 2 more
    await navigate.execute({
      url: 'https://example.com',
      sessionId: 'test-max-1',
    });
    await navigate.execute({
      url: 'https://example.com',
      sessionId: 'test-max-2',
    });

    // 4th session should fail
    await expect(
      navigate.execute({
        url: 'https://example.com',
        sessionId: 'test-max-overflow',
      })
    ).rejects.toThrow(/maximum.*3.*sessions/i);
  }, 60_000);
});
