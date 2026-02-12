import { describe, it, expect, beforeAll } from 'vitest';
import { _testExports, registerWebSearchTools } from '../src/tools/web-search.js';
import { getTool } from '../src/tool-registry.js';

const { isPrivateHost, htmlToText, extractTitle } = _testExports;

// ---------------------------------------------------------------------------
// Unit tests — no network required
// ---------------------------------------------------------------------------

describe('isPrivateHost', () => {
  it('blocks localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('LOCALHOST')).toBe(true);
  });

  it('blocks .local domains', () => {
    expect(isPrivateHost('myhost.local')).toBe(true);
    expect(isPrivateHost('server.LOCAL')).toBe(true);
  });

  it('blocks .internal domains', () => {
    expect(isPrivateHost('service.internal')).toBe(true);
  });

  it('blocks IPv6 loopback', () => {
    expect(isPrivateHost('[::1]')).toBe(true);
  });

  it('blocks 10.x.x.x (RFC 1918)', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('10.255.255.255')).toBe(true);
  });

  it('blocks 172.16-31.x.x (RFC 1918)', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    // 172.15.x.x and 172.32.x.x are public
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
  });

  it('blocks 192.168.x.x (RFC 1918)', () => {
    expect(isPrivateHost('192.168.0.1')).toBe(true);
    expect(isPrivateHost('192.168.255.255')).toBe(true);
  });

  it('blocks 127.x.x.x (loopback)', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.255.255.255')).toBe(true);
  });

  it('blocks 169.254.x.x (link-local)', () => {
    expect(isPrivateHost('169.254.0.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
  });

  it('blocks 0.x.x.x', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('0.1.2.3')).toBe(true);
  });

  it('allows valid public hostnames', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
    expect(isPrivateHost('api.brave.com')).toBe(false);
  });
});

describe('htmlToText', () => {
  it('removes script tags and their contents', () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    const result = htmlToText(html);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
    expect(result).not.toContain('alert');
  });

  it('removes style tags and their contents', () => {
    const html = '<style>body { color: red; }</style><p>Content</p>';
    expect(htmlToText(html)).toBe('Content');
  });

  it('strips remaining HTML tags', () => {
    const html = '<div><strong>Bold</strong> and <em>italic</em></div>';
    const result = htmlToText(html);
    expect(result).toContain('Bold');
    expect(result).toContain('italic');
    expect(result).not.toContain('<strong>');
    expect(result).not.toContain('<em>');
  });

  it('decodes common HTML entities', () => {
    const html = '&amp; &lt; &gt; &quot; &#39; &nbsp;';
    const result = htmlToText(html);
    expect(result).toContain('&');
    expect(result).toContain('<');
    expect(result).toContain('>');
    expect(result).toContain('"');
    expect(result).toContain("'");
    // &nbsp; is converted to a regular space (may be collapsed/trimmed)
    expect(result).not.toContain('&amp;');
    expect(result).not.toContain('&nbsp;');
  });

  it('collapses whitespace', () => {
    const html = '<p>Hello    World</p>   <p>Foo</p>';
    const result = htmlToText(html);
    expect(result).not.toMatch(/  /); // no double spaces
  });

  it('converts block elements to newlines', () => {
    const html = '<p>Paragraph 1</p><p>Paragraph 2</p>';
    const result = htmlToText(html);
    expect(result).toContain('\n');
  });

  it('removes HTML comments', () => {
    const html = '<!-- comment --><p>visible</p>';
    expect(htmlToText(html)).toBe('visible');
  });
});

describe('extractTitle', () => {
  it('extracts a normal title', () => {
    const html = '<html><head><title>My Page</title></head><body></body></html>';
    expect(extractTitle(html)).toBe('My Page');
  });

  it('returns undefined when title is missing', () => {
    const html = '<html><head></head><body></body></html>';
    expect(extractTitle(html)).toBeUndefined();
  });

  it('handles nested tags inside title', () => {
    const html = '<title><span>Nested</span> Title</title>';
    expect(extractTitle(html)).toBe('Nested Title');
  });

  it('trims whitespace in title', () => {
    const html = '<title>  Spaced  </title>';
    expect(extractTitle(html)).toBe('Spaced');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require BRAVE_SEARCH_API_KEY env var
// ---------------------------------------------------------------------------

const HAS_BRAVE_KEY = !!process.env.BRAVE_SEARCH_API_KEY;

describe.skipIf(!HAS_BRAVE_KEY)('web.search integration', () => {
  beforeAll(() => {
    registerWebSearchTools();
  });

  it('returns results with expected structure', async () => {
    const tool = getTool('web.search')!;
    const result = (await tool.execute({ query: 'test' })) as any;

    expect(result).toHaveProperty('query', 'test');
    expect(result).toHaveProperty('results');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toHaveProperty('title');
    expect(result.results[0]).toHaveProperty('url');
    expect(result).toHaveProperty('totalEstimate');
  });

  it('respects count parameter', async () => {
    const tool = getTool('web.search')!;
    const result = (await tool.execute({ query: 'test', count: 2 })) as any;

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it('accepts freshness parameter', async () => {
    const tool = getTool('web.search')!;
    const result = (await tool.execute({
      query: 'test',
      freshness: 'week',
    })) as any;

    expect(result).toHaveProperty('results');
  });
});

describe('web.search — missing API key', () => {
  it('throws a clear error when BRAVE_SEARCH_API_KEY is not set', async () => {
    // Temporarily remove key
    const saved = process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;

    try {
      registerWebSearchTools();
      const tool = getTool('web.search')!;
      await expect(tool.execute({ query: 'test' })).rejects.toThrow(
        /BRAVE_SEARCH_API_KEY/
      );
    } finally {
      if (saved) process.env.BRAVE_SEARCH_API_KEY = saved;
    }
  });
});

describe.skipIf(!HAS_BRAVE_KEY)('web.fetch integration', () => {
  beforeAll(() => {
    registerWebSearchTools();
  });

  it('fetches example.com and returns content', async () => {
    const tool = getTool('web.fetch')!;
    const result = (await tool.execute({
      url: 'https://example.com',
    })) as any;

    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('title');
    expect(result).toHaveProperty('content');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('rejects http:// URLs', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'http://example.com' })
    ).rejects.toThrow(/HTTPS/i);
  });

  it('rejects SSRF: localhost', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'https://localhost' })
    ).rejects.toThrow(/private|internal/i);
  });

  it('rejects SSRF: private IP 10.0.0.1', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'https://10.0.0.1' })
    ).rejects.toThrow(/private|internal/i);
  });

  it('rejects SSRF: private IP 192.168.1.1', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'https://192.168.1.1' })
    ).rejects.toThrow(/private|internal/i);
  });

  it('respects maxLength truncation', async () => {
    const tool = getTool('web.fetch')!;
    const result = (await tool.execute({
      url: 'https://example.com',
      maxLength: 50,
    })) as any;

    expect(result.content.length).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
  });
});

// SSRF tests that don't need network (they fail before making a request)
describe('web.fetch SSRF protection (no network)', () => {
  beforeAll(() => {
    registerWebSearchTools();
  });

  it('rejects http:// URLs', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'http://example.com' })
    ).rejects.toThrow(/HTTPS/i);
  });

  it('rejects https://localhost', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'https://localhost' })
    ).rejects.toThrow(/private|internal/i);
  });

  it('rejects https://10.0.0.1', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'https://10.0.0.1' })
    ).rejects.toThrow(/private|internal/i);
  });

  it('rejects https://192.168.1.1', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'https://192.168.1.1' })
    ).rejects.toThrow(/private|internal/i);
  });

  it('rejects https://127.0.0.1', async () => {
    const tool = getTool('web.fetch')!;
    await expect(
      tool.execute({ url: 'https://127.0.0.1' })
    ).rejects.toThrow(/private|internal/i);
  });
});
